import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { setupCopilotToken } from "~/lib/token"

const originalFetch = globalThis.fetch

describe("setupCopilotToken", () => {
  beforeEach(() => {
    state.githubToken = "github-oauth-token"
    state.copilotToken = ""
    state.copilotIntegrationId = "vscode-chat"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("uses a GitHub OAuth token directly when exchange is forbidden", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(new Response(null, { status: 403 })),
      { preconnect: originalFetch.preconnect },
    )

    await setupCopilotToken()

    expect(state.copilotToken).toBe("github-oauth-token")
    expect(state.copilotIntegrationId).toBe("copilot-developer-cli")
    expect(copilotHeaders(state)["copilot-integration-id"]).toBe(
      "copilot-developer-cli",
    )
  })

  test("does not hide other token exchange failures", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(new Response(null, { status: 401 })),
      { preconnect: originalFetch.preconnect },
    )

    let caughtError: unknown
    try {
      await setupCopilotToken()
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(HTTPError)
    expect(state.copilotToken).toBe("")
    expect(state.copilotIntegrationId).toBe("vscode-chat")
  })
})
