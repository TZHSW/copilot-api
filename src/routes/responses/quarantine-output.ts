import { createHash } from "node:crypto"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "agent_message",
])

// Explicitly configured ciphertext fingerprints only. Never infer that an
// unfamiliar encryption format is corrupt, or remove encrypted reasoning.
export function quarantineToolOutputs(
  payload: ResponsesPayload,
  fingerprints: ReadonlySet<string>,
): { payload: ResponsesPayload; quarantined: Array<string> } {
  const quarantined: Array<string> = []
  if (fingerprints.size === 0 || !Array.isArray(payload.input)) {
    return { payload, quarantined }
  }

  const input = payload.input.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return item
    const record = item as Record<string, unknown>
    if (typeof record.type !== "string" || !TOOL_OUTPUT_TYPES.has(record.type))
      return item

    const field = record.type === "agent_message" ? "content" : "output"
    const blocks = record[field]
    if (!Array.isArray(blocks)) return item
    const countBefore = quarantined.length
    const output = blocks.map((block: unknown) => {
      if (typeof block !== "object" || block === null) return block
      const content = block as Record<string, unknown>
      if (
        content.type !== "encrypted_content"
        || typeof content.encrypted_content !== "string"
      )
        return block

      const sha256 = createHash("sha256")
        .update(content.encrypted_content)
        .digest("hex")
      if (!fingerprints.has(sha256)) return block

      quarantined.push(sha256)
      return {
        type: "input_text",
        text:
          `[Proxy recovery: one encrypted tool/agent message was quarantined `
          + `by operator configuration after the upstream rejected it. `
          + `Its contents are unavailable; do not infer them. `
          + `The original ciphertext remains in the client's saved history. `
          + `SHA256: ${sha256}.]`,
      }
    })
    return quarantined.length > countBefore ?
        { ...record, [field]: output }
      : item
  })

  return {
    payload: quarantined.length > 0 ? { ...payload, input } : payload,
    quarantined,
  }
}
