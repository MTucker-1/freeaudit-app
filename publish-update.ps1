# publish-update.ps1 - publish a new version of the FreeAudit CODE so every
# installed copy auto-updates on its next launch.
#
# Run after code changes:   .\publish-update.ps1 "what changed"
# Bumps the version, then commits and pushes ONLY code (secrets excluded by
# .gitignore). Installed copies pull the new code automatically - no re-install.
param([string]$Message = 'Update')
$ErrorActionPreference = 'Stop'
$proj = $PSScriptRoot
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = 'C:\Program Files\Git\cmd\git.exe' }
if (-not (Test-Path $git)) { Write-Host 'Git is not installed. Install Git, then re-run.'; exit 1 }

# Safety: refuse to publish if any secret is tracked by git.
$danger = @('fullbay-credentials.json','vorto-credentials.json','google-service-account.json','google-credentials.json','connecteam-credentials.json','config.json','users.json')
$tracked = & $git ls-files
foreach ($d in $danger) {
  if ($tracked -contains $d) { Write-Host ("ABORT: " + $d + " is tracked by git - it must stay out of the repo. Check .gitignore."); exit 1 }
}

# Bump the patch version (written WITHOUT a BOM so Node can parse it).
$vpath = Join-Path $proj 'version.json'
$cur = (Get-Content $vpath -Raw | ConvertFrom-Json).version
$p = $cur.Split('.'); $p[-1] = [int]$p[-1] + 1; $new = ($p -join '.')
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($vpath, ('{ "version": "' + $new + '" }'), $enc)
Write-Host ("Version " + $cur + " -> " + $new)

& $git add -A
& $git commit -m ($Message + " (v" + $new + ")")
& $git push
if ($LASTEXITCODE -eq 0) { Write-Host ("Published v" + $new + ". Installed copies update on next launch.") }
else { Write-Host 'Push failed. Check the GitHub remote / sign-in (see TEAM-INSTALL.md).' }
