<#
.SYNOPSIS
  Registers (or re-registers) the WowAhTrackerPriceSnapshot scheduled task:
  Snapshot-Prices.ps1 once an hour, so the Crafting tab has a price history to
  judge today's price against.

.PARAMETER EveryMinutes
  How often to run, in minutes. Default 60. (Blizzard refreshes the commodity
  dump about hourly, so more often than that only fetches the same data.)

.NOTES
  Same shape as the WowAhTrackerPushEarnings / WowAhTrackerFetch tasks: runs
  as the normal interactive user (LogonType InteractiveToken - no stored
  password, no elevation at run time), hidden window, StartWhenAvailable so a
  run missed because the PC was off happens at the next opportunity.

  On this machine schtasks /create is denied without elevation, so if the plain
  attempt is refused this relaunches ITSELF elevated via a UAC prompt -
  registration only; the task itself never runs elevated.

  Idempotent: /f replaces an existing task of the same name. Remove it with
  schtasks /delete /tn WowAhTrackerPriceSnapshot /f (needs the same elevation).
#>
param(
    [int]$EveryMinutes = 60,
    [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$TaskName = "WowAhTrackerPriceSnapshot"
$ScriptPath = Join-Path $PSScriptRoot "Snapshot-Prices.ps1"
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$startBoundary = (Get-Date).AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ss")
$interval = "PT$($EveryMinutes)M"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Hourly record of the crafting optimizer's auction prices (local crafting DB only), so the Crafting tab can tell whether a price is low or high compared with the last week.</Description>
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
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
  </Settings>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Repetition>
        <Interval>$interval</Interval>
        <Duration>P3650D</Duration>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ScriptPath"</Arguments>
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
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-EveryMinutes", $EveryMinutes, "-Elevated"
    )
    exit $proc.ExitCode
}

schtasks.exe /create /tn $TaskName /xml $xmlPath /f
if ($LASTEXITCODE -ne 0) {
    Write-Output "FAILED: schtasks /create exited $LASTEXITCODE."
    exit $LASTEXITCODE
}
Remove-Item $xmlPath -ErrorAction SilentlyContinue
Write-Output "Registered '$TaskName': every $EveryMinutes minutes (StartWhenAvailable - catches up if the PC was off)."
