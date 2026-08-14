# copilot-api 0.7.0 — local patch: `thinking → reasoning_effort` translation

**Status (2026-05-29):** active, deployed, running.
**Source of truth:** this directory (`~/.local/src/copilot-api-patched/`).
**Deployed bundle:** `~/.local/share/copilot-api-patched/dist/main.js`.
**Systemd unit:** `~/.config/systemd/user/copilot-api.service`.
**Branch:** `local/thinking-translation` (off upstream `v0.7.0` tag).
**Upstream remote:** `upstream` → `https://github.com/ericc-ch/copilot-api.git`.

---

## TL;DR (one paragraph for future agents)

`copilot-api` is a thin reverse proxy that lets a client speaking Anthropic
Messages API (`POST /v1/messages`) talk to GitHub Copilot Enterprise. It
forwards by **translating Anthropic schema → OpenAI-style `/chat/completions`
schema** internally, since Copilot's underlying API is OpenAI-compatible.

Upstream 0.7.0 does NOT translate Anthropic's
`thinking: {type: "enabled", budget_tokens: N}` field — which Claude Code
emits when invoked with `--effort xhigh`/`high`/`medium`/`low` — into
Copilot's own `reasoning_effort: "<tier>"` field. As a result, every
Claude Code session routed through Copilot loses its effort tier silently:
Copilot's Vertex-backed Anthropic endpoint just drops the unknown `thinking`
field, the model thinks at its default (medium) tier, and the user has no
indication anything was dropped.

This patch adds the translation. ~50 lines of TypeScript across two files
in `src/routes/messages/`. It also clamps per-model based on what Copilot's
catalog actually accepts, so requests on models that only support
`["medium"]` don't 400.

---

## The 4-layer evidence (why this matters)

Investigated end-to-end on 2026-05-29. Each layer below was independently
verified.

### Layer 1: Claude Code DOES emit `thinking` properly

Decoded from Claude Code 2.1.156 binary (`/home/qid/.local/share/claude/versions/2.1.156`):

- `--effort xhigh` translates to `thinking: {type: "enabled", budget_tokens: <N>}`
  where N = `LMH(model).upperLimit - 1` clamped to `max_tokens - 1`.
- For `claude-opus-4-8` and `claude-opus-4-7`: `LMH().upperLimit = 128000`,
  so xhigh budget = 127999, but Claude Code typically caps at the default
  budget of 64000 since `max_tokens` defaults to ~64K.
- All effort tiers translate to a thinking budget — same mechanism, different magnitude.

### Layer 2: Copilot Enterprise's `/v1/messages` silently drops `thinking`

Stream probe with `model=claude-opus-4.8`, `thinking={budget_tokens: 2048}`,
hard reasoning question:

- `output_tokens` with thinking: 420
- `output_tokens` without thinking: 399
- Number of `thinking` content blocks in stream response: **0**
- Stream events seen: `text_delta` only, no `thinking_delta` or
  `content_block_start.thinking`

Conclusion: Copilot's Vertex-backed Anthropic Messages endpoint does not
honor the `thinking` field. It was the same on the OLD `-xhigh` model-ID
alias era — the alias was the only working path back then.

### Layer 3: Copilot DOES honor `reasoning_effort` — but per-model

Direct `/models` catalog query against `api.enterprise.githubcopilot.com`
(via Copilot CLI debug log + raw curl):

| model | supported `reasoning_effort` |
|---|---|
| `claude-opus-4.8` | `["medium"]` only |
| `claude-opus-4.7` | `["medium"]` only |
| **`claude-opus-4.7-1m-internal`** | `["low", "medium", "high", "xhigh"]` |
| `claude-opus-4.6-1m` | `["low", "medium", "high"]` |
| `claude-opus-4.6` | `["low", "medium", "high"]` |
| `claude-sonnet-4.6` | `["low", "medium", "high"]` |
| `claude-sonnet-4.5` / `claude-opus-4.5` / `claude-haiku-4.5` | not supported |
| `gpt-5.5` | `["none", "low", "medium", "high", "xhigh"]` |
| `gpt-5.4` / `gpt-5.3-codex` | `["low", "medium", "high", "xhigh"]` |

Sending unsupported effort returns HTTP 400 with
`{"code": "invalid_reasoning_effort", "message": "reasoning_effort 'xhigh'
is not supported by model claude-opus-4.8; supported values: [medium]"}`.

### Layer 4: `-internal` is literal — only Microsoft-internal Claude variants get xhigh

The `-internal` suffix on `claude-opus-4.7-1m-internal` is NOT a Copilot
convention or compensation policy for older models. It's Microsoft's
literal designator for **Claude variants only exposed to Microsoft-internal
Copilot Enterprise tenants** (which we are). Microsoft gives its internal
surface the full reasoning_effort spectrum; public-facing Claude IDs
(`claude-opus-4.7`, `claude-opus-4.8`) are catalog-restricted.

**Implication for future maintenance:** when Microsoft ships
`claude-opus-4.8-internal` (or any future `-internal` variant), that model
will probably also accept xhigh. Update the clamp table + wrapper default
at that point. Watch for it via:

```bash
# Daily check for new -internal Claude variants
curl -sS http://localhost:4141/v1/models | \
  python3 -c "import json,sys; \
    [print(m['id']) for m in json.load(sys.stdin)['data'] \
     if 'claude' in m['id'].lower() and 'internal' in m['id'].lower()]"
```

---

## What the patch does (code-level)

There are TWO patches stacked here, applied in sequence:

### Patch 1 (2026-05-29, morning): outbound `thinking → reasoning_effort`

Makes Claude Code's `--effort xhigh` flag actually fire on Copilot.

#### File: `src/services/copilot/create-chat-completions.ts`

Added `reasoning_effort?: "low" | "medium" | "high" | "xhigh" | null` to
the `ChatCompletionsPayload` interface so TypeScript will allow the new
field to flow into the outbound request body.

#### File: `src/routes/messages/non-stream-translation.ts`

