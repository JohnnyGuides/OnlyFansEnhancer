param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ExtensionId
)

$ErrorActionPreference = "Stop"
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "The Chrome extension ID must contain exactly 32 letters from a to p."
}
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$hostPath = [System.IO.Path]::GetFullPath((Join-Path $root "native\OFEnhancerNativeBridge.exe"))
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $hostPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
  throw "The installed native bridge is missing."
}

$nativeManifestPath = Join-Path $root "native\com.johnnyguides.ofenhancer.json"
$nativeManifest = [ordered]@{
  name = "com.johnnyguides.ofenhancer"
  description = "OFEnhancer desktop bridge"
  path = $hostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  $nativeManifestPath,
  ($nativeManifest | ConvertTo-Json -Depth 3),
  $utf8
)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $nativeManifestPath

$settingsDirectory = Join-Path $env:LOCALAPPDATA "OFEnhancer"
New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path $settingsDirectory "settings.json"),
  (@{ extensionId = $ExtensionId } | ConvertTo-Json),
  $utf8
)
Write-Output "REGISTERED=com.johnnyguides.ofenhancer"
