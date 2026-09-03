// @ts-check
/* eslint-disable unicorn/prefer-import-meta-properties -- import.meta.filename requires Node.js 20.11. */

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * @typedef {object} MigrationOptions
 * @property {string} backup
 * @property {boolean} [dryRun]
 * @property {string} home
 * @property {string} platform
 * @property {number} port
 * @property {string} source
 * @property {string} target
 */

/**
 * @typedef {object} MergeOptions
 * @property {boolean} [dryRun]
 * @property {(path: string) => boolean} [exclude]
 * @property {string} [prefix]
 */

/** @typedef {{ keys: Array<string> | null, lines: Array<string> }} TomlSection */

/** @param {string} value */
function splitDottedTomlKey(value) {
  /** @type {Array<string>} */
  const parts = []
  let part = ""
  let quote
  let escaped = false

  for (const character of value) {
    if (escaped) {
      part += character
      escaped = false
    } else if (quote === '"' && character === "\\") {
      part += character
      escaped = true
    } else if (quote) {
      part += character
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
      part += character
    } else if (character === ".") {
      parts.push(part.trim())
      part = ""
    } else {
      part += character
    }
  }
  parts.push(part.trim())

  return parts.map((key) => {
    if (
      (key.startsWith('"') && key.endsWith('"'))
      || (key.startsWith("'") && key.endsWith("'"))
    ) {
      return key.slice(1, -1)
    }
    return key
  })
}

/** @param {string} line */
// eslint-disable-next-line complexity -- TOML quoting requires a lexical state machine.
function readTomlHeader(line) {
  let index = 0
  while (/\s/.test(line[index] ?? "")) index += 1
  if (line[index] !== "[") return undefined
  const arrayTable = line[index + 1] === "["
  const contentStart = index + (arrayTable ? 2 : 1)
  let quote
  let escaped = false

  for (index = contentStart; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) escaped = false
    else if (quote === '"' && character === "\\") escaped = true
    else if (quote) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") quote = character
    else if (character === "]") {
      const headerEnd = index + (arrayTable ? 2 : 1)
      if (arrayTable && line[index + 1] !== "]") continue
      const remainder = line.slice(headerEnd).trim()
      if (remainder !== "" && !remainder.startsWith("#")) return undefined
      return splitDottedTomlKey(line.slice(contentStart, index).trim())
    }
  }
  return undefined
}

/** @param {string} text */
function splitTomlSections(text) {
  /** @type {Array<TomlSection>} */
  const sections = [{ keys: null, lines: [] }]

  for (const line of text.split(/\r?\n/)) {
    const keys = readTomlHeader(line)
    if (keys) sections.push({ keys, lines: [line] })
    else {
      const current = sections.at(-1)
      if (!current) throw new Error("invalid TOML section state")
      current.lines.push(line)
    }
  }

  return sections
}

/**
 * @param {string} text
 * @param {Pick<MigrationOptions, "home" | "port">} options
 */
export function transformToml(text, { port, home }) {
  const tomlHome = home.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)
  const sections = splitTomlSections(text).filter(
    ({ keys }) =>
      keys === null
      || (keys[0] !== "projects"
        && (keys[0] !== "hooks" || keys[1] !== "state")),
  )
  const provider = sections.find(
    ({ keys }) =>
      keys?.length === 2
      && keys[0] === "model_providers"
      && keys[1] === "copilot",
  )
  if (!provider) throw new Error("missing [model_providers.copilot]")

  const providerUrlIndex = provider.lines.findIndex((line) =>
    /^\s*base_url\s*=/.test(line),
  )
  if (providerUrlIndex === -1) throw new Error("missing Copilot base_url")
  provider.lines[providerUrlIndex] = `base_url = "http://localhost:${port}/v1"`

  const mcp = sections.find(
    ({ keys }) =>
      keys?.length === 2
      && keys[0] === "mcp_servers"
      && keys[1] === "copilotApi",
  )
  if (mcp) {
    mcp.lines = mcp.lines.map((line) =>
      /^\s*url\s*=/.test(line) ? `url = "http://localhost:${port}/mcp"` : line,
    )
  }

  return `${sections
    .flatMap(({ lines }) => lines)
    .join("\n")
    .replaceAll("__CODEX_HOME__", tomlHome)
    .trimEnd()}\n`
}

