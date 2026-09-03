# Copilot Codex Offline Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and produce a private Linux/Windows bundle that installs the standalone patched Copilot API offline and migrates the source machine's functional Codex configuration and credentials.

**Architecture:** A Bash packer builds one common payload and emits matching tar/zip archives. Linux Bash and native Windows PowerShell installers own platform service management, while two Node.js helpers provide shared configuration migration and service verification so behavior does not drift between platforms.

**Tech Stack:** Bash, Windows PowerShell 5.1+, Node.js ESM, Bun test, tsdown standalone build, systemd user services, Windows Task Scheduler.

**Spec:** `docs/superpowers/specs/2026-09-03-copilot-codex-offline-bundle-design.md`

## Global Constraints

- Target machines already have Node.js 20 or newer and Codex CLI; installers must not download or upgrade either one.
- Packaging and installation must perform no dependency downloads on the target.
- Generated archives contain live `auth.json` and GitHub credentials and must never be staged or pushed.
- Do not migrate sessions, history, logs, locks, model caches, shell snapshots, or SQLite runtime state.
- Snapshot files win on matching skill/plugin paths; unrelated target skill/plugin files remain.
- Linux and Windows use the same config migration and API verification helpers.
- Never stop or replace the live API on port 4141 during automated tests.
- A local installation failure rolls back; upstream unreachability defers online checks without rolling back.

---

## File Map

- `deploy/codex/lib/migrate-config.mjs`: Validate, normalize, back up, and migrate Codex config trees for Linux and Windows.
- `deploy/codex/lib/verify-service.mjs`: Run local identity/model checks and optional Standard/Fast/compact/MCP online checks with machine-readable results.
- `deploy/codex/install.sh`: Linux preflight, transaction, service installation, rollback, and verification.
- `deploy/codex/install.ps1`: Native Windows equivalent using per-user scheduled tasks.
- `deploy/codex/diagnose.sh`: Read-only Linux diagnostic report.
- `deploy/codex/diagnose.ps1`: Read-only Windows diagnostic report.
- `deploy/codex/pack.sh`: Build, snapshot, manifest, archive, extract, and cross-check both outputs.
- `deploy/codex/README.md`: Private-package usage and recovery guide.
- `tests/deploy-codex-migrate.test.ts`: Cross-platform migration unit tests.
- `tests/deploy-codex-verify.test.ts`: Verification helper tests with local mock servers.
- `tests/deploy-codex-install.test.ts`: Linux transaction and packaging contract tests.
- `tests/helpers/deploy-codex.ts`: Temporary-tree, hashing, process, and fixture helpers shared by deployment tests.
- `.github/workflows/ci.yml`: Native Windows PowerShell parser check.
- `.gitignore`: Prevent generated credential archives/directories from entering Git.

### Task 1: Cross-platform configuration migration helper

**Files:**
- Create: `deploy/codex/lib/migrate-config.mjs`
- Create: `tests/deploy-codex-migrate.test.ts`
- Create: `tests/helpers/deploy-codex.ts`

**Interfaces:**
- Consumes CLI flags `--source`, `--target`, `--home`, `--port`, `--platform`, `--backup`, and optional `--dry-run`.
- Produces exported `transformToml(text, options)`, `transformHooks(value, options)`, `mergeTree(source, target, options)`, and `migrateConfig(options)` plus JSON CLI output.
- Test helpers export `makeTempTree()`, `writeFixture(path, content)`, `treeHashes(path)`, `pathExists(path)`, `runCommand(command, args, options)`, `writeManifest(root)`, `createCompleteInstallerFixture()`, `createPackagingFixture()`, and `extractAndHashGeneratedArchives(out)`.

- [ ] **Step 1: Write failing tests for TOML and hooks transformation**

