<#
.SYNOPSIS
  Renders the Chrome Web Store promo tiles from store/listing/assets/promo.html.

.DESCRIPTION
  Both tiles come from one HTML source; the ?size= parameter switches the
  scale. Rendering goes through headless Chrome so the output is
  deterministic - same pixels on every machine that has Chrome.

  Output:
    store/listing/assets/promo-small-440x280.png     (required by CWS)
    store/listing/assets/promo-marquee-1400x560.png  (optional, needed for
                                                      marquee featuring)
#>
[CmdletBinding()]
param(
  [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $repoRoot 'store\listing\assets'
$source    = Join-Path $assetsDir 'promo.html'

if (-not (Test-Path $source)) { throw "Promo source not found: $source" }

if (-not $ChromePath) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath) { throw 'Chrome not found - pass -ChromePath explicitly.' }

$tiles = @(
  @{ Size = 'small';   W = 440;  H = 280; Name = 'promo-small-440x280.png' },
  @{ Size = 'marquee'; W = 1400; H = 560; Name = 'promo-marquee-1400x560.png' }
)

Write-Host ''
Write-Host '=== UnityChat promo tiles ===' -ForegroundColor Cyan

foreach ($tile in $tiles) {
  $out = Join-Path $assetsDir $tile.Name
  if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }

  $url = 'file:///' + ($source -replace '\\', '/') + '?size=' + $tile.Size

  # virtual-time-budget gives the Google Fonts request time to land before
  # the screenshot is taken; without it the wordmark renders in a fallback.
  # Chrome writes its progress to stderr even on success - do NOT redirect it
  # on PS 5.1, that turns a clean run into a NativeCommandError.
  & $ChromePath `
    --headless `
    --disable-gpu `
    --hide-scrollbars `
    --force-device-scale-factor=1 `
    --virtual-time-budget=6000 `
    "--window-size=$($tile.W),$($tile.H)" `
    "--screenshot=$out" `
    $url | Out-Null

  if (-not (Test-Path $out)) { throw "Chrome produced no output for $($tile.Name)" }

  # Verify the pixel dimensions - a wrong-sized asset is rejected on upload.
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($out)
  $w = $img.Width; $h = $img.Height
  $img.Dispose()

  if ($w -ne $tile.W -or $h -ne $tile.H) {
    throw "$($tile.Name) rendered at ${w}x${h}, expected $($tile.W)x$($tile.H)"
  }

  $kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
  Write-Host "  ok  $($tile.Name)  ${w}x${h}  ($kb KB)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Promo tiles ready in store/listing/assets/' -ForegroundColor Green
Write-Host ''
