<#
.SYNOPSIS
  Downloads reports/data.lua from the published wow-ah-tracker GitHub Pages
  site and atomically replaces the copy inside the WowAHTracker addon
  folder. Never overwrites the last-known-good copy with a failed or
  corrupt download - the game keeps reading yesterday's prices rather than
  a truncated or empty file if a fetch attempt fails.

  Also checks the downloaded file's own `generatedAt` timestamp and logs a
  STALE warning if it's more than StaleAfterHours old (deep-review-
  2026-09-26.md, finding S2): a successful download only proves the Pages
  site answered, not that the sync pipeline behind it is still running - a
  stalled sync (GitHub's 60-day scheduled-workflow auto-disable, an
  exhausted Actions quota, a crashed job) would otherwise go unnoticed
  forever, since this script previously logged "OK" for any file it could
  download and parse, regardless of age.

.PARAMETER AddOnsPath
  Path to WoW's AddOns folder. Defaults to the confirmed installation at
  C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns.

.PARAMETER DataUrl
  URL to fetch data.lua from. Defaults to the published Pages URL.

.PARAMETER StaleAfterHours
  How old `generatedAt` can be before this logs STALE instead of OK.
  Default 12h - the sync's own self-throttle only needs ~1h between
  successful runs (CLAUDE.md #7), so 12h is already several missed cycles,
  not a false alarm on ordinary jitter.
#>
param(
    [string]$AddOnsPath = "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns",
    [string]$DataUrl = "https://sundberg-simon.github.io/wow-ah-tracker/data.lua",
    [int]$StaleAfterHours = 12
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

    # Staleness check (finding S2): a successful download only proves Pages
    # answered, not that the sync pipeline behind it is still producing new
    # data. generatedAt is UTC ISO 8601 (scripts/report.ts), so this is exact
    # - no timezone guesswork, unlike the addon-side check.
    $genMatch = [regex]::Match($content, 'generatedAt\s*=\s*"([^"]+)"')
    if ($genMatch.Success) {
        try {
            $generatedAtUtc = [DateTimeOffset]::Parse($genMatch.Groups[1].Value).UtcDateTime
            $ageHours = ((Get-Date).ToUniversalTime() - $generatedAtUtc).TotalHours
            if ($ageHours -ge $StaleAfterHours) {
                $staleMsg = ("STALE: data.lua's generatedAt is {0:N1}h old ({1:o}) - the sync or GitHub Pages may be stuck. " -f $ageHours, $generatedAtUtc) `
                    + "Check Actions (gh run list --workflow=sync.yml) and GitHub's 60-day scheduled-workflow auto-disable if nothing's been pushed in a while."
                Write-Log $staleMsg
                try {
                    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
                    $icon = New-Object System.Windows.Forms.NotifyIcon
                    $icon.Icon = [System.Drawing.SystemIcons]::Warning
                    $icon.Visible = $true
                    $icon.ShowBalloonTip(10000, "WoW AH Tracker data is stale", ("Last generated {0:N1}h ago - check the sync." -f $ageHours), [System.Windows.Forms.ToolTipIcon]::Warning)
                    Start-Sleep -Seconds 1
                    $icon.Dispose()
                } catch {
                    # Best-effort only (no desktop session, no System.Windows.Forms, etc.) -
                    # the STALE log line above is the reliable signal, never fail the fetch over this.
                    Write-Log "  (could not show a desktop notification: $($_.Exception.Message))"
                }
            }
        } catch {
            Write-Log "  (could not parse generatedAt '$($genMatch.Groups[1].Value)' for a staleness check: $($_.Exception.Message))"
        }
    } else {
        Write-Log "  (no generatedAt field found - skipping staleness check)"
    }
}
catch {
    Write-Log "FAILED: $($_.Exception.Message) - kept existing copy at $DestinationPath"
    if (Test-Path $TempPath) { Remove-Item $TempPath -Force -ErrorAction SilentlyContinue }
    exit 1
}
