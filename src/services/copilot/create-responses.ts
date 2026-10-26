import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// Pass-through proxy. The GitHub Copilot backend natively exposes
// `/responses` (verified against gpt-5.6-sol), so we forward the request body
// as-is and stream the response back, except for one compatibility retry when
// the backend explicitly rejects Codex's private content item metadata.
// We intentionally use loose typing
// (`Record<string, unknown>`) to avoid coupling to the evolving OpenAI
// Responses schema; the upstream is the source of truth.
export type ResponsesPayload = Record<string, unknown> & {
  model: string
  stream?: boolean | null
}

interface ResponsesRequestOptions {
  method?: string
  path?: string
  search?: string
  signal?: AbortSignal
}

const CONTENT_METADATA_ERROR =
  /^Unknown parameter: 'input\[(\d+)\]\.internal_chat_message_metadata_passthrough\.content_item_metadata'\.$/

function withoutRejectedContentMetadata(
  payload: ResponsesPayload,
  body: unknown,
): { payload: ResponsesPayload; removedItems: number } | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return
  const error = body.error
  if (typeof error !== "object" || error === null) return
  const { code, message } = error as Record<string, unknown>
  if (code !== "invalid_request_body" || typeof message !== "string") return
  const match = CONTENT_METADATA_ERROR.exec(message)
  if (!match || !Array.isArray(payload.input)) return

  const removedIndices: Array<number> = []
  const input = payload.input.map((value: unknown, index: number) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value
    const item = value as Record<string, unknown>
    const metadata = item.internal_chat_message_metadata_passthrough
    if (
      typeof metadata !== "object"
      || metadata === null
      || Array.isArray(metadata)
      || !Object.hasOwn(metadata, "content_item_metadata")
    )
      return value
    const { content_item_metadata: _removed, ...retained } = metadata as Record<
      string,
      unknown
    >
    removedIndices.push(index)
    return { ...item, internal_chat_message_metadata_passthrough: retained }
  })
  if (!removedIndices.includes(Number(match[1]))) return
  return {
    payload: { ...payload, input },
    removedItems: removedIndices.length,
  }
}

export function hasResponsesVisualInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasResponsesVisualInput(item))
  }
  if (typeof value !== "object" || value === null) return false

  const item = value as Record<string, unknown>
  if (item.type === "input_image" || item.type === "input_file") return true

  return Object.values(item).some((child) => hasResponsesVisualInput(child))
}

export function responsesInitiator(
  payload: ResponsesPayload,
): "agent" | "user" {
  if (!Array.isArray(payload.input)) return "user"

  const isAgentItem = payload.input.some((item) => {
    if (typeof item !== "object" || item === null) return false
    const inputItem = item as { role?: unknown; type?: unknown }
    return (
      inputItem.role === "assistant"
      || inputItem.role === "tool"
      || inputItem.type === "function_call"
      || inputItem.type === "function_call_output"
      || inputItem.type === "custom_tool_call"
      || inputItem.type === "custom_tool_call_output"
    )
  })

  return isAgentItem ? "agent" : "user"
}

export const proxyResponses = async (
  payload: ResponsesPayload | undefined,
  options: ResponsesRequestOptions = {},
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = hasResponsesVisualInput(payload?.input)
  const method = options.method ?? "POST"
  const path = options.path ?? "/responses"
  const search = options.search ?? ""

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": payload ? responsesInitiator(payload) : "user",
  }

  const forward = (body: ResponsesPayload | undefined) =>
    fetch(`${copilotBaseUrl(state)}${path}${search}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    })
  const response = await forward(payload)
  if (response.status !== 400 || !payload || !Array.isArray(payload.input))
    return response

  let body: unknown
  try {
    body = await response.clone().json()
  } catch (error) {
    if (error instanceof SyntaxError) return response
    throw error
  }
  const retry = withoutRejectedContentMetadata(payload, body)
  if (!retry) return response

  consola.warn(
    `Retrying Copilot Responses without rejected content_item_metadata on ${retry.removedItems} input item(s)`,
  )
  await response.body?.cancel()
  return await forward(retry.payload)
}

export const createResponses = async (
  payload: ResponsesPayload,
  signal?: AbortSignal,
) => {
  const response = await proxyResponses(payload, { signal })

  if (!response.ok) {
    consola.error("Failed to create response", response)
    throw new HTTPError("Failed to create response", response)
  }

  if (payload.stream) {
    return events(response, signal)
  }

  return (await response.json()) as Record<string, unknown>
}
