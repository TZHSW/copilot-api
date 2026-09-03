// @ts-check

import { execFileSync } from "node:child_process"
import { readFile, readlink, realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

const EXPECTED_MODEL = "gpt-5.6-sol"
const MCP_PROTOCOL_VERSION = "2025-06-18"
const DEFERRED_HTTP_STATUSES = new Set([502, 503, 504])

class HttpVerificationError extends Error {
  /**
   * @param {string} check
   * @param {number} status
   * @param {string} [detail]
   */
  constructor(check, status, detail = "") {
    super(`${check} returned HTTP ${status}${detail ? `: ${detail}` : ""}`)
    this.name = "HttpVerificationError"
    this.status = status
  }
}

/** @param {string} baseUrl */
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "")
}

/**
 * @param {typeof globalThis.fetch} fetchImplementation
 * @param {string} url
 * @param {{ init?: RequestInit, timeoutMs?: number }} [options]
 */
async function fetchWithTimeout(
  fetchImplementation,
  url,
  { init = {}, timeoutMs = 30_000 } = {},
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref()
  try {
    return await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** @param {Response} response */
async function responseDetail(response) {
  const text = await response.text()
  return text.replaceAll(/\s+/g, " ").slice(0, 300)
}

/**
 * @param {Response} response
 * @param {string} check
 */
async function requireOk(response, check) {
  if (!response.ok) {
    throw new HttpVerificationError(
      check,
      response.status,
      await responseDetail(response),
    )
  }
  return response
}

/** @param {string} text */
function parseSse(text) {
  /** @type {Array<Record<string, unknown>>} */
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data || data === "[DONE]") continue
    const parsed = /** @type {unknown} */ (JSON.parse(data))
    if (typeof parsed === "object" && parsed !== null) {
      events.push(asRecord(parsed))
    }
  }
  return events
}

/**
 * @param {Response} response
 * @param {string} check
 */
async function readJsonOrSse(response, check) {
  await requireOk(response, check)
  const text = await response.text()
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const events = parseSse(text)
    if (events.length === 0) throw new Error(`${check} returned empty SSE`)
    return events.at(-1)
  }
  /** @type {unknown} */
  const parsed = JSON.parse(text)
  return parsed
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("response must be a JSON object")
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {object} options
 * @param {string} options.main
 * @param {string} options.nodePath
 * @param {number} options.port
 * @param {number} options.processId
 */