```ts
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { makeTempTree, writeFixture } from "./helpers/deploy-codex"

const migration = await import(
  pathToFileURL(`${process.cwd()}/deploy/codex/lib/migrate-config.mjs`).href
)

// tests/helpers/deploy-codex.ts
import { createHash } from "node:crypto"
import { access, chmod, copyFile, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

export async function makeTempTree() {
  const root = await mkdtemp(join(tmpdir(), "copilot-codex-test-"))
  return { root, source: join(root, "source"), target: join(root, "target"), backup: join(root, "backup") }
}

export async function writeFixture(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

export async function treeHashes(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name)
      if ((await stat(file)).isDirectory()) await visit(file)
      else output[relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex")
    }
  }
  await visit(root)
  return output
}

export async function pathExists(file: string) {
  try { await access(file); return true } catch { return false }
}

export async function runCommand(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export async function writeManifest(root: string) {
  const hashes = await treeHashes(root)
  const lines = Object.entries(hashes)
    .filter(([file]) => file !== "MANIFEST.sha256")
    .map(([file, hash]) => `${hash}  ${file.replaceAll("\\", "/")}`)
  await writeFixture(join(root, "MANIFEST.sha256"), `${lines.join("\n")}\n`)
}

export async function createCompleteInstallerFixture() {
  const root = await mkdtemp(join(tmpdir(), "copilot-codex-installer-fixture-"))
  const packageRoot = join(root, "package")
  const installRoot = join(root, "install")
  const bin = join(root, "bin")
  await mkdir(bin, { recursive: true })
  await symlink(process.execPath, join(bin, "node"))
  await writeFixture(join(bin, "codex"), "#!/bin/sh\necho codex-cli fixture\n")
  await chmod(join(bin, "codex"), 0o755)
  await writeFixture(join(packageRoot, "dist/main.js"), "console.log('fixture')\n")
  await writeFixture(join(packageRoot, "codex-config/config.toml"), "[model_providers.copilot]\nbase_url = \"http://localhost:4141/v1\"\n")
  await writeFixture(join(packageRoot, "codex-config/auth.json"), "{}\n")
  await writeFixture(join(packageRoot, "codex-config/hooks.json"), "{\"hooks\":{}}\n")
  await writeFixture(join(packageRoot, "credentials/github_token"), "fixture-token\n")
  await mkdir(join(packageRoot, "lib"), { recursive: true })
  await copyFile(join(process.cwd(), "deploy/codex/lib/migrate-config.mjs"), join(packageRoot, "lib/migrate-config.mjs"))
  await copyFile(join(process.cwd(), "deploy/codex/lib/verify-service.mjs"), join(packageRoot, "lib/verify-service.mjs"))
  await writeManifest(packageRoot)
  return { root, packageRoot, installRoot, path: `${bin}:/usr/bin:/bin` }
}

export async function createPackagingFixture() {
  const root = await mkdtemp(join(tmpdir(), "copilot-codex-pack-fixture-"))
  const home = join(root, "home")
  const codexHome = join(home, ".codex")
  const dist = join(root, "dist")
  await writeFixture(join(codexHome, "config.toml"), "[model_providers.copilot]\nbase_url = \"http://localhost:4141/v1\"\n")
  await writeFixture(join(codexHome, "auth.json"), "{\"auth_mode\":\"apikey\"}\n")
  await writeFixture(join(codexHome, "hooks.json"), "{\"hooks\":{}}\n")
  await writeFixture(join(codexHome, "skills/user-skill/SKILL.md"), "---\nname: user-skill\ndescription: fixture\n---\n")
  await writeFixture(join(codexHome, "skills/.system/builtin/SKILL.md"), "excluded\n")
  await writeFixture(join(codexHome, "plugins/cache/plugin/plugin.json"), "{}\n")
  await writeFixture(join(codexHome, "sessions/session.jsonl"), "excluded\n")
  await writeFixture(join(home, ".local/share/copilot-api/github_token"), "fixture-token\n")
  await writeFixture(join(dist, "main.js"), "console.log('fixture')\n")
  return { root, home, codexHome, dist }
}

export async function extractAndHashGeneratedArchives(out: string) {
  const names = await readdir(out)
  const tarFile = join(out, names.find((name) => name.endsWith(".tar.gz"))!)
  const zipFile = join(out, names.find((name) => name.endsWith(".zip"))!)
  const tarDir = join(out, "tar-extracted")
  const zipDir = join(out, "zip-extracted")
  await mkdir(tarDir); await mkdir(zipDir)
  if ((await runCommand("tar", ["-xzf", tarFile, "-C", tarDir])).exitCode !== 0) throw new Error("tar extraction failed")
  if ((await runCommand("unzip", ["-q", zipFile, "-d", zipDir])).exitCode !== 0) throw new Error("zip extraction failed")
  const tarRoot = join(tarDir, (await readdir(tarDir))[0])
  const zipRoot = join(zipDir, (await readdir(zipDir))[0])
  const tarHashes = await treeHashes(tarRoot)
  const zipHashes = await treeHashes(zipRoot)
  return { files: Object.keys(tarHashes), tarHashes, zipHashes }
}

test("rewrites provider URLs and removes machine-specific sections", () => {
  const input = `model = "gpt-5.6-sol"
