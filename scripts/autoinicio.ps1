param([switch]$Quitar)
# Noir Studio - Activa o quita el inicio automatico del hosting al iniciar sesion en Windows.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'Noir Studio Hosting'

if ($Quitar) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host '  Inicio automatico desactivado.' -ForegroundColor Green
  exit 0
}

$bat = Join-Path $Root 'INICIAR.bat'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument ('/c "' + $bat + '"') -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Description 'Inicia Noir Studio Hosting al iniciar sesion' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host '  Inicio automatico activado: el hosting arrancara cada vez que inicies sesion en Windows.' -ForegroundColor Green
