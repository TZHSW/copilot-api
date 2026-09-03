[CmdletBinding()]
param(
  [int]$Port = 4141,
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }),
  [switch]$Offline,
  [string]$BackupDir,
  [switch]$NoScheduledTask,
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$TaskName = "CopilotApiPatched"
$PackageRoot = $PSScriptRoot
$UserHome = if ($InstallRoot) { $InstallRoot } else { $HOME }
$LocalRoot = if ($InstallRoot) { Join-Path $InstallRoot "AppData\Local" } else { $env:LOCALAPPDATA }
if (-not $LocalRoot) { throw "LOCALAPPDATA is unavailable" }
$Share = Join-Path $LocalRoot "copilot-api-patched"
$TokenFile = Join-Path $UserHome ".local\share\copilot-api\github_token"
$Ctl = Join-Path $LocalRoot "Programs\copilot-api-ctl.ps1"
$DefaultBackupRoot = Join-Path $LocalRoot "copilot-codex-backups"
$BackupRoot = if ($BackupDir) { $BackupDir } else { $DefaultBackupRoot }
$Backup = Join-Path $BackupRoot ((Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + "-" + $PID)
$Mutated = $false
$PreviousRunning = $false

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Name, [string]$Message) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw $Message }
  return $command.Source
}

function Assert-SafeTarget([string]$PathValue) {
  if (-not $PathValue) { throw "Target path must not be empty" }
  $full = [IO.Path]::GetFullPath($PathValue)
  if ($full -eq [IO.Path]::GetPathRoot($full)) { throw "Refusing filesystem-root target: $full" }
}

function Test-Port([int]$PortNumber) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect("127.0.0.1", $PortNumber, $null, $null)
    return $pending.AsyncWaitHandle.WaitOne(500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-PortOwner([int]$PortNumber) {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
  return Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-ProcessCommandLine([int]$ProcessId) {
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($item) { return [string]$item.CommandLine }
  return ""
}

function Test-ManagedOwner($Owner) {
  if (-not $Owner) { return $false }
  return (Get-ProcessCommandLine ([int]$Owner.OwningProcess)).Contains((Join-Path $Share "dist\main.js"))
}

function Stop-ManagedService {
  if (Test-Path $Ctl) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl stop | Out-Null
  }
  & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
  $owner = Get-PortOwner $Port
  if ($owner -and (Test-ManagedOwner $owner)) {
    Stop-Process -Id ([int]$owner.OwningProcess) -Force -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    if (-not (Test-Port $Port)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Managed service did not release port $Port"
}

function Backup-Path([string]$Source, [string]$Name) {
  if (Test-Path $Source) {
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    Copy-Item -LiteralPath $Source -Destination (Join-Path $Backup $Name) -Recurse -Force
  }
}

function Restore-Path([string]$Destination, [string]$Name) {
  if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  $saved = Join-Path $Backup $Name
  if (Test-Path $saved) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $saved -Destination $Destination -Recurse -Force
  }
}

function Verify-Manifest {
  $manifest = Join-Path $PackageRoot "MANIFEST.sha256"
  if (-not (Test-Path $manifest)) { throw "Missing MANIFEST.sha256" }
  foreach ($line in Get-Content -LiteralPath $manifest) {
    if (-not $line) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Malformed manifest line: $line" }
    $relative = $Matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
    $file = [IO.Path]::GetFullPath((Join-Path $PackageRoot $relative))
    if (-not $file.StartsWith([IO.Path]::GetFullPath($PackageRoot), [StringComparison]::OrdinalIgnoreCase)) {
      throw "Manifest path escapes package: $relative"
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing package file: $relative" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
    if ($actual -ne $Matches[1]) { throw "Package checksum mismatch: $relative" }
  }
}

function Escape-SingleQuoted([string]$Value) {
  return $Value.Replace("'", "''")
}

function Write-Controller([string]$NodePath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Ctl) | Out-Null
  $template = @'
[CmdletBinding()]
param([ValidateSet("start", "stop", "restart", "status", "log")][string]$Action = "status")
$ErrorActionPreference = "Stop"
$NodePath = '__NODE__'
$Main = '__MAIN__'
$Port = __PORT__
$PidFile = '__PID__'
$LogFile = '__LOG__'
$ErrorLog = '__ERROR_LOG__'

function Get-ManagedProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $savedPid = [int](Get-Content $PidFile -Raw)
  return Get-Process -Id $savedPid -ErrorAction SilentlyContinue
}

if ($Action -eq "start") {
  $existing = Get-ManagedProcess
  if ($existing) { Write-Host "Running (pid $($existing.Id))"; exit 0 }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile) | Out-Null
  $process = Start-Process -FilePath $NodePath -ArgumentList @($Main, "start", "--account-type", "enterprise", "--port", [string]$Port) -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLog -PassThru
  Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
  Start-Sleep -Milliseconds 500
  if (-not (Get-ManagedProcess)) { throw "API process exited; inspect $ErrorLog" }
  Write-Host "Started (pid $($process.Id))"
  exit 0
}
if ($Action -eq "stop") {
  $existing = Get-ManagedProcess
  if ($existing) { Stop-Process -Id $existing.Id -Force; $existing.WaitForExit() }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped"
  exit 0
}
if ($Action -eq "restart") {
  & $PSCommandPath stop | Out-Null
  & $PSCommandPath start
  exit $LASTEXITCODE
}
if ($Action -eq "status") {
  $existing = Get-ManagedProcess
  if ($existing) { Write-Host "Running (pid $($existing.Id))"; exit 0 }
  Write-Host "Not running"
  exit 3
}
Get-Content -LiteralPath $LogFile -Wait -Tail 50
'@
  $content = $template.Replace('__NODE__', (Escape-SingleQuoted $NodePath))
  $content = $content.Replace('__MAIN__', (Escape-SingleQuoted (Join-Path $Share "dist\main.js")))
  $content = $content.Replace('__PORT__', [string]$Port)
  $content = $content.Replace('__PID__', (Escape-SingleQuoted (Join-Path $Share "run.pid")))
  $content = $content.Replace('__LOG__', (Escape-SingleQuoted (Join-Path $Share "run.log")))
  $content = $content.Replace('__ERROR_LOG__', (Escape-SingleQuoted (Join-Path $Share "error.log")))
  Set-Content -LiteralPath $Ctl -Value $content -Encoding UTF8
}