[model_providers.copilot]
base_url = "http://localhost:4141/v1"
[projects."/home/source/project"]
trust_level = "trusted"
[mcp_servers.copilotApi]
url = "http://localhost:4141/mcp"
[hooks.state."/home/source/.codex/hooks.json:stop:0:0"]
enabled = true
trusted_hash = "old"
`
  const output = migration.transformToml(input, { port: 5151, home: "/home/target" })
  expect(output).toContain('base_url = "http://localhost:5151/v1"')
  expect(output).toContain('url = "http://localhost:5151/mcp"')
  expect(output).not.toContain("[projects.")
  expect(output).not.toContain("[hooks.state.")
})

test("disables Unix hooks on Windows and rewrites the portable home marker on Linux", () => {
  const hooks = { hooks: { Stop: [{ hooks: [{ type: "command", command: "__CODEX_HOME__/.orca/agent-hooks/codex-hook.sh" }] }] } }
  expect(migration.transformHooks(hooks, { platform: "win32", home: "C:\\Users\\me" })).toEqual({ hooks: {} })
  expect(JSON.stringify(migration.transformHooks(hooks, { platform: "linux", home: "/home/me" }))).toContain("/home/me/.orca")
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `bun test tests/deploy-codex-migrate.test.ts`

Expected: FAIL because `deploy/codex/lib/migrate-config.mjs` does not exist.

- [ ] **Step 3: Implement deterministic text/JSON transformations**

```js
export function transformToml(text, { port, home }) {
  const sections = [{ name: null, lines: [] }]
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*$/)
    if (header) sections.push({ name: header[1], lines: [line] })
    else sections.at(-1).lines.push(line)
  }
  const kept = sections.filter(({ name }) =>
    name === null || (!name.startsWith("projects.") && !name.startsWith("hooks.state.")),
  )
  const provider = kept.find(({ name }) => name === "model_providers.copilot")
  if (!provider) throw new Error("missing [model_providers.copilot]")
  let providerUrl = false
  provider.lines = provider.lines.map((line) => {
    if (/^\s*base_url\s*=/.test(line)) {
      providerUrl = true
      return `base_url = "http://localhost:${port}/v1"`
    }
    return line
  })
  if (!providerUrl) throw new Error("missing Copilot base_url")
  const mcp = kept.find(({ name }) => name === "mcp_servers.copilotApi")
  if (mcp) mcp.lines = mcp.lines.map((line) =>
    /^\s*url\s*=/.test(line) ? `url = "http://localhost:${port}/mcp"` : line,
  )
  return `${kept.flatMap(({ lines }) => lines).join("\n").replaceAll("__CODEX_HOME__", home).trimEnd()}\n`
}

export function transformHooks(value, { platform, home }) {
  if (platform === "win32") return { hooks: {} }
  return JSON.parse(JSON.stringify(value).replaceAll("__CODEX_HOME__", home))
}
```

`migrateConfig` validates malformed hook JSON, unsupported platforms, and source/target paths outside the passed roots before it writes or creates a backup.

- [ ] **Step 4: Add merge, backup, dry-run, and permission tests**

```ts
test("snapshot wins while unrelated skills survive", async () => {
  const { source, target, backup } = await makeTempTree()
  await writeFixture(`${target}/skills/keep/SKILL.md`, "keep")
  await writeFixture(`${target}/skills/shared/SKILL.md`, "old")
  await writeFixture(`${source}/skills/shared/SKILL.md`, "new")
  const result = await migration.migrateConfig({ source, target, backup, home: target, port: 4141, platform: "linux" })
  expect(await Bun.file(`${target}/skills/keep/SKILL.md`).text()).toBe("keep")
  expect(await Bun.file(`${target}/skills/shared/SKILL.md`).text()).toBe("new")
  expect(result.changed).toContain("skills/shared/SKILL.md")
})

