# Copilot Codex Offline Bundle Design

## Purpose

Build a private, cross-platform migration bundle that installs the repository's patched `copilot-api` without downloading runtime dependencies and reproduces the source machine's functional Codex setup on another machine.

The bundle targets native Linux and native Windows. The target already has Node.js 20 or newer and Codex CLI installed. The API still needs network access to GitHub Copilot when it is used; "offline" means packaging and installation perform no dependency downloads and can finish while the upstream is temporarily unavailable.

## Success Criteria

1. One packaging command builds the current standalone API and creates both `.tar.gz` and `.zip` archives from an identical staged tree.
2. Either archive contains everything needed to install the API and migrate functional Codex configuration without contacting a package registry.
3. Linux and native Windows installers back up the target, install idempotently, configure per-user persistence, and roll back local failures.
4. The migrated Codex setup includes the source `config.toml`, `auth.json`, `hooks.json`, user skills, plugin cache, and Copilot GitHub token.
5. Sessions, history, logs, lock files, caches unrelated to installed plugins, and SQLite runtime state are excluded.
6. Existing target skills and plugins are retained unless the bundle contains the same relative path, in which case the bundle wins.
7. Standard Responses, Fast mode, model discovery, remote compaction transport, and the Copilot MCP endpoint remain available through the installed API.
8. The package records provenance and verifies every payload file before changing the target.

## Non-Goals

- Installing or upgrading Node.js or Codex CLI.
- Making GitHub Copilot inference work without network access.
- Migrating Codex conversations, histories, logs, goals, memories databases, or other live runtime state.
- Running Unix shell hooks natively on Windows.
- Publishing the credential-bearing archives to Git or a public release.

## Deliverables

Repository sources live under `deploy/codex/`:

```text
deploy/codex/
|-- pack.sh
|-- install.sh
|-- install.ps1
|-- diagnose.sh
|-- diagnose.ps1
|-- README.md
`-- lib/
    |-- migrate-config.mjs
    `-- verify-service.mjs
```

The generated archive tree is:

```text
copilot-codex-<YYYYMMDD>-<sha>/
|-- dist/
|-- codex-config/
|   |-- config.toml
|   |-- auth.json
|   |-- hooks.json
|   |-- skills/
|   `-- plugins/
|-- credentials/
|   `-- github_token
|-- optional-config/
|   `-- orca-agent-hooks/
|-- lib/
|   |-- migrate-config.mjs
|   `-- verify-service.mjs
|-- install.sh
|-- install.ps1
|-- diagnose.sh
|-- diagnose.ps1
|-- README.md
|-- VERSION
`-- MANIFEST.sha256
```

`optional-config/orca-agent-hooks/` is included only when the source directory exists. The two archives must contain byte-identical regular files after extraction.

## Automatic Packaging

`deploy/codex/pack.sh` is the only supported packaging entry point.

It performs these steps in order:

1. Require Bun, Node.js, Git, `tar`, and `zip` on the build machine.
2. Run the repository's frozen dependency install and standalone build.
3. Create a private temporary staging directory with mode `0700`.
4. Copy `dist-standalone/` to `dist/`.
5. Snapshot `~/.codex/config.toml`, `auth.json`, `hooks.json`, non-system skills, and plugin cache.
6. Copy `~/.local/share/copilot-api/github_token` and the optional `.orca/agent-hooks` support directory.
7. Exclude `.codex/skills/.system`, plugin installation staging, sessions, history, logs, shell snapshots, locks, model caches, and SQLite files.
8. Fail before archive creation when any required configuration file, credential, installer asset, or API entry point is missing.
9. Write `VERSION` with branch, commit, dirty state, build timestamp, host, Node version, Bun version, Codex version, and API bundle hash.
10. Generate a stable, sorted `MANIFEST.sha256` over all payload files except the manifest itself.
11. Create `.tar.gz` and `.zip` outputs in `OUT_DIR`, defaulting to the repository root.
12. Extract both outputs into fresh temporary directories, verify the manifest, and compare their file lists and hashes.
13. Remove temporary staging directories. If validation fails, remove the newly created invalid outputs.

Archive names are `copilot-codex-<YYYYMMDD>-<short-sha>.tar.gz` and `.zip`. The packer prints their paths, sizes, and a warning that both archives contain live credentials.

## Common Configuration Migration

Both installers call `lib/migrate-config.mjs` so path rewriting and merge behavior stay identical across shells.

Inputs are the staged snapshot, target Codex directory, target home, port, platform (`linux` or `win32`), and backup directory. The helper:

1. Replaces `config.toml`, `auth.json`, and the active hooks configuration from the snapshot.
2. Rewrites the Copilot provider `base_url` to `http://localhost:<port>/v1` and the Copilot MCP URL to `http://localhost:<port>/mcp`.
3. Removes source-machine project trust entries because those paths do not identify projects on the target.
4. Merges skills and plugins recursively, preserving unrelated target files and overwriting matching snapshot paths.
5. Never copies `.system` skills or plugin staging directories.
6. On Linux, rewrites source-home references in hooks and installs the optional Orca hook support under the target home. Stale hook trust-state entries are removed after path rewriting so Codex does not treat hashes for different command text as current.
7. On Windows, saves the Unix hook file as `hooks.linux.json`, writes an active empty hooks object, and removes Unix hook trust-state entries from `config.toml`.
8. Writes files containing credentials with user-only permissions where the platform supports them.

The helper exposes a dry-run mode that prints its planned changes without writing. It rejects malformed JSON, a missing Copilot provider, paths outside the explicit target roots, and unsupported platform names.

