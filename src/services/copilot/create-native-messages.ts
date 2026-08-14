import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Native pass-through to Copilot's /v1/messages endpoint.
 * Only translates the model name; all other fields forwarded as-is.
 */
export const createNativeMessages = async (
  payload: Record<string, unknown>,
  enableVision: boolean,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create native messages", response)
    throw new HTTPError("Failed to create native messages", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as Record<string, unknown>
}
