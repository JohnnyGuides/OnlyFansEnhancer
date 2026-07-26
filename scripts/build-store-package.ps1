$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$storeRoot = Join-Path $repositoryRoot "store"
$manifestPath = Join-Path $storeRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$distRoot = Join-Path $repositoryRoot "dist"
$zipPath = Join-Path $distRoot "ofenhancer-store-v$($manifest.version).zip"

if (-not (Test-Path -LiteralPath (Join-Path $storeRoot "icons\icon128.png"))) {
  throw "The mandatory 128x128 extension icon is missing."
}

$searchable = Get-ChildItem -LiteralPath $storeRoot -Recurse -File |
  Where-Object {
    $_.FullName -notmatch "\\_metadata\\" -and
    $_.Extension -match "^\.(js|json|html|md)$"
  } |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }
$prohibited = "gelbooru|realbooru|127\.0\.0\.1|declarativeNetRequest|api[_ -]?key|fetch\s*\(|XMLHttpRequest|WebSocket"
if (($searchable -join "`n") -match $prohibited) {
  throw "The store source contains a prohibited remote-integration marker: $($Matches[0])"
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
  Get-ChildItem -LiteralPath $storeRoot -Recurse -File |
    Where-Object { $_.FullName -notmatch "\\_metadata\\" } |
    ForEach-Object {
      $relativePath = $_.FullName.Substring($storeRoot.Length + 1).Replace("\", "/")
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $relativePath,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
} finally {
  $archive.Dispose()
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath
Write-Output "PACKAGE=$zipPath"
Write-Output "SHA256=$($hash.Hash)"
