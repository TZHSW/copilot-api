import { beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { prepareResponsesPayload } from "../src/routes/responses/handler"
import { server } from "../src/server"
import {
  createResponses,
  hasResponsesVisualInput,
  proxyResponses,
  responsesInitiator,
} from "../src/services/copilot/create-responses"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.manualApprove = false
state.rateLimitSeconds = undefined

let nextResponse = () =>
  Response.json({
    id: "resp_test",
    object: "response",
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hi!" }] },
    ],
  })

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(nextResponse()),
)
;(globalThis as unknown as { fetch: typeof fetch }).fetch =
  fetchMock as unknown as typeof fetch

beforeEach(() => {
  fetchMock.mockClear()
  nextResponse = () =>
    Response.json({
      id: "resp_test",
      object: "response",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hi!" }] },
      ],
    })
})

function fetchInputUrl(input: string | URL | Request | undefined): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input?.url ?? ""
}

test("forwards POST to /responses and returns body as-is", async () => {
  const result = (await createResponses({
    model: "gpt-5.6-sol",
    input: "say hi",
  })) as { object: string; output: Array<unknown> }

  expect(fetchMock).toHaveBeenCalled()
  const url = fetchInputUrl(fetchMock.mock.calls[0]?.[0])
  expect(url.endsWith("/responses")).toBe(true)
  expect(result.object).toBe("response")
  expect(result.output).toHaveLength(1)
})

test.each(["fast", "priority"])(
  "maps the %s service tier to Copilot's internal fast model",
  (serviceTier) => {
    const prepared = prepareResponsesPayload({
      model: "gpt-5.6-sol",
      input: "test",
      service_tier: serviceTier,
    })

    expect(prepared.payload).toEqual({
      model: "gpt-5.6-sol-fast",
      input: "test",
    })
  },
)

test("leaves standard model requests unchanged", () => {
  const withoutTier = {
    model: "gpt-5.6-sol",
    input: "test",
  }
  const defaultTier = {
    ...withoutTier,
    service_tier: "default",
  }

  expect(prepareResponsesPayload(withoutTier).payload).toBe(withoutTier)
  expect(prepareResponsesPayload(defaultTier).payload).toBe(defaultTier)
})

test("removes the service tier from an explicit Copilot fast model", () => {
  const prepared = prepareResponsesPayload({
    model: "gpt-5.6-sol-fast",
    input: "test",
    service_tier: "priority",
  })

  expect(prepared.payload).toEqual({
    model: "gpt-5.6-sol-fast",
    input: "test",
  })
})

test("preserves future tool types while dropping optional image generation", () => {
  const prepared = prepareResponsesPayload({
    model: "gpt-5.6-sol",
    input: "test",
    tools: [
      { type: "function", name: "run" },
      { type: "namespace", name: "workspace" },
      { type: "tool_search" },
      { type: "custom", name: "patch" },
      { type: "shell" },
      { type: "image_generation" },
    ],
  })

  expect(prepared.removedToolTypes).toEqual(["image_generation"])
  expect(
    (prepared.payload.tools as Array<{ type: string }>).map(
      (tool) => tool.type,
    ),
  ).toEqual(["function", "namespace", "tool_search", "custom", "shell"])
})

test("does not hide an explicitly selected image generation tool", () => {
  const prepared = prepareResponsesPayload({
    model: "gpt-5.6-sol",
    input: "draw",
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
  })

  expect(prepared.removedToolTypes).toEqual([])
  expect(prepared.payload.tools).toHaveLength(1)
})

test("detects image and file inputs recursively", () => {
  expect(
    hasResponsesVisualInput([
      { role: "user", content: [{ type: "input_image", image_url: "data:" }] },
    ]),
  ).toBe(true)
  expect(
    hasResponsesVisualInput([
      { role: "user", content: [{ type: "input_file", file_url: "data:" }] },
    ]),
  ).toBe(true)
  expect(hasResponsesVisualInput([{ role: "user", content: "text" }])).toBe(
    false,
  )
})

test("marks tool continuation requests as agent initiated", () => {
  expect(
    responsesInitiator({
      model: "gpt-5.6-sol",
      input: [
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    }),
  ).toBe("agent")
  expect(responsesInitiator({ model: "gpt-5.6-sol", input: "hello" })).toBe(
    "user",
  )
})

test("passes abort signals and multimodal headers upstream", async () => {
  const controller = new AbortController()
  await proxyResponses(
    {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: [{ type: "input_file" }] }],
    },
    { signal: controller.signal },
  )

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(init.signal).toBe(controller.signal)
  expect(
    (init.headers as Record<string, string>)["copilot-vision-request"],
  ).toBe("true")
})

test("preserves SSE bytes and upstream response headers", async () => {
  const body =
    ': heartbeat\n\nevent: response.output_text.delta\ndata: {"delta":"hi"}\n\n'
  nextResponse = () =>
    new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "request-1",
      },
    })

  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "hello",
      stream: true,
    }),
  })

  expect(await response.text()).toBe(body)
  expect(response.headers.get("x-request-id")).toBe("request-1")
})

test("accepts Codex zstd-compressed Responses request bodies", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      { role: "user", content: "remember 1234" },
      { type: "compaction_trigger" },
    ],
    stream: true,
  }
  const body = Bun.zstdCompressSync(
    new TextEncoder().encode(JSON.stringify(payload)),
  )

  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-encoding": "zstd",
      "content-type": "application/json",
    },
    body,
  })

  expect(response.status).toBe(200)
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(JSON.parse(init.body as string)).toEqual(payload)
})

test("does not abort upstream fetches for adapter-aborted request signals", async () => {
  const controller = new AbortController()
  controller.abort()

  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    signal: controller.signal,
  })

  expect(response.status).toBe(200)
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(init.signal).toBeUndefined()
})

test("forwards response subpaths, query parameters, and empty POST bodies", async () => {
  const response = await server.request(
    "http://localhost/v1/responses/resp_1/cancel?beta=true",
    { method: "POST" },
  )

  expect(response.status).toBe(200)
  const [url, init] = fetchMock.mock.calls[0] ?? []
  expect(
    fetchInputUrl(url).endsWith("/responses/resp_1/cancel?beta=true"),
  ).toBe(true)
  expect((init as RequestInit).body).toBeUndefined()
})

test("preserves upstream errors and retry metadata", async () => {
  nextResponse = () =>
    Response.json(
      {
        error: {
          message: "slow down",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      { status: 429, headers: { "retry-after": "3" } },
    )

  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
  })

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("3")
  expect(await response.json()).toEqual({
    error: {
      message: "slow down",
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    },
  })
})

test("returns an OpenAI-shaped error for malformed JSON", async () => {
  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({
    error: {
      message: "Request body must be valid JSON.",
      type: "invalid_request_error",
    },
  })
})
