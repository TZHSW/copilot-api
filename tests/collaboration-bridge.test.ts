import { expect, test } from "bun:test"

import {
  bridgeCollaborationRequest,
  bridgeCollaborationStream,
  COLLABORATION_ALIAS,
  restoreCollaborationResponse,
} from "../src/routes/responses/collaboration-bridge"

function namespace() {
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      ...["spawn_agent", "send_message", "followup_task"].map((name) => ({
        type: "function",
        name,
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      })),
      { type: "function", name: "list_agents", parameters: { type: "object" } },
    ],
  }
}

test.each(["standard", "lite"])(
  "bridges %s definitions and replay without changing saved input",
  (mode) => {
    const tool = namespace()
    const history = {
      type: "function_call",
      namespace: "collaboration",
      name: "send_message",
      arguments: '{"message":"keep"}',
      call_id: "call_1",
    }
    const payload = {
      model: "gpt-6-astra",
      ...(mode === "standard" ? { tools: [tool] } : {}),
      input: [
        ...(mode === "lite" ?
          [{ type: "additional_tools", role: "developer", tools: [tool] }]
        : []),
        history,
      ],
      tool_choice: {
        type: "function",
        namespace: "collaboration",
        name: "send_message",
      },
    }
    const snapshot = JSON.stringify(payload)
    const result = bridgeCollaborationRequest(payload)
    expect(result.active).toBe(true)
    expect(JSON.stringify(result.payload)).toContain(COLLABORATION_ALIAS)
    expect(JSON.stringify(result.payload)).not.toContain('"encrypted":true')
    expect(JSON.stringify(result.payload)).toContain('"encrypted":false')
    expect(JSON.stringify(payload)).toBe(snapshot)
    expect(result.payload.tool_choice).toEqual({
      type: "function",
      namespace: COLLABORATION_ALIAS,
      name: "send_message",
    })
    expect((result.payload.input as Array<unknown>).at(-1)).toEqual({
      ...history,
      namespace: COLLABORATION_ALIAS,
    })
  },
)

test("does not change ordinary tools, reasoning or absent collaboration definitions", () => {
  const payload = {
    model: "gpt-6-astra",
    tools: [{ type: "function", name: "send_message" }],
    input: [{ type: "reasoning", encrypted_content: "opaque" }],
  }
  expect(bridgeCollaborationRequest(payload)).toEqual({
    payload,
    active: false,
  })
  expect(bridgeCollaborationRequest(payload).payload).toBe(payload)
})

test("rejects an alias collision instead of rerouting a client tool", () => {
  expect(() =>
    bridgeCollaborationRequest({
      model: "test",
      tools: [
        namespace(),
        { type: "namespace", name: COLLABORATION_ALIAS, tools: [] },
      ],
    }),
  ).toThrow("conflicts")
})

test("returns explicit plaintext metadata only for bridged message tools", () => {
  const call = {
    type: "function_call",
    namespace: COLLABORATION_ALIAS,
    name: "send_message",
    arguments: '{"message":"中文 progress"}',
    call_id: "call_1",
  }
  const expected = {
    ...call,
    namespace: "collaboration",
    encrypted_function_args: [],
  }
  expect(restoreCollaborationResponse(call)).toEqual(expected)
  expect(
    restoreCollaborationResponse({
      type: "response.output_item.done",
      item: call,
    }),
  ).toEqual({ type: "response.output_item.done", item: expected })
  expect(
    restoreCollaborationResponse({
      type: "response.completed",
      response: { output: [call] },
    }),
  ).toEqual({ type: "response.completed", response: { output: [expected] } })
  expect(
    restoreCollaborationResponse({ ...call, name: "list_agents" }),
  ).toEqual({ ...call, name: "list_agents", namespace: "collaboration" })
  expect(
    restoreCollaborationResponse({ ...call, namespace: "unrelated" }),
  ).toEqual({ ...call, namespace: "unrelated" })
  expect(() =>
    restoreCollaborationResponse({
      ...call,
      encrypted_function_args: ["message"],
    }),
  ).toThrow("encrypted arguments")
})

test("streaming handles split UTF-8, CRLF, deltas, completion, comments and cancellation", async () => {
  const delta =
    'event: response.function_call_arguments.delta\r\ndata: {"type":"response.function_call_arguments.delta","delta":"中文"}\r\n\r\n'
  const done = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      namespace: COLLABORATION_ALIAS,
      name: "send_message",
      arguments: '{"message":"中文"}',
    },
  }
  const source =
    ": ping\r\n\r\n"
    + delta
    + "id: 7\r\nevent: response.output_item.done\r\ndata: "
    + JSON.stringify(done)
    + "\r\n\r\ndata: [DONE]\r\n\r\n"
  const bytes = new TextEncoder().encode(source)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  const output = await new Response(bridgeCollaborationStream(stream)).text()
  expect(output).toContain(delta)
  expect(output).toContain(": ping\r\n\r\n")
  expect(output).toContain("id: 7\r\n")
  expect(output).toContain('"namespace":"collaboration"')
  expect(output).toContain('"encrypted_function_args":[]')
  expect(output).toEndWith("data: [DONE]\r\n\r\n")
  let cancelled = false
  const pending = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  await bridgeCollaborationStream(pending).cancel()
  await Bun.sleep(0)
  expect(cancelled).toBe(true)
})
