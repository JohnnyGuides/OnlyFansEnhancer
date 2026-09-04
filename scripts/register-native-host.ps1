param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [Parameter(DontShow = $true)][scriptblock]$RegistryWriter = {
    param([string]$Path, [string]$Value)
    New-Item -Path $Path -Force | Out-Null
    Set-Item -Path $Path -Value $Value
  }
)

$ErrorActionPreference = "Stop"
function Resolve-DataRoot([AllowNull()]$ConfiguredRoot, [string]$LocalAppData) {
  if ($null -eq $ConfiguredRoot) {
    return Join-Path $LocalAppData "OFEnhancer"
  }
  if (
    [string]::IsNullOrWhiteSpace($ConfiguredRoot) -or
    $ConfiguredRoot.Length -gt 1024 -or
    $ConfiguredRoot -ne $ConfiguredRoot.Trim()
  ) {
    throw "OFENHANCER_DATA_ROOT must name an absolute, creatable directory below a volume root."
  }
  try {
    $pathRoot = [System.IO.Path]::GetPathRoot($ConfiguredRoot)
    if (
      -not [System.IO.Path]::IsPathRooted($ConfiguredRoot) -or
      [string]::IsNullOrEmpty($pathRoot) -or
      $pathRoot -eq [System.IO.Path]::DirectorySeparatorChar -or
      $pathRoot -match '^[A-Za-z]:$'
    ) {
      throw "invalid"
    }
    $fullRoot = [System.IO.Path]::GetFullPath($ConfiguredRoot).TrimEnd(
      [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
      )
    )
    $volumeRoot = [System.IO.Path]::GetPathRoot($fullRoot).TrimEnd(
      [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
      )
    )
    if (
      $fullRoot.Equals($volumeRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      (Test-Path -LiteralPath $fullRoot -PathType Leaf)
    ) {
      throw "invalid"
    }
    [System.IO.Directory]::CreateDirectory($fullRoot) | Out-Null
    return $fullRoot
  } catch {
    throw "OFENHANCER_DATA_ROOT must name an absolute, creatable directory below a volume root."
  }
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "The Chrome extension ID must contain exactly 32 letters from a to p."
}
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$hostPath = [System.IO.Path]::GetFullPath((Join-Path $root "native\OFEnhancerNativeBridge.exe"))
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $hostPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
  throw "The installed native bridge is missing."
}
$settingsDirectory = Resolve-DataRoot $env:OFENHANCER_DATA_ROOT $env:LOCALAPPDATA

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
& $RegistryWriter $registryPath $nativeManifestPath

New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path $settingsDirectory "settings.json"),
  (@{ extensionId = $ExtensionId } | ConvertTo-Json),
  $utf8
)
Write-Output "REGISTERED=com.johnnyguides.ofenhancer"
