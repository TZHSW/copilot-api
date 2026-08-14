// Anthropic Messages <-> OpenAI Responses translation.
//
// Why this exists: Copilot's GPT-5.x models (gpt-5.5, gpt-5.4, ...) are
// **responses-only** — they reject `/chat/completions` with
// `unsupported_api_for_model` and are only reachable on the `/responses`
// endpoint. Claude Code speaks the Anthropic Messages API (`/v1/messages`),
// which our default path translates to `/chat/completions`. For GPT-5.x we
// instead translate Anthropic Messages <-> OpenAI Responses here and route
// through `createResponses()`.
//
// Shapes below were captured live against Copilot's `/responses` (2026-06,
// gpt-5.5-2026-04-23): output items of type `reasoning` (encrypted, no text),
// `message` (content[].output_text), and `function_call` (call_id/name/
// arguments); streaming events `response.output_item.added/done`,
// `response.content_part.added`, `response.output_text.delta`,
// `response.function_call_arguments.delta`, `response.completed`.

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamEventData,
} from "./anthropic-types"

// ─────────────────────────── Request translation ───────────────────────────

function systemToInstructions(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system
    .map((b) => b.text)
    .filter(Boolean)
    .join("\n\n")
}

// Anthropic effort knobs -> Responses `reasoning.effort`.
function reasoningFromPayload(
  payload: AnthropicMessagesPayload,
): { effort: string } | undefined {
  const e = payload.output_config?.effort
  if (e) {
    // Responses supports low|medium|high; clamp xhigh/max -> high.
    const map: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    }
    return { effort: map[e] ?? "medium" }
  }
  if (payload.thinking?.type === "enabled" && payload.thinking.budget_tokens) {
    const b = payload.thinking.budget_tokens
    return { effort: b >= 8000 ? "high" : b >= 2000 ? "medium" : "low" }
  }
  return undefined
}

function mapToolChoice(
  tc: NonNullable<AnthropicMessagesPayload["tool_choice"]>,
): unknown {
  switch (tc.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return { type: "function", name: tc.name }
    }
    default: {
      return "auto"
    }
  }
}

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
): ResponsesPayload {
  const input: Array<Record<string, unknown>> = []

  for (const msg of payload.messages) {
    const role = msg.role
    if (typeof msg.content === "string") {
      input.push({
        role,
        content: [
          {
            type: role === "assistant" ? "output_text" : "input_text",
            text: msg.content,
          },
        ],
      })
      continue
    }

    // Accumulate plain content parts into a message item; flush before any
    // function_call / function_call_output so ordering is preserved.
    let parts: Array<Record<string, unknown>> = []
    // Images returned inside a tool_result can't ride in the text-only
    // `function_call_output.output`; collect them and re-emit as a user message.
    const toolResultImages: Array<Record<string, unknown>> = []
    const flush = () => {
      if (parts.length > 0) {
        input.push({ role, content: parts })
        parts = []
      }
    }

    for (const block of msg.content) {
      switch (block.type) {
        case "text": {
          parts.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: block.text,
          })
          break
        }
        case "image": {
          parts.push({
            type: "input_image",
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          })
          break
        }
        case "tool_use": {
          flush()
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
          break
        }
        case "tool_result": {
          flush()
          let output: string
          if (typeof block.content === "string") {
            output = block.content
          } else {
            const items = Array.isArray(block.content) ? block.content : []
            const texts: Array<string> = []
            let imageCount = 0
            for (const item of items) {
              if (item.type === "text") {
                texts.push(item.text)
              } else if (item.type === "image") {
                imageCount++
                toolResultImages.push({
                  type: "input_image",
                  image_url: `data:${item.source.media_type};base64,${item.source.data}`,
                })
              }
            }
            output =
              texts.length > 0 ? texts.join("\n")
              : imageCount > 0 ? "[image returned by tool — see attached image below]"
              : JSON.stringify(block.content)
          }
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output,
          })
          break
        }
        default: {
          break
        }
      }
    }
    flush()
    if (toolResultImages.length > 0) {
      input.push({ role: "user", content: toolResultImages })
    }
  }

  const out: ResponsesPayload = {
    model: payload.model,
    input,
    max_output_tokens: payload.max_tokens,
    stream: payload.stream ?? false,
  }

  const instructions = systemToInstructions(payload.system)
  if (instructions) out.instructions = instructions

  const reasoning = reasoningFromPayload(payload)
  if (reasoning) out.reasoning = reasoning

  if (payload.tools && payload.tools.length > 0) {
    out.tools = payload.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }))
  }
  if (payload.tool_choice) out.tool_choice = mapToolChoice(payload.tool_choice)
  if (payload.temperature !== undefined) out.temperature = payload.temperature
  if (payload.top_p !== undefined) out.top_p = payload.top_p

  return out
}

// ─────────────────────── Non-stream response translation ───────────────────

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

