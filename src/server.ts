import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { mcpRoutes } from "./routes/mcp/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { nativeMessageRoutes } from "./routes/native-messages/route"
import { responseRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(cors())

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// OpenAI Responses API
server.route("/responses", responseRoutes)
server.route("/v1/responses", responseRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Native Anthropic pass-through (model name translation only)
// CC uses this by setting ANTHROPIC_BASE_URL=http://localhost:4142/v1/native
server.route("/v1/native/v1/messages", nativeMessageRoutes)
server.route("/v1/native/v1/models", modelRoutes)

// GitHub remote MCP pass-through (github-mcp-server @ /mcp/readonly).
// Injects the GitHub OAuth token + X-MCP-Tools: web_search. Point an MCP
// client at http://localhost:<port>/mcp to use web_search without a token.
server.route("/mcp", mcpRoutes)
