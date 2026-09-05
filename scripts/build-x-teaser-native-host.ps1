param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist")
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "manifest.json") -Raw | ConvertFrom-Json
$project = Join-Path $repositoryRoot "native-host\CreatorTeaserNativeHost\CreatorTeaserNativeHost.csproj"
$distRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$publishRoot = Join-Path $distRoot "x-teaser-native-host-v$($manifest.version)"
$zipPath = "$publishRoot.zip"

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $publishRoot) { Remove-Item -LiteralPath $publishRoot -Recurse }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
dotnet publish $project -c Release -r win-x64 --self-contained false -o $publishRoot
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
& (Join-Path $PSScriptRoot "remove-stale-release-output.ps1") `
  -OutputRoot $distRoot `
  -Family TeaserHost `
  -CurrentVersion $manifest.version
Write-Output "PACKAGE=$zipPath"
Write-Output "SHA256=$hashValue"
