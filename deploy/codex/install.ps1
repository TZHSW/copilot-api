[CmdletBinding()]
param(
  [int]$Port = 4141,
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }),
  [switch]$Offline,
  [string]$BackupDir,
  [switch]$NoScheduledTask,
  [string]$InstallRoot,
  [switch]$DryRun,
  [string]$PackageRoot
)

$ErrorActionPreference = "Stop"
$TaskName = "CopilotApiPatched"
if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)
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

function Wait-ApiReady([int]$PortNumber, [int]$TimeoutSeconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = "no response"
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$PortNumber/" -TimeoutSec 1
      $content = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
      if ($response.StatusCode -eq 200 -and $content -eq "Server running") { return $true }
      $lastFailure = "HTTP $($response.StatusCode): $content"
    } catch { $lastFailure = $_.Exception.Message }
    Start-Sleep -Milliseconds 250
  }
  Write-Warning "API on port $PortNumber was not ready after ${TimeoutSeconds}s: $lastFailure"
  return $false
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
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
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
  $root = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $rootPrefix = $root + [IO.Path]::DirectorySeparatorChar
  $listed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($line in Get-Content -LiteralPath $manifest) {
    if (-not $line) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Malformed manifest line: $line" }
    $relative = $Matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
    if ($relative.StartsWith("." + [IO.Path]::DirectorySeparatorChar)) { $relative = $relative.Substring(2) }
    $segments = $relative.Split([IO.Path]::DirectorySeparatorChar)
    if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $segments -contains ".." -or $segments -contains ".") {
      throw "Unsafe manifest path: $relative"
    }
    if (-not $listed.Add($relative)) { throw "Duplicate manifest path: $relative" }
    $file = [IO.Path]::GetFullPath((Join-Path $PackageRoot $relative))
    if (-not $file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Manifest path escapes package: $relative"
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing package file: $relative" }
    $item = Get-Item -LiteralPath $file -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package links are not allowed: $relative" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
    if ($actual -ne $Matches[1]) { throw "Package checksum mismatch: $relative" }
  }
  if ($listed.Count -eq 0) { throw "Manifest is empty" }
  $links = Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
  if ($links) { throw "Package links are not allowed: $($links[0].FullName)" }
  foreach ($file in Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force) {
    if ($file.FullName -eq $manifest) { continue }
    $relative = $file.FullName.Substring($rootPrefix.Length)
    if (-not $listed.Contains($relative)) { throw "File is not listed in manifest: $relative" }
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
  try { $record = Get-Content $PidFile -Raw | ConvertFrom-Json } catch { return $null }
  $process = Get-Process -Id ([int]$record.Pid) -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  if ([int64]$record.StartTimeUtcTicks -ne $process.StartTime.ToUniversalTime().Ticks) { return $null }
  if (-not $process.Path.Equals($NodePath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
  $commandLine = if ($cim) { [string]$cim.CommandLine } else { "" }
  if (-not $commandLine.Contains($Main) -or -not $commandLine.Contains(" start ") -or -not $commandLine.Contains("--account-type enterprise") -or -not $commandLine.Contains("--port $Port")) { return $null }
  return $process
}

if ($Action -eq "start") {
  $existing = Get-ManagedProcess
  if ($existing) { Write-Host "Running (pid $($existing.Id))"; exit 0 }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile) | Out-Null
  $argumentLine = '"' + $Main.Replace('"', '\"') + '" start --account-type enterprise --port ' + $Port
  Write-Host "Launching API process"
  $process = Start-Process -FilePath $NodePath -ArgumentList $argumentLine -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLog -PassThru
  Write-Host "Launched API candidate (pid $($process.Id))"
  @{ Pid = $process.Id; StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $PidFile -Encoding ASCII
  Start-Sleep -Milliseconds 500
  Write-Host "Checking API process identity"
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
  Write-Host "Rollback: stopping replacement service"
  try { Stop-ManagedService } catch { Write-Warning $_.Exception.Message }
  Write-Host "Rollback: restoring files"
  Restore-Path $Share "api"
  Restore-Path $CodexHome "codex"
  Restore-Path $TokenFile "github_token"
  Restore-Path $Ctl "controller"
  Write-Host "Rollback: restoring scheduled task"
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $taskXml = Join-Path $Backup "scheduled-task.xml"
  if (Test-Path $taskXml) {
    Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $taskXml -Raw) -Force | Out-Null
  }
  if ($PreviousRunning) {
    Write-Host "Rollback: starting previous controller"
    if (Test-Path $Ctl) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl start }
    else { Write-Warning "Previous controller was not restored; service cannot be restarted" }
    Write-Host "Rollback: waiting for previous API"
    if (-not (Wait-ApiReady $Port)) { Write-Warning "Previous service was restored but did not become ready on port $Port" }
  }
  Write-Host "Rollback: complete"
}

