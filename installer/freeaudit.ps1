# freeaudit.ps1 — launches an installed copy of FreeAudit (runs locally on this PC).
# 1) self-updates the app code from the update channel (fail-safe),
# 2) starts the local engine hidden (if not already running),
# 3) opens FreeAudit in its own app window.
#
# -EngineOnly does 1 and 2 but not 3. The Startup shortcut uses it so the engine
# is back after a reboot without an app window appearing at every login.
param([switch]$EngineOnly)
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $dir
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $dir 'browsers'
$port = 4477
$node = Join-Path $dir 'node.exe'
$pidFile = Join-Path $dir 'server.pid'

# Only OUR server counts. Checking the port alone was not enough: anything else
# bound to 4477 on another address (a Tailscale serve proxy, say) made this
# report "already running", so the engine was never started and the app window
# opened on a dead URL — "can't reach this page" with no way to recover by
# clicking the icon again.
function Server-Listening {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') })
}
function Stop-Server {
  if (Test-Path $pidFile) {
    $sp = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($sp) { & taskkill /PID $sp /T /F 2>$null | Out-Null }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}
function Start-Server {
  $p = Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'watch-server.js' -WorkingDirectory $dir -PassThru
  if ($p) { $p.Id | Set-Content $pidFile }
  for ($i = 0; $i -lt 25; $i++) { Start-Sleep -Milliseconds 400; if (Server-Listening) { break } }
}

# 1) Auto-update the code. If it changed, restart the engine so the new code runs.
$updated = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'update.ps1') -Dir $dir
if ($updated -eq 'updated') { Stop-Server }

# 2) Make sure the engine is running.
if (-not (Server-Listening)) { Start-Server }

# 2b) Make sure the engine comes back after a reboot. The installer writes this
# shortcut, but update.ps1 only syncs FILES — so an already-installed copy would
# never get it. Creating it here means existing installs heal themselves on the
# next launch instead of waiting for a reinstall.
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'FreeAudit Engine.lnk'
if (-not (Test-Path $startupLnk) -and (Test-Path (Join-Path $dir 'engine-launcher.vbs'))) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($startupLnk)
    $sc.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $sc.Arguments        = '"' + (Join-Path $dir 'engine-launcher.vbs') + '"'
    $sc.WorkingDirectory = $dir
    $sc.IconLocation     = Join-Path $dir 'logo.ico'
    $sc.Description      = 'Starts the FreeAudit engine at login (no window)'
    $sc.Save()
  } catch { }  # a missing startup shortcut must never stop FreeAudit opening
}

# 3) Open the app window (no address bar — looks like a desktop app).
if ($EngineOnly) { return }
$url = "http://localhost:$port/"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (Test-Path $edge) { Start-Process $edge "--app=$url --window-size=1320,880" }
elseif (Test-Path $chrome) { Start-Process $chrome "--app=$url --window-size=1320,880" }
else { Start-Process $url }