function Restore-Installation {
  Write-Warning "Installation failed; restoring $Backup"
  try { Stop-ManagedService } catch { Write-Warning $_.Exception.Message }
  Restore-Path $Share "api"
  Restore-Path $CodexHome "codex"
  Restore-Path $TokenFile "github_token"
  Restore-Path $Ctl "controller"
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  $taskXml = Join-Path $Backup "scheduled-task.xml"
  if (Test-Path $taskXml) { & schtasks.exe /Create /TN $TaskName /XML $taskXml /F | Out-Null }
  if ($PreviousRunning) {
    if (Test-Path $Ctl) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl start | Out-Null }
    else { & schtasks.exe /Run /TN $TaskName 2>$null | Out-Null }
  }
}

Write-Step "Preflight"
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }
Assert-SafeTarget $UserHome
Assert-SafeTarget $CodexHome
Assert-SafeTarget $Share
$Node = Assert-Command "node" "Node.js 20 or newer is required"
$Codex = Assert-Command "codex" "Codex CLI is required; this installer does not download it"
$nodeMajor = [int](& $Node -p 'Number(process.versions.node.split(".")[0])')
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required" }
& $Codex --version | Out-Null
foreach ($required in @("dist\main.js", "lib\migrate-config.mjs", "lib\verify-service.mjs", "codex-config\config.toml", "codex-config\auth.json", "credentials\github_token")) {
  if (-not (Test-Path (Join-Path $PackageRoot $required))) { throw "Missing package file: $required" }
}
Verify-Manifest

$owner = Get-PortOwner $Port
if ($owner) {
  if (-not (Test-ManagedOwner $owner)) {
    throw "Port $Port is owned by an unmanaged process (pid $($owner.OwningProcess)); refusing to stop it"
  }
  $PreviousRunning = $true
} elseif (Test-Port $Port) {
  throw "Port $Port answers but its owner cannot be verified; refusing to replace it"
}

Write-Step "Backup"
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Backup-Path $Share "api"
Backup-Path $CodexHome "codex"
Backup-Path $TokenFile "github_token"
Backup-Path $Ctl "controller"
if ((& schtasks.exe /Query /TN $TaskName 2>$null) -and $LASTEXITCODE -eq 0) {
  & schtasks.exe /Query /TN $TaskName /XML 2>$null | Set-Content -LiteralPath (Join-Path $Backup "scheduled-task.xml") -Encoding Unicode
}
if ($PreviousRunning) { Stop-ManagedService }

try {
  $Mutated = $true
  Write-Step "Deploy standalone API"
  $stage = "$Share.new.$PID"
  if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -LiteralPath (Join-Path $PackageRoot "dist") -Destination (Join-Path $stage "dist") -Recurse
  Copy-Item -LiteralPath (Join-Path $PackageRoot "lib") -Destination (Join-Path $stage "lib") -Recurse
  if (Test-Path $Share) { Remove-Item -LiteralPath $Share -Recurse -Force }
  Move-Item -LiteralPath $stage -Destination $Share
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TokenFile) | Out-Null
  Copy-Item -LiteralPath (Join-Path $PackageRoot "credentials\github_token") -Destination $TokenFile -Force

  Write-Step "Migrate Codex configuration"
  $migrationJson = & $Node (Join-Path $PackageRoot "lib\migrate-config.mjs") --source (Join-Path $PackageRoot "codex-config") --target $CodexHome --home $UserHome --port $Port --platform win32 --backup (Join-Path $Backup "migration")
  if ($LASTEXITCODE -ne 0) { throw "Configuration migration failed" }
  $migration = $migrationJson | ConvertFrom-Json
  Write-Host "Migrated $($migration.changed.Count) configuration files"

  Write-Step "Configure background service"
  Write-Controller $Node
  if (-not $NoScheduledTask) {
    $taskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Ctl`" start"
    & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskCommand /RL LIMITED /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to register scheduled task $TaskName" }
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl restart | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to start Copilot API" }

  Write-Step "Verify installation"
  $ready = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ready) { throw "API did not start on port $Port" }
  $verifyArguments = @((Join-Path $Share "lib\verify-service.mjs"), "--base-url", "http://127.0.0.1:$Port", "--managed-root", $Share)
  if ($Offline) { $verifyArguments += "--offline" }
  & $Node $verifyArguments
  if ($LASTEXITCODE -ne 0) { throw "Service verification failed" }
  $Mutated = $false
} catch {
  if ($Mutated) { Restore-Installation }
  throw
}

Write-Host "`nInstallation complete: API=http://localhost:$Port/v1 Codex=$CodexHome" -ForegroundColor Green
Write-Host "Backup: $Backup"
Write-Host "Control: powershell.exe -File `"$Ctl`" status|restart|stop|log"
