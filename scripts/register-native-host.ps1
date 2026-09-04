param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [Parameter(DontShow = $true)][scriptblock]$RegistryWriter = {
    param([string]$Path, [string]$Value)
    New-Item -Path $Path -Force | Out-Null
    Set-Item -Path $Path -Value $Value
  },
  [Parameter(DontShow = $true)][scriptblock]$SettingsCommit = {
    param([string]$Source, [string]$Destination, [bool]$DestinationExists)
    if ($DestinationExists) {
      [System.IO.File]::Replace(
        $Source,
        $Destination,
        [System.Management.Automation.Language.NullString]::Value
      )
    } else {
      [System.IO.File]::Move($Source, $Destination)
    }
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

function Normalize-OptionalSetting($Property, [string]$Pattern) {
  if ($null -eq $Property -or $null -eq $Property.Value) {
    return $null
  }
  if ($Property.Value -isnot [string]) {
    throw "invalid"
  }
  $candidate = $Property.Value.Trim()
  if (-not [System.Text.RegularExpressions.Regex]::IsMatch(
    $candidate,
    $Pattern,
    [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
  )) {
    throw "invalid"
  }
  return $candidate
}

function Read-ExistingSettings([string]$SettingsPath) {
  if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
    return [pscustomobject]@{ GoogleOAuthClientId = $null }
  }
  try {
    $settingsFile = Get-Item -LiteralPath $SettingsPath
    if ($settingsFile.Length -gt (64 * 1024)) {
      throw "invalid"
    }
    $bytes = [System.IO.File]::ReadAllBytes($SettingsPath)
    $json = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $payload = $json | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $payload) {
      return [pscustomobject]@{ GoogleOAuthClientId = $null }
    }
    if ($payload -isnot [System.Management.Automation.PSCustomObject]) {
      throw "invalid"
    }
    $properties = @($payload.PSObject.Properties)
    foreach ($property in $properties) {
      if (
        $property.Name -cne "extensionId" -and
        $property.Name -cne "googleOAuthClientId"
      ) {
        throw "invalid"
      }
    }
    $extensionProperty = $properties |
      Where-Object { $_.Name -ceq "extensionId" } |
      Select-Object -First 1
    $null = Normalize-OptionalSetting $extensionProperty '^[a-p]{32}$'
    $googleProperty = $properties |
      Where-Object { $_.Name -ceq "googleOAuthClientId" } |
      Select-Object -First 1
    $googleOAuthClientId = Normalize-OptionalSetting $googleProperty '^[0-9]{6,30}-[a-z0-9]{8,128}\.apps\.googleusercontent\.com$'
    return [pscustomobject]@{ GoogleOAuthClientId = $googleOAuthClientId }
  } catch {
    throw "Existing settings.json is invalid. Registration stopped before making changes."
  }
}

function Write-SettingsAtomically(
  [string]$SettingsPath,
  [string]$ExtensionId,
  [AllowNull()]$GoogleOAuthClientId,
  [scriptblock]$Commit
) {
  $settings = [ordered]@{ extensionId = $ExtensionId }
  if ($null -ne $GoogleOAuthClientId) {
    $settings.googleOAuthClientId = $GoogleOAuthClientId
  }
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $bytes = $utf8.GetBytes(($settings | ConvertTo-Json -Compress))
  $temporaryPath = "$SettingsPath.$([guid]::NewGuid().ToString('N')).tmp"
  $destinationExists = Test-Path -LiteralPath $SettingsPath -PathType Leaf
  try {
    $output = [System.IO.FileStream]::new(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough
    )
    try {
      $output.Write($bytes, 0, $bytes.Length)
      $output.Flush($true)
    } finally {
      $output.Dispose()
    }
    & $Commit $temporaryPath $SettingsPath $destinationExists
  } catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw "Desktop settings write failed. Registration stopped before registry changes."
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
[System.IO.Directory]::CreateDirectory($settingsDirectory) | Out-Null
$settingsPath = Join-Path $settingsDirectory "settings.json"
$existingSettings = Read-ExistingSettings $settingsPath
Write-SettingsAtomically `
  $settingsPath `
  $ExtensionId `
  $existingSettings.GoogleOAuthClientId `
  $SettingsCommit

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
Write-Output "REGISTERED=com.johnnyguides.ofenhancer"
