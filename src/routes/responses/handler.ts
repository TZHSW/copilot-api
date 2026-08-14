import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()

  // Strip tools the Copilot Responses backend does not support
  // (e.g. Codex CLI injects `image_generation` by default).
  // Allowlist what we know Copilot accepts: function, mcp, web_search.
  if (Array.isArray(payload.tools)) {
    const allowed = new Set(["function", "mcp", "web_search"])
    const before = payload.tools.length
    payload.tools = (payload.tools as Array<{ type?: string }>).filter((t) =>
      allowed.has(t.type ?? ""),
    )
    if (payload.tools.length !== before) {
      consola.debug(
        `Filtered ${before - payload.tools.length} unsupported tool(s)`,
      )
    }
  }

  consola.debug("Responses payload:", JSON.stringify(payload).slice(-400))

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(payload)

  if (isAsyncIterable(response)) {
    consola.debug("Streaming response")
    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        await stream.writeSSE(chunk as SSEMessage)
      }
    })
  }

  consola.debug("Non-streaming response")
  return c.json(response)
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value
