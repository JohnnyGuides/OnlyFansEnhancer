param(
  [Parameter(Mandatory = $true)][string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer"
if (-not (Test-Path -LiteralPath $registryPath)) {
  Write-Output "UNREGISTERED=not-present"
  exit 0
}
$registeredManifest = [string](Get-Item -LiteralPath $registryPath).GetValue("")
if (-not $registeredManifest) {
  throw "The registered native host path is empty."
}
$registeredFullPath = [System.IO.Path]::GetFullPath($registeredManifest)
if (-not $registeredFullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "The native host points outside this installation."
}
Remove-Item -LiteralPath $registryPath -Force
if (Test-Path -LiteralPath $registeredFullPath -PathType Leaf) {
  Remove-Item -LiteralPath $registeredFullPath -Force
}
Write-Output "UNREGISTERED=com.johnnyguides.ofenhancer"
