$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repositoryRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$distRoot = Join-Path $repositoryRoot "dist"
$zipPath = Join-Path $distRoot "creator-workflow-toolkit-personal-v$($manifest.version).zip"

$relativeFiles = @(
  "manifest.json",
  "background.js",
  "gelbooru-rules.json",
  "core.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css",
  "options.html",
  "options.js",
  "options.css"
)

$relativeFiles += Get-ChildItem -LiteralPath (Join-Path $repositoryRoot "creator-tools") -Recurse -File |
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

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath
Write-Output "PACKAGE=$zipPath"
Write-Output "SHA256=$($hash.Hash)"
