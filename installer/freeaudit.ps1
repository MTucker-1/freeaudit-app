# freeaudit.ps1 — launches an installed copy of FreeAudit (runs locally on this PC).
# 1) self-updates the app code from the update channel (fail-safe),
# 2) starts the local engine hidden (if not already running),
# 3) opens FreeAudit in its own app window.
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $dir
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $dir 'browsers'
$port = 4477
$node = Join-Path $dir 'node.exe'
$pidFile = Join-Path $dir 'server.pid'

function Server-Listening { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) }
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

# 3) Open the app window (no address bar — looks like a desktop app).
$url = "http://localhost:$port/"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (Test-Path $edge) { Start-Process $edge "--app=$url --window-size=1320,880" }
elseif (Test-Path $chrome) { Start-Process $chrome "--app=$url --window-size=1320,880" }
else { Start-Process $url }
