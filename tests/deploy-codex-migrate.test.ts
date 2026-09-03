import { describe, expect, test } from "bun:test"
import { chmod, mkdir, stat, symlink } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import {
  makeTempTree,
  pathExists,
  runCommand,
  treeHashes,
  writeFixture,
} from "./helpers/deploy-codex"

interface MigrationOptions {
  backup: string
  dryRun?: boolean
  home: string
  platform: string
  port: number
  source: string
  target: string
}

interface MigrationModule {
  mergeTree: (
    source: string,
    target: string,
    options?: { dryRun?: boolean },
  ) => Promise<Array<string>>
  migrateConfig: (
    options: MigrationOptions,
  ) => Promise<{ changed: Array<string> }>
  transformHooks: (
    value: unknown,
    options: Pick<MigrationOptions, "home" | "platform">,
  ) => unknown
  transformToml: (
    text: string,
    options: Pick<MigrationOptions, "home" | "port">,
  ) => string
}

const migration = (await import(
  pathToFileURL(`${process.cwd()}/deploy/codex/lib/migrate-config.mjs`).href
)) as MigrationModule

async function getRejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected promise to reject")
}

describe("Codex configuration transformation", () => {
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

    const output = migration.transformToml(input, {
      home: "/home/target",
      port: 5151,
    })

    expect(output).toContain('base_url = "http://localhost:5151/v1"')
    expect(output).toContain('url = "http://localhost:5151/mcp"')
    expect(output).not.toContain("[projects.")
    expect(output).not.toContain("[hooks.state.")
  })

  test("disables Unix hooks on Windows and rewrites the portable home marker on Linux", () => {
    const hooks = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command: "__CODEX_HOME__/.orca/agent-hooks/codex-hook.sh",
                type: "command",
              },
            ],
          },
        ],
      },
    }

    expect(
      migration.transformHooks(hooks, {
        home: String.raw`C:\Users\me`,
        platform: "win32",
      }),
    ).toEqual({ hooks: {} })
    expect(
      JSON.stringify(
        migration.transformHooks(hooks, {
          home: "/home/me",
          platform: "linux",
        }),
      ),
    ).toContain("/home/me/.orca")
  })

  test("recognizes quoted TOML table keys and brackets inside quoted paths", () => {
    const input = `[model_providers."copilot"] # quoted key
base_url = "http://localhost:4141/v1"
[projects."/home/source/a]b"]
trust_level = "trusted"
[mcp_servers.'copilotApi']
url = "http://localhost:4141/mcp"
[hooks.state.'/home/source/a]b']
enabled = true
`

    const output = migration.transformToml(input, {
      home: "/home/target",
      port: 5151,
    })

    expect(output).toContain('base_url = "http://localhost:5151/v1"')
    expect(output).toContain('url = "http://localhost:5151/mcp"')
    expect(output).not.toContain("trust_level")
    expect(output).not.toContain("enabled = true")
  })

  test("escapes a Windows home marker inside TOML basic strings", () => {
    const input = `[model_providers.copilot]
base_url = "http://localhost:4141/v1"
support_path = "__CODEX_HOME__/.orca/hooks"
`

    const output = migration.transformToml(input, {
      home: String.raw`C:\Users\target`,
      port: 4141,
    })

    expect(output).toContain(
      String.raw`support_path = "C:\\Users\\target/.orca/hooks"`,
    )
  })
})