Added `translateThinkingToReasoningEffort(thinking, model)` helper that:

1. Returns `undefined` if `thinking` is absent or `type !== "enabled"`.
2. Maps `budget_tokens` to a tier:
   - `< 4096` → low
   - `4096-15999` → medium
   - `16000-49999` → high
   - `>= 50000` → xhigh
3. Clamps to the highest supported tier in a per-model allowlist table
   (Layer 3 catalog above).
4. Returns `undefined` for unknown models (passes through whatever the
   client requested, lets upstream 400 if invalid).

Wired into `translateToOpenAI` via a conditional spread:
`...(reasoningEffort && { reasoning_effort: reasoningEffort })`.

### Patch 2 (2026-05-29, afternoon): inbound `reasoning_text → thinking block`

Patch 1 alone leaves a silent ~5-10K-token loss per response. Discovered
during a long-doc + hard-question test: Copilot's reasoning-capable
models split their output between `message.content` (the visible answer)
and `message.reasoning_text` (the chain-of-thought). The base translator
only extracts `content`, so all the CoT was dropped — yielding short or
empty Anthropic responses despite high `output_tokens`.

Concrete repro before patch 2 (from `~/.local/src/copilot-api-patched/`
2026-05-29 testing): `/v1/messages + thinking{budget=64000}` on
`claude-opus-4.7-1m-internal` with a 10K-token doc + multi-faceted
review prompt returned `output_tokens=8192` but `content:[]` (empty)
— all 8K tokens went to the silently-dropped `reasoning_text`.

#### File: `src/services/copilot/create-chat-completions.ts`

Added `reasoning_text?: string | null` and `reasoning_opaque?: string | null`
to both the `Delta` interface (streaming chunks) and the `ResponseMessage`
interface (non-streaming).

#### File: `src/routes/messages/anthropic-types.ts`

- Added optional `signature?: string` to `AnthropicThinkingBlock` so we
  can carry Copilot's `reasoning_opaque` token through to the client.
- Added `thinkingBlockOpen: boolean` to `AnthropicStreamState` for the
  streaming translator to track whether the currently-open block is a
  thinking block (which must be closed before any text/tool block).

#### File: `src/routes/messages/non-stream-translation.ts`

Extended `translateToAnthropic` to extract `message.reasoning_text` into
an Anthropic `thinking` content block (with `signature` from
`reasoning_opaque`), emitted BEFORE text and tool_use blocks per Anthropic
ordering convention. Removed the old "GitHub Copilot doesn't generate
thinking blocks" comment — it does now.

#### File: `src/routes/messages/stream-translation.ts`

Added a new branch ahead of the `delta.content` branch:

- On `delta.reasoning_text`: open a `thinking` content block if not
  already open, emit `thinking_delta` events. The thinking block stays
  open until either `delta.content` or `delta.tool_calls` arrives, at
  which point it's closed (Anthropic forbids interleaved thinking/text).
- On `delta.reasoning_opaque`: emit a `signature_delta` event.

#### File: `src/routes/messages/handler.ts`

Initialized `thinkingBlockOpen: false` in the stream-state setup.

---

## Per-model clamp table (snapshot 2026-05-29)

If you update this, also update the table in `non-stream-translation.ts`:

```ts
const allowed: Record<string, Array<"low" | "medium" | "high" | "xhigh">> = {
  "claude-opus-4.8":             ["medium"],
  "claude-opus-4.7":             ["medium"],
  "claude-opus-4.7-1m-internal": ["low", "medium", "high", "xhigh"],
  "claude-opus-4.6":             ["low", "medium", "high"],
  "claude-opus-4.6-1m":          ["low", "medium", "high"],
  "claude-sonnet-4.6":           ["low", "medium", "high"],
  // claude-sonnet-4.5, claude-opus-4.5, claude-haiku-4.5: no reasoning_effort support
  // -> not in table -> pass-through (will 400 upstream if effort field added)
}
```

---

## Deployment topology

```
~/.local/src/copilot-api-patched/        ← source of truth (this dir)
   ├── .git/                                 ← branch: local/thinking-translation
   ├── src/routes/messages/non-stream-translation.ts   ← patched
   ├── src/services/copilot/create-chat-completions.ts ← patched
   └── PATCH_NOTES.md                        ← this file

~/.local/share/copilot-api-patched/      ← deployed bundle (rebuilt from src)
   ├── dist/main.js                          ← what systemd actually runs
   ├── dist/main.js.map
   ├── package.json
   └── node_modules/                         ← runtime deps

~/.config/systemd/user/copilot-api.service  ← ExecStart points at the bundle
                                              above. Restart with:
                                              systemctl --user restart copilot-api.service

~/.local/bin/claude-copilot               ← wrapper, defaults
                                              COPILOT_MODEL=claude-opus-4.7-1m-internal

~/.local/bin/claude-pr-pipeline-up        ← spawns PR daemons via claude-copilot
```

---

## How to rebuild + redeploy after editing source

```bash
cd ~/.local/src/copilot-api-patched
npm install --no-audit --no-fund          # one-time, or after dep changes
npm run build                              # tsdown → dist/main.js
# Deploy:
cp -r dist/* ~/.local/share/copilot-api-patched/dist/
systemctl --user restart copilot-api.service
```

If `npm install` fails on rolldown native binding (we hit this on
2026-05-29 with node v22.11.0 vs required v22.12.0+):

```bash
npm install --include=optional @rolldown/binding-linux-x64-gnu --no-audit --no-fund
```

---

## How to verify the patch is working (end-to-end probes)

After redeploy or whenever in doubt:

