# Starts the Comfy Desktop install headless on a fixed port for AdForge.
# Same models/input/output as the Desktop app; GUI still at http://127.0.0.1:$Port.
# Override paths with COMFY_DESKTOP_INSTALL / COMFY_DESKTOP_SHARED if your install differs.
param([int]$Port = 8188)

$install = if ($env:COMFY_DESKTOP_INSTALL) { $env:COMFY_DESKTOP_INSTALL } else { "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI" }
$shared  = if ($env:COMFY_DESKTOP_SHARED)  { $env:COMFY_DESKTOP_SHARED }  else { "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Shared" }
$paths   = Get-ChildItem "$env:APPDATA\Comfy Desktop\instance-model-paths\*.yaml" -ErrorAction Stop | Select-Object -First 1

& "$install\.venv\Scripts\python.exe" "$install\main.py" `
  --listen 127.0.0.1 --port $Port --disable-auto-launch `
  --extra-model-paths-config $paths.FullName `
  --input-directory "$shared\input" --output-directory "$shared\output"
