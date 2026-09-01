param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$hostName = "com.johnnyguides.creator_x_teaser"
$hostRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostExe = Join-Path $hostRoot "CreatorTeaserNativeHost.exe"
$configPath = Join-Path $hostRoot "config.json"
$manifestPath = Join-Path $hostRoot "$hostName.json"

if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  throw "Native host executable is missing: $hostExe"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Copy config.example.json to config.json and configure the two allowed roots first."
}

$manifest = [ordered]@{
  name = $hostName
  description = "Creator Workflow Toolkit X teaser audit host"
  path = $hostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output "Installed $hostName for Chrome extension $ExtensionId."
