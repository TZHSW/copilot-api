import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  newResponsesStreamState,
  translateAnthropicToResponses,
  translateResponsesResultToAnthropic,
  translateResponsesStreamEvent,
} from "./responses-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

// Copilot's GPT-5.x models are responses-only — they reject /chat/completions
// with `unsupported_api_for_model`. Route them through /responses instead.
function isResponsesOnlyModel(model: string): boolean {
  return /^gpt-5/i.test(model)
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.info("Anthropic request: model=%s thinking=%s output_config=%s",
    anthropicPayload.model,
    JSON.stringify(anthropicPayload.thinking),
    JSON.stringify(anthropicPayload.output_config),
  )

  if (isResponsesOnlyModel(anthropicPayload.model)) {
    return handleViaResponses(c, anthropicPayload)
  }

  // Optional full-payload dump bypassing journald's ~48KB line truncation.
  // Set COPILOT_API_DUMP_PAYLOADS=1 to enable; writes /tmp/copilot-api-payloads.jsonl
  // with one JSON object per request/response. Useful for diagnosing
  // unexpected request shapes. Leave off in production — file grows unbounded.
  if (process.env.COPILOT_API_DUMP_PAYLOADS) {
    const fs = await import("node:fs")
    fs.appendFileSync(
      "/tmp/copilot-api-payloads.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        dir: "in-anthropic",
        body: anthropicPayload,
      }) + "\n",
    )
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.info("Translated OpenAI: model=%s reasoning_effort=%s",
    openAIPayload.model,
    openAIPayload.reasoning_effort ?? "NOT SET",
  )

  if (process.env.COPILOT_API_DUMP_PAYLOADS) {
    const fs = await import("node:fs")
    fs.appendFileSync(
      "/tmp/copilot-api-payloads.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        dir: "out-openai",
        body: openAIPayload,
      }) + "\n",
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// GPT-5.x path: translate Anthropic Messages <-> OpenAI Responses and forward
// to Copilot's /responses endpoint (the only one that serves these models).
async function handleViaResponses(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  const responsesPayload = translateAnthropicToResponses(anthropicPayload)
  consola.info(
    "Routing model=%s via /responses (responses-only model)",
    anthropicPayload.model,
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(responsesPayload)

  if (!(typeof response === "object" && Symbol.asyncIterator in response)) {
    const anthropicResponse = translateResponsesResultToAnthropic(
      response as Record<string, unknown>,
      anthropicPayload.model,
    )
    return c.json(anthropicResponse)
  }

  const responseStream = response as AsyncIterable<{ data?: string }>
  return streamSSE(c, async (stream) => {
    const streamState = newResponsesStreamState()
    for await (const rawEvent of responseStream) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawEvent.data)
      } catch {
        continue
      }
      const events = translateResponsesStreamEvent(
        parsed as Parameters<typeof translateResponsesStreamEvent>[0],
        streamState,
        anthropicPayload.model,
      )
      for (const event of events) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      }
    }
  })
}

