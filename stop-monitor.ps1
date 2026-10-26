$ErrorActionPreference = "SilentlyContinue"

$WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StopFile = Join-Path $WorkDir "stop.signal"
$PidFile = Join-Path $WorkDir "monitor.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "Monitor nao parece estar em execucao (monitor.pid nao encontrado)." -ForegroundColor Yellow
    exit 0
}

$TargetPid = Get-Content $PidFile
Write-Host "Enviando comando de desligamento seguro (graceful shutdown) para o PID $TargetPid..." -ForegroundColor Cyan

# Cria arquivo stop.signal que o monitor.js detecta a cada 1 segundo para salvar state.json e sair
Set-Content -Path $StopFile -Value "STOP" -Encoding UTF8

for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path $PidFile)) {
        Write-Host "[OK] Monitor encerrado com seguranca e status salvo em state.json!" -ForegroundColor Green
        exit 0
    }
}

Write-Host "[AVISO] Processo ainda ativo, forcando encerramento..." -ForegroundColor Yellow
Stop-Process -Id $TargetPid -Force
if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
Write-Host "[OK] Processo finalizado." -ForegroundColor Green
