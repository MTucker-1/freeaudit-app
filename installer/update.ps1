# update.ps1 — self-updates the FreeAudit app CODE from the update channel before
# launch. Only refreshes lightweight code files; never touches node.exe, the
# browser engine, node_modules, credentials, config, or saved logins/profiles.
# Fails SAFE: any problem (offline, bad download, not configured) => keep the
# current version and run it. Prints "updated" to stdout if it applied an update.
param([string]$Dir)
$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$cfgPath = Join-Path $Dir 'update.json'
try {
  if (-not (Test-Path $cfgPath)) { return }
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if (-not $cfg.repo -or $cfg.repo -match 'OWNER/REPO') { return }  # channel not set up yet
  $branch = if ($cfg.branch) { $cfg.branch } else { 'main' }
  $localVer = [string]$cfg.version
  $remote = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$($cfg.repo)/$branch/version.json" -TimeoutSec 10
  $remoteVer = [string]$remote.version
  if (-not $remoteVer -or $remoteVer -eq $localVer) { return }  # already current

  # Newer version published — download the code zip and apply it.
  $tmp = Join-Path $env:TEMP ('fa-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp 'code.zip'
  Invoke-WebRequest -Uri "https://codeload.github.com/$($cfg.repo)/zip/refs/heads/$branch" -OutFile $zip -TimeoutSec 90
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not $root) { return }
  # Replace only the code files/folders (leave runtime + user data alone).
  $items = @('server.js', 'audit.js', 'vorto.js', 'gsheets.js', 'connecteam.js', 'checks.js', 'watch-server.js', 'public', 'version.json')
  foreach ($it in $items) {
    $src = Join-Path $root.FullName $it
    if (Test-Path $src) { Copy-Item $src -Destination $Dir -Recurse -Force }
  }
  $cfg.version = $remoteVer
  ($cfg | ConvertTo-Json) | Set-Content $cfgPath -Encoding utf8
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output 'updated'
} catch { return }  # any failure => silently keep the current version
