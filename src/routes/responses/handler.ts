import type { Context } from "hono"

import consola from "consola"
import { decompress as decompressZstd } from "fzstd"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  proxyResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const RESPONSES_PATH = /^\/(?:v1\/)?responses/
const UNSUPPORTED_OPTIONAL_TOOLS = new Set(["image_generation"])
const textDecoder = new TextDecoder()

export async function decodeResponsesRequestBody(
  request: Request,
): Promise<string> {
  const body = new Uint8Array(await request.arrayBuffer())
  const encodings = (request.headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity")

  if (encodings.length === 0) return textDecoder.decode(body)
  if (encodings.length === 1 && encodings[0] === "zstd") {
    return textDecoder.decode(decompressZstd(body))
  }

  throw new Error(`Unsupported Content-Encoding: ${encodings.join(", ")}`)
}

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
    let rawBody: string
    try {
      rawBody = await decodeResponsesRequestBody(c.req.raw)
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

  // Some Node server adapters expose an already-aborted request signal after
  // the request body has been consumed. Passing that signal to fetch aborts
  // every upstream request immediately; retain cancellation where the adapter
  // provides a live signal and otherwise allow the request to proceed.
  const signal = c.req.raw.signal.aborted ? undefined : c.req.raw.signal
  const response = await proxyResponses(payload, {
    method: c.req.method,
    path,
    search: requestUrl.search,
    signal,
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
