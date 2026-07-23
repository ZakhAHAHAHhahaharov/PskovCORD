# PskovCord native launch (Windows, no Docker).
# Requires: PostgreSQL + Redis/Memurai services running, DB pskovcord created,
# web built (cd web; npm run build), backend\.venv ready.
#
# Usage:  powershell -ExecutionPolicy Bypass -File start-native.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "== PskovCord: native launch ==" -ForegroundColor Cyan

# 1) LiveKit (SFU), dev mode. Used only if backend\.env points to ws://localhost:7880.
$livekit = Join-Path $root "tools\livekit-server.exe"
if (Test-Path $livekit) {
    if (-not (Get-NetTCPConnection -LocalPort 7880 -State Listen -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $livekit -ArgumentList "--dev","--bind","0.0.0.0","--node-ip","127.0.0.1" -WindowStyle Hidden
        Write-Host "[ok] LiveKit started on :7880 (dev keys devkey/secret)" -ForegroundColor Green
    } else { Write-Host "[skip] LiveKit already on :7880" -ForegroundColor Yellow }
} else {
    Write-Host "[warn] tools\livekit-server.exe not found - local voice unavailable" -ForegroundColor Yellow
}

# 2) Backend (Daphne: HTTP + WebSocket + serves built web)
$daphne = Join-Path $root "backend\.venv\Scripts\daphne.exe"
Push-Location (Join-Path $root "backend")
& ".\.venv\Scripts\python.exe" manage.py migrate --noinput | Out-Null
if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $daphne -ArgumentList "-b","0.0.0.0","-p","8000","config.asgi:application" -WindowStyle Hidden
    Write-Host "[ok] Backend started on :8000 (API + WebSocket + web client)" -ForegroundColor Green
} else { Write-Host "[skip] :8000 already in use" -ForegroundColor Yellow }
Pop-Location

Start-Sleep 2
Write-Host ""
Write-Host "Ready. Open:  http://localhost:8000" -ForegroundColor Cyan
