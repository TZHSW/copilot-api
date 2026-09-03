import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fetch as undiciFetch } from "undici"

const nativeFetch = undiciFetch as unknown as typeof globalThis.fetch

interface VerificationResult {
  checks: Record<string, unknown>
  exitCode: number
  status: "deferred" | "failed" | "ok"
}

interface VerifierModule {
  runVerification: (options: {
    baseUrl: string
    fetch?: typeof globalThis.fetch
    managedRoot?: string
    nodePath?: string
    offline?: boolean
    processId?: number
  }) => Promise<VerificationResult>
  verifyCompaction: (options: {
    baseUrl: string
    fetch?: typeof globalThis.fetch
  }) => Promise<unknown>
  verifyMcp: (options: {
    baseUrl: string
    fetch?: typeof globalThis.fetch
  }) => Promise<{
    mcp: { tools: Array<string> }
  }>
  verifyResponseTiers: (options: {
    baseUrl: string
    fetch?: typeof globalThis.fetch
  }) => Promise<{
    fast: { serviceTier: string }
    standard: { serviceTier: string }
  }>
}

const verifier = (await import(
  pathToFileURL(`${process.cwd()}/deploy/codex/lib/verify-service.mjs`).href
)) as VerifierModule

async function withServer<T>(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<T>,
) {
  const server = Bun.serve({ fetch, port: 0 })
  try {
    return await run(server.url.href)
  } finally {
    await server.stop(true)
  }
}

function localRoute(request: Request) {
  const pathname = new URL(request.url).pathname
  if (pathname === "/") return new Response("Server running")
  if (pathname === "/v1/models") {
    return Response.json({
      data: [{ id: "gpt-5.6-sol", object: "model" }],
      object: "list",
    })
  }
  return undefined
}

describe("portable service local verification", () => {
  test("passes local identity checks and defers online checks in offline mode", async () => {
    await withServer(
      (request) =>
        localRoute(request) ?? new Response("unexpected", { status: 500 }),
      async (baseUrl) => {
        const result = await verifier.runVerification({
          baseUrl,
          fetch: nativeFetch,
          offline: true,
        })

        expect(result.status).toBe("deferred")
        expect(result.exitCode).toBe(0)
        expect(result.checks).toMatchObject({
          localRoot: { ok: true },
          models: { count: 1, ok: true },
          online: { deferred: true, ok: false },
        })
      },
    )
  })

  test("fails locally when the expected model is absent", async () => {
    await withServer(
      (request) => {
        if (new URL(request.url).pathname === "/") {
          return new Response("Server running")
        }
        return Response.json({ data: [{ id: "other" }], object: "list" })
      },
      async (baseUrl) => {
        const result = await verifier.runVerification({
          baseUrl,
          fetch: nativeFetch,
          offline: true,
        })

        expect(result.status).toBe("failed")
        expect(result.exitCode).toBe(2)
        expect(result.checks.models).toMatchObject({ ok: false })
      },
    )
  })

  test("rejects a managed PID whose executable is not the configured Node", async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), "managed-api-"))
    await mkdir(join(managedRoot, "dist"))
    await writeFile(join(managedRoot, "dist/main.js"), "fixture")
    const unrelated = Bun.spawn(["sleep", "30"])
    try {
      await withServer(
        (request) =>
          localRoute(request) ?? new Response("unexpected", { status: 500 }),
        async (baseUrl) => {
          const result = await verifier.runVerification({
            baseUrl,
            fetch: nativeFetch,
            managedRoot,
            nodePath: process.execPath,
            offline: true,
            processId: unrelated.pid,
          })

          expect(result.status).toBe("failed")
          expect(result.exitCode).toBe(2)
          expect(result.checks.managedRoot).toMatchObject({ ok: false })
          expect(unrelated.exitCode).toBeNull()
        },
      )
    } finally {
      unrelated.kill()
      await unrelated.exited
    }
  })
})

describe("portable service online verification", () => {
  test("distinguishes Standard and Fast service tiers", async () => {
    await withServer(
      async (request) => {
        const payload = (await request.json()) as { service_tier?: string }
        return Response.json({
          output: [
            {
              content: [{ text: "ok", type: "output_text" }],
              type: "message",
            },
          ],
          service_tier:
            payload.service_tier === "priority" ? "priority" : "default",
          status: "completed",
        })
      },
      async (baseUrl) => {
        const result = await verifier.verifyResponseTiers({
          baseUrl,
          fetch: nativeFetch,
        })

        expect(result.standard.serviceTier).toBe("default")
        expect(result.fast.serviceTier).toBe("priority")
      },
    )
  })

  test("accepts a streamed remote compaction completion", async () => {
    await withServer(
      async (request) => {
        const payload = (await request.json()) as {
          input?: Array<{ type?: string }>
          stream?: boolean
        }
        expect(payload.stream).toBe(true)
        expect(
          payload.input?.some((item) => item.type === "compaction_trigger"),
        ).toBe(true)
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      async (baseUrl) => {
        expect(
          await verifier.verifyCompaction({ baseUrl, fetch: nativeFetch }),
        ).toMatchObject({ compaction: { ok: true } })
      },
    )
  })

  test("initializes an MCP session and lists web_search", async () => {
    let initialized = false
    await withServer(
      async (request) => {
        const payload = (await request.json()) as { id: number; method: string }
        if (payload.method === "initialize") {
          initialized = true
          return Response.json(
            {
              id: payload.id,
              jsonrpc: "2.0",
              result: {
                capabilities: {},
                protocolVersion: "2025-06-18",
                serverInfo: { name: "fixture", version: "1" },
              },
            },
            { headers: { "mcp-session-id": "fixture-session" } },
          )
        }
        expect(request.headers.get("mcp-session-id")).toBe("fixture-session")
        return Response.json({
          id: payload.id,
          jsonrpc: "2.0",
          result: { tools: [{ name: "web_search" }] },
        })
      },
      async (baseUrl) => {
        const result = await verifier.verifyMcp({ baseUrl, fetch: nativeFetch })

        expect(initialized).toBe(true)
        expect(result.mcp.tools).toContain("web_search")
      },
    )
  })

  test("treats reachable authentication errors as failures", async () => {
    await withServer(
      (request) => {
        const local = localRoute(request)
        if (local) return local
        return Response.json(
          { error: { message: "unauthorized", type: "authentication_error" } },
          { status: 401 },
        )
      },
      async (baseUrl) => {
        const result = await verifier.runVerification({
          baseUrl,
          fetch: nativeFetch,
        })

        expect(result.status).toBe("failed")
        expect(result.exitCode).toBe(3)
      },
    )
  })

  test("defers gateway failures caused by an unreachable upstream", async () => {
    await withServer(
      (request) => {
        const local = localRoute(request)
        if (local) return local
        return Response.json(
          { error: { message: "upstream unavailable" } },
          { status: 503 },
        )
      },
      async (baseUrl) => {
        const result = await verifier.runVerification({
          baseUrl,
          fetch: nativeFetch,
        })

        expect(result.status).toBe("deferred")
        expect(result.exitCode).toBe(0)
        expect(result.checks.online).toMatchObject({
          deferred: true,
          ok: false,
        })
      },
    )
  })
})