test("dry-run leaves target byte-identical", async () => {
  const { source, target, backup } = await makeTempTree()
  await writeFixture(`${target}/config.toml`, '[model_providers.copilot]\nbase_url = "http://localhost:4141/v1"\n')
  await writeFixture(`${source}/config.toml`, '[model_providers.copilot]\nbase_url = "http://localhost:4141/v1"\n')
  const before = await treeHashes(target)
  await migration.migrateConfig({ source, target, backup, home: target, port: 4141, platform: "linux", dryRun: true })
  expect(await treeHashes(target)).toEqual(before)
})
```

- [ ] **Step 5: Run migration tests and full type-independent lint**

Run: `bun test tests/deploy-codex-migrate.test.ts && bunx eslint tests/deploy-codex-migrate.test.ts`

Expected: all migration tests pass and ESLint exits 0.

- [ ] **Step 6: Commit the migration helper**

```bash
git add deploy/codex/lib/migrate-config.mjs tests/deploy-codex-migrate.test.ts
git commit -m "feat(deploy): add portable Codex config migration"
```

### Task 2: Shared service verification helper

**Files:**
- Create: `deploy/codex/lib/verify-service.mjs`
- Create: `tests/deploy-codex-verify.test.ts`

**Interfaces:**
- Consumes CLI flags `--base-url`, `--managed-root`, and optional `--offline`.
- Produces exported `verifyLocal(options)`, `verifyOnline(options)`, and `runVerification(options)` returning `{ status, checks }`; CLI prints the same object as JSON.
- Also exports focused `verifyResponseTiers(options)` and `verifyMcp(options)` functions used by unit tests and composed by `verifyOnline`.
- Exit codes: `0` success or deferred online checks, `2` local installation failure, `3` reachable-upstream capability failure.

- [ ] **Step 1: Write failing mock-server tests**

```ts
test("accepts local identity and defers unreachable online checks", async () => {
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/") return new Response("Server running")
      return Response.json({ object: "list", data: [{ id: "gpt-5.6-sol" }] })
    },
  })
  const result = await verifier.runVerification({ baseUrl: server.url.href, offline: true })
  expect(result.status).toBe("deferred")
  expect(result.checks.localRoot.ok).toBe(true)
  expect(result.checks.models.ok).toBe(true)
})

