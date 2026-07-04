@echo off
cd /d "%~dp0"
echo Starting local server...
start "TCG Manager Server" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
timeout /t 2 /nobreak >nul
echo Starting public tunnel (watch this window for your https://...trycloudflare.com link)...
"%~dp0cloudflared.exe" tunnel --url http://localhost:8080 --http-host-header "localhost:8080"