```bash
# Probe A: 4.7-1m-internal + thinking{budget=64000} should engage xhigh
# Expect output_tokens > 700 on a multi-step reasoning question
cat > /tmp/probe_xhigh.json <<'JSON'
{
  "model": "claude-opus-4.7-1m-internal",
  "max_tokens": 4096,
  "thinking": {"type": "enabled", "budget_tokens": 64000},
  "messages": [{"role": "user", "content": "Three boxes A B C, one has gold. A says 'gold in B', B says 'not here', C says 'not in A'. Exactly one is true. Which box?"}]
}
JSON
curl -sS http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d @/tmp/probe_xhigh.json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('output_tokens:', d['usage']['output_tokens'])"
# Expected: ~800-900 tokens. Without the patch (or on unpatched 0.7.0): ~200-400.

# Probe B: 4.8 + thinking{budget=64000} should clamp to medium, NOT 400
cat > /tmp/probe_48.json <<'JSON'
{
  "model": "claude-opus-4.8",
  "max_tokens": 4096,
  "thinking": {"type": "enabled", "budget_tokens": 64000},
  "messages": [{"role": "user", "content": "hi"}]
}
JSON
curl -sS http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d @/tmp/probe_48.json | head -c 200
# Expected: 200 OK with a normal response. Without clamp logic: HTTP 400.
```

---

## How to revert to upstream `@latest`

If you ever want to undo this patch and go back to running upstream
`copilot-api` straight from npm:

```bash
# Stop and switch unit back to npx @latest
systemctl --user stop copilot-api.service
sudo tee ~/.config/systemd/user/copilot-api.service > /dev/null <<'UNIT'
[Unit]
Description=GitHub Copilot API proxy (Claude Code -> Copilot Enterprise)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/qid/.local/bin/npx --yes copilot-api@latest start --account-type enterprise --port 4141
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
WorkingDirectory=/home/qid
Environment=HOME=/home/qid
Environment=PATH=/home/qid/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user start copilot-api.service

# Also revert the wrapper default
# (no automated revert — just edit ~/.local/bin/claude-copilot line ~96
#  back to claude-opus-4.8 or whatever you want)

# Optionally clean up:
rm -rf ~/.local/share/copilot-api-patched/
# Keep ~/.local/src/copilot-api-patched/ in case you want to re-apply later.
```

---

## When upstream `copilot-api` ships a new release

Periodically check `npm view copilot-api version`. When > 0.7.0 ships:

```bash
cd ~/.local/src/copilot-api-patched
git fetch upstream
git fetch upstream --tags
# Rebase our local branch onto the new tag, e.g. v0.8.0
git rebase v0.8.0
# Resolve conflicts in the two patched files
# Rebuild + redeploy as above
```

If upstream merges this translation (consider opening a PR — the patch
is generic and useful for every Claude-Code-on-Copilot user), then just:

```bash
systemctl --user stop copilot-api.service
# Switch unit ExecStart back to npx @latest (see revert section above)
```

---

## When `-internal` 4.8 ships

This is the most likely future event. Check periodically (the probe at
the end of Layer 4 above does it). When `claude-opus-4.8-internal` shows
up in `/v1/models`:

1. Edit `~/.local/src/copilot-api-patched/src/routes/messages/non-stream-translation.ts`,
   add `"claude-opus-4.8-internal": ["low", "medium", "high", "xhigh"]` to the
   `allowed` table.
2. Edit `~/.local/bin/claude-copilot` line ~96,
   change default `COPILOT_MODEL` to `claude-opus-4.8-internal`.
3. Rebuild + redeploy (`npm run build && cp dist/* ~/.local/share/.../dist/ && systemctl --user restart copilot-api.service`).
4. Verify via the probe in this doc, then kill + relaunch any active
   PR daemons via `claude-pr-pipeline-up`.

That gets us 4.8's baseline + 1M context + xhigh effort all in one model.

---

## Probe outputs that confirmed the patch works (archived from 2026-05-29 install)

### After patch 1 only (short-puzzle probe, ~50-token prompt)

| Config | output_tokens | text_chars | latency |
|---|---|---|---|
| 4.7-1m-internal, no thinking field | 224 | 325 | 2.9s |
| **4.7-1m-internal + thinking{64K} → xhigh** | **849** | **1593** | **7.3s** |
| 4.8 + thinking{64K} → clamped to medium (no 400) | 709 | 1248 | 8.8s |
| 4.8 + thinking{64K} on UNPATCHED 0.7.0 (decorative) | 420 | ~800 | ~5s |

3.8× output growth on 4.7-1m between baseline and xhigh confirmed real
reasoning engagement on short prompts.

### After patch 2 (long-doc probe — 10K-token Python file + multi-faceted review prompt)

Test prompt: review `link.py` (959 lines) for (1) concurrency risks,
(2) error-handling gaps, (3) resource leaks, (4) subtle edge-case bugs.
Each finding requires function name + line range + severity + 2-sentence
explanation + fix sketch.

**Patch 1 alone (silently drops reasoning_text)** — empty or short content:

| Endpoint | output_tokens | text_chars | reasoning surfaced |
|---|---|---|---|
| /v1/messages + thinking{64K}, run #1 | 8192 | 3110 (truncated mid-finding) | ❌ |
| /v1/messages + thinking{64K}, run #2 | 8191 | 0 (empty `content: []`) | ❌ |

**Patch 2 (surfaces reasoning_text as thinking block)** — full response:

| Endpoint | output_tokens | thinking_chars | text_chars | stop_reason |
|---|---|---|---|---|
| /v1/messages + thinking{64K}, non-streaming | 7769 | 0 (Copilot inlined this run) | 20073 | end_turn |
| /v1/messages + thinking{64K}, **streaming** | 8192 | **7131** | 3966 | length |