test("verifies Standard and Fast response tiers", async () => {
  const tierAwareFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return Response.json({
      status: "completed",
      service_tier: body.service_tier === "priority" ? "priority" : "default",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    })
  }
  const result = await verifier.verifyResponseTiers({ baseUrl: "http://fixture", fetch: tierAwareFetch })
  expect(result.standard.serviceTier).toBe("default")
  expect(result.fast.serviceTier).toBe("priority")
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `bun test tests/deploy-codex-verify.test.ts`

Expected: FAIL because `deploy/codex/lib/verify-service.mjs` does not exist.

- [ ] **Step 3: Implement local checks and online/deferred classification**

```js
export async function runVerification(options) {
  const local = await verifyLocal(options)
  if (!local.ok) return { status: "failed", checks: local.checks, exitCode: 2 }
  if (options.offline) return { status: "deferred", checks: local.checks, exitCode: 0 }
  try {
    const online = await verifyOnline(options)
    return { status: "ok", checks: { ...local.checks, ...online.checks }, exitCode: 0 }
  } catch (error) {
    if (isConnectivityError(error)) return { status: "deferred", checks: { ...local.checks, online: { ok: false, deferred: true } }, exitCode: 0 }
    return { status: "failed", checks: { ...local.checks, online: { ok: false, message: String(error) } }, exitCode: 3 }
  }
}
```

Implement MCP initialize/tool-list requests as a session-aware pair, parse SSE completion events, and distinguish connection/DNS/timeout errors from HTTP/model/authentication errors.

```js
class HttpVerificationError extends Error {
  constructor(check, status) {
    super(`${check} returned HTTP ${status}`)
    this.status = status
  }
}

async function readJsonOrSse(response) {
  if (!response.ok) throw new HttpVerificationError("MCP request", response.status)
  const text = await response.text()
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const messages = text.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()))
    return messages.at(-1)
  }
  return JSON.parse(text)
}

export async function verifyMcp({ baseUrl, fetch = globalThis.fetch }) {
  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "copilot-codex-verifier", version: "1" } } }),
  })
  if (!initialized.ok) throw new HttpVerificationError("MCP initialize", initialized.status)
  const session = initialized.headers.get("mcp-session-id")
  const listed = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  })
  const payload = await readJsonOrSse(listed)
  const tools = payload.result?.tools?.map((tool) => tool.name) ?? []
  if (!tools.includes("web_search")) throw new Error("MCP web_search missing")
  return { mcp: { ok: true, tools } }
}

function isConnectivityError(error) {
  return error instanceof TypeError || error?.name === "AbortError" || ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(error?.cause?.code)
}
```

- [ ] **Step 4: Add malformed response, MCP, compact, and timeout tests**

```ts
test.each([401, 403, 400])("does not defer reachable HTTP %s failures", async (status) => {
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/") return new Response("Server running")
      if (pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "gpt-5.6-sol" }] })
      return new Response("failure", { status })
    },
  })
  const result = await verifier.runVerification({ baseUrl: server.url.href })
  expect(result.status).toBe("failed")
  expect(result.exitCode).toBe(3)
})

test("initializes MCP and lists web_search", async () => {
  let initialized = false
  const mcpFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.method === "initialize") {
      initialized = true
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "fixture-session" } })
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "web_search" }] } })
  }
  const result = await verifier.verifyMcp({ baseUrl: "http://fixture", fetch: mcpFetch })
  expect(initialized).toBe(true)
  expect(result.mcp.tools).toContain("web_search")
})
```

- [ ] **Step 5: Run verifier tests**

Run: `bun test tests/deploy-codex-verify.test.ts`

Expected: all verifier tests pass.

- [ ] **Step 6: Commit the verifier**

```bash
git add deploy/codex/lib/verify-service.mjs tests/deploy-codex-verify.test.ts
git commit -m "feat(deploy): verify portable Codex API capabilities"
```

### Task 3: Transactional Linux installer and diagnostics

**Files:**
- Create: `deploy/codex/install.sh`
- Create: `deploy/codex/diagnose.sh`
- Create: `tests/deploy-codex-install.test.ts`

**Interfaces:**
- `install.sh` consumes package-relative `dist/`, `codex-config/`, `credentials/`, `lib/`, and `MANIFEST.sha256` plus `PORT`, `CODEX_HOME`, `SUPERVISOR`, `OFFLINE`, `BACKUP_DIR`, and test-only `INSTALL_ROOT` and `PACKAGE_ROOT`.
- Produces `~/.local/share/copilot-api-patched`, migrated Codex files, a systemd user service or `copilot-api-ctl`, and a timestamped backup.
- `diagnose.sh` is read-only and accepts `PORT` and `CODEX_HOME`.

- [ ] **Step 1: Write failing tests for preflight and unrelated port refusal**

```ts
import { mkdtemp, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompleteInstallerFixture, pathExists, runCommand } from "./helpers/deploy-codex"

async function runInstaller(environment: Record<string, string>) {
  return runCommand("bash", ["deploy/codex/install.sh"], { env: { ...process.env, ...environment } })
}

test("fails before mutation when Node or Codex is unavailable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "copilot-codex-install-"))
  const fixtureBinWithoutCodex = join(tempRoot, "bin")
  await mkdir(fixtureBinWithoutCodex)
  await symlink(process.execPath, join(fixtureBinWithoutCodex, "node"))
  const result = await runInstaller({ PATH: fixtureBinWithoutCodex, INSTALL_ROOT: tempRoot })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("Codex CLI")
  expect(await pathExists(`${tempRoot}/share/copilot-api-patched`)).toBe(false)
})

test("does not kill an unrelated listener", async () => {
  const fixture = await createCompleteInstallerFixture()
  using listener = Bun.serve({ port: 0, fetch: () => new Response("foreign") })
  const result = await runInstaller({
    PORT: String(listener.port),
    INSTALL_ROOT: fixture.installRoot,
    PACKAGE_ROOT: fixture.packageRoot,
    PATH: fixture.path,
  })
  expect(result.exitCode).not.toBe(0)
  expect(await fetch(listener.url).then((r) => r.text())).toBe("foreign")
})
```

- [ ] **Step 2: Run focused tests and confirm installer-not-found failures**

Run: `bun test tests/deploy-codex-install.test.ts -t "preflight|unrelated"`

Expected: FAIL because `deploy/codex/install.sh` does not exist.

- [ ] **Step 3: Implement manifest preflight, staging, and guarded port handling**

```bash
require_cmd node
require_cmd codex
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 20 ] || die "需要 Node.js 20 或更新版本"
verify_manifest "$SELF_DIR/MANIFEST.sha256"

busy_pid=$(port_pid || true)
if [ -n "$busy_pid" ] && ! process_is_managed "$busy_pid" "$SHARE"; then
  die "端口 $PORT 被非托管进程占用；不会停止 pid $busy_pid"
fi
```

Use explicit paths beneath `INSTALL_ROOT` during tests and normal home-relative roots otherwise. Never recursively remove an unresolved or broad target.

- [ ] **Step 4: Implement backup, service activation, rollback trap, and offline success**

```bash
rollback() {
  status=$?
  trap - ERR INT TERM
  restore_backup "$BACKUP"
  restore_previous_service_state
  exit "$status"
}
trap rollback ERR INT TERM

stage_payload
activate_payload
install_service
node "$SHARE/lib/verify-service.mjs" --base-url "http://localhost:$PORT" ${OFFLINE:+--offline}
trap - ERR INT TERM
```

Reuse the proven systemd-bus detection and `setsid`/pidfile controller semantics from `deploy/install.sh`, changing names and config migration for Codex.

- [ ] **Step 5: Write and test read-only Linux diagnostics**

```bash
node --version
codex --version
copilot-api-ctl status 2>/dev/null || systemctl --user status copilot-api.service --no-pager
node "$SHARE/lib/verify-service.mjs" --base-url "http://localhost:$PORT" --offline
```

Run: `bash -n deploy/codex/install.sh deploy/codex/diagnose.sh && bun test tests/deploy-codex-install.test.ts`

Expected: shell syntax and all isolated-home transaction tests pass.

- [ ] **Step 6: Commit Linux installation support**

```bash
git add deploy/codex/install.sh deploy/codex/diagnose.sh tests/deploy-codex-install.test.ts
git commit -m "feat(deploy): add offline Linux Codex installer"
```

### Task 4: Native Windows installer, controller, diagnostics, and CI parsing

**Files:**
- Create: `deploy/codex/install.ps1`
- Create: `deploy/codex/diagnose.ps1`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/deploy-codex-install.test.ts`

**Interfaces:**
- `install.ps1` accepts `-Port`, `-CodexHome`, `-Offline`, `-BackupDir`, `-NoScheduledTask`, and test-only `-InstallRoot`.
- Produces `%LOCALAPPDATA%\copilot-api-patched`, `%LOCALAPPDATA%\Programs\copilot-api-ctl.ps1`, migrated Codex files, logs, backup, and optional `CopilotApiPatched` scheduled task.
- `diagnose.ps1` accepts `-Port` and `-CodexHome` and never mutates state.

- [ ] **Step 1: Add package-contract tests for Windows assets and dangerous operations**

```ts
test("Windows installer is per-user and exposes required parameters", async () => {
  const script = await Bun.file("deploy/codex/install.ps1").text()
  for (const parameter of ["Port", "CodexHome", "Offline", "BackupDir", "NoScheduledTask"]) {
    expect(script).toContain(`$${parameter}`)
  }
  expect(script).toContain("CopilotApiPatched")
  expect(script).not.toMatch(/RunAs|HighestAvailable|\/RL\s+HIGHEST/i)
})
```

- [ ] **Step 2: Run the Windows contract test and confirm missing-file failure**

Run: `bun test tests/deploy-codex-install.test.ts -t "Windows"`

Expected: FAIL because `deploy/codex/install.ps1` does not exist.

- [ ] **Step 3: Implement PowerShell preflight, manifest verification, transaction, and control script**

```powershell
[CmdletBinding()]
param(
  [int]$Port = 4141,
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }),
  [switch]$Offline,
  [string]$BackupDir,
  [switch]$NoScheduledTask,
  [string]$InstallRoot
)
$ErrorActionPreference = "Stop"

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name is required" }
}

