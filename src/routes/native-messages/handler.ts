import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { translateModelName } from "~/lib/model-name"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createNativeMessages } from "~/services/copilot/create-native-messages"

/**
 * Native pass-through handler for Anthropic Messages API.
 * Only translates the model name; everything else forwarded as-is.
 * CC can use this by setting ANTHROPIC_BASE_URL to .../v1/native
 */
export async function handleNativeMessages(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<Record<string, unknown>>()

  // Translate model name (hyphen→dot, date suffix strip, [1m] strip)
  if (typeof payload.model === "string") {
    const original = payload.model
    payload.model = translateModelName(original)
    if (payload.model !== original) {
      consola.info("Native: model %s → %s", original, payload.model)
    }
  }

  // Strip fields that Copilot's /v1/messages doesn't accept
  delete payload.context_management
  delete payload.service_tier

  // Strip fields per model capability, each keyed on its OWN capability.
  // Effort knobs (thinking, output_config.effort) go when the model has no
  // reasoning_effort; the json_schema in output_config.format goes when the
  // model doesn't declare structured_outputs. Dropping the whole
  // output_config on the reasoning check alone would take the schema with
  // it and silently degrade structured output to prose.
  //
  // Models that support effort but reject the specific level (e.g. sonnet 4.6
  // doesn't support xhigh) will get Copilot's native 400 error — no clamping.
  if (typeof payload.model === "string") {
    const model = state.models?.data.find((m) => m.id === payload.model)
    const supports = model?.capabilities.supports
    const outputConfig = payload.output_config as
      | Record<string, unknown>
      | undefined

    if (!Array.isArray(supports?.reasoning_effort)) {
      delete payload.thinking
      if (outputConfig) delete outputConfig.effort
    }
    if (supports?.structured_outputs !== true && outputConfig) {
      delete outputConfig.format
    }
    if (outputConfig && Object.keys(outputConfig).length === 0) {
      delete payload.output_config
    }
  }

  consola.info("Native request: model=%s stream=%s",
    payload.model,
    payload.stream ?? false,
  )

  if (state.manualApprove) await awaitApproval()

  // Vision detection for Anthropic format: messages[].content[].type === "image"
  const enableVision =
    Array.isArray(payload.messages)
    && (payload.messages as Array<Record<string, unknown>>).some(
      (msg) =>
        Array.isArray(msg.content)
        && (msg.content as Array<Record<string, unknown>>).some(
          (part) => part.type === "image",
        ),
    )

  const response = await createNativeMessages(payload, enableVision)

  if (isAsyncIterable(response)) {
    consola.debug("Native streaming response")
    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        await stream.writeSSE(chunk as SSEMessage)
      }
    })
  }

  consola.debug("Native non-streaming response")
  return c.json(response)
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value
