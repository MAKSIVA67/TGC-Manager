# TCG Manager - local-only admin API (player roster editing)
#
# This is a SEPARATE server from serve.ps1, on a different port, and is
# deliberately never passed to cloudflared. That's the actual security
# boundary: "localhost" always resolves to whoever is running the browser,
# so a friend's browser hitting http://localhost:8081 reaches THEIR OWN
# machine, not this one, no matter what URL they used to load the game.
# Only a browser physically running on this PC can ever reach this API.
#
# Routes:
#   GET  /players  -> current contents of players.json
#   POST /players  -> replace players.json with the request body, after
#                      validating it's a well-formed player roster array
param([int]$Port = 8081)

$root = $PSScriptRoot
$playersPath = Join-Path $root "players.json"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
    $listener.Start()
} catch {
    Write-Host "Could not bind admin API to port $Port (already running?)." -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    exit 1
}

Write-Host "TCG Manager admin API is live at http://localhost:$Port/ (local device only, not tunneled)" -ForegroundColor Green

$validPositions = @("GK", "DEF", "MID", "FWD")
$validRarities = @("Common", "Uncommon", "Rare", "Epic", "Elite", "Ultra", "Legendary", "Mythic", "Icon", "GOAT")

function Test-PlayerRoster {
    param($Roster)
    if ($null -eq $Roster) { return $false }
    # A single object (not an array) from ConvertFrom-Json when there's only one item -- reject, we require an array.
    if ($Roster -isnot [System.Collections.IEnumerable] -or $Roster -is [string]) { return $false }
    foreach ($p in $Roster) {
        if ($null -eq $p.id -or $null -eq $p.name -or $null -eq $p.position -or $null -eq $p.power -or $null -eq $p.rarity) { return $false }
        if ($p.name -isnot [string] -or $p.name.Trim().Length -eq 0) { return $false }
        if ($validPositions -notcontains $p.position) { return $false }
        if ($validRarities -notcontains $p.rarity) { return $false }
        $powerNum = 0
        if (-not [double]::TryParse([string]$p.power, [ref]$powerNum)) { return $false }
        if ($powerNum -lt 1 -or $powerNum -gt 100) { return $false }
    }
    return $true
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $response.Headers.Add("Access-Control-Allow-Origin", "*")
    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
    try {
        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 204
        } elseif ($request.Url.LocalPath -eq "/players" -and $request.HttpMethod -eq "GET") {
            $bytes = [System.IO.File]::ReadAllBytes($playersPath)
            $response.ContentType = "application/json; charset=utf-8"
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } elseif ($request.Url.LocalPath -eq "/players" -and $request.HttpMethod -eq "POST") {
            $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd()
            $reader.Close()
            try {
                $parsed = $body | ConvertFrom-Json
            } catch {
                $parsed = $null
            }
            if (Test-PlayerRoster $parsed) {
                # Re-serialize (rather than writing the raw body) so the file on disk
                # is always canonically formatted JSON, not whatever the client sent.
                $json = $parsed | ConvertTo-Json -Depth 5
                [System.IO.File]::WriteAllText($playersPath, $json, [System.Text.Encoding]::UTF8)
                $response.ContentType = "application/json; charset=utf-8"
                $okBytes = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true,"count":' + $parsed.Count + '}')
                $response.OutputStream.Write($okBytes, 0, $okBytes.Length)
            } else {
                $response.StatusCode = 400
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"Invalid player roster payload"}')
                $response.ContentType = "application/json; charset=utf-8"
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
            }
        } else {
            $response.StatusCode = 404
        }
    } catch {
        $response.StatusCode = 500
    } finally {
        $response.OutputStream.Close()
    }
}
