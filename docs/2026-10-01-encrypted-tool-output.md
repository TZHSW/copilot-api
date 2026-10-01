# Encrypted subagent output failure, 2026-10-01

The Codex thread `01a0f756-61c0-7db1-9d9f-03b7ed4b3030` first failed at
12:22:17 UTC after receiving four encrypted messages from
`01a0f767-93e4-7f41-95cf-0a9ac207cfbc`. Copilot returned HTTP 400 with
`invalid_request_body`: `Encrypted function output content could not be
decrypted or decoded.` The proxy was still serving other requests successfully.

Minimal requests to the existing proxy used `gpt-6-astra`, no executable tools,
and a historical `function_call_output`. Plain text and messages 1, 2, and 4
completed with HTTP 200. Message 3 failed twice with the exact error above.
Its ciphertext starts with `UlQC`; the three successful samples start with
`gAAA`. This establishes failure for this ciphertext, not every instance of
either encoding. The exact upstream cryptographic cause remains unknown.

The confirmed failing ciphertext's SHA256 (UTF-8 string bytes) is:

```text
236f877273d442594c386fa46df430abd1e4c212e588703484ff698c31fd5a72
```

The recovery option in `README.md` replaces only explicitly listed ciphertext
blocks with a missing-content notice. It is disabled by default. A request
containing all four messages completed with HTTP 200 after replacing this one
block. The three readable encrypted messages and saved source history remained
unchanged. This is a lossy workaround, not decryption or an upstream fix.

Validation: 22 targeted tests passed, TypeScript checking and targeted ESLint
passed, and the production bundle built successfully. The original deployed
bundle was from commit `334c9a3354320dae805e20cce1dde2e869d9f7ba`, SHA256
`cef853cdeba837faa31a963af0d9d9f003cfda7cfce0a2ce2c77287620033eb1`.
Preparing and validating the patch did not deploy it or restart the service.

Private reproduction evidence is archived under
`ICLR_workspace/output/archive/2026-10-01/copilot-encrypted-tool-output-1222/`.
