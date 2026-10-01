import { expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { quarantineToolOutputs } from "../src/routes/responses/quarantine-output"

const ciphertext = "explicitly-confirmed-unreadable-ciphertext"
const fingerprint = createHash("sha256").update(ciphertext).digest("hex")
const encrypted = { type: "encrypted_content", encrypted_content: ciphertext }

test.each(["function_call_output", "custom_tool_call_output", "agent_message"])(
  "quarantines only the approved block in %s and leaves saved input intact",
  (type) => {
    const field = type === "agent_message" ? "content" : "output"
    const clear = { type: "input_text", text: "Keep the readable context." }
    const healthy = { ...encrypted, encrypted_content: "another-ciphertext" }
    const payload = {
      model: "gpt-6-astra",
      input: [
        { type, call_id: "call_1", [field]: [clear, encrypted, healthy] },
      ],
    }
    const before = JSON.stringify(payload)
    const result = quarantineToolOutputs(payload, new Set([fingerprint]))
    const input = result.payload.input as Array<Record<string, unknown>>
    const blocks = input[0][field] as Array<Record<string, unknown>>

    expect(result.quarantined).toEqual([fingerprint])
    expect(blocks[0]).toBe(clear)
    expect(blocks[2]).toBe(healthy)
    expect(blocks[1].type).toBe("input_text")
    expect(blocks[1].text).toContain("contents are unavailable")
    expect(blocks[1].text).toContain(fingerprint)
    expect(JSON.stringify(payload)).toBe(before)
    expect(input[0].call_id).toBe("call_1")
  },
)

test("defaults to exact pass-through and preserves unapproved ciphertext", () => {
  const payload = {
    model: "gpt-6-astra",
    input: [{ type: "function_call_output", output: [encrypted] }],
  }
  for (const fingerprints of [new Set<string>(), new Set(["unmatched"])]) {
    const result = quarantineToolOutputs(payload, fingerprints)
    expect(result.payload).toBe(payload)
    expect(result.quarantined).toEqual([])
  }
})

test("never alters reasoning, compaction, user text, or tool arguments", () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "reasoning", encrypted_content: ciphertext },
      { type: "compaction", encrypted_content: ciphertext },
      { role: "user", content: [encrypted] },
      { type: "function_call", arguments: ciphertext },
      { type: "function_call_output", output: ciphertext },
    ],
  }
  expect(quarantineToolOutputs(payload, new Set([fingerprint])).payload).toBe(
    payload,
  )
})
