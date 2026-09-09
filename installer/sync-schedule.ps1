# sync-schedule.ps1 — makes Windows Task Scheduler match FreeAudit's config.
#
# The schedule lives in config.json ("schedule"), edited in the FreeAudit app.
# This script is the one thing that turns it into real Windows tasks, so the
# app never has to know anything about schtasks.
#
# Scheduled tasks are used rather than a timer inside FreeAudit for two reasons:
#   * a timer inside the app only fires while the app is open, and the web
#     server is NOT in the Startup folder — only the portal agent is; and
#   * only Task Scheduler can WAKE a sleeping PC. This machine is Modern
#     Standby (S0 low-power idle), so it is asleep most of the time.
#
# Tasks are recreated from scratch on every sync: removing them all and writing
# what the config says is simpler and safer than reconciling, and there are only
# ever a handful.
#
# Usage: powershell -File sync-schedule.ps1 [-DataDir <path>]
param([string]$DataDir = "")

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appDir = Split-Path -Parent $dir            # installer\ lives under the app dir
if (-not $DataDir) { $DataDir = $appDir }

$cfgPath = Join-Path $DataDir 'config.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { Write-Output "no config.json at $cfgPath"; exit 1 }

# -Raw then ConvertFrom-Json: Get-Content without -Raw hands back an array of
# lines and ConvertFrom-Json rejects it.
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sched = $cfg.schedule

$prefix = 'FreeAudit Run'

# --- clear out the previous set -------------------------------------------
$existing = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$prefix*" }
foreach ($t in $existing) {
  Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Output ("removed {0} existing task(s)" -f @($existing).Count)

if (-not $sched -or -not $sched.enabled -or -not $sched.runs -or @($sched.runs).Count -eq 0) {
  Write-Output "schedule disabled or empty - nothing scheduled"
  exit 0
}

# --- rebuild ---------------------------------------------------------------
$vbs = Join-Path $appDir 'scheduled-launcher.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { $vbs = Join-Path $dir 'scheduled-launcher.vbs' }
if (-not (Test-Path -LiteralPath $vbs)) { Write-Output "scheduled-launcher.vbs not found"; exit 1 }

$wake = $true
if ($null -ne $sched.wake) { $wake = [bool]$sched.wake }

# WakeToRun asks Windows to wake the machine for the task. AllowStartIfOnBatteries
# / DontStopIfGoingOnBatteries matter on a laptop: without them a run on battery
# is skipped or killed mid-audit.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun:$wake `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

$made = 0
foreach ($run in $sched.runs) {
  $time = [string]$run.time
  if ($time -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') { Write-Output "skipped bad time '$time'"; continue }
  $kind = [string]$run.kind
  if ($kind -notin @('audit', 'open', 'both')) { $kind = 'audit' }

  $name = "$prefix $($time.Replace(':','-')) $kind"
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument ('"{0}" {1}' -f $vbs, $kind) -WorkingDirectory $appDir
  $trigger = New-ScheduledTaskTrigger -Daily -At $time

  try {
    # Interactive logon type: the audit drives a visible Chrome window, so it
    # needs the user's own desktop session. "Run whether logged on or not" would
    # start it in session 0 where the browser cannot appear.
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
      -Settings $settings -RunLevel Limited `
      -User $env:USERNAME -Description "FreeAudit scheduled $kind run at $time" | Out-Null
    Write-Output "scheduled $time  $kind"
    $made++
  } catch {
    Write-Output ("FAILED {0} {1}: {2}" -f $time, $kind, $_.Exception.Message)
  }
}
Write-Output "$made task(s) active"
