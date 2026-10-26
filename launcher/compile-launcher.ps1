# compile-launcher.ps1 - compiles launcher\FreeAudit.cs to launcher\FreeAudit.exe.
#
# launcher\FreeAudit.exe is committed on purpose: installed copies self-update it
# from the repo, so a launcher fix reaches everyone without a new download.
# publish-update.ps1 runs this before every publish.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$proj = Split-Path -Parent $here
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$exe = Join-Path $here 'FreeAudit.exe'
$tmp = Join-Path $here 'FreeAudit.build.exe'
& $csc -nologo -target:winexe -optimize "-win32icon:$(Join-Path $proj 'logo.ico')" `
  -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll -r:System.Windows.Forms.dll -r:System.Drawing.dll `
  "-out:$tmp" (Join-Path $here 'FreeAudit.cs') | Where-Object { $_ -and $_ -notmatch 'C# 5|supports up to|go.microsoft' }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { throw 'Launcher failed to compile.' }
Move-Item $tmp $exe -Force
Write-Host "Launcher -> $exe"
