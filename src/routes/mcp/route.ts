import type { Context } from "hono"

import { Hono } from "hono"

import { copilotBaseUrl } from "~/lib/api-config"
import { state } from "~/lib/state"

/**
 * Transparent pass-through to GitHub's remote MCP server (github-mcp-server)
 * hosted at `<copilotBase>/mcp/readonly`.
 *
 * Injects the long-lived GitHub OAuth token (state.githubToken — the MCP
 * endpoint rejects the short-lived copilot completion token) and, by default,
 * exposes a curated read-only toolset via the X-MCP-Tools header: web_search
 * plus a few useful GitHub lookups. This lets a local MCP client (e.g. Claude
 * Code at http://localhost:<port>/mcp) use them without ever holding the token.
 *
 * The body is forwarded as-is and the (possibly SSE) response is streamed back,
 * including the mcp-session-id header the client needs for streamable HTTP.
 */
export const mcpRoutes = new Hono()

// Default tools exposed to clients. A client may override via its own
// X-MCP-Tools header (e.g. to widen or narrow the set).
const DEFAULT_TOOLS =
  "web_search,search_code,get_file_contents,search_repositories,get_latest_release,github_support_docs_search"

const handle = async (c: Context) => {
  if (!state.githubToken) {
    return c.json({ error: "GitHub token not found" }, 500)
  }

  const upstream = `${copilotBaseUrl(state)}/mcp/readonly`

  const headers: Record<string, string> = {
    authorization: `Bearer ${state.githubToken}`,
    "content-type": c.req.header("content-type") ?? "application/json",
    accept: c.req.header("accept") ?? "application/json, text/event-stream",
    // Default to a curated read-only set; let the client override if it asks.
    "x-mcp-tools": c.req.header("x-mcp-tools") ?? DEFAULT_TOOLS,
  }
  // Forward streamable-HTTP session headers so multi-request sessions work.
  const sessionId = c.req.header("mcp-session-id")
  if (sessionId) headers["mcp-session-id"] = sessionId
  const protocolVersion = c.req.header("mcp-protocol-version")
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion
  const lastEventId = c.req.header("last-event-id")
  if (lastEventId) headers["last-event-id"] = lastEventId

  const method = c.req.method
  const body =
    method === "GET" || method === "HEAD" ?
      undefined
    : await c.req.arrayBuffer()

  const response = await fetch(upstream, { method, headers, body })

  // Strip encoding/length headers — fetch already decoded the body, and we
  // re-stream the decoded bytes, so the original values would be wrong.
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete("content-encoding")
  responseHeaders.delete("content-length")

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  })
}

mcpRoutes.all("/", handle)
mcpRoutes.all("/*", handle)
