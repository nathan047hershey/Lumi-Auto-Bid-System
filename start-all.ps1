# Job Apply Master - Start All Services
# Paths are relative to this script's folder (the repo root). Works on any drive/PC.

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Job Apply Master - Starting Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$serverDir = Join-Path $root 'server'
$clientDir = Join-Path $root 'client'

if (-not (Test-Path (Join-Path $serverDir 'index.js'))) {
    Write-Host "[ERROR] server\index.js not found under: $root" -ForegroundColor Red
    Write-Host "Run this script from the repo root (folder that contains server\ and client\)." -ForegroundColor Yellow
    exit 1
}

# Stop any existing instances
Write-Host "[*] Stopping existing Node processes..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Start Backend Server
Write-Host "[1/2] Starting Backend Server..." -ForegroundColor Green
$serverLog = Join-Path $serverDir 'server.log'
$serverJob = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $serverDir -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $serverDir 'server-error.log') -WindowStyle Hidden
Write-Host "    Server PID: $($serverJob.Id)" -ForegroundColor Gray
Write-Host "    Root: $root" -ForegroundColor Gray
Write-Host "    Data: $(Join-Path $root 'database')" -ForegroundColor Gray

# Wait for server to initialize
Start-Sleep -Seconds 3

# Start Frontend
Write-Host "[2/2] Starting Frontend on port 5173..." -ForegroundColor Green
$clientJob = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -WorkingDirectory $clientDir -PassThru -WindowStyle Hidden
Write-Host "    Frontend PID: $($clientJob.Id)" -ForegroundColor Gray

# Wait for frontend to start
Start-Sleep -Seconds 3

# Verify services
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Checking services..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$apiBase = if ($env:PORT) { "http://localhost:$($env:PORT)" } else { "http://localhost:9017" }

# Check backend
try {
    $response = Invoke-WebRequest -Uri "$apiBase/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "[OK] Backend API: $apiBase" -ForegroundColor Green
    }
} catch {
    Write-Host "[!!] Backend API: $apiBase (Not responding — check server\log)" -ForegroundColor Red
}

# Check frontend
try {
    $response = Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "[OK] Frontend: http://localhost:5173" -ForegroundColor Green
    }
} catch {
    Write-Host "[!!] Frontend: http://localhost:5173 (Not responding)" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Services Started!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "URLs:" -ForegroundColor White
Write-Host "  - Backend API: $apiBase" -ForegroundColor Gray
Write-Host "  - Frontend:    http://localhost:5173" -ForegroundColor Gray
Write-Host "  - Health:      $apiBase/health" -ForegroundColor Gray
Write-Host ""
Write-Host "Prefer: Job Apply Master.bat or run-all.bat (same root, portable)." -ForegroundColor Yellow
Write-Host ""
