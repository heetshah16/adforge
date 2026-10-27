# Starts every service in the config hidden and restarts each per its policy. Logs JSON lines to
# <ADFORGE_DATA_DIR>/logs/supervisor-YYYYMMDD.log. Stop: Ctrl-C, or create the stop file
# (default <ADFORGE_DATA_DIR>/supervisor.stop); either kills every child tree.
# Windows PowerShell 5.1: no $ErrorActionPreference='Stop' around native commands; kill trees with taskkill.
param(
  [string]$Config = "$PSScriptRoot\supervisor.config.json",
  [string]$StopFile
)
$root = (Resolve-Path "$PSScriptRoot\..").Path

# ADFORGE_DATA_DIR: process env, else .env, else <repo>/.data (same default as packages/core/src/config/env.ts).
$dataDir = $env:ADFORGE_DATA_DIR
if (-not $dataDir -and (Test-Path "$root\.env")) {
  $line = Get-Content "$root\.env" | Where-Object { $_ -match '^\s*ADFORGE_DATA_DIR\s*=' } | Select-Object -Last 1
  if ($line) { $dataDir = ($line -replace '^\s*ADFORGE_DATA_DIR\s*=\s*', '').Trim().Trim('"').Trim("'") }
}
if (-not $dataDir) { $dataDir = '.data' }
function Abs($p) { [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $root $p })) }
$dataDir = Abs $dataDir
$logDir = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
if (-not $StopFile) { $StopFile = Join-Path $dataDir 'supervisor.stop' }
Remove-Item $StopFile -ErrorAction SilentlyContinue

function Log($event, $service, $extra = @{}) {
  $rec = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); event = $event; service = $service }
  foreach ($k in $extra.Keys) { $rec[$k] = $extra[$k] }
  $file = Join-Path $logDir ("supervisor-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
  [IO.File]::AppendAllText($file, (($rec | ConvertTo-Json -Compress) + "`n"))
}

function Quote($a) { if ($a -match '\s') { '"' + $a + '"' } else { $a } }

$cfg = Get-Content $Config -Raw | ConvertFrom-Json
$state = @{}
foreach ($s in $cfg.services) { $state[$s.name] = @{ svc = $s; proc = $null; restarts = New-Object System.Collections.Generic.List[datetime]; next = Get-Date; done = $false } }

function Start-Svc($st) {
  $s = $st.svc
  $cwd = Abs $s.cwd
  $exe = (Get-Command $s.command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $exe) { Log 'start-failed' $s.name @{ reason = "command not found: $($s.command)" }; return $false }
  $saved = @{}
  if ($s.env) { foreach ($p in $s.env.PSObject.Properties) { $saved[$p.Name] = [Environment]::GetEnvironmentVariable($p.Name); [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) } }
  try {
    $a = @{ FilePath = $exe; WorkingDirectory = $cwd; WindowStyle = 'Hidden'; PassThru = $true
            RedirectStandardOutput = Join-Path $logDir "$($s.name).out.log"; RedirectStandardError = Join-Path $logDir "$($s.name).err.log" }
    if ($s.args -and @($s.args).Count) { $a.ArgumentList = (@($s.args) | ForEach-Object { Quote $_ }) -join ' ' }
    $p = Start-Process @a
    $null = $p.Handle   # cache the handle so ExitCode is readable after exit
    $st.proc = $p
    Log 'started' $s.name @{ pid = $p.Id }
    return $true
  } catch {
    Log 'start-failed' $s.name @{ reason = $_.Exception.Message }
    return $false
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
}

# Counts a restart against maxRestarts/windowMin and schedules it after backoffSec, or gives up. Used for exits and failed starts.
function Retry($st, $now, $code) {
  $s = $st.svc
  [void]$st.restarts.RemoveAll({ param($t) ($now - $t).TotalMinutes -gt $s.windowMin })
  if ($st.restarts.Count -ge $s.maxRestarts) {
    Log 'gave-up' $s.name @{ code = $code; maxRestarts = $s.maxRestarts; windowMin = $s.windowMin }
    $st.done = $true; return
  }
  $st.restarts.Add($now)
  $st.next = $now.AddSeconds($s.backoffSec)
  Log 'exited' $s.name @{ code = $code; restarts = $st.restarts.Count }
}

try {
  while (-not (Test-Path $StopFile)) {
    $now = Get-Date
    foreach ($st in $state.Values) {
      if ($st.done) { continue }
      $s = $st.svc
      if ($null -eq $st.proc) { if ($now -ge $st.next -and -not (Start-Svc $st)) { Retry $st $now $null }; continue }
      if (-not $st.proc.HasExited) { continue }
      $code = $st.proc.ExitCode
      $st.proc = $null
      $again = ($s.restartOn -is [string] -and $s.restartOn -eq 'any') -or (@($s.restartOn) -contains $code)
      if (-not $again) { Log 'exited-final' $s.name @{ code = $code }; $st.done = $true; continue }
      Retry $st $now $code
    }
    Start-Sleep -Milliseconds 500
  }
}
finally {
  foreach ($st in $state.Values) {
    if ($st.proc -and -not $st.proc.HasExited) {
      & taskkill /T /F /PID $st.proc.Id | Out-Null
      Log 'stopped' $st.svc.name @{ pid = $st.proc.Id }
    }
  }
  Log 'supervisor-exit' $null
}
