@echo off
cd /d "%~dp0"
start "" http://localhost:8080/
start "TCG Manager Admin API" powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0admin-server.ps1"
powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
