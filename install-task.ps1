$ErrorActionPreference = "Stop"

$TaskName = "MonitorCorreiosImportador"
$WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath = Join-Path $WorkDir "start-hidden.vbs"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$StartupShortcutPath = Join-Path $StartupFolder "MonitorCorreiosImportador.lnk"

Write-Host "Configurando inicializacao automatica no Windows para: $TaskName" -ForegroundColor Cyan

# 1. Registra no Agendador de Tarefas do Windows (Task Scheduler) ao fazer Logon
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`"" -WorkingDirectory $WorkDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Monitora as encomendas no Portal Minhas Importacoes dos Correios e envia alertas no Telegram." -Force | Out-Null
Write-Host "[OK] Tarefa '$TaskName' registrada no Agendador de Tarefas do Windows." -ForegroundColor Green

# 2. Cria também atalho na pasta Inicializar (shell:startup) como garantia redundante
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($StartupShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $WorkDir
$Shortcut.Description = "Monitor Correios Importador (Background)"
$Shortcut.Save()
Write-Host "[OK] Atalho de inicializacao salvo em: $StartupShortcutPath" -ForegroundColor Green

# 3. Inicia a tarefa imediatamente em background
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$PidFile = Join-Path $WorkDir "monitor.pid"
if (Test-Path $PidFile) {
    $RunningPid = Get-Content $PidFile
    Write-Host "[OK] Monitor em execucao em segundo plano (PID: $RunningPid)!" -ForegroundColor Green
} else {
    Write-Host "[INFO] Tarefa disparada. Verifique monitor.log para acompanhar." -ForegroundColor Yellow
}
