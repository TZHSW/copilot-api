import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  proxyResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const RESPONSES_PATH = /^\/(?:v1\/)?responses/
const UNSUPPORTED_OPTIONAL_TOOLS = new Set(["image_generation"])

export function prepareResponsesPayload(payload: ResponsesPayload): {
  payload: ResponsesPayload
  removedToolTypes: Array<string>
} {
  if (!Array.isArray(payload.tools)) {
    return { payload, removedToolTypes: [] }
  }

  const toolChoice = payload.tool_choice
  const explicitlySelectedType =
    (
      typeof toolChoice === "object"
      && toolChoice !== null
      && typeof (toolChoice as { type?: unknown }).type === "string"
    ) ?
      (toolChoice as { type: string }).type
    : undefined
  const removedToolTypes: Array<string> = []
  const tools = (payload.tools as Array<unknown>).filter((tool) => {
    if (typeof tool !== "object" || tool === null) return true
    const type = (tool as { type?: unknown }).type
    if (typeof type !== "string") return true
    if (
      !UNSUPPORTED_OPTIONAL_TOOLS.has(type)
      || explicitlySelectedType === type
    ) {
      return true
    }
    removedToolTypes.push(type)
    return false
  })

  return {
    payload: { ...payload, tools },
    removedToolTypes,
  }
}

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const requestUrl = new URL(c.req.url)
  const suffix = requestUrl.pathname.replace(RESPONSES_PATH, "")
  const path = `/responses${suffix}`
  const hasBody = !["DELETE", "GET", "HEAD"].includes(c.req.method)
  let payload: ResponsesPayload | undefined

  if (hasBody) {
    const rawBody = await c.req.text()
    if (rawBody.trim()) {
      try {
        payload = JSON.parse(rawBody) as ResponsesPayload
      } catch {
        return c.json(
          {
            error: {
              message: "Request body must be valid JSON.",
              type: "invalid_request_error",
            },
          },
          400,
        )
      }

      const prepared = prepareResponsesPayload(payload)
      payload = prepared.payload
      if (prepared.removedToolTypes.length > 0) {
        consola.debug(
          `Filtered optional Copilot-incompatible tools: ${prepared.removedToolTypes.join(", ")}`,
        )
      }
    }
  }

  if (state.manualApprove) await awaitApproval()

  const response = await proxyResponses(payload, {
    method: c.req.method,
    path,
    search: requestUrl.search,
    signal: c.req.raw.signal,
  })
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
