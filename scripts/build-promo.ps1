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
    store/listing/assets/icon128-store.png           (required; transparent,
                                                      96x96 art + glow)
#>
[CmdletBinding()]
param(
  [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $repoRoot 'store\listing\assets'
if (-not $ChromePath) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath) { throw 'Chrome not found - pass -ChromePath explicitly.' }

# Source is the page to render; Transparent keeps the alpha channel (the
# store icon needs it, the tiles are full bleed).
$tiles = @(
  @{ Source = 'promo.html'; Query = '?size=small';   W = 440;  H = 280; Name = 'promo-small-440x280.png' },
  @{ Source = 'promo.html'; Query = '?size=marquee'; W = 1400; H = 560; Name = 'promo-marquee-1400x560.png' },
  @{ Source = 'icon.html';  Query = '';              W = 128;  H = 128; Name = 'icon128-store.png'; Transparent = $true },
  @{ Source = 'screenshot.html'; Query = '';         W = 1280; H = 800; Name = 'screenshot-1-panel-1280x800.png' }
)

Write-Host ''
Write-Host '=== UnityChat promo tiles ===' -ForegroundColor Cyan

foreach ($tile in $tiles) {
  $out = Join-Path $assetsDir $tile.Name
  if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }

  $page = Join-Path $assetsDir $tile.Source
  if (-not (Test-Path $page)) { throw "Source page not found: $page" }
  $url = 'file:///' + ($page -replace '\\', '/') + $tile.Query

  $bgArg = if ($tile.Transparent) { '--default-background-color=00000000' } else { '--default-background-color=000000ff' }

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
    $bgArg `
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
