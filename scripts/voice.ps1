# Starts the AdForge voice service (Chatterbox + Whisper) on 127.0.0.1:8190. Models load on first request
# and unload after VOICE_IDLE_TTL_S seconds idle (default 120).
# The service's watchdog exits with code 3 when a GPU call hangs; that (and only that) restarts it, after 2 s,
# at most 5 times in 10 minutes. Any other exit code ends the script.
param([int]$Port = 8190)
Push-Location "$PSScriptRoot\..\services\voice"
try {
  $restarts = New-Object System.Collections.Generic.List[datetime]
  while ($true) {
    uv run uvicorn app:app --host 127.0.0.1 --port $Port --timeout-keep-alive 5
    $code = $LASTEXITCODE
    if ($code -ne 3) { exit $code }
    $now = Get-Date
    [void]$restarts.RemoveAll({ param($t) ($now - $t).TotalMinutes -gt 10 })
    if ($restarts.Count -ge 5) { Write-Error "voice: watchdog exit 3 five times in 10 minutes; giving up"; exit 3 }
    $restarts.Add($now)
    Write-Warning "voice: watchdog exit (code 3); restarting in 2 s ($($restarts.Count)/5 in the last 10 minutes)"
    Start-Sleep -Seconds 2
  }
}
finally { Pop-Location }