/**
 * @param {unknown} value
 * @param {Pick<MigrationOptions, "home" | "platform">} options
 * @returns {unknown}
 */
export function transformHooks(value, { platform, home }) {
  if (platform === "win32") return { hooks: {} }
  const serialized = /** @type {string | undefined} */ (JSON.stringify(value))
  if (serialized === undefined)
    throw new Error("hooks must be JSON-serializable")
  return /** @type {unknown} */ (
    JSON.parse(serialized.replaceAll("__CODEX_HOME__", home))
  )
}

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    )
      return false
    throw error
  }
}

/**
 * @param {string} source
 * @param {string} target
 */
async function filesMatch(source, target) {
  if (!(await exists(target))) return false
  const targetStat = await stat(target)
  if (!targetStat.isFile()) return false
  const [sourceContents, targetContents] = await Promise.all([
    readFile(source),
    readFile(target),
  ])
  return sourceContents.equals(targetContents)
}

/**
 * @param {string} target
 * @param {import("node:buffer").Buffer} content
 * @param {number | undefined} [expectedMode]
 */
async function fileMatchesContent(target, content, expectedMode) {
  if (!(await exists(target))) return false
  const targetStat = await stat(target)
  return (
    targetStat.isFile()
    && (expectedMode === undefined
      || (targetStat.mode & 0o777) === expectedMode)
    && (await readFile(target)).equals(content)
  )
}

/** @param {string} root */
async function validateTreePaths(root) {
  let metadata
  try {
    metadata = await lstat(root)
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    )
      return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`symbolic link outside migration roots: ${root}`)
  }
  if (!metadata.isDirectory()) return

  for (const entry of await readdir(root)) {
    await validateTreePaths(join(root, entry))
  }
}

/**
 * @param {string} path
 * @param {string} root
 */
function pathIsWithin(path, root) {
  const child = relative(resolve(root), resolve(path))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
}

/** @param {Array<string>} roots */
function validateSeparateRoots(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        pathIsWithin(roots[left], roots[right])
        || pathIsWithin(roots[right], roots[left])
      ) {
        throw new Error("migration roots must not overlap")
      }
    }
  }
}

/**
 * @param {import("node:buffer").Buffer} contents
 * @param {string} name
 * @returns {unknown}
 */
function parseJson(contents, name) {
  try {
    return /** @type {unknown} */ (JSON.parse(contents.toString("utf8")))
  } catch (error) {
    throw new Error(`malformed ${name}`, { cause: error })
  }
}

/**
 * @param {string} source
 * @param {string} target
 * @param {MergeOptions} [options]
 */
export async function mergeTree(source, target, options = {}) {
  const { dryRun = false, exclude = () => false, prefix = "" } = options
  /** @type {Array<string>} */
  const changed = []

  const entries = await readdir(source, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (exclude(relativePath)) continue

    if (entry.isDirectory()) {
      changed.push(
        ...(await mergeTree(sourcePath, targetPath, {
          dryRun,
          exclude,
          prefix: relativePath,
        })),
      )
    } else if (entry.isFile() && !(await filesMatch(sourcePath, targetPath))) {
      changed.push(relativePath)
      if (!dryRun) {
        await mkdir(target, { recursive: true })
        await copyFile(sourcePath, targetPath)
        await chmod(targetPath, (await stat(sourcePath)).mode & 0o777)
      }
    }
  }

  return changed
}

/** @param {string} path */
function excludedPortablePath(path) {
  return (
    path === "skills/.system"
    || path.startsWith("skills/.system/")
    || path.endsWith("/.remote-plugin-install-staging")
    || path.includes("/.remote-plugin-install-staging/")
  )
}

