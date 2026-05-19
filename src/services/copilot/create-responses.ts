import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// Pass-through proxy. The GitHub Copilot backend natively exposes
// `/responses` (verified against gpt-5.5), so we forward the request body
// as-is and stream the response back. We intentionally use loose typing
// (`Record<string, unknown>`) to avoid coupling to the evolving OpenAI
// Responses schema; the upstream is the source of truth.
export type ResponsesPayload = Record<string, unknown> & {
  model: string
  stream?: boolean | null
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Detect image input parts so we can advertise vision capability upstream.
  // Responses API uses `input: [{ role, content: [{ type: "input_image", ... }] }]`.
  const enableVision =
    Array.isArray(payload.input)
    && (payload.input as Array<unknown>).some(
      (item) =>
        typeof item === "object"
        && item !== null
        && Array.isArray((item as { content?: unknown }).content)
        && (item as { content: Array<unknown> }).content.some(
          (part) =>
            typeof part === "object"
            && part !== null
            && (part as { type?: string }).type === "input_image",
        ),
    )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    // Responses API conversations always originate from the user-facing client.
    "X-Initiator": "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create response", response)
    throw new HTTPError("Failed to create response", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as Record<string, unknown>
}