## Backups and Transaction Boundary

Linux backups are stored in `~/.local/share/copilot-codex-backups/<timestamp>/`. Windows backups are stored in `%LOCALAPPDATA%\copilot-codex-backups\<timestamp>\`.

Before stopping a service, the installer records:

- whether an older API deployment exists;
- whether the managed service or task exists and is running;
- the target `config.toml`, `auth.json`, `hooks.json`, skills, and plugins;
- the existing GitHub token and optional Orca hooks.

The installer stages new files beside their destination and validates them before activation. A failure in checksums, configuration migration, local service startup, root health, or model-directory shape restores the previous files and previous running state. Backups remain after success for manual recovery.

Lack of upstream network access is not a local installation failure. In that case the installer reports that online checks are deferred and exits successfully after local health passes.

## Linux Installation

`install.sh`:

1. Requires Bash, Node.js 20 or newer, Codex CLI, `curl`, and checksum tooling. It never downloads them.
2. Verifies `MANIFEST.sha256` before copying credentials or configuration.
3. Refuses to take over the selected port when the listener is not an existing deployment from the managed API directory.
4. Deploys the API under `~/.local/share/copilot-api-patched/` and the GitHub token under `~/.local/share/copilot-api/`.
5. Migrates Codex configuration under `${CODEX_HOME:-$HOME/.codex}`.
6. Uses a systemd user unit when a usable user bus exists. Otherwise it installs the same `setsid`/pidfile controller and optional crontab `@reboot` behavior used by the existing Copilot CC package.
7. Starts the service, verifies the local root and model directory, then runs optional online capability checks.

Supported overrides are `PORT`, `CODEX_HOME`, `SUPERVISOR=auto|systemd|nohup`, `OFFLINE=1`, and `BACKUP_DIR`.

## Native Windows Installation

`install.ps1` runs in Windows PowerShell 5.1 or PowerShell 7 without administrator rights:

1. Require Node.js 20 or newer and Codex CLI. Do not install or upgrade them.
2. Verify every manifest entry with `Get-FileHash`.
3. Refuse to replace an unrelated listener on the selected port, using `Get-NetTCPConnection` plus the owning process command line when available.
4. Deploy the API to `%LOCALAPPDATA%\copilot-api-patched\`.
5. Store the GitHub token at `%USERPROFILE%\.local\share\copilot-api\github_token`, matching the API's cross-platform home-relative lookup.
6. Migrate Codex configuration under `$env:CODEX_HOME` or `%USERPROFILE%\.codex`.
7. Install `copilot-api-ctl.ps1` with `start`, `stop`, `restart`, `status`, and `log` commands.
8. Register a limited, current-user `CopilotApiPatched` scheduled task triggered at logon and start the service immediately.
9. Log to `%LOCALAPPDATA%\copilot-api-patched\run.log`.
10. Verify local and optional online capabilities using the common verifier.

Supported parameters are `-Port`, `-CodexHome`, `-Offline`, `-BackupDir`, and `-NoScheduledTask`.

## Service Verification

`lib/verify-service.mjs` provides consistent JSON output and exit codes for both installers and diagnostic scripts.

Local checks always run:

- `GET /` returns the expected server marker;
- `GET /v1/models` returns a non-empty model directory containing `gpt-5.6-sol`;
- the installed process command line points into the managed deployment directory.

Online checks run unless `OFFLINE=1` or the Copilot upstream is unreachable:

- a Standard Responses request completes;
- a Fast request made as `gpt-5.6-sol` with `service_tier=priority` completes and reports `priority`;
- a zstd/streaming-compatible Responses request path remains functional where the platform client sends it;
- a remote compaction trigger receives a valid streaming completion;
- MCP initialization and tool listing succeed through `/mcp`.

Authentication failures, unsupported model errors, or malformed API responses count as verification failures when the network is reachable. Connection/DNS timeouts are reported as deferred in offline-tolerant mode.

## Diagnostics

`diagnose.sh` and `diagnose.ps1` are read-only and redact credential contents. They report:

- Node and Codex versions;
- configured API port and provider URL;
- listener identity and service/task status;
- root and model-directory responses;
- token presence and file size, never token content;
- upstream reachability;
- Standard/Fast/MCP capability status;
- recent managed-service logs;
- installed config, skill, and plugin inventory.

## Testing Strategy

Automated tests cover:

1. Linux and Windows-mode config transformation using temporary source and target homes.
2. Replacement of managed config files and snapshot-wins recursive merges.
3. Exclusion of system skills, runtime state, and plugin staging.
4. Source-home and port rewriting, invalid project removal, and Windows hook disabling.
5. Backup creation and restoration after an injected failure.
6. Manifest stability, tamper detection, archive content parity, and mandatory credential presence.
7. Port-conflict refusal without killing an unrelated listener.
8. Bash syntax and a Linux installer run against an isolated temporary home.
9. PowerShell parser and dry-run installation in a Windows CI job.
10. A real package build followed by local API startup and Standard/Fast/MCP smoke checks on a non-production port.

Tests must not stop or replace the live service on port 4141. Temporary service tests choose an unused port and clean up their own process.

## Security and Distribution

The user explicitly requested credential migration. Generated archives therefore contain live Codex and GitHub credentials in plaintext. The packer uses private staging permissions and the repository must ignore generated `copilot-codex-*` archives and extracted directories. The README labels the bundle private and instructs the owner to transfer it through a trusted channel and delete unused copies.

The generated bundle is a local deliverable only. Source scripts and tests may be committed and pushed; credential-bearing output archives must never be staged or pushed.

