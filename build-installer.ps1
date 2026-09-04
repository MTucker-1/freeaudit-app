# build-installer.ps1 — assembles a self-contained FreeAudit and compiles the
# Windows installer (FreeAudit-Setup.exe). Run from the project root.
$ErrorActionPreference = 'Stop'
$proj  = $PSScriptRoot
$build = Join-Path $proj 'installer-build'
$app   = Join-Path $build 'app'
$iscc  = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$nodeExe = (Get-Command node).Source
$pwCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'

# Single source of truth for the version — version.json, the same file the
# updater compares against. Hardcoding it here made fresh installs claim an old
# version and immediately re-download code they already had.
$ver = (Get-Content (Join-Path $proj 'version.json') -Raw | ConvertFrom-Json).version
if (-not $ver) { throw 'version.json has no "version" field.' }
Write-Host "Building FreeAudit $ver"

Write-Host '[1/9] Clean staging…'
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null

Write-Host '[2/9] App code…'
# All root-level .js (matches what update.ps1 syncs, so a new module can't be
# left out of one and not the other).
Get-ChildItem (Join-Path $proj '*.js') -File | ForEach-Object { Copy-Item $_.FullName $app -Force }
Copy-Item (Join-Path $proj 'package.json') $app -Force
Copy-Item (Join-Path $proj 'public') (Join-Path $app 'public') -Recurse -Force

Write-Host '[3/9] node_modules…'
Copy-Item (Join-Path $proj 'node_modules') (Join-Path $app 'node_modules') -Recurse -Force

Write-Host '[4/9] Portable Node…'
Copy-Item $nodeExe (Join-Path $app 'node.exe') -Force

Write-Host '[5/9] Browser engine (large — please wait)…'
Copy-Item $pwCache (Join-Path $app 'browsers') -Recurse -Force

Write-Host '[6/9] Launcher + updater…'
'freeaudit.ps1','update.ps1','freeaudit-launcher.vbs','stop-freeaudit.ps1' |
  ForEach-Object { Copy-Item (Join-Path $proj "installer\$_") $app -Force }

Write-Host '[7/9] Config, version, update channel, credential templates…'
# IMPORTANT: write JSON as UTF-8 WITHOUT a BOM — Node's JSON.parse() crashes on a
# BOM, so Set-Content -Encoding utf8 (which adds one on PS 5.1) must NOT be used.
$noBom = New-Object System.Text.UTF8Encoding $false
function Write-Json($path, $text) { [System.IO.File]::WriteAllText($path, $text, $noBom) }
# Bundled config: local port, visible browser (so manual sign-in works), no secrets.
$cfg = Get-Content (Join-Path $proj 'config.json') -Raw | ConvertFrom-Json
$cfg.webPort = 4477
$cfg.headless = $false
Write-Json (Join-Path $app 'config.json') ($cfg | ConvertTo-Json -Depth 10)
Write-Json (Join-Path $app 'version.json') ('{ "version": "' + $ver + '" }')
# Update channel — set "repo" to OWNER/REPO once the GitHub repo exists (see TEAM-INSTALL.md).
Write-Json (Join-Path $app 'update.json') ('{ "repo": "MTucker-1/freeaudit-app", "branch": "main", "version": "' + $ver + '" }')
# Per-user logins start blank — each teammate enters their own in Settings.
Write-Json (Join-Path $app 'fullbay-credentials.json') '{ "username": "", "password": "" }'
Write-Json (Join-Path $app 'vorto-credentials.json') '{ "username": "", "password": "" }'
Write-Json (Join-Path $app 'google-credentials.json') '{ "apiKey": "" }'
# Shared, READ-ONLY Google service account so the completion-sheet check works for everyone.
if (Test-Path (Join-Path $proj 'google-service-account.json')) {
  Copy-Item (Join-Path $proj 'google-service-account.json') $app -Force
}
# Facility address -> tax location mapping. Shop reference data, not a secret, but
# gitignored because the update repo is public — so it ships in the installer or
# the "Fix Addresses" action has nothing to resolve against.
if (Test-Path (Join-Path $proj 'tax-locations.json')) {
  Copy-Item (Join-Path $proj 'tax-locations.json') $app -Force
}

Write-Host '[8/9] Stage installer script…'
Copy-Item (Join-Path $proj 'installer\FreeAudit.iss') $build -Force

Write-Host '[9/9] Compile installer…'
& $iscc "/DAppVer=$ver" (Join-Path $build 'FreeAudit.iss')
$out = Join-Path $build 'FreeAudit-Setup.exe'
if (Test-Path $out) {
  $mb = [int]((Get-Item $out).Length / 1MB)
  Write-Host "DONE -> $out ($mb MB)"
} else {
  Write-Host 'BUILD FAILED — no FreeAudit-Setup.exe produced.'
}