function Invoke-Rollback {
  Restore-Backup -Backup $script:Backup
  Restore-TaskState -State $script:PreviousTaskState
}
```

Verify hashes with `Get-FileHash`, query listeners with `Get-NetTCPConnection`, and inspect `Win32_Process.CommandLine` before stopping only a process rooted in the managed deployment. Generate `copilot-api-ctl.ps1` with explicit managed paths and `start|stop|restart|status|log` operations. Register a limited current-user logon task through `schtasks.exe` and start immediately.

- [ ] **Step 4: Implement Windows hook handling and diagnostics**

Call `migrate-config.mjs --platform win32`, retain the source hook JSON as `hooks.linux.json`, and ensure active `hooks.json` contains `{ "hooks": {} }`. Diagnostics use `Get-CimInstance`, `Get-ScheduledTask`, `Get-NetTCPConnection`, and the common verifier without printing token contents.

- [ ] **Step 5: Add a Windows CI parser job**

```yaml
  powershell-parse:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Parse native Windows scripts
        shell: powershell
        run: |
          $failed = $false
          Get-ChildItem deploy/codex/*.ps1 | ForEach-Object {
            $tokens = $null; $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
            if ($errors.Count -gt 0) { $errors | Format-List; $failed = $true }
          }
          if ($failed) { throw "PowerShell parser errors" }
```

- [ ] **Step 6: Run local contracts and commit Windows support**

Run: `bun test tests/deploy-codex-install.test.ts && bun run typecheck`

Expected: local contract tests and TypeScript checks pass; the PR's Windows runner performs native parser validation.

```bash
git add deploy/codex/install.ps1 deploy/codex/diagnose.ps1 tests/deploy-codex-install.test.ts .github/workflows/ci.yml
git commit -m "feat(deploy): add native Windows Codex installer"
```

### Task 5: Credential-aware automatic packer

**Files:**
- Create: `deploy/codex/pack.sh`
- Create: `deploy/codex/README.md`
- Modify: `.gitignore`
- Create: `tests/deploy-codex-pack.test.ts`

**Interfaces:**
- `pack.sh` consumes `OUT_DIR`, optional `CODEX_HOME`, the current repository/source home, and test-only `PACK_TEST_DIST` to bypass a real standalone build in fixture tests.
- Produces matching `copilot-codex-<date>-<sha>.tar.gz` and `.zip` plus terminal provenance/security output.

- [ ] **Step 1: Write failing packaging contract and exclusion tests**

```ts
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPackagingFixture, extractAndHashGeneratedArchives, runCommand } from "./helpers/deploy-codex"

async function buildFixturePackage() {
  const fixture = await createPackagingFixture()
  const out = await mkdtemp(join(tmpdir(), "copilot-codex-output-"))
  const result = await runCommand("bash", ["deploy/codex/pack.sh"], {
    env: { ...process.env, CODEX_HOME: fixture.codexHome, HOME: fixture.home, OUT_DIR: out, PACK_TEST_DIST: fixture.dist },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return extractAndHashGeneratedArchives(out)
}

test("package includes credentials and excludes runtime state", async () => {
  const files = await buildFixturePackage()
  for (const required of [
    "dist/main.js", "codex-config/config.toml", "codex-config/auth.json",
    "credentials/github_token", "install.sh", "install.ps1", "MANIFEST.sha256",
  ]) expect(files).toContain(required)
  expect(files.some((file) => file.includes("sessions") || file.endsWith(".sqlite"))).toBe(false)
  expect(files.some((file) => file.includes("skills/.system"))).toBe(false)
})

test("tar and zip payload hashes are identical", async () => {
  const { tarHashes, zipHashes } = await buildFixturePackage()
  expect(tarHashes).toEqual(zipHashes)
})
```

- [ ] **Step 2: Run focused tests and confirm missing-packer failure**

Run: `bun test tests/deploy-codex-pack.test.ts`

Expected: FAIL because `deploy/codex/pack.sh` does not exist.

- [ ] **Step 3: Implement standalone build, private snapshot, and portable marker normalization**

```bash
umask 077
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

bun install --frozen-lockfile
bun run build:standalone
cp -a dist-standalone "$ROOT/dist"
install -m 600 "$CODEX_HOME/config.toml" "$ROOT/codex-config/config.toml"
install -m 600 "$CODEX_HOME/auth.json" "$ROOT/codex-config/auth.json"
install -m 600 "$TOKEN_FILE" "$ROOT/credentials/github_token"
```

Copy user skills with `.system` excluded, copy plugin cache with `.remote-plugin-install-staging` excluded, and normalize copied source-home strings to `__CODEX_HOME__` without altering live source files.

- [ ] **Step 4: Implement provenance, manifest, dual archives, and extraction verification**

```bash
(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
tar -czf "$TAR_OUT" -C "$STAGE" "$NAME"
(cd "$STAGE" && zip -qr "$ZIP_OUT" "$NAME")
verify_extracted_archive "$TAR_OUT" tar
verify_extracted_archive "$ZIP_OUT" zip
compare_archive_hashes "$TAR_OUT" "$ZIP_OUT"
```

On any post-output failure, remove only the two explicitly resolved new output paths. Print a credential warning and exact install commands on success.

- [ ] **Step 5: Document private transfer, offline semantics, install, diagnostics, and rollback**

Document:

```text
Linux:   tar xzf copilot-codex-*.tar.gz && cd copilot-codex-* && bash install.sh
Windows: Expand-Archive .\copilot-codex-*.zip; Set-ExecutionPolicy -Scope Process Bypass; .\copilot-codex-*\install.ps1
Offline means no installation downloads; Copilot inference still needs GitHub network access.
The archives contain live credentials and must not be published.
```

- [ ] **Step 6: Run packaging tests and commit**

Run: `bash -n deploy/codex/pack.sh && bun test tests/deploy-codex-pack.test.ts`

Expected: packaging tests pass without reading the real user's credentials; fixtures supply isolated test credentials.

```bash
git add deploy/codex/pack.sh deploy/codex/README.md tests/deploy-codex-pack.test.ts .gitignore
git commit -m "feat(deploy): package private offline Codex bundles"
```

### Task 6: Build the real private bundle and complete end-to-end verification

**Files:**
- Modify only if verification exposes defects: files introduced in Tasks 1-5.
- Generate locally, never stage: `copilot-codex-<date>-<sha>.tar.gz`, `copilot-codex-<date>-<sha>.zip`.

**Interfaces:**
- Consumes the real current Codex configuration and credentials authorized by the user.
- Produces final verified local archives and updates the existing PR branch with source-only commits.

- [ ] **Step 1: Run all repository verification before packaging**

Run:

```bash
bun test
bun run typecheck
bun run lint src/routes/responses/handler.ts tests/responses-smoke.test.ts deploy/codex tests/deploy-codex-*.test.ts
bun run build
bun run build:standalone
```

Expected: all tests, typecheck, focused lint, and both builds pass. Record separately any pre-existing unrelated `lint:all` failures.

- [ ] **Step 2: Build real credential-bearing archives**

Run: `OUT_DIR="$PWD" bash deploy/codex/pack.sh`

Expected: tar and zip paths, sizes, hashes, provenance, and private-credential warning are printed; neither output appears in `git status`.

- [ ] **Step 3: Verify the generated package on an isolated Linux home and unused port**

```bash
TEST_ROOT=$(mktemp -d)
TEST_HOME="$TEST_ROOT/home"
TEST_PORT=14142
mkdir -p "$TEST_HOME"
tar -xzf copilot-codex-*.tar.gz -C "$TEST_ROOT"
PACKAGE_DIR=$(find "$TEST_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'copilot-codex-*' -print -quit)
HOME="$TEST_HOME" PORT="$TEST_PORT" SUPERVISOR=nohup OFFLINE=1 bash "$PACKAGE_DIR/install.sh"
curl --fail --silent "http://localhost:$TEST_PORT/"
HOME="$TEST_HOME" "$PACKAGE_DIR/diagnose.sh"
HOME="$TEST_HOME" "$TEST_HOME/.local/bin/copilot-api-ctl" stop
```

Use explicit resolved extraction and temporary-home paths; clean up only the temporary test directory and test process after confirming its PID belongs to that directory.

- [ ] **Step 4: Run online capability smoke tests through the isolated deployment**

Run: `node "$PACKAGE_DIR/lib/verify-service.mjs" --base-url "http://localhost:$TEST_PORT" --managed-root "$TEST_HOME/.local/share/copilot-api-patched"`

Expected: Standard returns `default`, Fast returns `priority`, compaction completes, and MCP lists `web_search`.

- [ ] **Step 5: Review Git state and push source changes to the existing PR**

```bash
git status --short
git log --oneline --decorate -8
git push origin feat/codex-responses-compat
gh pr view 1 --repo TZHSW/copilot-api --json url,state,headRefName,commits,statusCheckRollup
```

Expected: only the deliberately extracted old `copilot-cc-20260814-ff37084/` directory may remain untracked; no credential snapshot or new archive is staged. PR 1 remains open and contains all source commits.

- [ ] **Step 6: Report the local artifact paths and Windows acceptance boundary**

Report both archive paths and SHA-256 hashes, source commits, Linux isolated-install results, online capability results, and Windows CI parser status. State explicitly that native scheduled-task behavior still requires a real Windows acceptance run if no Windows runner has completed it.
