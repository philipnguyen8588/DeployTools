# Post-process app_icon.png:
#  1. Replace near-white pixels with transparent.
#  2. Auto-crop to the non-transparent bounding box.
#  3. Resize to a 1024x1024 canvas, keeping aspect + adding a small
#     uniform padding so the rounded-square motif fills more of the
#     frame than the source (which had ~10 % white border).
#
# Uses .NET System.Drawing with LockBits for fast pixel access.

param(
  [string]$Source = "D:\Projects\Personal\PycharmProjects\DeployTools\src-tauri\icons\app_icon.png",
  [string]$OutFile = "D:\Projects\Personal\PycharmProjects\DeployTools\src-tauri\icons\app_icon.png",
  [int]$OutputSize = 1024,
  [int]$PaddingPx = 40,
  # Pixels with R,G,B all >= this are treated as background (white).
  [int]$WhiteThreshold = 240
)

Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::new($Source)
$w = $bmp.Width
$h = $bmp.Height
Write-Host "Loaded $Source $($w)x$($h)"

# --- Access pixels via LockBits (ARGB 32bpp) ---
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$size = $stride * $h
$bytes = New-Object byte[] $size
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $size)

# Pass 1: alpha-zero every near-white pixel + track bbox of kept pixels.
$minX = $w; $minY = $h; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    $i = $row + ($x * 4)
    $b = $bytes[$i]
    $g = $bytes[$i + 1]
    $r = $bytes[$i + 2]
    if ($r -ge $WhiteThreshold -and $g -ge $WhiteThreshold -and $b -ge $WhiteThreshold) {
      $bytes[$i]     = 0
      $bytes[$i + 1] = 0
      $bytes[$i + 2] = 0
      $bytes[$i + 3] = 0
    }
    else {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $size)
$bmp.UnlockBits($data)

if ($minX -ge $maxX -or $minY -ge $maxY) {
  throw "Bounding box empty - source might already be transparent"
}
$bboxW = $maxX - $minX + 1
$bboxH = $maxY - $minY + 1
Write-Host ("BBox: ({0},{1}) - ({2},{3}) = {4}x{5}" -f $minX, $minY, $maxX, $maxY, $bboxW, $bboxH)

# --- Crop to bbox, then render onto a fresh square canvas with padding ---
$cropRect = New-Object System.Drawing.Rectangle $minX, $minY, $bboxW, $bboxH
$cropped = $bmp.Clone($cropRect, $bmp.PixelFormat)

$canvas = New-Object System.Drawing.Bitmap $OutputSize, $OutputSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($canvas)
$gfx.Clear([System.Drawing.Color]::Transparent)
$gfx.InterpolationMode   = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gfx.SmoothingMode       = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gfx.PixelOffsetMode     = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Fit to (OutputSize - 2*PaddingPx) square, preserving aspect.
$target = $OutputSize - (2 * $PaddingPx)
$scale  = [Math]::Min($target / $bboxW, $target / $bboxH)
$drawW  = [int]($bboxW * $scale)
$drawH  = [int]($bboxH * $scale)
$dx     = [int](($OutputSize - $drawW) / 2)
$dy     = [int](($OutputSize - $drawH) / 2)

$gfx.DrawImage($cropped, $dx, $dy, $drawW, $drawH)
$gfx.Dispose()

$cropped.Dispose()
# Release the source handle BEFORE saving — System.Drawing holds a
# file lock on the input file until the Bitmap is disposed, so saving
# back to the same path while the lock is live silently fails.
$bmp.Dispose()

try {
  $canvas.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $sz = "$($OutputSize)x$($OutputSize)"
  Write-Host "Wrote $OutFile [$sz transparent bg]"
} catch {
  Write-Error "Save failed: $_"
  throw
} finally {
  $canvas.Dispose()
}