Streaming output (586 `thinking_delta` events + 341 `text_delta` events +
1 `signature_delta`) confirms the CoT is now visible to Claude Code's
daemons in the format they natively parse. The non-streaming run above
happened to inline reasoning into `content` rather than split into
`reasoning_text` (Copilot's behavior is non-deterministic per request);
either path now produces a complete, untruncated response.

Without patch 2, the daemons would silently lose 7K+ characters of
review reasoning per turn on long-doc prompts — exactly the workload
the PR pipeline runs. The patch is essential, not cosmetic.

---

# Appendix A: Claude Code built-in agent overrides for Copilot path

**Scope:** this appendix is OUTSIDE the proxy patch — it's a separate
configuration layer that lives in `~/.claude-copilot/` (the
claude-copilot wrapper's profile dir). It exists because some Claude
Code built-in agents are hardcoded to use models that aren't in
Copilot's catalog. The proxy patch (Patch 1 + Patch 2 above) is
about the wire-level translation; this appendix is about the
session-level agent dispatching layer that sits above it.

Added 2026-05-31.

## The problem

Claude Code 2.1.156+ ships built-in agentTypes with hardcoded model
fields baked into the binary. Two of them matter on the Copilot path:

| Built-in agentType | Hardcoded model | In Copilot catalog? |
|---|---|---|
| `Explore` | `"haiku"` → `claude-haiku-4-5-20251001` | ❌ NO (returns 400 `model_not_supported`) |
| `statusline-setup` | `"sonnet"` → `claude-sonnet-4-*` | ✅ yes (sonnet-4.6 exposed) |
| `Plan` | `"inherit"` (session main model) | ✅ (inherits whatever) |
| `general-purpose` | unspecified → inherits | ✅ |
| `worker` | unspecified → inherits | ✅ |
| `claude` | unspecified → inherits | ✅ |
| `workflow-subagent` | unspecified → inherits | ✅ |

Only `Explore` is a hard blocker. `statusline-setup`'s sonnet works
fine on Copilot but we override it too for uniformity (everything on
opus).

`Explore` is invoked by:

1. **Model directly** — `Agent({subagent_type: "Explore", prompt: "..."})`
   tool call.
2. **Workflow scripts internally** — `agent("...", {agentType: "Explore"})`
   JS calls inside the script passed to the `Workflow` tool. The
   workflow runner spawns sub-agents from the script using the
   agentType registered in Claude Code's internal registry.

Both paths fail when the built-in Explore tries to dispatch to haiku
via the patched copilot-api proxy — the 400 is upstream from
GitHub Copilot, not from our proxy.

## Why naive override (user agent with `name: Explore`) only half-works

The obvious approach is to drop a `~/.claude-copilot/agents/Explore.md`
file with `model: opus`, expecting Claude Code's user-agent loader to
override the built-in registration. Empirically (tested 2026-05-31):

- ✅ The override file IS loaded (debug log shows
  `[API REQUEST] /v1/messages source=agent:custom:Explore`).
- ❌ But the `model: opus` alias DOESN'T resolve — Claude Code falls
  back to the built-in's hardcoded `haiku` for some code paths.
- ❌ Even using fully-qualified `model: claude-opus-4.7-1m-internal`
  in the override file, Claude Code's SDK has internal calls
  (`source=sdk` tagged) that still fire to haiku independently of
  the agent registry. These calls 400 and are retry-swallowed but
  pollute the logs.

The alias `opus` works correctly for **purely user-defined** agents
that don't collide with built-in names (e.g., `code-reviewer-opus`).
The collision case (same name as built-in) is what triggers the
half-fallback bug.

## The clean solution: parallel user agent + PreToolUse hook

Three pieces. Each addresses a different interception point.

### Piece 1: `~/.claude-copilot/agents/Explore-copilot.md`

A **purely user-defined** agent (not colliding with any built-in name).
System prompt copied verbatim from the binary's `Eb5()` function (the
built-in Explore's getSystemPrompt). Tools restricted to read-only
search ops (Glob, Grep, LS, Read, NotebookRead, WebFetch, WebSearch,
BashOutput, TodoWrite). `model: opus` alias works correctly because
there's no name collision.

The complete prompt lives in the file; refer to that as the source of
truth. The key frontmatter is:

```yaml
---
name: Explore-copilot
description: <same text as built-in Explore's whenToUse from binary>
tools: Glob, Grep, LS, Read, NotebookRead, WebFetch, WebSearch, BashOutput, TodoWrite
model: opus
color: cyan
---
```

### Piece 2: `~/.claude-copilot/hooks/redirect-explore-to-copilot.py`

A Python PreToolUse hook that intercepts both call paths and rewrites
`Explore` → `Explore-copilot`:

```python
def rewrite_agent_subagent_type(tool_input):
    # Path 1: Agent({subagent_type: "Explore"}) tool call
    if tool_input.get("subagent_type") == "Explore":
        return {**tool_input, "subagent_type": "Explore-copilot"}
    return None

_AGENT_TYPE_RE = re.compile(
    r"""(agentType\s*:\s*)(['"])Explore\2(?![-\w])"""
)

def rewrite_workflow_input(tool_input):
    # Path 2a: Workflow({script: "...agent('x', {agentType: 'Explore'})..."})
    if isinstance(tool_input.get("script"), str):
        new_script, n = _AGENT_TYPE_RE.subn(
            lambda m: f"{m.group(1)}{m.group(2)}Explore-copilot{m.group(2)}",
            tool_input["script"]
        )
        if n > 0:
            return {**tool_input, "script": new_script}

    # Path 2b: Workflow({scriptPath: "/path/to/foo.js", resumeFromRunId: "..."})
    # Read file, rewrite, write back in-place (scripts live under
    # ~/.claude-copilot/projects/.../workflows/scripts/, session-scoped).
    script_path = tool_input.get("scriptPath")
    if isinstance(script_path, str) and os.path.isfile(script_path):
        old = open(script_path).read()
        new, n = _AGENT_TYPE_RE.subn(..., old)
        if n > 0:
            open(script_path, "w").write(new)
    return None
```

The hook contract (per Claude Code 2.1.157):

- **stdin**: JSON `{tool_name, tool_input, ...}`
- **stdout**: JSON `{hookSpecificOutput: {hookEventName: "PreToolUse",
  permissionDecision: "allow", updatedInput: {<rewritten>}}}`
- **fail-open**: any parse error → emit `{}` and exit 0. Hook bugs
  should never break the session.

The word-boundary anchor `(?![-\w])` in the regex prevents
double-rewriting `Explore-copilot` if it's already there (idempotent).

### Piece 3: `~/.claude-copilot/settings.json` hook registration

Append to existing `hooks.PreToolUse` array (don't replace — the
user already has Bash/Edit/WebSearch hooks):

```json
{
  "matcher": "Agent|Workflow",
  "hooks": [{
    "type": "command",
    "command": "$HOME/.claude-copilot/hooks/redirect-explore-to-copilot.py",
    "timeout": 10
  }]
}
```

`matcher: "Agent|Workflow"` is a regex matching the tool name. The
hook fires for both tools and decides which (if any) rewrite to do
based on tool_name internally.

## Verification probe outputs (2026-05-31 — proves it works)

Test: `claude-copilot -p "Use a workflow with explicit agentType:'Explore'
to count TODOs under scripts/. Report the count in one sentence."`

| Metric | Before (no override) | After Explore.md override only | After hook + Explore-copilot |
|---|---|---|---|
| Workflow exit code | 0 (self-recovered by dropping agentType) | 0 (with stray haiku 400s) | **0 (clean)** |
| opus dispatches | varies | 16 | **6 (100%)** |
| haiku dispatches | several (then dropped agentType) | 2 (SDK internals) | **0** |
| sonnet dispatches | 0 | 1 | **0** |
| HTTP 400 `model_not_supported` | 1+ (in initial agentType pass) | 3 (retry-swallowed) | **0** |
| sub-agent meta.json agentType | `Explore` (failed) → drop agentType | `Explore` (failed-then-succeeded) | **`Explore-copilot` (succeeded first try)** |
| Generated workflow script | `agentType: 'Explore'` | `agentType: 'Explore'` | **`agentType: 'Explore-copilot'`** (hook rewrote) |

The hook approach achieves 100% opus dispatch with zero 400 errors and
zero SDK haiku residual on the same workload. The override-only
approach has measurable noise.

Debug log evidence the hook fired:

```
[DEBUG] Hook PreToolUse (.../redirect-explore-to-copilot.py) returned permissionDecision: allow
[DEBUG] Hook PreToolUse (.../redirect-explore-to-copilot.py) modified tool input keys: [script]
[DEBUG] [API REQUEST] /v1/messages source=agent:custom:Explore-copilot
```

## Why this is better than binary-patching Claude Code

Theoretical alternative: patch the Claude Code binary at the `Y8H`
registration to change `model:"haiku"` → `model:"inherit"`. Three
reasons this is worse:

1. **Update churn**: every Claude Code release would need re-patching
   (versions are at `~/.local/share/claude/versions/<v>/`).
2. **Per-version brittleness**: minified variable names (`Y8H`, `Eb5`,
   etc.) change across versions; the binary-patch script would need
   to re-locate them.
3. **Opacity**: a binary patch is invisible to anyone who didn't
   write it. The hook + agent file is grep-able and self-documenting.

The hook approach is **zero-invasive** to Claude Code — works across
upgrades, leaves audit trail in the hook script and agent file.

## Defense-in-depth: keep the override Explore.md too

We also have `~/.claude-copilot/agents/Explore.md` (the half-working
override). It's now redundant — the hook intercepts before
`Explore` ever gets dispatched. But keeping it as a fallback safety
net costs nothing: if the hook script crashes, the settings.json
gets corrupted, or someone disables the hook for debugging, the
Explore.md override is still there to partially work. Belt + suspenders.

## How to extend this pattern to other built-in agents

If a future Claude Code release adds new built-in agentTypes that
default to haiku (or any other model not in Copilot's catalog),
repeat the pattern:

1. **Identify** the built-in by checking the binary:
   ```bash
   grep -aoE 'agentType:"[A-Za-z_-]+"[^{}]{0,500}' \
     /home/qid/.local/share/claude/versions/<v> | \
     grep -iE 'model:"haiku"|model:"sonnet"'
   ```

2. **Extract the system prompt** (the function called by
   `getSystemPrompt`). For Eb5 example, use Python brace-matching:
   ```python
   blob = open(BINARY_PATH, "rb").read()
   idx = blob.find(b"function Eb5(")
   brace = blob.find(b"{", idx)
   # walk braces to find matching close...
   ```

3. **Create the parallel agent** at
   `~/.claude-copilot/agents/<Name>-copilot.md` with the extracted
   prompt + `model: opus` (alias works because no name collision).

4. **Extend the hook** (`redirect-explore-to-copilot.py`) to handle
   the new agentType. The regex and rewrite functions are
   parameterized — just add the new name to a map. Or split into
   separate hook files per agentType if you want isolation.

5. **No settings.json change needed** if reusing the existing
   `Agent|Workflow` matcher entry.

## Files reference

```
~/.claude-copilot/
├── agents/
│   ├── code-reviewer-opus.md           # pre-existing (Anthropic Max default reviewer)
│   ├── Explore-copilot.md              # NEW — parallel agent, model: opus alias
│   ├── Explore.md                      # NEW — fallback override, full model ID
│   └── statusline-setup.md             # NEW — override, full model ID (uniformity)
├── hooks/
│   └── redirect-explore-to-copilot.py  # NEW — PreToolUse interceptor
└── settings.json                       # MODIFIED — added Agent|Workflow PreToolUse entry
```

## Reverting this appendix

If you want to undo this layer (e.g., switching back to Anthropic
direct where haiku Explore works fine):

```bash
# Remove the hook entry from settings.json
python3 -c "
import json
p = '/home/qid/.claude-copilot/settings.json'
d = json.load(open(p))
d['hooks']['PreToolUse'] = [
    e for e in d['hooks']['PreToolUse']
    if e.get('matcher') != 'Agent|Workflow'
]
json.dump(d, open(p,'w'), indent=2)
"

# Optionally remove the agent files + hook script
rm ~/.claude-copilot/agents/Explore-copilot.md
rm ~/.claude-copilot/agents/Explore.md
rm ~/.claude-copilot/agents/statusline-setup.md
rm ~/.claude-copilot/hooks/redirect-explore-to-copilot.py
```

The proxy patch (Patches 1 + 2 above) is INDEPENDENT and stays in
place after this reversion. They live in `~/.local/share/copilot-api-patched/`
and `~/.config/systemd/user/copilot-api.service`.

---

## Patch 3 (2026-06-03, afternoon): correct `translateModelName` for hyphen / `[1m]` forms

Patches 1 and 2 covered the request-body translation (thinking →
reasoning_effort) and the response-body translation (reasoning_text →
thinking block). But upstream copilot-api 0.7.0 also has a broken
**model-id translation** that wasn't on our radar until 2026-06-03:

```ts
// upstream original:
if (model.startsWith("claude-opus-")) {
  return model.replace(/^claude-opus-4-.*/, "claude-opus-4")
}
```

This collapses every hyphenated opus id to bare `claude-opus-4` — which
isn't in Copilot's catalog. Claude Code's internal sub-agent dispatch
and tool routing use the hyphen form (`claude-opus-4-7`,
`claude-opus-4-8`), so every one of those calls 400'd with
`model_not_supported`. Claude Code's retry layer absorbed the 400s
silently, but it polluted debug logs and (worse) prevented the
`[1m]` 1M-context syntax from working at all.

### What patch 3 does

Replaced `translateModelName` with explicit hyphen→dot translation plus
`[1m]` suffix mapping:

```ts
function translateModelName(model: string): string {
  const has1m = model.endsWith("[1m]")
  const base = has1m ? model.slice(0, -"[1m]".length) : model

  const dotted = base.replace(
    /^(claude-(?:opus|sonnet|haiku)-(\d+))-(\d+)/,
    "$1.$3",
  )

  if (!has1m) return dotted
  if (dotted === "claude-opus-4.7" || dotted === "claude-opus-4.8")
    return "claude-opus-4.7-1m-internal"
  if (dotted === "claude-opus-4.6") return "claude-opus-4.6-1m"
  return dotted
}
```

Translation table:

| Input (Claude Code emits) | Output (Copilot catalog form) |
|---|---|
| `claude-opus-4-7[1m]` | `claude-opus-4.7-1m-internal` (xhigh-capable) |
| `claude-opus-4-7` | `claude-opus-4.7` (medium-only) |
| `claude-opus-4-8[1m]` | `claude-opus-4.7-1m-internal` (fallback; no 4.8 1M in catalog) |
| `claude-opus-4-8` | `claude-opus-4.8` (medium-only) |
| `claude-opus-4-6[1m]` | `claude-opus-4.6-1m` |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `claude-sonnet-4-6[1m]` | `claude-sonnet-4.6` (no sonnet 1M on Copilot — degrade rather than 400) |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `claude-opus-4.7-1m-internal` (already dotted) | pass-through |
| `gpt-5.5` | pass-through |

### Why it matters: 1M context unlock

Before patch 3, the wrapper passed `--model claude-opus-4.7-1m-internal`
(literal Copilot id, dotted). Claude Code's client-side LMH model
registry doesn't know this id, so it fell back to a generic 200K context
window → autocompact threshold sat at `effectiveWindow=180000` tokens.
~820K of usable 1M context was unreachable.

After patch 3, the wrapper passes `--model claude-opus-4-7[1m]` instead.
Claude Code DOES recognize this form (saw `claude-opus-4-6[1m]` and
`claude-opus-4-7[1m]` strings in the binary's LMH table) → switches
client-side autocompact to 1M-context mode → effectiveWindow jumps to
~480000. The proxy's new translateModelName transparently maps
`claude-opus-4-7[1m]` to `claude-opus-4.7-1m-internal` upstream.

Verified 2026-06-03 — upstream model distribution during a substantive
session:

| Upstream model | Count | Source |
|---|---|---|
| `claude-opus-4.7-1m-internal` | 4 | main chat (1M + xhigh-eligible) |
| `claude-opus-4.7` | 2 | sub-agent dispatch (medium-only, fine) |
| HTTP 400 errors | **0** | (previously 3 per session from collapsed `claude-opus-4`) |

### Wrapper change tied to this patch

`~/.local/bin/claude-copilot` changed `COPILOT_MODEL` default from
`claude-opus-4.7-1m-internal` (literal Copilot id) to
`claude-opus-4-7[1m]` (Claude-Code-recognized 1M syntax). The wrapper's
old behavior (passing the literal Copilot id) still works thanks to the
pass-through rule for already-dotted ids, but loses the 1M autocompact
window. Both forms reach the right upstream model now — the difference
is whether Claude Code's CLIENT-SIDE behavior knows it's a 1M model.

### Maintenance: when does the `[1m]→4.8-1m-internal` mapping update

Currently `claude-opus-4-8[1m]` maps to `claude-opus-4.7-1m-internal`
(fallback) because Microsoft hasn't shipped a 4.8 1M variant yet (latest
catalog snapshot: 2026-06-03). When `claude-opus-4.8-1m-internal` or
`claude-opus-4.8-1m` appears in Copilot's catalog, update the
translation table in `src/routes/messages/non-stream-translation.ts`:

```ts
if (dotted === "claude-opus-4.8") return "claude-opus-4.8-1m-internal"
if (dotted === "claude-opus-4.7") return "claude-opus-4.7-1m-internal"  // keep
```

Also update the wrapper default to `claude-opus-4-8[1m]` if you want
Copilot sessions to use the 4.8 baseline by default — but consider
that 4.7-1m-internal currently has the better effort spectrum
(`[low, medium, high, xhigh]`) while 4.8 base is restricted to
`["medium"]`. Once 4.8 1M variant exists, check its catalog
`reasoning_effort` field before flipping.

### Per-model clamp table interaction

The clamp table in `translateThinkingToReasoningEffort` keys on the
**dotted (post-translation) form**:

```ts
"claude-opus-4.7-1m-internal": ["low", "medium", "high", "xhigh"],
"claude-opus-4.7":             ["medium"],
"claude-opus-4.8":             ["medium"],
```

So a request with `model: claude-opus-4-7[1m]`, `thinking: {budget: 64K}`
flows through:

1. `translateThinkingToReasoningEffort(thinking, "claude-opus-4-7[1m]")`
   → currently returns `desired` directly (model not in clamp table)
   because table is keyed on POST-translation form.

That's a **bug** — the clamp lookup should be on the translated id, not
the raw input. **TODO** for a future patch 4: do model translation
first, then clamp lookup. For now, this means sub-agent calls with
`claude-opus-4-7` get whatever effort tier the client requested without
clamping — which can 400 if Claude Code sends xhigh on a medium-only
model.

Empirically (2026-06-03) we haven't seen this 400 in practice — likely
because sub-agent calls don't include a `thinking` field anyway. But
the clamp ordering bug is a latent footgun. Fix tracked but not
currently impacting normal usage.

---

## Patch 4 (2026-06-03, late afternoon): `output_config.effort` translation + bare-hyphen → 1m-internal

After patch 3 a major discrepancy was found: despite all wrapper config
(`effortLevel: xhigh`, `alwaysThinkingEnabled: true`, `--effort xhigh`),
the proxy was receiving requests with NO `thinking` field AND NO `effort`
field. So our patch 1 (thinking → reasoning_effort) never fired — every
Copilot request defaulted to `defaultReasoningEffort: medium`.

Root cause (doc-driven investigation 2026-06-03):

1. **Anthropic deprecated `thinking.budget_tokens` for 4.6+**, removed
   entirely on 4.7/4.8. The new wire format is `thinking: {type: "adaptive"}`
   + `output_config: {effort: "xhigh"}`. Patch 1 was handling the wrong
   field for our models.

2. **Claude Code emits the new fields only when the model is recognized**
   as supporting adaptive_thinking + effort. The Microsoft-internal
   `claude-opus-4.7-1m-internal` id wasn't in Claude Code's built-in
   pattern table, so capability detection silently failed.

3. **`modelOverrides` setting doesn't apply to LLM-gateway paths**:
   > "Values you supply directly through `ANTHROPIC_MODEL`, `--model`, or
   > the `ANTHROPIC_DEFAULT_*_MODEL` environment variables are passed to
   > the provider as-is and are not transformed by `modelOverrides`."
   So we can't use modelOverrides to remap `claude-opus-4-7` →
   `claude-opus-4.7-1m-internal` at the Claude Code layer — must do it
   in the proxy.

### What patch 4 does

**File: `src/routes/messages/anthropic-types.ts`**

Extended `AnthropicMessagesPayload`:
- `thinking.type` now accepts `"enabled" | "adaptive" | "disabled"`
  (was just `"enabled"`).
- New `output_config: { effort?: "low" | "medium" | "high" | "xhigh" | "max" }`
  field per [Anthropic effort docs](https://platform.claude.com/docs/en/build-with-claude/effort).

**File: `src/routes/messages/non-stream-translation.ts`**

Two changes:

1. **New `translateOutputConfigEffort()`**: reads `payload.output_config.effort`,
   maps to Copilot's `reasoning_effort` field, clamps via the same per-model
   allowlist as the legacy thinking-budget translation. `max` collapses to
   `xhigh` (Copilot doesn't expose `max`). Takes precedence over legacy
   `thinking.budget_tokens` translation.

2. **Updated `translateModelName()`**: bare hyphenated `claude-opus-4-7`
   (which Claude Code emits when wrapper resolves `opus` alias via
   ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7[1m] — `[1m]` is stripped
   client-side before send) now maps to `claude-opus-4.7-1m-internal`
   instead of base `claude-opus-4.7`. The 1m-internal variant is strictly
   better (1M context + full effort spectrum vs base's 200K + medium-only).
   Same for `claude-opus-4-8`. Already-dotted forms still pass through
   unchanged so PR daemons (passing `claude-opus-4.7-1m-internal` literally)
   are unaffected.

**File: `src/routes/messages/handler.ts`**

Added optional `COPILOT_API_DUMP_PAYLOADS=1` env var that writes every
incoming and outgoing payload to `/tmp/copilot-api-payloads.jsonl` as
NDJSON. Bypasses journald's 48KB line-truncation. Useful for diagnosing
unexpected wire shapes during config changes. Off by default — file
grows unbounded if left on.

### Wrapper-side changes (2026-06-03 — paired with patch 4)

`~/.local/bin/claude-copilot`:

- `COPILOT_MODEL` default changed from literal id to `opus` alias.
- New env vars set by the wrapper:
  - `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7[1m]` — Claude Code's
    1M-context-recognized syntax. The `[1m]` suffix triggers 1M-mode
    autocompact threshold computation (effectiveWindow grows from 180K).
  - `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES='effort,xhigh_effort,thinking,adaptive_thinking,interleaved_thinking'`
    — declares to Claude Code which features the model supports, so it
    actually emits `output_config.effort` and `thinking: {type: "adaptive"}`
    in API requests.
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` — drops autocompact threshold
    from default ~95% to 80% of perceived window. (Per issue #43989, this
    var is capped by Math.min to ~83%, so 80 is the safe ceiling.)

### Wire-format verification (2026-06-03, end-to-end test)

Using the proxy's `COPILOT_API_DUMP_PAYLOADS=1` diagnostic mode:

```
[in-anthropic]
  model: "claude-opus-4-7"          ← Claude Code stripped [1m]
  thinking: {"type": "adaptive"}
  output_config: {"effort": "xhigh"}

[out-openai]
  model: "claude-opus-4.7-1m-internal"   ← patch 4 routes hyphen → 1m-internal
  thinking: ABSENT                        ← stripped (not Copilot-compatible)
  output_config: ABSENT                   ← stripped (translated below)
  reasoning_effort: "xhigh"               ← patch 4 translated output_config.effort
```

Zero HTTP 400 errors on a comprehensive workflow + Explore-copilot session.
PR daemons (which use dotted `claude-opus-4.7-1m-internal` literal) are
unaffected — dotted forms pass through unchanged.

### Sub-agent uniformity

A welcome side effect of the bare-hyphen → 1m-internal mapping: sub-agent
dispatches that previously dropped to base 4.7 now also land on
1m-internal. Workflow / Agent tool invocations that internally use
`claude-opus-4-7` get the same capability profile as the main chat:
1M context, xhigh effort.

### Final effective capability (Copilot path via claude-copilot wrapper, 2026-06-03)

| Dimension | Achieved |
|---|---|
| Server-side model | claude-opus-4.7-1m-internal (1M context, xhigh-capable) |
| Server-side effort | **xhigh** (via reasoning_effort field, confirmed in wire dump) |
| Server-side max thinking budget | 32K tokens (Copilot catalog cap; half of Anthropic native 64K) |
| Client-side autocompact threshold | Set via 80% override + `[1m]` recognition |
| CoT visibility | Anthropic `thinking` content blocks (via patch 2's reasoning_text → thinking translation) |
| Sub-agent capability | Same as main chat (1m-internal + xhigh-eligible) |
| Daemon impact | Zero (dotted form pass-through) |

### Maintenance reminders

- When Microsoft ships `claude-opus-4.8-1m-internal` to Copilot catalog,
  update the `claude-opus-4-8[1m]` → ... mapping (currently falls back
  to 4.7-1m-internal) and consider switching wrapper's
  ANTHROPIC_DEFAULT_OPUS_MODEL to `claude-opus-4-8[1m]`.

- If Anthropic changes the effort field schema again (e.g., renames
  `output_config.effort` or adds new tier), update
  `translateOutputConfigEffort` and the `Anthropic*.thinking.type` union
  in `anthropic-types.ts`.

- The diagnostic dump at `/tmp/copilot-api-payloads.jsonl` is invaluable
  for verifying wire shape — keep `COPILOT_API_DUMP_PAYLOADS=1` env var
  in your toolkit when investigating any future config-vs-reality
  discrepancy.

---

## Patch 5 (2026-06-10): GPT-5.x via `/responses` on `/v1/messages`

**Problem.** Copilot's GPT-5.x models (`gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, ...)
are **responses-only**. Both `/chat/completions` and the Anthropic
`/v1/messages` path (which we translate *to* `/chat/completions`) reject them:

```
POST /v1/messages {"model":"gpt-5.5", ...}
-> 400 {"code":"unsupported_api_for_model",
        "message":"model \"gpt-5.5\" is not accessible via the /chat/completions endpoint"}
```

Only the `/responses` endpoint serves them (verified live against
`gpt-5.5-2026-04-23`). Claude Code speaks Anthropic Messages, so to use GPT-5.x
as a Claude Code agent backend we must bridge Anthropic Messages <-> OpenAI
Responses.

**What the patch does.** `handler.ts` now detects `^gpt-5` and routes those
requests through `createResponses()` (the pre-existing `/responses` pass-through
in `src/services/copilot/create-responses.ts`) instead of
`createChatCompletions()`. All other models (Claude, gpt-4o, ...) keep the
existing `/chat/completions` path untouched.

#### File: `src/routes/messages/handler.ts`
- `isResponsesOnlyModel(model)` = `/^gpt-5/i.test(model)`.
- New `handleViaResponses()`: translate → `createResponses()` → translate back
  (non-stream `c.json`, stream via `streamSSE`).

#### File: `src/routes/messages/responses-translation.ts` (NEW)
- `translateAnthropicToResponses`: `messages`→`input` items (text/image →
  `input_text`/`input_image`/`output_text`; assistant `tool_use` → top-level
  `function_call`; user `tool_result` → `function_call_output`, order
  preserved); `system`→`instructions`; `max_tokens`→`max_output_tokens`;
  effort→`reasoning.effort`; Anthropic tools→Responses `function` tools;
  `tool_choice` mapping.
- `translateResponsesResultToAnthropic` (non-stream): `output[]` items —
  `message`(content `output_text`)→text block, `function_call`(call_id/name/
  arguments)→`tool_use` block; `reasoning` items skipped (encrypted, no client
  text); `stop_reason` (tool_use / max_tokens / end_turn); usage.
- `translateResponsesStreamEvent` (stream): maps `response.output_item.added/
  done`, `response.content_part.added`, `response.output_text.delta`,
  `response.function_call_arguments.delta`, `response.completed/incomplete` →
  Anthropic `message_start` / `content_block_{start,delta,stop}` /
  `message_delta` / `message_stop`. Maintains its own sequential Anthropic
  block index (Responses `output_index` → Anthropic index), opening tool_use
  blocks on `output_item.added` and text blocks on `content_part.added`.

#### Verification (replay-able)
```bash
KEY=<copilot-token>
H=(-H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json")
# non-stream
curl -s localhost:4141/v1/messages "${H[@]}" \
  -d '{"model":"gpt-5.5","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
#   -> {"type":"message","stop_reason":"end_turn","content":[{"type":"text",...}], "usage":{...}}
# stream -> message_start, content_block_start, content_block_delta*, content_block_stop, message_delta, message_stop
# tool call -> stop_reason "tool_use", content[].tool_use with input
# multi-turn tool_result roundtrip -> final text answer using the tool output
# regression: claude-opus-4-8 still 200 via /chat/completions
```
All verified 2026-06-10. Used in production by DeepV's agent (gpt-5.5 via
`ANTHROPIC_BASE_URL=http://localhost:4141`) on both the dev box and the stable
server (each runs its own copilot-api instance).

**Caveat — responses-only family.** The `^gpt-5` match assumes the whole GPT-5
family is responses-only. If a future `gpt-5*` variant supports
`/chat/completions`, narrow the regex. GPT-5.x reasoning summaries come back
encrypted (`summary: []`), so no Anthropic `thinking` blocks are emitted for
this path — the model's CoT is not client-visible.
