<#
.SYNOPSIS
  Downloads reports/data.lua from the published wow-ah-tracker GitHub Pages
  site and atomically replaces the copy inside the WowAHTracker addon
  folder. Never overwrites the last-known-good copy with a failed or
  corrupt download - the game keeps reading yesterday's prices rather than
  a truncated or empty file if a fetch attempt fails.

.PARAMETER AddOnsPath
  Path to WoW's AddOns folder. Defaults to the confirmed installation at
  C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns.

.PARAMETER DataUrl
  URL to fetch data.lua from. Defaults to the published Pages URL.
#>
param(
    [string]$AddOnsPath = "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns",
    [string]$DataUrl = "https://sundberg-simon.github.io/wow-ah-tracker/data.lua"
)

$ErrorActionPreference = "Stop"

$AddonDir = Join-Path $AddOnsPath "WowAHTracker"
$DestinationPath = Join-Path $AddonDir "data.lua"
$LogPath = Join-Path $PSScriptRoot "Fetch-DataLua.log"
$TempPath = Join-Path $env:TEMP "wow-ah-tracker-data-lua-$([guid]::NewGuid()).tmp"

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Write-Output $line
    Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue
}

try {
    Invoke-WebRequest -Uri $DataUrl -OutFile $TempPath -UseBasicParsing -TimeoutSec 30

    $content = Get-Content -Path $TempPath -Raw -ErrorAction Stop

    # Validate before ever touching the real file: a failed/partial download
    # (empty body, an HTML error page, truncated content) must never replace
    # a working data.lua the addon is currently reading. The real file leads
    # with a comment header, so check the assignment appears near the top
    # rather than requiring it as the literal first characters, and reject
    # anything that looks like an HTML error/placeholder page.
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "Downloaded file is empty."
    }
    $head = $content.Substring(0, [Math]::Min(500, $content.Length))
    if ($head -notmatch "WowAhTrackerData\s*=\s*\{") {
        throw "Downloaded file does not contain a 'WowAhTrackerData = {' assignment near the top - not a valid data.lua."
    }
    if ($head -match "(?i)<html") {
        throw "Downloaded file looks like an HTML page, not Lua - likely an error/redirect response."
    }

    if (-not (Test-Path $AddonDir)) {
        New-Item -ItemType Directory -Path $AddonDir -Force | Out-Null
    }

    Move-Item -Path $TempPath -Destination $DestinationPath -Force
    Write-Log "OK: updated $DestinationPath ($('{0:N0}' -f $content.Length) bytes)"
}
catch {
    Write-Log "FAILED: $($_.Exception.Message) - kept existing copy at $DestinationPath"
    if (Test-Path $TempPath) { Remove-Item $TempPath -Force -ErrorAction SilentlyContinue }
    exit 1
}
