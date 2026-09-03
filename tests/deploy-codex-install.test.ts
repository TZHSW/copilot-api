import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetch as undiciFetch } from "undici"

import {
  createCompleteInstallerFixture,
  pathExists,
  runCommand,
  treeHashes,
  writeFixture,
} from "./helpers/deploy-codex"

const installer = join(process.cwd(), "deploy/codex/install.sh")
const controllers: Array<string> = []

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    if (await pathExists(controller)) {
      await runCommand("bash", [controller, "stop"])
    }
  }
})

async function runInstaller(environment: Record<string, string>) {
  return await runCommand("bash", [installer], {
    env: { ...process.env, ...environment },
  })
}

async function unusedPort() {
  const server = Bun.serve({ fetch: () => new Response("reserved"), port: 0 })
  const port = server.port
  await server.stop(true)
  return port
}

describe("portable Linux installer", () => {
  test("fails before mutation when Codex CLI is unavailable", async () => {
    const fixture = await createCompleteInstallerFixture()
    const nodeOnlyBin = await mkdtemp(join(tmpdir(), "copilot-node-only-"))
    await symlink(process.execPath, join(nodeOnlyBin, "node"))

    const result = await runInstaller({
      CODEX_BIN: join(nodeOnlyBin, "missing-codex"),
      INSTALL_ROOT: fixture.installRoot,
      PACKAGE_ROOT: fixture.packageRoot,
      PATH: `${nodeOnlyBin}:/usr/bin:/bin`,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Codex CLI")
    expect(
      await pathExists(
        join(fixture.installRoot, ".local/share/copilot-api-patched"),
      ),
    ).toBe(false)
  }, 20_000)

  test("refuses an unrelated listener without stopping it", async () => {
    const fixture = await createCompleteInstallerFixture()
    const listener = Bun.serve({
      fetch: () => new Response("foreign-listener"),
      port: 0,
    })
    try {
      const result = await runInstaller({
        INSTALL_ROOT: fixture.installRoot,
        OFFLINE: "1",
        PACKAGE_ROOT: fixture.packageRoot,
        PATH: fixture.path,
        PORT: String(listener.port),
        SUPERVISOR: "nohup",
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("非托管进程")
      expect(
        await undiciFetch(listener.url).then((response) => response.text()),
      ).toBe("foreign-listener")
    } finally {
      await listener.stop(true)
    }
  })

  test("installs offline into an isolated home and remains controllable", async () => {
    const fixture = await createCompleteInstallerFixture()
    const port = await unusedPort()
    const codexHome = join(fixture.installRoot, ".codex")
    await mkdir(codexHome, { recursive: true })
    const controller = join(fixture.installRoot, ".local/bin/copilot-api-ctl")
    controllers.push(controller)

    const result = await runInstaller({
      CODEX_HOME: codexHome,
      INSTALL_ROOT: fixture.installRoot,
      OFFLINE: "1",
      PACKAGE_ROOT: fixture.packageRoot,
      PATH: fixture.path,
      PORT: String(port),
      SUPERVISOR: "nohup",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("安装完成")
    expect(
      await undiciFetch(`http://127.0.0.1:${port}/`).then((response) =>
        response.text(),
      ),
    ).toBe("Server running")
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain(
      `base_url = "http://localhost:${port}/v1"`,
    )
    expect(
      await readFile(
        join(fixture.installRoot, ".local/share/copilot-api/github_token"),
        "utf8",
      ),
    ).toBe("fixture-token\n")
    expect((await runCommand("bash", [controller, "status"])).exitCode).toBe(0)
    const configBeforeDiagnosis = await treeHashes(codexHome)
    const diagnosis = await runCommand(
      "bash",
      [join(process.cwd(), "deploy/codex/diagnose.sh")],
      {
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          INSTALL_ROOT: fixture.installRoot,
          OFFLINE: "1",
          PATH: fixture.path,
          PORT: String(port),
        },
      },
    )
    expect(diagnosis.exitCode).toBe(0)
    expect(diagnosis.stdout).toContain("github_token: 存在")
    expect(diagnosis.stdout).not.toContain("fixture-token")
    expect(await treeHashes(codexHome)).toEqual(configBeforeDiagnosis)
    expect((await runCommand("bash", [controller, "stop"])).exitCode).toBe(0)
  }, 20_000)

  test("restores config and credentials after a post-migration failure", async () => {
    const fixture = await createCompleteInstallerFixture()
    const port = await unusedPort()
    const systemctlMarker = join(fixture.root, "systemctl-called")
    await writeFixture(
      join(fixture.bin, "systemctl"),
      '#!/bin/sh\nprintf called >"$SYSTEMCTL_MARKER"\nexit 0\n',
    )
    await chmod(join(fixture.bin, "systemctl"), 0o755)
    const codexHome = join(fixture.installRoot, ".codex")
    const token = join(
      fixture.installRoot,
      ".local/share/copilot-api/github_token",
    )
    await writeFixture(join(codexHome, "config.toml"), "old-config\n")
    await writeFixture(token, "old-token\n")

    const result = await runInstaller({
      CODEX_HOME: codexHome,
      INSTALL_FAIL_AFTER_CONFIG: "1",
      INSTALL_ROOT: fixture.installRoot,
      OFFLINE: "1",
      PACKAGE_ROOT: fixture.packageRoot,
      PATH: fixture.path,
      PORT: String(port),
      SUPERVISOR: "nohup",
      SYSTEMCTL_MARKER: systemctlMarker,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("恢复")
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      "old-config\n",
    )
    expect(await readFile(token, "utf8")).toBe("old-token\n")
    expect(
      await pathExists(
        join(fixture.installRoot, ".local/share/copilot-api-patched"),
      ),
    ).toBe(false)
    expect(await pathExists(systemctlMarker)).toBe(false)
  }, 20_000)
})
