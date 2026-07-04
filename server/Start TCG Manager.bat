@echo off
cd /d "%~dp0"
start "" http://localhost:8080/
powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
