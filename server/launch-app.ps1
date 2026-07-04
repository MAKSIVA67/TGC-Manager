# TCG Manager - desktop app launcher
# Starts the local server if it isn't already running, then opens the game
# in a Chrome "app window" (no tabs/address bar) so it feels like an installed app.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"

$serverUp = $false
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8080/" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $serverUp = $true }
} catch {}

if (-not $serverUp) {
    Start-Process powershell.exe -ArgumentList @(
        "-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"$root\serve.ps1`""
    ) -WindowStyle Hidden
    Start-Sleep -Seconds 1
}

Start-Process $chrome -ArgumentList @(
    "--app=http://localhost:8080/",
    "--window-size=430,932",
    "--user-data-dir=$env:LOCALAPPDATA\TCGManagerApp"
)
