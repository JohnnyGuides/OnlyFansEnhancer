param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist")
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repositoryRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$distRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$zipPath = Join-Path $distRoot "creator-workflow-toolkit-personal-v$($manifest.version).zip"

$relativeFiles = @(
  "manifest.json",
  "background.js",
  "gelbooru-rules.json",
  "realbooru-parser.html",
  "realbooru-parser.js",
  "core.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css",
  "upload-console.html",
  "upload-console.js",
  "upload-console.css",
  "x-teaser.html",
  "x-teaser.js",
  "x-teaser.css",
  "file-bridge.html",
  "file-bridge.js",
  "apps-script\catalogue-bridge.gs",
  "options.html",
  "options.js",
  "options.css"
)

$relativeFiles += Get-ChildItem -LiteralPath (Join-Path $repositoryRoot "creator-tools") -Recurse -File |
  ForEach-Object {
    $_.FullName.Substring($repositoryRoot.Length + 1)
  }
$relativeFiles += Get-ChildItem -LiteralPath (Join-Path $repositoryRoot "app") -Recurse -File |
  ForEach-Object {
    $_.FullName.Substring($repositoryRoot.Length + 1)
  }

foreach ($relativePath in $relativeFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $relativePath))) {
    throw "Required personal-edition file is missing: $relativePath"
  }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open(
  $zipPath,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  foreach ($relativePath in $relativeFiles) {
    $sourcePath = Join-Path $repositoryRoot $relativePath
    $archivePath = $relativePath.Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $sourcePath,
      $archivePath,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$requiredArchiveEntries = @(
  "manifest.json",
  "background.js",
  "realbooru-parser.html",
  "realbooru-parser.js",
  "upload-console.html",
  "upload-console.js",
  "upload-console.css",
  "x-teaser.html",
  "x-teaser.js",
  "x-teaser.css",
  "file-bridge.html",
  "file-bridge.js",
  "apps-script/catalogue-bridge.gs",
  "creator-tools/registry.js",
  "creator-tools/common.js",
  "creator-tools/onlyfans-list-common.js",
  "creator-tools/upload-trace-recorder.js",
  "creator-tools/upload-capability-probe.js",
  "creator-tools/catalogue-client.js",
  "creator-tools/catalogue-contract.js",
  "creator-tools/subreddit-presets.js",
  "creator-tools/upload-file-bridge.js",
  "creator-tools/local-file-attacher.js",
  "creator-tools/upload-platform-adapters.js",
  "creator-tools/upload-response-observer.js",
  "creator-tools/upload-session-store.js",
  "creator-tools/social-distribution-contract.js",
  "creator-tools/social-distribution-session-store.js",
  "creator-tools/social-distribution-orchestrator.js",
  "creator-tools/social-chrome-runtime.js",
  "creator-tools/social-trace-evidence.js",
  "creator-tools/social-trace-contract.js",
  "creator-tools/x-publisher-adapter.js",
  "creator-tools/x-teaser-contract.js",
  "creator-tools/x-teaser-session-store.js",
  "creator-tools/x-teaser-reconcile.js",
  "creator-tools/x-teaser-tab-binding.js",
  "creator-tools/x-teaser-observer.js",
  "creator-tools/c4s-upload.js",
  "creator-tools/ph-uploader.js",
  "creator-tools/fansly-prefill.js",
  "creator-tools/manyvids-autofill.js",
  "creator-tools/sheer-tags.js",
  "creator-tools/onlyfans-auto-select.js",
  "creator-tools/onlyfans-auto-follow.js",
  "creator-tools/reddit-banner-censor.js",
  "app/index.html",
  "app/app.css",
  "app/app.js",
  "app/host-bridge.js",
  "app/finalLogo.png"
)

$validationArchive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entryNames = @($validationArchive.Entries | ForEach-Object { $_.FullName })
  foreach ($requiredEntry in $requiredArchiveEntries) {
    if ($entryNames -notcontains $requiredEntry) {
      throw "Built personal package is missing required entry: $requiredEntry"
    }
  }
  if ($entryNames -contains "creator-tools/c4s-categories.js") {
    throw "Built personal package contains the retired corrupt C4S taxonomy."
  }
  if ($entryNames | Where-Object { $_ -match "(?i)bypass" }) {
    throw "Built personal package contains a bypass-named artifact."
  }

  foreach ($entry in $validationArchive.Entries) {
    if ($entry.FullName -notmatch "\.(?:js|gs|json|html|md|css)$") {
      continue
    }
    $reader = [System.IO.StreamReader]::new(
      $entry.Open(),
      [System.Text.Encoding]::UTF8,
      $true
    )
    try {
      $text = $reader.ReadToEnd()
      if ($text -match "(?i)Bypass All Shortlinks|bypass\.city|adbypass\.org") {
        throw "Built personal package contains retired bypasser content in $($entry.FullName)."
      }
      if ($text -match "(?i)realbooru_scraper|127\.0\.0\.1:47831") {
        throw "Built personal package still contains the retired Realbooru companion in $($entry.FullName)."
      }
    } finally {
      $reader.Dispose()
    }
  }
} finally {
  $validationArchive.Dispose()
}

$hashStream = [System.IO.File]::OpenRead($zipPath)
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hashValue = ([System.BitConverter]::ToString($sha.ComputeHash($hashStream))).Replace("-", "") }
  finally { $sha.Dispose() }
} finally { $hashStream.Dispose() }
& (Join-Path $PSScriptRoot "remove-stale-release-output.ps1") `
  -OutputRoot $distRoot `
  -Family PersonalExtension `
  -CurrentVersion $manifest.version
Write-Output "PACKAGE=$zipPath"
Write-Output "SHA256=$hashValue"
Write-Output "VALIDATED_ENTRIES=$($requiredArchiveEntries.Count)"
