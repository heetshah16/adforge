# Starts the AdForge Qwen3-TTS service on 127.0.0.1:8191. Models load on first request
# and unload after QWEN_IDLE_TTL_S seconds idle (default 120).
# The service's watchdog exits with code 3 when a GPU call hangs; that (and only that) restarts it, after 2 s,
# at most 5 times in 10 minutes. Any other exit code ends the script.
param([int]$Port = 8191)
Push-Location "$PSScriptRoot\..\services\voice-qwen"
try {
  $env:UV_LINK_MODE = "copy"  # a OneDrive-hosted .venv cannot hardlink from the uv cache
  $restarts = New-Object System.Collections.Generic.List[datetime]
  while ($true) {
    uv run uvicorn app:app --host 127.0.0.1 --port $Port --timeout-keep-alive 5
    $code = $LASTEXITCODE
    if ($code -ne 3) { exit $code }
    $now = Get-Date
    [void]$restarts.RemoveAll({ param($t) ($now - $t).TotalMinutes -gt 10 })
    if ($restarts.Count -ge 5) { Write-Error "voice-qwen: watchdog exit 3 five times in 10 minutes; giving up"; exit 3 }
    $restarts.Add($now)
    Write-Warning "voice-qwen: watchdog exit (code 3); restarting in 2 s ($($restarts.Count)/5 in the last 10 minutes)"
    Start-Sleep -Seconds 2
  }
}
finally { Pop-Location }
