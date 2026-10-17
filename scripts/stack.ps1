# Starts the local AdForge stack in separate windows: ComfyUI, voice service, Qwen voice, Inngest dev server, worker.
$root = Resolve-Path "$PSScriptRoot\.."
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "$root\scripts\comfyui.ps1"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "$root\scripts\voice.ps1"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "$root\scripts\voice-qwen.ps1"   # only needed when PIPELINE.voice.engineByLanguage routes a language to qwen (P6c)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; pnpm --filter @adforge/worker inngest:dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; pnpm --filter @adforge/worker start"
Write-Host "Started. Inngest UI: http://127.0.0.1:8288  Worker: http://127.0.0.1:3001/health"
