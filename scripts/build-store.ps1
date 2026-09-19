<#
.SYNOPSIS
  Packages extension/ for the Chrome Web Store.

.DESCRIPTION
  Since v3.38.67 extension/ IS the store version - there is no dev-only code
  to strip any more (self-update, update.bat, streamer OAuth, backup pages and
  the Opera sidebar_action key were removed from the source). The script only
  copies the folder, verifies it (manifest parses, every script passes
  `node --check`, no out-of-store update artefact sneaked back in) and zips it.

.PARAMETER OutDir
  Build output root. Default: store/build (gitignored).

.PARAMETER SkipZip
  Produce only the unpacked folder.

.EXAMPLE
  pwsh scripts/build-store.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-store.ps1 -SkipZip
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- paths ----
$repoRoot = Split-Path -Parent $PSScriptRoot
$srcDir   = Join-Path $repoRoot 'extension'
# Dva segmenty schvalne: 'store\build' by v pwsh na Linuxu (CI runner) vzniklo
# jako jediny adresar s backslashem v nazvu misto vnoreneho.
if (-not $OutDir) { $OutDir = Join-Path (Join-Path $repoRoot 'store') 'build' }
$unpacked = Join-Path $OutDir 'unpacked'

if (-not (Test-Path $srcDir)) { throw "Source folder not found: $srcDir" }

# Anything matching these would be a CWS policy problem (out-of-store update
# path) or a leftover from the pre-3.38.67 dual-source setup.
$forbiddenPatterns = @(
  @{ Pattern = 'jouki\.cz/download';  Why = 'self-update endpoint' },
  @{ Pattern = 'update\.bat';         Why = 'out-of-store updater' },
  @{ Pattern = 'UC_STORE_STRIP';      Why = 'strip markers are gone since v3.38.67' },
  @{ Pattern = 'sidebar_action';      Why = 'Opera-only manifest key'; Include = @('*.json') }
)
$forbiddenFiles = @('update.bat', 'backup.html', 'backup.js', 'streamer.html', 'streamer.js', 'streamer.css')

# --------------------------------------------------------------- build ----
Write-Host ''
Write-Host '=== UnityChat -> Chrome Web Store package ===' -ForegroundColor Cyan

if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null

Copy-Item -Path (Join-Path $srcDir '*') -Destination $unpacked -Recurse -Force
Write-Host "  copied  extension/ -> $unpacked"

# ---------------------------------------------------------------- verify ---
Write-Host ''
Write-Host '--- verification ---' -ForegroundColor Cyan
$failures = @()

$manifestPath = Join-Path $unpacked 'manifest.json'
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $srcVersion = $manifest.version
  if (-not $srcVersion) { $failures += 'manifest.json has no version' }
  Write-Host "  ok  manifest parses (v$srcVersion)"
} catch {
  $failures += "manifest.json is not valid JSON: $($_.Exception.Message)"
}

foreach ($rule in $forbiddenPatterns) {
  $include = if ($rule.Include) { $rule.Include } else { @('*.js', '*.html', '*.css', '*.json') }
  $hits = Get-ChildItem -Path $unpacked -Recurse -Include $include -File |
          Select-String -Pattern $rule.Pattern -List
  if ($hits) {
    foreach ($h in $hits) {
      $rel = $h.Path.Substring($unpacked.Length + 1)
      $failures += "forbidden '$($rule.Pattern)' ($($rule.Why)) present in $rel"
    }
  } else {
    Write-Host "  ok  no '$($rule.Pattern)'"
  }
}

foreach ($name in $forbiddenFiles) {
  if (Test-Path (Join-Path $unpacked $name)) { $failures += "dev-only file is back: $name" }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Get-ChildItem -Path $unpacked -Recurse -Include *.js -File | ForEach-Object {
    & node --check $_.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $rel = $_.FullName.Substring($unpacked.Length + 1)
      $failures += "syntax error: $rel"
    }
  }
  Write-Host '  ok  all scripts pass node --check'
} else {
  Write-Host '  !!  node not found - skipping syntax check' -ForegroundColor Yellow
}

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host 'BUILD FAILED:' -ForegroundColor Red
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
  exit 1
}

# ------------------------------------------------------------------ zip ----
if (-not $SkipZip) {
  $zipPath = Join-Path $OutDir "unitychat-store-v$srcVersion.zip"
  Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zipPath -Force
  $sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  Write-Host ''
  Write-Host "  zipped  $zipPath ($sizeKb KB)" -ForegroundColor Green
}

Write-Host ''
Write-Host "Store package ready: v$srcVersion" -ForegroundColor Green
Write-Host "  unpacked: $unpacked"
Write-Host '  listing copy + permission justifications: store/listing/'
Write-Host ''
