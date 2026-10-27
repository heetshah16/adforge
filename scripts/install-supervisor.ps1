# Registers (or with -Uninstall removes) the "AdForge supervisor" logon scheduled task for the current user.
# The user runs this; the task itself only runs supervisor.ps1. -WhatIf prints the plan and changes nothing.
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Uninstall)
$name = 'AdForge supervisor'
$sup = (Resolve-Path "$PSScriptRoot\supervisor.ps1").Path
$cfg = (Resolve-Path "$PSScriptRoot\supervisor.config.json").Path
$arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$sup`" -Config `"$cfg`""

if ($Uninstall) {
  $exists = [bool](Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
  if (-not $exists) { Write-Host "Scheduled task '$name' is not registered; nothing to remove."; return }
  if ($WhatIfPreference) { Write-Host "What if: would remove scheduled task '$name'." }
  if ($PSCmdlet.ShouldProcess($name, 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed scheduled task '$name'."
  }
  return
}

Write-Host "Task '$name': at logon of $env:USERNAME run: powershell.exe $arg"
Write-Host "Restart on failure: 3 times, 1 minute apart. No execution time limit."
if ($PSCmdlet.ShouldProcess($name, 'Register scheduled task')) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory (Split-Path $PSScriptRoot)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Registered '$name'. It starts at your next logon; start now with: Start-ScheduledTask -TaskName '$name'"
}
