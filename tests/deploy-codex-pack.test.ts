import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createPackagingFixture,
  extractAndHashGeneratedArchives,
  runCommand,
} from "./helpers/deploy-codex"

async function buildFixturePackage({ realBuild = false } = {}) {
  const fixture = await createPackagingFixture()
  const out = await mkdtemp(join(tmpdir(), "copilot-codex-output-"))
  const result = await runCommand(
    "bash",
    [join(process.cwd(), "deploy/codex/pack.sh")],
    {
      env: {
        ...process.env,
        CODEX_HOME: fixture.codexHome,
        HOME: fixture.home,
        OUT_DIR: out,
        PACK_TEST_DIST: realBuild ? undefined : fixture.dist,
      },
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(`packer failed: ${result.stderr}\n${result.stdout}`)
  }
  return {
    fixture,
    output: await extractAndHashGeneratedArchives(out),
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

describe("portable credential-aware packer", () => {
  test("includes install assets and credentials while excluding runtime state", async () => {
    const { output } = await buildFixturePackage()

    for (const required of [
      "dist/main.js",
      "codex-config/config.toml",
      "codex-config/auth.json",
      "codex-config/hooks.json",
      "codex-config/skills/user-skill/SKILL.md",
      "codex-config/plugins/cache/plugin/plugin.json",
      "credentials/github_token",
      "install.sh",
      "install.ps1",
      "diagnose.sh",
      "diagnose.ps1",
      "lib/migrate-config.mjs",
      "lib/verify-service.mjs",
      "MANIFEST.sha256",
      "VERSION",
      "README.md",
    ]) {
      expect(output.files).toContain(required)
    }
    expect(
      output.files.some(
        (file) =>
          file.includes("sessions")
          || file.includes("skills/.system")
          || file.includes(".remote-plugin-install-staging")
          || file.endsWith(".sqlite"),
      ),
    ).toBe(false)
  }, 30_000)

  test("creates tar and zip archives with identical file hashes", async () => {
    const { output } = await buildFixturePackage()

    expect(output.tarHashes).toEqual(output.zipHashes)
  }, 30_000)

  test("normalizes the source home and warns that credentials are live", async () => {
    const { fixture, output, stdout } = await buildFixturePackage()
    const config = await readFile(
      join(output.tarRoot, "codex-config/config.toml"),
      "utf8",
    )

    expect(config).not.toContain(fixture.home)
    expect(config).toContain("__CODEX_HOME__")
    expect(stdout).toContain("包含实时凭据")
  }, 30_000)

  test("does not try to install Git hooks while preparing dependencies", async () => {
    const { stderr, stdout } = await buildFixturePackage({ realBuild: true })

    expect(`${stdout}\n${stderr}`).not.toContain(
      "Was not able to set git hooks",
    )
  }, 30_000)
})
