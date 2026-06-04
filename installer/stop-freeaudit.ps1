# stop-freeaudit.ps1 — stops the background FreeAudit engine on this PC.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pidFile = Join-Path $dir 'server.pid'
if (Test-Path $pidFile) {
  $sp = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($sp) { & taskkill /PID $sp /T /F 2>$null | Out-Null }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
