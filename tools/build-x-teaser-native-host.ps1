param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist")
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "extensions\personal\manifest.json") -Raw | ConvertFrom-Json
$project = Join-Path $repositoryRoot "native-host\CreatorTeaserNativeHost\CreatorTeaserNativeHost.csproj"
$distRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$publishRoot = Join-Path $distRoot "x-teaser-native-host-v$($manifest.version)"
$zipPath = "$publishRoot.zip"

. (Join-Path $PSScriptRoot 'release-output-safety.ps1')
Assert-ReleaseRoot $distRoot
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

$finalPublishRoot = $publishRoot
$finalZipPath = $zipPath
$publishRoot = Join-Path $distRoot (".teaser-build-" + [guid]::NewGuid().ToString('N'))
$zipPath = "$publishRoot.zip"
dotnet publish $project -c Release -r win-x64 --self-contained false -o $publishRoot
if ($LASTEXITCODE -ne 0) { throw "The X teaser native host publish failed." }
Copy-Item -LiteralPath (Join-Path $repositoryRoot "native-host\config.example.json") -Destination $publishRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "native-host\install-current-user.ps1") -Destination $publishRoot
Compress-Archive -Path (Join-Path $publishRoot "*") -DestinationPath $zipPath
$stream = [System.IO.File]::OpenRead($zipPath)
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashValue = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "")
  } finally {
    $sha.Dispose()
  }
} finally {
  $stream.Dispose()
}
Publish-ReleaseArtifact $zipPath $finalZipPath $false
Publish-ReleaseArtifact $publishRoot $finalPublishRoot $true
$zipPath = $finalZipPath
& (Join-Path $PSScriptRoot "remove-stale-release-output.ps1") `
  -OutputRoot $distRoot `
  -Family TeaserHost `
  -CurrentVersion $manifest.version
Write-Output "PACKAGE=$zipPath"
Write-Output "SHA256=$hashValue"
