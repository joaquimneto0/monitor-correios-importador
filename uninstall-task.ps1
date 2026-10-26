$ErrorActionPreference = "SilentlyContinue"

$TaskName = "MonitorCorreiosImportador"
$WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupFolder = [Environment]::GetFolderPath("Startup")
$StartupShortcutPath = Join-Path $StartupFolder "MonitorCorreiosImportador.lnk"

# Para o monitor primeiro com graceful shutdown
& (Join-Path $WorkDir "stop-monitor.ps1")

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "[OK] Tarefa '$TaskName' removida do Agendador de Tarefas do Windows." -ForegroundColor Green

if (Test-Path $StartupShortcutPath) {
    Remove-Item $StartupShortcutPath -Force
    Write-Host "[OK] Atalho removido da pasta Inicializar." -ForegroundColor Green
}
