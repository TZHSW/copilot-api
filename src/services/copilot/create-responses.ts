import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// Pass-through proxy. The GitHub Copilot backend natively exposes
// `/responses` (verified against gpt-5.6-sol), so we forward the request body
// as-is and stream the response back. We intentionally use loose typing
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

  return await fetch(`${copilotBaseUrl(state)}${path}${search}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: options.signal,
  })
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
