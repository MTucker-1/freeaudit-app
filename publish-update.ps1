# publish-update.ps1 — publish a new version of the FreeAudit CODE so every
# installed copy auto-updates on its next launch.
#
# Run this after making code changes:   .\publish-update.ps1 "what changed"
# It bumps the version, then commits & pushes ONLY code (secrets are excluded by
# .gitignore). Installed copies pull the new code automatically — no re-install.
param([string]$Message = 'Update')
$ErrorActionPreference = 'Stop'
$proj = $PSScriptRoot
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = 'C:\Program Files\Git\cmd\git.exe' }
if (-not (Test-Path $git)) { Write-Host 'Git is not installed. Install Git, then re-run.'; exit 1 }

# Safety: make sure no secrets are about to be committed.
$danger = @('fullbay-credentials.json','vorto-credentials.json','google-service-account.json','google-credentials.json','config.json','users.json')
$tracked = & $git ls-files
foreach ($d in $danger) { if ($tracked -contains $d) { Write-Host "ABORT: $d is tracked by git — it must stay out of the repo. Check .gitignore."; exit 1 } }

# Bump the patch version.
$vpath = Join-Path $proj 'version.json'
$cur = (Get-Content $vpath -Raw | ConvertFrom-Json).version
$p = $cur.Split('.'); $p[-1] = [int]$p[-1] + 1; $new = ($p -join '.')
"{ ""version"": ""$new"" }" | Set-Content $vpath -Encoding utf8
Write-Host "Version $cur -> $new"

& $git add -A
& $git commit -m "$Message (v$new)"
& $git push
if ($LASTEXITCODE -eq 0) { Write-Host "Published v$new. Installed copies update on next launch." }
else { Write-Host 'Push failed — check the GitHub remote / sign-in (see TEAM-INSTALL.md).' }
