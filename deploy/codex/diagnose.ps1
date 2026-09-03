[CmdletBinding()]
param(
  [int]$Port = 4141,
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }),
  [switch]$Offline,
  [string]$InstallRoot
)

$ErrorActionPreference = "Continue"
$UserHome = if ($InstallRoot) { $InstallRoot } else { $HOME }
$LocalRoot = if ($InstallRoot) { Join-Path $InstallRoot "AppData\Local" } else { $env:LOCALAPPDATA }
$Share = Join-Path $LocalRoot "copilot-api-patched"
$TokenFile = Join-Path $UserHome ".local\share\copilot-api\github_token"
$Ctl = Join-Path $LocalRoot "Programs\copilot-api-ctl.ps1"

function Write-Heading([string]$Message) { Write-Host "`n-- $Message --" -ForegroundColor Cyan }

Write-Heading "Environment"
Write-Host "PORT=$Port"
Write-Host "CODEX_HOME=$CodexHome"
Write-Host "API_ROOT=$Share"
& node --version
& codex --version

Write-Heading "Listener and scheduled task"
Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Format-List LocalAddress, LocalPort, OwningProcess
& schtasks.exe /Query /TN "CopilotApiPatched" 2>$null
if (Test-Path $Ctl) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl status }

Write-Heading "Local API"
try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 | Select-Object StatusCode, Content | Format-List } catch { Write-Warning $_.Exception.Message }
try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 10 | ConvertTo-Json -Depth 4 } catch { Write-Warning $_.Exception.Message }

Write-Heading "Credentials (contents redacted)"
if (Test-Path $TokenFile) { Write-Host "github_token: present ($((Get-Item $TokenFile).Length) bytes)" } else { Write-Host "github_token: missing" }
$auth = Join-Path $CodexHome "auth.json"
if (Test-Path $auth) { Write-Host "auth.json: present ($((Get-Item $auth).Length) bytes)" } else { Write-Host "auth.json: missing" }

Write-Heading "Codex extensions"
$skillCount = @(Get-ChildItem (Join-Path $CodexHome "skills") -Filter SKILL.md -Recurse -File -ErrorAction SilentlyContinue).Count
$pluginCount = @(Get-ChildItem (Join-Path $CodexHome "plugins") -Recurse -File -ErrorAction SilentlyContinue).Count
Write-Host "skill files: $skillCount"
Write-Host "plugin files: $pluginCount"

Write-Heading "Capability verification"
$verifier = Join-Path $Share "lib\verify-service.mjs"
if (Test-Path $verifier) {
  $arguments = @($verifier, "--base-url", "http://127.0.0.1:$Port", "--managed-root", $Share)
  if ($Offline) { $arguments += "--offline" }
  & node $arguments
} else {
  Write-Warning "Verifier is missing: $verifier"
}

Write-Heading "Recent logs"
foreach ($log in @((Join-Path $Share "run.log"), (Join-Path $Share "error.log"))) {
  if (Test-Path $log) { Write-Host "[$log]"; Get-Content -LiteralPath $log -Tail 30 }
}
