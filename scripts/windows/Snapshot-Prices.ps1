<#
.SYNOPSIS
  Records the current auction prices of every item the crafting optimizer
  watches (npm run crafting -- prices snapshot) into the local crafting DB.
  Run hourly by the WowAhTrackerPriceSnapshot scheduled task so the Crafting
  tab can say whether a price is low or high next to the last week's - a
  single price on its own can't. Safe to run any number of times: a Blizzard
  dump already recorded is left alone.

.PARAMETER RepoPath
  Path to the wow-ah-tracker checkout. Defaults to two levels above this
  script.

.NOTES
  Local only: reads Blizzard's public commodity data and writes to
  data-private/crafting.sqlite (gitignored). Touches none of the player's own
  records (batches, runs, policies) and none of the Neon data. Output goes to
  Snapshot-Prices.log next to this script.
#>
param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $PSScriptRoot "Snapshot-Prices.log"

function Write-Status {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Write-Host $line
    Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue
}

try {
    # Keep the log from growing forever: once it passes ~256 KB, keep its last 500 lines.
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 262144)) {
        $tail = Get-Content $LogPath -Tail 500
        Set-Content -Path $LogPath -Value $tail
    }

    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) {
        $npm = "C:\Program Files\nodejs\npm.cmd"
    }
    if (-not (Test-Path $npm)) {
        throw "npm.cmd not found on PATH or in C:\Program Files\nodejs - is Node installed for this user?"
    }

    $env:NODE_NO_WARNINGS = "1"
    $tmp = Join-Path $env:TEMP "wow-ah-tracker-price-snapshot-$([guid]::NewGuid()).txt"
    Push-Location $RepoPath
    try {
        # Redirect inside cmd.exe: Windows PowerShell 5.1 turns a native command's stderr into
        # ErrorRecords, which -ErrorAction Stop would report as a failure even on exit 0.
        cmd.exe /c "`"$npm`" run crafting -- prices snapshot > `"$tmp`" 2>&1"
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $lines = if (Test-Path $tmp) { Get-Content $tmp } else { @() }
    Remove-Item $tmp -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        if ($line -notmatch "^\s*$" -and $line -notmatch "npm notice") { Write-Status "  $line" }
    }
    if ($code -ne 0) {
        Write-Status "FAILED: price snapshot exited $code - see the output above."
        exit $code
    }
    exit 0
} catch {
    Write-Status "FAILED: $($_.Exception.Message)"
    exit 1
}
