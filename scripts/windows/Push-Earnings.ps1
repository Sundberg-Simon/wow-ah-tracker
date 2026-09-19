<#
.SYNOPSIS
  Pushes the WoW addon's sale/purchase logs and realm roster from every WoW
  account's SavedVariables file into the Neon DB (npm run ingest), then
  regenerates the local earnings report (npm run report:earnings ->
  reports-private/earnings.html) so it's never a manual second step. Safe to
  run any number of times: the ingest is insert-only and idempotent, so a
  second run right after the first inserts nothing.

.PARAMETER RepoPath
  Path to the wow-ah-tracker checkout. Defaults to two levels above this
  script.

.PARAMETER Unattended
  For the scheduled daily run: no interactive niceties, output goes to the log
  only, and the exit code is that of whichever step (ingest, then report)
  failed, or 0.

.NOTES
  WoW only writes SavedVariables when a character logs out or /reloads, so
  whatever the game is doing RIGHT NOW is not in the file yet - the best time
  to run this by hand is right after logging out. If WoW is running, this
  warns (it can't hurt anything - the ingest only reads the files - it just
  means the freshest captures may be missing until the next logout).

  Direct-to-Neon from this machine, deliberately not relayed through GitHub:
  the repo and its Pages site are public and this is personal income data.
#>
param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [switch]$Unattended
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $PSScriptRoot "Push-Earnings.log"

function Write-Status {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    # Write-Host, not Write-Output: Invoke-NpmScript logs from inside a function
    # whose return value is the exit code, and pipeline output would pollute it.
    Write-Host $line
    Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue
}

try {
    if (Get-Process -Name "Wow" -ErrorAction SilentlyContinue) {
        Write-Status "NOTE: WoW is running - SavedVariables are only written on logout or /reload, so this session's newest sales/purchases may not be in the files yet. Run again after logging out to pick them up."
    }

    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) {
        $npm = "C:\Program Files\nodejs\npm.cmd"
    }
    if (-not (Test-Path $npm)) {
        throw "npm.cmd not found on PATH or in C:\Program Files\nodejs - is Node installed for this user?"
    }

    # Runs one npm script and logs its output. Redirects inside cmd.exe, not
    # PowerShell: Windows PowerShell 5.1 wraps a native command's stderr lines
    # in ErrorRecords, which -ErrorAction Stop would turn into a bogus failure
    # even on a clean exit 0.
    function Invoke-NpmScript {
        param([string]$Script)
        $safeName = $Script -replace "[^A-Za-z0-9]", "-" # script names like report:earnings contain a colon, invalid in a filename
        $tmp = Join-Path $env:TEMP "wow-ah-tracker-$safeName-$([guid]::NewGuid()).txt"
        Push-Location $RepoPath
        try {
            cmd.exe /c "`"$npm`" run $Script > `"$tmp`" 2>&1"
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $lines = if (Test-Path $tmp) { Get-Content $tmp } else { @() }
        Remove-Item $tmp -ErrorAction SilentlyContinue
        foreach ($line in $lines) {
            Write-Status "  $line"
        }
        return $code
    }

    $env:NODE_NO_WARNINGS = "1" # silences pg's SSL-mode deprecation notice; our own console.warn lines are unaffected

    $ingestExit = Invoke-NpmScript "ingest"
    if ($ingestExit -ne 0) {
        Write-Status "FAILED: earnings ingest exited $ingestExit - see the output above (nothing was committed to the DB if it failed mid-way; the ingest is all-or-nothing). Report NOT regenerated."
        exit $ingestExit
    }
    Write-Status "Ingest finished."

    # Regenerate the report from what's in the DB now. A failure here doesn't
    # undo the (already committed, idempotent) ingest - say so explicitly.
    $reportExit = Invoke-NpmScript "report:earnings"
    if ($reportExit -ne 0) {
        Write-Status "FAILED: report generation exited $reportExit - the ingest itself succeeded and is in the DB; only reports-private/earnings.html is stale."
        exit $reportExit
    }
    Write-Status "DONE: earnings ingested and reports-private/earnings.html regenerated."
    exit 0
} catch {
    Write-Status "FAILED: $($_.Exception.Message)"
    exit 1
}
