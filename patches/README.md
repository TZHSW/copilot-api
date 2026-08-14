# Patches against ericc-ch/copilot-api v0.7.0

These are the 4 commits as `git format-patch` files for review-clarity.
The proxy source tree in this repo ALREADY HAS these applied — you do
NOT need to `git am` them to use the proxy. Just `cd ..` and `npm install
&& npm run build`.

The patches are here for two reasons:
1. **Review**: each one is small and self-contained; reading them is
   the fastest way to understand what we changed vs upstream.
2. **Rebase**: when upstream ships v0.8.0+, these patches give you the
   discrete unit-of-work to replay onto the new base.

The companion narrative for each patch (motivation, evidence,
verification probes) is in `../PATCH_NOTES.md`.

| File | Adds |
|---|---|
| `0001-*.patch` | Patch 1 — Anthropic thinking.budget_tokens → Copilot reasoning_effort (legacy path) |
| `0002-*.patch` | Patch 2 — Copilot reasoning_text → Anthropic thinking content block |
| `0003-*.patch` | Patch 3 — translateModelName for hyphen / `[1m]` forms |
| `0004-*.patch` | Patch 4 — Anthropic adaptive-thinking output_config.effort handling |

To rebase onto a future upstream tag, e.g. v0.8.0:

```bash
git clone https://github.com/ericc-ch/copilot-api.git
cd copilot-api
git checkout v0.8.0
git am /path/to/this/repo/proxy/patches/*.patch
# resolve any conflicts (likely in src/routes/messages/non-stream-translation.ts)
npm install && npm run build
```
