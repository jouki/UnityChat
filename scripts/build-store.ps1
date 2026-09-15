<#
.SYNOPSIS
  Builds the Chrome Web Store package from extension/.

.DESCRIPTION
  extension/ is the single dev source (Chrome + Opera, no build step). The
  Chrome Web Store forbids out-of-store update mechanisms, so the store
  package is a stripped derivative:

    - files removed       : update.bat, backup.*, streamer.*
    - marker blocks cut   : everything between UC_STORE_STRIP_START/END
    - manifest patched    : sidebar_action (Opera key), streamer.html WAR
                            entry and the alarms permission dropped

  The build fails loudly if anything forbidden survives, so a broken strip
  can never reach an upload.

.PARAMETER OutDir
  Build output root. Default: store/build (gitignored).

.PARAMETER SkipZip
  Produce only the unpacked folder (useful while iterating in Chrome via
  "Load unpacked").

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
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'store\build' }
$unpacked = Join-Path $OutDir 'unpacked'

if (-not (Test-Path $srcDir)) { throw "Source folder not found: $srcDir" }

# Files that exist for the self-hosted distribution only and must never be
# part of a store upload.
$excludedFiles = @(
  'update.bat',      # out-of-store updater (CWS policy violation)
  'backup.html',     # not reachable from the store UI
  'backup.js',
  'streamer.html',   # streamer OAuth login, cut from the store build
  'streamer.js',
  'streamer.css'
)

# Strings that must not survive in the built package. Include narrows the
# check to a file set - sidebar_action is only a problem as a manifest key,
# the background.js comments explaining the Opera path are fine to keep.
$forbiddenPatterns = @(
  @{ Pattern = 'jouki\.cz/download';  Why = 'self-update endpoint';  Include = @('*.js', '*.html', '*.css', '*.json') },
  @{ Pattern = 'update\.bat';         Why = 'out-of-store updater';  Include = @('*.js', '*.html', '*.css', '*.json') },
  @{ Pattern = 'streamer\.(html|js|css)'; Why = 'streamer OAuth flow'; Include = @('*.js', '*.html', '*.css', '*.json') },
  @{ Pattern = 'sidebar_action';      Why = 'Opera-only manifest key'; Include = @('*.json') },
  @{ Pattern = 'chrome\.alarms\.';    Why = 'alarms permission dropped from manifest'; Include = @('*.js') },
  @{ Pattern = 'UC_STORE_STRIP';      Why = 'leftover strip marker'; Include = @('*.js', '*.html', '*.css', '*.json') }
)

# ------------------------------------------------------------- helpers ----
function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  # Set-Content -Encoding utf8 writes a BOM on PS 5.1; a BOM in manifest.json
  # breaks Chrome's parser, so write the bytes ourselves.
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Remove-StripBlocks {
  <#
    Drops every line between UC_STORE_STRIP_START and UC_STORE_STRIP_END
    (markers included). Nesting is supported; unbalanced markers throw so a
    bad edit fails the build instead of shipping half a function.
  #>
  param([string]$Path)

  $lines   = [System.IO.File]::ReadAllLines($Path)
  $kept    = New-Object System.Collections.Generic.List[string]
  $depth   = 0
  $dropped = 0

  foreach ($line in $lines) {
    if ($line -match 'UC_STORE_STRIP_START') { $depth++;   $dropped++; continue }
    if ($line -match 'UC_STORE_STRIP_END') {
      if ($depth -eq 0) { throw "UC_STORE_STRIP_END without START in $Path" }
      $depth--; $dropped++; continue
    }
    if ($depth -gt 0) { $dropped++ } else { $kept.Add($line) }
  }
  if ($depth -ne 0) { throw "Unclosed UC_STORE_STRIP_START in $Path" }

  if ($dropped -gt 0) {
    Write-Utf8NoBom -Path $Path -Text (($kept -join "`n") + "`n")
  }
  return $dropped
}

function ConvertTo-ReadableJson {
  # PS 5.1 escapes every non-ASCII char as \uXXXX. Valid JSON, but the
  # manifest is human-reviewed during CWS submission, so fold them back.
  param([string]$Json)
  return [regex]::Replace($Json, '\\u([0-9a-fA-F]{4})', {
    param($m) [string][char][int]('0x' + $m.Groups[1].Value)
  })
}

