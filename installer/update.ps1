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
  # A code update must never leave an install unable to start. This script syncs
  # code but deliberately NOT node_modules, so code that requires a package this
  # install does not have would crash on every launch with "Cannot find module"
  # — and the only repair would be a hand-delivered installer, on a PC whose app
  # no longer opens. So check before applying.
  #
  # But only a REQUIRED package can do that, and the distinction is what
  # package.json already encodes:
  #
  #   dependencies          the app cannot start without it -> block the update
  #   optionalDependencies  the code already handles its absence -> ship anyway
  #
  # Treating both as fatal is what stranded every install on 1.1.40: tesseract.js
  # (OCR for Check I) is required inside a try/catch that turns the check off and
  # logs it, so its absence was never going to crash anything — yet it blocked
  # three releases of unrelated work, and the only offered cure was redistributing
  # an installer. An optional feature staying off is not a reason to withhold
  # everything else.
  #
  # So: block on a missing REQUIRED package, and let a missing OPTIONAL one
  # through. The feature it powers reports itself off where it runs.
  $blockPath = Join-Path $Dir 'update-blocked.json'
  $needPkg = Join-Path $root.FullName 'package.json'
  if (Test-Path $needPkg) {
    $missing = @()
    $pkg = Get-Content $needPkg -Raw | ConvertFrom-Json
    $deps = $pkg.dependencies
    if ($deps) {
      foreach ($name in $deps.PSObject.Properties.Name) {
        if (-not (Test-Path (Join-Path $Dir ('node_modules' + $name)))) { $missing += $name }
      }
    }
    if ($missing.Count -gt 0) {
      $noBom = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::WriteAllText($blockPath,
        ('{ "version": "' + $remoteVer + '", "missing": ["' + ($missing -join '","') + '"] }'), $noBom)
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      return
    }
  }
  # Deliverable after all — clear any note left by an earlier blocked attempt.
  if (Test-Path $blockPath) { Remove-Item $blockPath -Force -ErrorAction SilentlyContinue }
  # Replace the code (leave runtime + user data alone). Every root-level .js is
  # synced rather than a hand-kept list, so a newly added module ships on its own
  # — a missed name here would break `require` in every installed copy.
  # package.json is deliberately NOT synced: node_modules isn't updated, so a new
  # dependency needs a fresh installer, not a code update.
  Get-ChildItem (Join-Path $root.FullName '*.js') -File |
    ForEach-Object { Copy-Item $_.FullName -Destination $Dir -Force }
  # The launcher and the updater itself must update too. Without this, a fix to
  # update.ps1 can never reach an installed copy — it would keep running the old
  # updater forever, and only a fresh installer could repair it.
  Get-ChildItem (Join-Path $root.FullName 'installer\*') -Include *.ps1, *.vbs -File -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName -Destination $Dir -Force }
  foreach ($it in @('public', 'version.json')) {
    $src = Join-Path $root.FullName $it
    if (Test-Path $src) { Copy-Item $src -Destination $Dir -Recurse -Force }
  }
  $cfg.version = $remoteVer
  ($cfg | ConvertTo-Json) | Set-Content $cfgPath -Encoding utf8
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output 'updated'
} catch { return }  # any failure => silently keep the current version