describe("Codex configuration migration", () => {
  test("merge results are deterministic regardless of source creation order", async () => {
    const { source, target } = await makeTempTree()
    await writeFixture(`${source}/z-last`, "z")
    await writeFixture(`${source}/a-first`, "a")

    expect(await migration.mergeTree(source, target, { dryRun: true })).toEqual(
      ["a-first", "z-last"],
    )
  })

  test("snapshot wins while unrelated skills survive", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${target}/skills/keep/SKILL.md`, "keep")
    await writeFixture(`${target}/skills/shared/SKILL.md`, "old")
    await writeFixture(`${source}/skills/shared/SKILL.md`, "new")

    const result = await migration.migrateConfig({
      backup,
      home: target,
      platform: "linux",
      port: 4141,
      source,
      target,
    })

    expect(await Bun.file(`${target}/skills/keep/SKILL.md`).text()).toBe("keep")
    expect(await Bun.file(`${target}/skills/shared/SKILL.md`).text()).toBe(
      "new",
    )
    expect(result.changed).toContain("skills/shared/SKILL.md")
  })

  test("backs up the target before replacing and transforming managed config", async () => {
    const { backup, source, target } = await makeTempTree()
    const oldConfig = `[model_providers.copilot]
base_url = "http://localhost:4000/v1"
`
    await writeFixture(`${target}/config.toml`, oldConfig)
    await writeFixture(
      `${source}/config.toml`,
      `[model_providers.copilot]
base_url = "http://localhost:4141/v1"
`,
    )

    await migration.migrateConfig({
      backup,
      home: target,
      platform: "linux",
      port: 5151,
      source,
      target,
    })

    expect(await Bun.file(`${backup}/config.toml`).text()).toBe(oldConfig)
    expect(await Bun.file(`${target}/config.toml`).text()).toContain(
      'base_url = "http://localhost:5151/v1"',
    )
  })

  test("dry-run reports changes without mutating the target or creating a backup", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(
      `${target}/config.toml`,
      '[model_providers.copilot]\nbase_url = "http://localhost:4000/v1"\n',
    )
    await writeFixture(`${target}/skills/shared/SKILL.md`, "old")
    await writeFixture(
      `${source}/config.toml`,
      '[model_providers.copilot]\nbase_url = "http://localhost:4141/v1"\n',
    )
    await writeFixture(`${source}/skills/shared/SKILL.md`, "new")
    const before = await treeHashes(target)

    const result = await migration.migrateConfig({
      backup,
      dryRun: true,
      home: target,
      platform: "linux",
      port: 5151,
      source,
      target,
    })

    expect(await treeHashes(target)).toEqual(before)
    expect(await pathExists(backup)).toBe(false)
    expect(result.changed).toEqual(["skills/shared/SKILL.md", "config.toml"])
  })

  test("Windows preserves Unix hooks separately and activates an empty hook set", async () => {
    const { backup, source, target } = await makeTempTree()
    const sourceHooks = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command: "__CODEX_HOME__/.orca/agent-hooks/codex-hook.sh",
                type: "command",
              },
            ],
          },
        ],
      },
    })
    await writeFixture(`${source}/auth.json`, '{"auth_mode":"apikey"}\n')
    await writeFixture(`${source}/hooks.json`, `${sourceHooks}\n`)

    const result = await migration.migrateConfig({
      backup,
      home: String.raw`C:\Users\target`,
      platform: "win32",
      port: 4141,
      source,
      target,
    })

    expect(await Bun.file(`${target}/auth.json`).json()).toEqual({
      auth_mode: "apikey",
    })
    expect(await Bun.file(`${target}/hooks.linux.json`).text()).toBe(
      `${sourceHooks}\n`,
    )
    expect(await Bun.file(`${target}/hooks.json`).json()).toEqual({ hooks: {} })
    expect(result.changed).toEqual([
      "auth.json",
      "hooks.json",
      "hooks.linux.json",
    ])
  })

  test("writes authentication data with user-only permissions", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/auth.json`, '{"token":"secret"}\n')
    await writeFixture(`${target}/auth.json`, '{"token":"secret"}\n')
    await chmod(`${source}/auth.json`, 0o644)
    await chmod(`${target}/auth.json`, 0o644)

    await migration.migrateConfig({
      backup,
      home: target,
      platform: "linux",
      port: 4141,
      source,
      target,
    })

    expect((await stat(`${target}/auth.json`)).mode & 0o777).toBe(0o600)
  })

  test("merges only portable skill and plugin files", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/skills/user/SKILL.md`, "user")
    await writeFixture(`${source}/skills/.system/builtin/SKILL.md`, "system")
    await writeFixture(`${source}/plugins/cache/example/plugin.json`, "{}")
    await writeFixture(
      `${source}/plugins/cache/.remote-plugin-install-staging/temp/plugin.json`,
      "{}",
    )
    await writeFixture(`${source}/sessions/private.jsonl`, "runtime")

    await migration.migrateConfig({
      backup,
      home: target,
      platform: "linux",
      port: 4141,
      source,
      target,
    })

    expect(await pathExists(`${target}/skills/user/SKILL.md`)).toBe(true)
    expect(
      await pathExists(`${target}/plugins/cache/example/plugin.json`),
    ).toBe(true)
    expect(await pathExists(`${target}/skills/.system`)).toBe(false)
    expect(
      await pathExists(
        `${target}/plugins/cache/.remote-plugin-install-staging`,
      ),
    ).toBe(false)
    expect(await pathExists(`${target}/sessions`)).toBe(false)
  })
})

describe("Codex configuration migration validation", () => {
  test("rejects unsupported platforms before writing or backing up", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/auth.json`, '{"token":"new"}\n')
    await writeFixture(`${target}/auth.json`, '{"token":"old"}\n')

    expect(
      (
        await getRejection(
          migration.migrateConfig({
            backup,
            home: target,
            platform: "darwin",
            port: 4141,
            source,
            target,
          }),
        )
      ).message,
    ).toContain("unsupported platform: darwin")
    expect(await Bun.file(`${target}/auth.json`).json()).toEqual({
      token: "old",
    })
    expect(await pathExists(backup)).toBe(false)
  })

  test("rejects target symlinks that escape the migration root before backup", async () => {
    const { backup, root, source, target } = await makeTempTree()
    const outside = `${root}/outside.md`
    await writeFixture(outside, "outside")
    await writeFixture(`${source}/skills/shared/SKILL.md`, "new")
    await mkdir(`${target}/skills/shared`, { recursive: true })
    await symlink(outside, `${target}/skills/shared/SKILL.md`)

    expect(
      (
        await getRejection(
          migration.migrateConfig({
            backup,
            home: target,
            platform: "linux",
            port: 4141,
            source,
            target,
          }),
        )
      ).message,
    ).toContain("symbolic link outside migration roots")
    expect(await Bun.file(outside).text()).toBe("outside")
    expect(await pathExists(backup)).toBe(false)
  })

  test("rejects malformed hook JSON before writing or backing up", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/hooks.json`, '{"hooks":')
    await writeFixture(`${target}/hooks.json`, '{"hooks":{"old":[]}}\n')

    expect(
      (
        await getRejection(
          migration.migrateConfig({
            backup,
            home: target,
            platform: "linux",
            port: 4141,
            source,
            target,
          }),
        )
      ).message,
    ).toContain("malformed hooks.json")
    expect(await Bun.file(`${target}/hooks.json`).json()).toEqual({
      hooks: { old: [] },
    })
    expect(await pathExists(backup)).toBe(false)
  })

  test("rejects malformed authentication JSON before creating a backup", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/auth.json`, '{"token":')
    await writeFixture(`${target}/auth.json`, '{"token":"old"}\n')

    expect(
      (
        await getRejection(
          migration.migrateConfig({
            backup,
            home: target,
            platform: "linux",
            port: 4141,
            source,
            target,
          }),
        )
      ).message,
    ).toContain("malformed auth.json")
    expect(await pathExists(backup)).toBe(false)
  })

  test("rejects overlapping migration roots before mutation", async () => {
    const { source, target } = await makeTempTree()
    const backup = `${target}/backup`
    await writeFixture(`${source}/auth.json`, '{"token":"new"}\n')
    await writeFixture(`${target}/auth.json`, '{"token":"old"}\n')

    expect(
      (
        await getRejection(
          migration.migrateConfig({
            backup,
            home: target,
            platform: "linux",
            port: 4141,
            source,
            target,
          }),
        )
      ).message,
    ).toContain("migration roots must not overlap")
    expect(await Bun.file(`${target}/auth.json`).json()).toEqual({
      token: "old",
    })
    expect(await pathExists(backup)).toBe(false)
  })
})

describe("Codex configuration migration CLI", () => {
  test("CLI accepts migration flags and emits its result as JSON", async () => {
    const { backup, source, target } = await makeTempTree()
    await writeFixture(`${source}/skills/new/SKILL.md`, "new")
    const script = `${process.cwd()}/deploy/codex/lib/migrate-config.mjs`

    const result = await runCommand("node", [
      script,
      "--source",
      source,
      "--target",
      target,
      "--home",
      target,
      "--port",
      "5151",
      "--platform",
      "linux",
      "--backup",
      backup,
      "--dry-run",
    ])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      changed: ["skills/new/SKILL.md"],
    })
    expect(result.stderr).toBe("")
    expect(await pathExists(target)).toBe(false)
  })
})
