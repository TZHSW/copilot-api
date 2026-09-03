import { createHash } from "node:crypto"
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

export async function makeTempTree() {
  const root = await mkdtemp(join(tmpdir(), "copilot-codex-test-"))
  return {
    backup: join(root, "backup"),
    root,
    source: join(root, "source"),
    target: join(root, "target"),
  }
}

export async function writeFixture(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

export async function treeHashes(
  root: string,
): Promise<Record<string, string>> {
  const output: Record<string, string> = {}

  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name)
      if ((await stat(file)).isDirectory()) await visit(file)
      else {
        output[relative(root, file)] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex")
      }
    }
  }

  await visit(root)
  return output
}

export async function pathExists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function runCommand(
  command: string,
  args: Array<string>,
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
  } = {},
) {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
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
  await writeFixture(
    join(packageRoot, "dist/main.js"),
    `import http from "node:http"
const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1])
const server = http.createServer((request, response) => {
  if (request.url === "/") {
    response.end("Server running")
    return
  }
  if (request.url?.startsWith("/v1/models")) {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.6-sol" }] }))
    return
  }
  response.statusCode = 503
  response.end("offline fixture")
})
server.listen(port)
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))
`,
  )
  await writeFixture(
    join(packageRoot, "codex-config/config.toml"),
    '[model_providers.copilot]\nbase_url = "http://localhost:4141/v1"\n',
  )
  await writeFixture(join(packageRoot, "codex-config/auth.json"), "{}\n")
  await writeFixture(
    join(packageRoot, "codex-config/hooks.json"),
    '{"hooks":{}}\n',
  )
  await writeFixture(
    join(packageRoot, "credentials/github_token"),
    "fixture-token\n",
  )
  await mkdir(join(packageRoot, "lib"), { recursive: true })
  await copyFile(
    join(process.cwd(), "deploy/codex/lib/migrate-config.mjs"),
    join(packageRoot, "lib/migrate-config.mjs"),
  )
  await copyFile(
    join(process.cwd(), "deploy/codex/lib/verify-service.mjs"),
    join(packageRoot, "lib/verify-service.mjs"),
  )
  await writeManifest(packageRoot)
  return { bin, installRoot, packageRoot, path: `${bin}:/usr/bin:/bin`, root }
}

export async function createPackagingFixture() {
  const root = await mkdtemp(join(tmpdir(), "copilot-codex-pack-fixture-"))
  const home = join(root, "home")
  const codexHome = join(home, ".codex")
  const dist = join(root, "dist")
  await writeFixture(
    join(codexHome, "config.toml"),
    '[model_providers.copilot]\nbase_url = "http://localhost:4141/v1"\n',
  )
  await writeFixture(join(codexHome, "auth.json"), '{"auth_mode":"apikey"}\n')
  await writeFixture(join(codexHome, "hooks.json"), '{"hooks":{}}\n')
  await writeFixture(
    join(codexHome, "skills/user-skill/SKILL.md"),
    "---\nname: user-skill\ndescription: fixture\n---\n",
  )
  await writeFixture(
    join(codexHome, "skills/.system/builtin/SKILL.md"),
    "excluded\n",
  )
  await writeFixture(
    join(codexHome, "plugins/cache/plugin/plugin.json"),
    "{}\n",
  )
  await writeFixture(join(codexHome, "sessions/session.jsonl"), "excluded\n")
  await writeFixture(
    join(home, ".local/share/copilot-api/github_token"),
    "fixture-token\n",
  )
  await writeFixture(join(dist, "main.js"), "console.log('fixture')\n")
  return { codexHome, dist, home, root }
}

export async function extractAndHashGeneratedArchives(out: string) {
  const names = await readdir(out)
  const tarName = names.find((name) => name.endsWith(".tar.gz"))
  const zipName = names.find((name) => name.endsWith(".zip"))
  if (!tarName || !zipName) throw new Error("generated archives are missing")
  const tarFile = join(out, tarName)
  const zipFile = join(out, zipName)
  const tarDir = join(out, "tar-extracted")
  const zipDir = join(out, "zip-extracted")
  await mkdir(tarDir)
  await mkdir(zipDir)
  if (
    (await runCommand("tar", ["-xzf", tarFile, "-C", tarDir])).exitCode !== 0
  ) {
    throw new Error("tar extraction failed")
  }
  if (
    (await runCommand("unzip", ["-q", zipFile, "-d", zipDir])).exitCode !== 0
  ) {
    throw new Error("zip extraction failed")
  }
  const tarRoot = join(tarDir, (await readdir(tarDir))[0])
  const zipRoot = join(zipDir, (await readdir(zipDir))[0])
  const tarHashes = await treeHashes(tarRoot)
  const zipHashes = await treeHashes(zipRoot)
  return { files: Object.keys(tarHashes), tarHashes, zipHashes }
}