Write-Step "Preflight"
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }
Assert-SafeTarget $UserHome
Assert-SafeTarget $CodexHome
Assert-SafeTarget $Share
$Node = Assert-Command "node" "Node.js 20 or newer is required"
$Codex = Assert-Command "codex" "Codex CLI is required; this installer does not download it"
$nodeVersion = (& $Node --version).Trim().TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required" }
& $Codex --version | Out-Null
foreach ($required in @("dist\main.js", "lib\migrate-config.mjs", "lib\verify-service.mjs", "codex-config\config.toml", "codex-config\auth.json", "codex-config\hooks.json", "credentials\github_token")) {
  if (-not (Test-Path (Join-Path $PackageRoot $required))) { throw "Missing package file: $required" }
}
Verify-Manifest

$owner = Get-PortOwner $Port
if ($owner) {
  if (-not (Test-ManagedOwner $owner)) {
    throw "Port $Port is owned by an unmanaged process (pid $($owner.OwningProcess)); refusing to stop it"
  }
  $PreviousRunning = $true
  if (-not (Test-Path $Ctl)) { throw "Existing managed API has no controller; refusing upgrade" }
} elseif (Test-Port $Port) {
  throw "Port $Port answers but its owner cannot be verified; refusing to replace it"
}

if ($DryRun) {
  $dryRunResult = & $Node (Join-Path $PackageRoot "lib\migrate-config.mjs") --source (Join-Path $PackageRoot "codex-config") --target $CodexHome --home $UserHome --port $Port --platform win32 --backup $Backup --dry-run
  if ($LASTEXITCODE -ne 0) { throw "Configuration dry-run failed" }
  Write-Host $dryRunResult
  Write-Host "Dry run complete; no files, processes, or scheduled tasks were changed"
  exit 0
}

Write-Step "Backup"
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Backup-Path $Share "api"
Backup-Path $CodexHome "codex"
Backup-Path $TokenFile "github_token"
Backup-Path $Ctl "controller"
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $Backup "scheduled-task.xml") -Encoding Unicode
}
try {
  $Mutated = $true
  if ($PreviousRunning) { Stop-ManagedService }
  if ($env:INSTALL_FAIL_AFTER_STOP -eq "1") { throw "Injected failure after stopping previous service" }
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
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ctl restart
  if ($LASTEXITCODE -ne 0) { throw "Failed to start Copilot API" }

  Write-Step "Verify installation"
  if (-not (Wait-ApiReady $Port)) { throw "API did not start on port $Port" }
  $processRecord = Get-Content (Join-Path $Share "run.pid") -Raw | ConvertFrom-Json
  $verifyArguments = @((Join-Path $Share "lib\verify-service.mjs"), "--base-url", "http://127.0.0.1:$Port", "--managed-root", $Share, "--node-path", $Node, "--process-id", [string]$processRecord.Pid)
  if ($Offline) { $verifyArguments += "--offline" }
  & $Node $verifyArguments
  if ($LASTEXITCODE -ne 0) { throw "Service verification failed" }
  $Mutated = $false
} catch {
  $installError = $_
  foreach ($logName in @("error.log", "run.log")) {
    $logFile = Join-Path $Share $logName
    if (Test-Path $logFile) {
      Write-Warning "Last lines from ${logName}:"
      Get-Content -LiteralPath $logFile -Tail 30 | ForEach-Object { Write-Warning $_ }
    }
  }
  if ($Mutated) { Restore-Installation }
  throw $installError
}

Write-Host "`nInstallation complete: API=http://localhost:$Port/v1 Codex=$CodexHome" -ForegroundColor Green
Write-Host "Backup: $Backup"
Write-Host "Control: powershell.exe -File `"$Ctl`" status|restart|stop|log"
