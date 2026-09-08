# Starts Cloudflare tunnel + prints the public webhook URL.
# Keep this window open while Auto Bidder needs email OTP forward.
# Paths are relative to the repo root (parent of server\) — no hardcoded drive/folder name.
$ErrorActionPreference = 'Stop'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# This script lives in <root>\server\scripts\
$serverDir = Split-Path $PSScriptRoot -Parent
$root = Split-Path $serverDir -Parent
if (-not (Test-Path (Join-Path $serverDir 'index.js'))) {
    Write-Host "[ERROR] Cannot find server\index.js near this script." -ForegroundColor Red
    Write-Host "Expected: <repo-root>\server\scripts\startMailTunnel.ps1" -ForegroundColor Yellow
    exit 1
}
Set-Location $serverDir

Write-Host "Repo root: $root"
Write-Host 'Starting cloudflared quick tunnel -> http://127.0.0.1:9017'
Write-Host 'When the trycloudflare.com URL appears, update MAIL_WEBHOOK_PUBLIC_BASE in server/.env and restart the API if it changed.'
& cloudflared tunnel --url http://127.0.0.1:9017
