@echo off
cd /d "%~dp0"
echo Starting local server...
start "TCG Manager Server" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
start "TCG Manager Admin API (local only, not tunneled)" powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0admin-server.ps1"
timeout /t 2 /nobreak >nul
echo Starting public tunnel (watch this window for your https://...trycloudflare.com link)...
echo NOTE: only port 8080 is tunneled below -- the admin API on 8081 stays local-only.
"%~dp0cloudflared.exe" tunnel --url http://localhost:8080 --http-host-header "localhost:8080"