interface ResponsesOutputItem {
  type: string
  content?: Array<{ type: string; text?: string }>
  // function_call fields
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesResult {
  id?: string
  model?: string
  status?: string
  output?: Array<ResponsesOutputItem>
  usage?: ResponsesUsage
  incomplete_details?: { reason?: string } | null
}

function synthMessageId(): string {
  // Anthropic clients only use this for logging/correlation.
  return `msg_${Date.now().toString(36)}`
}

export function translateResponsesResultToAnthropic(
  raw: Record<string, unknown>,
  requestedModel: string,
): AnthropicResponse {
  const result = raw as unknown as ResponsesResult
  const content: Array<AnthropicAssistantContentBlock> = []
  let hasToolUse = false

  for (const item of result.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({ type: "text", text: part.text })
        }
      }
    } else if (item.type === "function_call") {
      hasToolUse = true
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(item.arguments || "{}") as Record<string, unknown>
      } catch {
        parsed = {}
      }
      content.push({
        type: "tool_use",
        id: item.call_id ?? synthMessageId(),
        name: item.name ?? "",
        input: parsed,
      })
    }
    // `reasoning` items carry no client-visible text (encrypted) — skip.
  }

  const usage = result.usage ?? {}
  const cached = usage.input_tokens_details?.cached_tokens
  const maxedOut = result.incomplete_details?.reason === "max_output_tokens"

  return {
    id: result.id && result.id.length < 64 ? result.id : synthMessageId(),
    type: "message",
    role: "assistant",
    content,
    model: requestedModel,
    stop_reason: maxedOut ? "max_tokens" : hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      ...(cached !== undefined && { cache_read_input_tokens: cached }),
    },
  }
}

// ─────────────────────────── Stream translation ────────────────────────────

export interface ResponsesStreamState {
  messageStartSent: boolean
  nextIndex: number
  // Responses output_index -> Anthropic content block index.
  items: Record<number, number>
  hadToolCall: boolean
  maxedOut: boolean
}

export function newResponsesStreamState(): ResponsesStreamState {
  return {
    messageStartSent: false,
    nextIndex: 0,
    items: {},
    hadToolCall: false,
    maxedOut: false,
  }
}

interface ResponsesStreamEvent {
  type?: string
  output_index?: number
  item?: ResponsesOutputItem
  part?: { type?: string }
  delta?: string
  response?: ResponsesResult & { status?: string }
}

export function translateResponsesStreamEvent(
  event: ResponsesStreamEvent,
  state: ResponsesStreamState,
  requestedModel: string,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  const ensureStart = (id: string) => {
    if (state.messageStartSent) return
    events.push({
      type: "message_start",
      message: {
        id: id || synthMessageId(),
        type: "message",
        role: "assistant",
        content: [],
        model: requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    state.messageStartSent = true
  }

  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      ensureStart(event.response?.id ?? "")
      break
    }

    case "response.output_item.added": {
      // Only function_call items open a block here; message text blocks open
      // on `response.content_part.added`. reasoning items are skipped.
      if (event.item?.type === "function_call" && event.output_index != null) {
        ensureStart("")
        const idx = state.nextIndex++
        state.items[event.output_index] = idx
        state.hadToolCall = true
        events.push({
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "tool_use",
            id: event.item.call_id ?? synthMessageId(),
            name: event.item.name ?? "",
            input: {},
          },
        })
      }
      break
    }

    case "response.content_part.added": {
      if (event.part?.type === "output_text" && event.output_index != null) {
        ensureStart("")
        if (state.items[event.output_index] === undefined) {
          const idx = state.nextIndex++
          state.items[event.output_index] = idx
          events.push({
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          })
        }
      }
      break
    }

    case "response.output_text.delta": {
      if (event.output_index != null && event.delta) {
        const idx = state.items[event.output_index]
        if (idx !== undefined) {
          events.push({
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: event.delta },
          })
        }
      }
      break
    }

    case "response.function_call_arguments.delta": {
      if (event.output_index != null && event.delta) {
        const idx = state.items[event.output_index]
        if (idx !== undefined) {
          events.push({
            type: "content_block_delta",
            index: idx,
            delta: { type: "input_json_delta", partial_json: event.delta },
          })
        }
      }
      break
    }

    case "response.output_item.done": {
      if (event.output_index != null) {
        const idx = state.items[event.output_index]
        if (idx !== undefined) {
          events.push({ type: "content_block_stop", index: idx })
        }
      }
      break
    }

    case "response.completed":
    case "response.incomplete": {
      const incomplete =
        event.type === "response.incomplete"
        || event.response?.incomplete_details?.reason === "max_output_tokens"
      const usage = event.response?.usage ?? {}
      const cached = usage.input_tokens_details?.cached_tokens
      events.push(
        {
          type: "message_delta",
          delta: {
            stop_reason: incomplete
              ? "max_tokens"
              : state.hadToolCall
                ? "tool_use"
                : "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            ...(cached !== undefined && { cache_read_input_tokens: cached }),
          },
        },
        { type: "message_stop" },
      )
      break
    }

    case "response.failed":
    case "error": {
      events.push({
        type: "error",
        error: { type: "api_error", message: "Responses stream failed." },
      })
      break
    }

    default: {
      break
    }
  }

  return events
}
