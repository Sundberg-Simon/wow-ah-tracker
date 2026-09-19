<#
.SYNOPSIS
  Registers (or re-registers) the WowAhTrackerPushEarnings scheduled task: a
  once-a-day, safety-net run of Push-Earnings.ps1 in case the manual
  "Push Earnings" shortcut wasn't used.

.PARAMETER Time
  Local time of day to run, HH:mm. Default 09:00.

.NOTES
  Mirrors the existing WowAhTrackerFetch task's shape: runs as the normal
  interactive user (LogonType InteractiveToken - no stored password, no
  elevation at run time), hidden window, StartWhenAvailable so a run missed
  because the PC was off or nobody was logged in at that time happens at the
  next opportunity instead of being skipped for the day.

  On this machine schtasks /create is denied without elevation (same as when
  WowAhTrackerFetch was registered), so if the plain attempt is refused this
  relaunches ITSELF elevated via a UAC prompt - registration only; the task
  itself never runs elevated.

  Idempotent: /f replaces an existing task of the same name.
#>
param(
    [string]$Time = "09:00",
    [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$TaskName = "WowAhTrackerPushEarnings"
$ScriptPath = Join-Path $PSScriptRoot "Push-Earnings.ps1"
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$startBoundary = "$(Get-Date -Format 'yyyy-MM-dd')T$($Time):00"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Daily safety-net push of WoW sales/purchases (SavedVariables) into the wow-ah-tracker DB. The manual 'Push Earnings' desktop shortcut does the same thing on demand.</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
  </Settings>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ScriptPath" -Unattended</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP "$TaskName.xml"
# schtasks /xml wants UTF-16 with a BOM.
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $Elevated) {
    Write-Output "Registering '$TaskName' needs elevation on this machine - approve the UAC prompt (registration only; the task itself runs as you, not elevated)."
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Time", $Time, "-Elevated"
    )
    exit $proc.ExitCode
}

schtasks.exe /create /tn $TaskName /xml $xmlPath /f
if ($LASTEXITCODE -ne 0) {
    Write-Output "FAILED: schtasks /create exited $LASTEXITCODE."
    exit $LASTEXITCODE
}
Remove-Item $xmlPath -ErrorAction SilentlyContinue
Write-Output "Registered '$TaskName': daily at $Time (StartWhenAvailable - catches up if the PC was off)."
