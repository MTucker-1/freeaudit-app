# build-portable.ps1 - builds the PORTABLE FreeAudit: one FreeAudit.exe, no installer.
#
# Download it, double-click it. The exe carries the whole app (portable Node, the
# browser engine, node_modules, the code) as a zip appended to the launcher; on
# first run it unpacks to %LOCALAPPDATA%\Programs\FreeAudit, makes the shortcuts,
# and starts FreeAudit. See launcher\FreeAudit.cs.
#
# Run from the project root:   .\build-portable.ps1
# Output: installer-build\portable\FreeAudit.exe
$ErrorActionPreference = 'Stop'
$proj = $PSScriptRoot
$build = Join-Path $proj 'installer-build'
$app = Join-Path $build 'app'
$out = Join-Path $build 'portable'

# 0) node_modules must be complete before it is bundled.
& npm ls --omit=dev *> $null
if ($LASTEXITCODE -ne 0) { throw 'node_modules is incomplete - run "npm install" first.' }

# 1) Stage the same app folder the installer ships.
& (Join-Path $proj 'build-installer.ps1') -StageOnly

# 2) Compile the launcher. csc ships with .NET Framework 4 on every Windows PC.
# Only when the source changed: csc output differs byte-for-byte every time, so
# recompiling on every build would leave a spurious change to the committed exe.
$lexe = Join-Path $proj 'launcher\FreeAudit.exe'
$lsrc = Join-Path $proj 'launcher\FreeAudit.cs'
if (-not (Test-Path $lexe) -or (Get-Item $lsrc).LastWriteTime -gt (Get-Item $lexe).LastWriteTime) {
  Write-Host '[portable] Compiling launcher...'
  & (Join-Path $proj 'launcher\compile-launcher.ps1')
}
Copy-Item (Join-Path $proj 'launcher\FreeAudit.exe') (Join-Path $app 'FreeAudit.exe') -Force

# 2b) Prove the bundle is self-contained: every npm package loads, the browser
# engine starts, and OCR loads its language data with downloads blocked. Using
# the BUNDLED node, from the staged folder, so it tests exactly what ships.
Write-Host '[portable] Checking every dependency is bundled...'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $app 'browsers'
$check = & (Join-Path $app 'node.exe') (Join-Path $app 'selfcheck.js') --deep
Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH
if ($LASTEXITCODE -ne 0) { throw ("The bundle is missing dependencies:`n" + ($check -join "`n")) }
Write-Host "        $check"

# 3) Zip the app folder.
Write-Host '[portable] Packing the app (large - please wait)...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $build 'payload.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# 4) launcher + zip + [8-byte zip length]["FAPAYLD1"] = one runnable file.
Write-Host '[portable] Joining launcher and app...'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$exe = Join-Path $out 'FreeAudit.exe'
$dst = [System.IO.File]::Create($exe)
try {
  foreach ($part in @((Join-Path $proj 'launcher\FreeAudit.exe'), $zip)) {
    $src = [System.IO.File]::OpenRead($part)
    try { $src.CopyTo($dst) } finally { $src.Close() }
  }
  $len = (Get-Item $zip).Length
  $tail = [BitConverter]::GetBytes([long]$len) + [System.Text.Encoding]::ASCII.GetBytes('FAPAYLD1')
  $dst.Write($tail, 0, $tail.Length)
} finally { $dst.Close() }
Remove-Item $zip -Force

$mb = [int]((Get-Item $exe).Length / 1MB)
Write-Host "DONE -> $exe ($mb MB)"
