<#
.SYNOPSIS
  Manually triggers the wow-ah-tracker sync workflow on GitHub Actions,
  waits for it to finish, then pulls whatever is currently published down
  into the WoW AddOns folder via Fetch-DataLua.ps1 - for right before a
  play session, instead of hoping the background */15 schedule happened
  to fire recently.

.PARAMETER Repo
  GitHub repo in owner/name form.

.PARAMETER AddOnsPath
  Passed through to Fetch-DataLua.ps1.

.NOTES
  Deliberately does NOT poll data.lua's generatedAt as a "done" signal -
  generatedAt bumps on every workflow run, including ticks where
  runFullSync() self-throttled and did no real work (see CLAUDE.md).
  Polling the workflow run's own status instead sidesteps that entirely:
  it only tells us the run finished, not whether it did real work - which
  is correct, since if the last real sync was under the 55-minute
  self-throttle window, the already-published data is "fresh enough" by
  the pipeline's own definition and there's nothing wrong with fetching it.
#>
param(
    [string]$Repo = "Sundberg-Simon/wow-ah-tracker",
    [string]$AddOnsPath = "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns"
)

$PollIntervalSeconds = 5
$OverallTimeoutSeconds = 180
$ActionsUrl = "https://github.com/$Repo/actions"

function Write-Status {
    param([string]$Message)
    Write-Output "$(Get-Date -Format 'HH:mm:ss') $Message"
}

Write-Status "Triggering sync workflow on $Repo..."
$dispatchedAt = (Get-Date).ToUniversalTime()

gh workflow run sync.yml --repo $Repo
if ($LASTEXITCODE -ne 0) {
    Write-Status "FAILED: could not trigger the workflow (gh exited $LASTEXITCODE) - is 'gh auth status' still logged in?"
    exit 1
}

$deadline = (Get-Date).AddSeconds($OverallTimeoutSeconds)
$runId = $null

# Step 1: find the run that was just dispatched. There's a short delay
# between "gh workflow run" returning and the run actually appearing in
# the API, so this gets its own retries within the overall time budget.
# Matching on event=workflow_dispatch + createdAt handles a concurrently
# queued scheduled run correctly (sync.yml's concurrency group means they
# can't run in parallel, so ours may sit queued behind one briefly).
while (-not $runId -and (Get-Date) -lt $deadline) {
    try {
        $runs = gh run list --repo $Repo --workflow=sync.yml --limit 5 --json databaseId,event,createdAt | ConvertFrom-Json
        $candidate = $runs |
            Where-Object { $_.event -eq "workflow_dispatch" -and ([datetime]$_.createdAt).ToUniversalTime() -ge $dispatchedAt.AddSeconds(-5) } |
            Sort-Object createdAt -Descending |
            Select-Object -First 1
        if ($candidate) {
            $runId = $candidate.databaseId
            Write-Status "Found dispatched run: $runId"
        }
    } catch {
        # Transient gh/network hiccup - just retry on the next iteration.
    }
    if (-not $runId) {
        Start-Sleep -Seconds $PollIntervalSeconds
    }
}

if (-not $runId) {
    Write-Status "TIMED OUT: the dispatched run never showed up after $OverallTimeoutSeconds s - it's taking longer than expected. Check the Actions tab: $ActionsUrl"
    exit 1
}

# Step 2: wait for that specific run to finish, regardless of outcome - a
# failed sync run is still worth fetching after, since Fetch-DataLua.ps1
# just pulls whatever is currently published (an earlier, still-good
# snapshot if this run failed before publishing) and validates it itself.
$status = $null
$conclusion = $null
while ((Get-Date) -lt $deadline) {
    try {
        $run = gh run view $runId --repo $Repo --json status,conclusion | ConvertFrom-Json
        $status = $run.status
        $conclusion = $run.conclusion
    } catch {
        # Transient gh/network hiccup - just retry on the next iteration.
    }
    if ($status -eq "completed") {
        break
    }
    Start-Sleep -Seconds $PollIntervalSeconds
}

if ($status -ne "completed") {
    Write-Status "TIMED OUT: run $runId is still '$status' after $OverallTimeoutSeconds s - it's taking longer than expected. Check the Actions tab: $ActionsUrl/runs/$runId"
    exit 1
}

Write-Status "Workflow run $runId finished: $conclusion. Fetching latest published data..."

& (Join-Path $PSScriptRoot "Fetch-DataLua.ps1") -AddOnsPath $AddOnsPath
$fetchExitCode = $LASTEXITCODE

if ($fetchExitCode -eq 0) {
    Write-Status "DONE: sync run $conclusion, data.lua updated. Log in or /reload for fresh prices."
} else {
    Write-Status "PARTIAL: sync run $conclusion, but the data.lua fetch failed - see Fetch-DataLua.log for details."
    exit 1
}
