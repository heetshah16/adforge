# Starts the AdForge voice service (Chatterbox + Whisper) on 127.0.0.1:8190. Models load on first request
# and unload after VOICE_IDLE_TTL_S seconds idle (default 120).
param([int]$Port = 8190)
Push-Location "$PSScriptRoot\..\services\voice"
try { uv run uvicorn app:app --host 127.0.0.1 --port $Port --timeout-keep-alive 5 }
finally { Pop-Location }