async function verifyManagedProcess({ main, nodePath, port, processId }) {
  if (!Number.isInteger(processId) || processId < 1) {
    throw new Error("managed process id is invalid")
  }
  if (process.platform === "win32") {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}'; if(-not $p){exit 3}; @{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress`
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
      },
    )
    const details = asRecord(/** @type {unknown} */ (JSON.parse(output)))
    if (
      String(details.ExecutablePath).toLowerCase()
      !== resolve(nodePath).toLowerCase()
    ) {
      throw new Error("managed process executable does not match Node")
    }
    const commandLine = String(details.CommandLine)
    if (
      !commandLine.includes(main)
      || !commandLine.includes(" start ")
      || !commandLine.includes("--account-type enterprise")
      || !commandLine.includes(`--port ${port}`)
    ) {
      throw new Error("managed process command line does not match deployment")
    }
    return
  }

  const [actualNode, expectedNode, commandLine] = await Promise.all([
    readlink(`/proc/${processId}/exe`),
    realpath(resolve(nodePath)),
    readFile(`/proc/${processId}/cmdline`),
  ])
  if (resolve(actualNode) !== resolve(expectedNode)) {
    throw new Error("managed process executable does not match Node")
  }
  const arguments_ = commandLine.toString("utf8").split("\0")
  if (
    arguments_[1] !== main
    || arguments_[2] !== "start"
    || arguments_[3] !== "--account-type"
    || arguments_[4] !== "enterprise"
    || arguments_[5] !== "--port"
    || arguments_[6] !== String(port)
  ) {
    throw new Error("managed process command line does not match deployment")
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {string} [options.managedRoot]
 * @param {string} [options.nodePath]
 * @param {number} [options.processId]
 */
export async function verifyLocal({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
  managedRoot,
  nodePath,
  processId,
}) {
  const root = normalizeBaseUrl(baseUrl)
  /** @type {Record<string, unknown>} */
  const checks = {}

  try {
    const response = await fetchWithTimeout(fetchImplementation, `${root}/`)
    const body = await response.text()
    const ok = response.ok && body.includes("Server running")
    checks.localRoot = { ok, status: response.status }
    if (!ok) return { checks, ok: false }
  } catch (error) {
    checks.localRoot = { message: errorMessage(error), ok: false }
    return { checks, ok: false }
  }

  try {
    const response = await requireOk(
      await fetchWithTimeout(fetchImplementation, `${root}/v1/models`),
      "model directory",
    )
    const payload = asRecord(/** @type {unknown} */ (await response.json()))
    const data = /** @type {Array<unknown>} */ (
      Array.isArray(payload.data) ? payload.data : []
    )
    const ids = data
      .map((model) =>
        typeof model === "object" && model !== null && "id" in model ?
          model.id
        : undefined,
      )
      .filter((id) => typeof id === "string")
    const ok = ids.includes(EXPECTED_MODEL)
    checks.models = { count: ids.length, ok }
    if (!ok) return { checks, ok: false }
  } catch (error) {
    checks.models = { message: errorMessage(error), ok: false }
    return { checks, ok: false }
  }

  if (managedRoot) {
    try {
      const main = join(resolve(managedRoot), "dist", "main.js")
      const entry = await stat(main)
      if (!entry.isFile()) throw new Error("managed main.js is not a file")
      if (!nodePath || !processId) {
        throw new Error("managed process identity was not provided")
      }
      const url = new URL(root)
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
      await verifyManagedProcess({ main, nodePath, port, processId })
      checks.managedRoot = { ok: true }
      checks.managedProcess = { ok: true, processId }
    } catch (error) {
      checks.managedRoot = { message: errorMessage(error), ok: false }
      return { checks, ok: false }
    }
  }

  return { checks, ok: true }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function verifyResponseTiers({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  const root = normalizeBaseUrl(baseUrl)

  /** @param {"default" | "priority"} tier */
  async function runTier(tier) {
    const payload = {
      input: `Reply with exactly: portable-${tier}-ok`,
      model: EXPECTED_MODEL,
      stream: false,
      ...(tier === "priority" ? { service_tier: "priority" } : {}),
    }
    const response = await fetchWithTimeout(
      fetchImplementation,
      `${root}/v1/responses`,
      {
        init: {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
        timeoutMs: 90_000,
      },
    )
    await requireOk(response, `${tier} Responses`)
    const body = asRecord(/** @type {unknown} */ (await response.json()))
    if (body.status !== "completed") {
      throw new Error(`${tier} Responses did not complete`)
    }
    if (body.service_tier !== tier) {
      throw new Error(
        `${tier} Responses reported service_tier=${String(body.service_tier)}`,
      )
    }
    return { ok: true, serviceTier: tier }
  }

  return {
    fast: await runTier("priority"),
    standard: await runTier("default"),
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function verifyCompaction({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  const root = normalizeBaseUrl(baseUrl)
  const response = await fetchWithTimeout(
    fetchImplementation,
    `${root}/v1/responses`,
    {
      init: {
        body: JSON.stringify({
          input: [
            { content: "Preserve the portable verifier state.", role: "user" },
            { type: "compaction_trigger" },
          ],
          model: EXPECTED_MODEL,
          stream: true,
        }),
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      },
      timeoutMs: 90_000,
    },
  )
  await requireOk(response, "remote compaction")
  const events = parseSse(await response.text())
  const completed = events.find(
    (event) =>
      event.type === "response.completed"
      && typeof event.response === "object"
      && event.response !== null
      && "status" in event.response
      && event.response.status === "completed",
  )
  if (!completed) throw new Error("remote compaction did not complete")
  return { compaction: { ok: true } }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function verifyMcp({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  const root = normalizeBaseUrl(baseUrl)
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  }
  const initialized = await fetchWithTimeout(
    fetchImplementation,
    `${root}/mcp`,
    {
      init: {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "copilot-codex-verifier", version: "1" },
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
        }),
        headers,
        method: "POST",
      },
    },
  )
  const initializePayload = asRecord(
    await readJsonOrSse(initialized, "MCP initialize"),
  )
  if (!("result" in initializePayload)) {
    throw new Error("MCP initialize returned no result")
  }
  const session = initialized.headers.get("mcp-session-id")
  const sessionHeaders = {
    ...headers,
    ...(session ? { "mcp-session-id": session } : {}),
  }
  const notification = await fetchWithTimeout(
    fetchImplementation,
    `${root}/mcp`,
    {
      init: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        headers: sessionHeaders,
        method: "POST",
      },
    },
  )
  await requireOk(notification, "MCP initialized notification")
  const listed = await fetchWithTimeout(fetchImplementation, `${root}/mcp`, {
    init: {
      body: JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: sessionHeaders,
      method: "POST",
    },
  })
  const toolsPayload = asRecord(await readJsonOrSse(listed, "MCP tools/list"))
  const result = asRecord(toolsPayload.result)
  const toolEntries = /** @type {Array<unknown>} */ (
    Array.isArray(result.tools) ? result.tools : []
  )
  const tools =
    toolEntries.length > 0 ?
      toolEntries
        .map((tool) =>
          (
            typeof tool === "object"
            && tool !== null
            && "name" in tool
            && typeof tool.name === "string"
          ) ?
            tool.name
          : undefined,
        )
        .filter((name) => typeof name === "string")
    : []
  if (!tools.includes("web_search")) throw new Error("MCP web_search missing")
  return { mcp: { ok: true, tools } }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function verifyOnline(options) {
  const responses = await verifyResponseTiers(options)
  const compaction = await verifyCompaction(options)
  const mcp = await verifyMcp(options)
  return {
    checks: { compaction: compaction.compaction, mcp: mcp.mcp, responses },
    ok: true,
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} error */
function isConnectivityError(error) {
  if (
    error instanceof HttpVerificationError
    && DEFERRED_HTTP_STATUSES.has(error.status)
  ) {
    return true
  }
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return true
  if (!(error instanceof TypeError)) return false
  const cause = /** @type {{ code?: unknown } | undefined} */ (error.cause)
  return (
    cause === undefined
    || ["ECONNREFUSED", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"].includes(
      String(cause.code),
    )
  )
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {string} [options.managedRoot]
 * @param {string} [options.nodePath]
 * @param {boolean} [options.offline]
 * @param {number} [options.processId]
 */
export async function runVerification(options) {
  const local = await verifyLocal(options)
  if (!local.ok) {
    return { checks: local.checks, exitCode: 2, status: "failed" }
  }
  if (options.offline) {
    return {
      checks: {
        ...local.checks,
        online: { deferred: true, ok: false, reason: "offline mode" },
      },
      exitCode: 0,
      status: "deferred",
    }
  }
  try {
    const online = await verifyOnline(options)
    return {
      checks: { ...local.checks, ...online.checks },
      exitCode: 0,
      status: "ok",
    }
  } catch (error) {
    const deferred = isConnectivityError(error)
    return {
      checks: {
        ...local.checks,
        online: {
          deferred,
          message: errorMessage(error),
          ok: false,
        },
      },
      exitCode: deferred ? 0 : 3,
      status: deferred ? "deferred" : "failed",
    }
  }
}

/** @param {Array<string>} args */
function parseArguments(args) {
  /** @type {{ baseUrl?: string, managedRoot?: string, nodePath?: string, offline?: boolean, processId?: number }} */
  const options = { offline: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--offline") {
      options.offline = true
      continue
    }
    if (
      argument !== "--base-url"
      && argument !== "--managed-root"
      && argument !== "--node-path"
      && argument !== "--process-id"
    ) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`)
    }
    switch (argument) {
      case "--base-url": {
        options.baseUrl = value
        break
      }
      case "--managed-root": {
        options.managedRoot = value
        break
      }
      case "--node-path": {
        options.nodePath = value
        break
      }
      default: {
        options.processId = Number(value)
      }
    }
    index += 1
  }
  if (!options.baseUrl) throw new Error("missing --base-url")
  return /** @type {{ baseUrl: string, managedRoot?: string, nodePath?: string, offline?: boolean, processId?: number }} */ (
    options
  )
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)

if (isMain) {
  try {
    const result = await runVerification(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 2
  }
}
