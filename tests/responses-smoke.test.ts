import { test, expect, mock } from "bun:test"

import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((_url: string, _opts: unknown) => ({
  ok: true,
  json: () => ({
    id: "resp_test",
    object: "response",
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hi!" }] },
    ],
  }),
}))
// @ts-expect-error - mock doesn't implement full fetch
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("forwards POST to /responses and returns body as-is", async () => {
  const result = (await createResponses({
    model: "gpt-5.5",
    input: "say hi",
  })) as { object: string; output: Array<unknown> }

  expect(fetchMock).toHaveBeenCalled()
  const url = fetchMock.mock.calls[0][0]
  expect(url.endsWith("/responses")).toBe(true)
  expect(result.object).toBe("response")
  expect(result.output).toHaveLength(1)
})