/** @param {MigrationOptions} options */
// eslint-disable-next-line complexity -- Optional inputs are validated before one atomic migration.
export async function migrateConfig(options) {
  if (options.platform !== "linux" && options.platform !== "win32") {
    throw new Error(`unsupported platform: ${options.platform}`)
  }
  validateSeparateRoots([options.source, options.target, options.backup])
  await validateTreePaths(options.source)
  await validateTreePaths(options.target)
  await validateTreePaths(options.backup)

  const sourceConfig = join(options.source, "config.toml")
  let transformedConfig
  if (await exists(sourceConfig)) {
    transformedConfig = Buffer.from(
      transformToml(await readFile(sourceConfig, "utf8"), options),
    )
  }

  const sourceAuth = join(options.source, "auth.json")
  let authContents
  if (await exists(sourceAuth)) {
    authContents = await readFile(sourceAuth)
    parseJson(authContents, "auth.json")
  }
  const sourceHooks = join(options.source, "hooks.json")
  let hooksContents
  let linuxHooksContents
  if (await exists(sourceHooks)) {
    const rawHooks = await readFile(sourceHooks)
    hooksContents = Buffer.from(
      `${JSON.stringify(
        transformHooks(parseJson(rawHooks, "hooks.json"), options),
        null,
        2,
      )}\n`,
    )
    if (options.platform === "win32") linuxHooksContents = rawHooks
  }

  if (!options.dryRun && (await exists(options.target))) {
    await mergeTree(options.target, options.backup)
  }

  /** @type {Array<string>} */
  const changed = []
  for (const directory of ["skills", "plugins"]) {
    const sourceDirectory = join(options.source, directory)
    if (await exists(sourceDirectory)) {
      changed.push(
        ...(await mergeTree(sourceDirectory, join(options.target, directory), {
          dryRun: options.dryRun,
          exclude: excludedPortablePath,
          prefix: directory,
        })),
      )
    }
  }

  if (transformedConfig) {
    const targetConfig = join(options.target, "config.toml")
    if (!(await fileMatchesContent(targetConfig, transformedConfig, 0o600))) {
      changed.push("config.toml")
      if (!options.dryRun) {
        await mkdir(options.target, { recursive: true })
        await writeFile(targetConfig, transformedConfig)
        await chmod(targetConfig, 0o600)
      }
    }
  }

  /** @type {Array<[string, import("node:buffer").Buffer | undefined]>} */
  const managedFiles = [
    ["auth.json", authContents],
    ["hooks.json", hooksContents],
    ["hooks.linux.json", linuxHooksContents],
  ]
  for (const [relativePath, contents] of managedFiles) {
    if (!contents) continue
    const targetFile = join(options.target, relativePath)
    if (!(await fileMatchesContent(targetFile, contents, 0o600))) {
      changed.push(relativePath)
      if (!options.dryRun) {
        await mkdir(options.target, { recursive: true })
        await writeFile(targetFile, contents)
        await chmod(targetFile, 0o600)
      }
    }
  }
  return { changed }
}

/** @param {Array<string>} args */
function parseCliArguments(args) {
  /** @type {Record<string, string | number | boolean | undefined>} */
  const options = { dryRun: false }
  const names = new Set([
    "source",
    "target",
    "home",
    "port",
    "platform",
    "backup",
  ])

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--dry-run") {
      options.dryRun = true
      continue
    }
    if (!argument.startsWith("--") || !names.has(argument.slice(2))) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`)
    }
    options[argument.slice(2)] = value
    index += 1
  }

  for (const name of names) {
    if (options[name] === undefined) throw new Error(`missing --${name}`)
  }
  options.port = Number(options.port)
  if (
    !Number.isInteger(options.port)
    || options.port < 1
    || options.port > 65_535
  ) {
    throw new Error("port must be an integer from 1 to 65535")
  }
  return /** @type {MigrationOptions} */ (options)
}

const isMain =
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const result = await migrateConfig(parseCliArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
