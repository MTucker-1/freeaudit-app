# make-icon.ps1 — build logo.ico from public/icon-512.png.
#
# The old logo.ico held a SINGLE 256x256 image. Windows draws desktop icons at
# 48x48 (96x96 for large icons) and scales that one bitmap down on the fly,
# which is what made it look choppy. A real .ico carries a purpose-built,
# properly resampled copy at each size so Windows never has to guess.
#
# Each entry is PNG-encoded, which Windows Vista and later read natively.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot 'public\icon-512.png'
$out = Join-Path $PSScriptRoot 'logo.ico'
$sizes = 256, 128, 96, 64, 48, 32, 16

$source = [System.Drawing.Image]::FromFile($src)
Write-Host ("source: {0}x{1} {2}" -f $source.Width, $source.Height, $source.PixelFormat)

$images = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # High-quality resampling, and a transparent ground so the logo keeps its
  # alpha instead of picking up a black or white box behind it.
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
  $images += , @{ size = $s; bytes = $bytes }
  Write-Host ("  {0}x{0} -> {1} bytes" -f $s, $bytes.Length)
}
$source.Dispose()

# --- assemble the .ico -------------------------------------------------------
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)

$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type: 1 = icon
$bw.Write([UInt16]$images.Count)     # image count

# Data starts after the header (6 bytes) plus one 16-byte directory entry each.
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.size -ge 256) { 0 } else { $img.size }   # 0 means 256 in the spec
  $bw.Write([Byte]$dim)              # width
  $bw.Write([Byte]$dim)              # height
  $bw.Write([Byte]0)                 # palette size (0 = truecolour)
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # colour planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$img.bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $img.bytes.Length
}
foreach ($img in $images) { $bw.Write($img.bytes) }

$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host ("wrote {0} ({1} images, {2} bytes)" -f $out, $images.Count, (Get-Item $out).Length)