# --------------------------------------------------------------- build ----
Write-Host ''
Write-Host '=== UnityChat -> Chrome Web Store build ===' -ForegroundColor Cyan

if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null

Copy-Item -Path (Join-Path $srcDir '*') -Destination $unpacked -Recurse -Force
Write-Host "  copied  extension/ -> $unpacked"

# 1. Drop dev-only files -----------------------------------------------------
foreach ($name in $excludedFiles) {
  $p = Join-Path $unpacked $name
  if (Test-Path $p) {
    Remove-Item -LiteralPath $p -Force
    Write-Host "  removed $name"
  }
}

# 2. Strip marker blocks -----------------------------------------------------
$totalDropped = 0
Get-ChildItem -Path $unpacked -Recurse -Include *.js, *.html, *.css -File | ForEach-Object {
  $n = Remove-StripBlocks -Path $_.FullName
  if ($n -gt 0) {
    $rel = $_.FullName.Substring($unpacked.Length + 1)
    Write-Host "  stripped $rel ($n lines)"
    $totalDropped += $n
  }
}
if ($totalDropped -eq 0) { throw 'No UC_STORE_STRIP blocks found - markers missing from extension/ sources?' }

# 3. Patch the manifest ------------------------------------------------------
$manifestPath = Join-Path $unpacked 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$srcVersion = $manifest.version

# Opera sidebar key: dead weight in a Chrome package, flagged by the validator.
$manifest.PSObject.Properties.Remove('sidebar_action')

# alarms is used by the self-update poll only, which the strip just removed.
$manifest.permissions = @($manifest.permissions | Where-Object { $_ -ne 'alarms' })

# streamer.html is gone, so its web_accessible_resources entry must go too.
$manifest.web_accessible_resources = @(
  $manifest.web_accessible_resources | Where-Object {
    -not ($_.resources -contains 'streamer.html')
  }
)

Write-Utf8NoBom -Path $manifestPath -Text (ConvertTo-ReadableJson (($manifest | ConvertTo-Json -Depth 20)))
Write-Host "  patched manifest.json (v$srcVersion)"

# 4. Verify ------------------------------------------------------------------
Write-Host ''
Write-Host '--- verification ---' -ForegroundColor Cyan
$failures = @()

foreach ($rule in $forbiddenPatterns) {
  $hits = Get-ChildItem -Path $unpacked -Recurse -Include $rule.Include -File |
          Select-String -Pattern $rule.Pattern -List
  if ($hits) {
    foreach ($h in $hits) {
      $rel = $h.Path.Substring($unpacked.Length + 1)
      $failures += "forbidden '$($rule.Pattern)' ($($rule.Why)) still present in $rel"
    }
  } else {
    Write-Host "  ok  no '$($rule.Pattern)'"
  }
}

foreach ($name in $excludedFiles) {
  if (Test-Path (Join-Path $unpacked $name)) { $failures += "excluded file survived: $name" }
}

# Manifest must still parse and keep the source version.
try {
  $check = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($check.version -ne $srcVersion) { $failures += "version drift: $($check.version) != $srcVersion" }
  if ($check.PSObject.Properties.Name -contains 'sidebar_action') { $failures += 'sidebar_action still in manifest' }
  Write-Host "  ok  manifest parses (v$($check.version))"
} catch {
  $failures += "manifest.json is not valid JSON: $($_.Exception.Message)"
}

# Syntax-check every script - proves the strip did not break a brace.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Get-ChildItem -Path $unpacked -Recurse -Include *.js -File | ForEach-Object {
    & node --check $_.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $rel = $_.FullName.Substring($unpacked.Length + 1)
      $failures += "syntax error after strip: $rel"
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

# 5. Zip ---------------------------------------------------------------------
if (-not $SkipZip) {
  $zipPath = Join-Path $OutDir "unitychat-store-v$srcVersion.zip"
  Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zipPath -Force
  $sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  Write-Host ''
  Write-Host "  zipped  $zipPath ($sizeKb KB)" -ForegroundColor Green
}

Write-Host ''
Write-Host "Store build ready: v$srcVersion" -ForegroundColor Green
Write-Host "  unpacked (Load unpacked for testing): $unpacked"
Write-Host '  listing copy + permission justifications: store/listing/'
Write-Host ''
