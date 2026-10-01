# Codex collaboration encryption on Copilot: cause and prevention

## Evidence

The manager thread failed again at 14:19:48 UTC with the encrypted function
output error. The proxy process and first fingerprint quarantine remained
healthy. There were no new encrypted agent messages in that thread: messages
1, 2, and 4 from 12:19–12:22, which had completed successfully in earlier
probes, now all returned HTTP 400. Plain text and the already-quarantined third
message still worked. A direct upstream request also reproduced this new
failure, without the local proxy.

The three previously readable tokens contain Fernet timestamps matching their
creation times. This establishes time-varying decryptability; it does not prove
a particular TTL or key-rotation interval. The first failed token used a
different envelope and failed immediately. The exact upstream cryptographic
policy is not observable here.

## Protocol mismatch

Codex marks the `message` argument of multi-agent v2 `spawn_agent`,
`send_message`, and `followup_task` as encrypted. On replay, the receiving
agent carries that message as an `encrypted_content` block and depends on the
provider to decrypt it again. The client has no plaintext copy on that path.

The inspected upstream Codex source at
`ecc78e4cf5607ecf5f080d682eae0ecb650868ae` provides the relevant behavior:

- [Message schemas](https://github.com/openai/codex/blob/ecc78e4cf5607ecf5f080d682eae0ecb650868ae/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
  use `.with_encrypted()` on the three message fields.
- [Tool routing](https://github.com/openai/codex/blob/ecc78e4cf5607ecf5f080d682eae0ecb650868ae/codex-rs/core/src/tools/router.rs)
  requires an explicit empty `encrypted_function_args` list for the plaintext
  branch; simply returning a normal string without this marker is insufficient.
- [Client integration tests](https://github.com/openai/codex/blob/ecc78e4cf5607ecf5f080d682eae0ecb650868ae/codex-rs/core/tests/suite/subagent_notifications.rs)
  cover both encrypted and plaintext agent-message delivery.

Live `gpt-6-astra` comparisons established:

| Tool definition | Result |
| --- | --- |
| `collaboration.send_message`, `encrypted: true` | 200; opaque ciphertext argument |
| Same name, `encrypted: false` | 400; reserved tool must match configured schema |
| Same name, encryption field omitted | Same reserved-schema rejection |
| Ordinary namespace, `encrypted: false` | 200; exact readable message argument |

Thus the local integration was using an upstream-reserved encrypted
communication protocol whose historical ciphertext replay is unreliable on
this route. Although the proxy did not corrupt the bytes, pass-through alone
did not provide durable compatibility. Repeatedly quarantining messages only
treats the saved-history symptom.

## Prevention

With `COPILOT_PLAINTEXT_COLLABORATION=true`, the proxy maps the collaboration
namespace to an ordinary upstream namespace, advertises normal message text,
and restores Codex's namespace and explicit plaintext marker on returned calls.
The client then stores and relays the original text without depending on a
provider-held message encryption key. Reasoning and compaction are unchanged.

Tests cover both tool-definition locations, history replay, namespace collision
rejection, plaintext markers, unexpected encrypted responses, split UTF-8 SSE,
CRLF events, untouched deltas and comments, and stream cancellation. Live JSON
and Responses Lite SSE calls returned the exact test message with the required
marker, and subsequent history replay returned the exact original message.
No diagnostic tool call was actually executed and no test subagent was started.

Four old failing message fingerprints remain explicitly quarantined for the
manager's existing history. This is separate from preventing new ciphertext.
Private evidence and runtime deployment records are under
`ICLR_workspace/output/archive/2026-10-01/copilot-encrypted-tool-output-1222/recurrence-1419/`.

## Deployment result

Commit `4197a4f` was deployed with the plaintext bridge enabled. All 28 targeted
tests, TypeScript checking, ESLint, and the build passed. Production JSON and
Responses Lite SSE calls returned plaintext arguments with the client marker;
both subsequent replay requests retained the exact message. At 14:32:25 UTC
the manager's original session received HTTP 200 with both the plaintext-bridge
header and a quarantine count of four, then replied successfully. No cleanup
or other work was started during that verification.
