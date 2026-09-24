param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$GoogleOAuthClientId = "",
  [Parameter(DontShow = $true)][scriptblock]$RegistryReader = {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        try {
          $key = $registry.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer')
          if ($null -ne $key) { try { [string]$key.GetValue('') } finally { $key.Dispose() } }
        } finally { $registry.Dispose() }
      }
    }
  },
  [Parameter(DontShow = $true)][scriptblock]$RegistryWriter = {
    param([string]$Path, [string]$Value)
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $user = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
      try {
        $key = $user.CreateSubKey('Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer')
        try { $key.SetValue('', $Value) } finally { $key.Dispose() }
      } finally { $user.Dispose() }
    }
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
    return [pscustomobject]@{ GoogleOAuthClientId = $null; BrowserId = $null; GoogleSheetUrl = $null }
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
      return [pscustomobject]@{ GoogleOAuthClientId = $null; BrowserId = $null; GoogleSheetUrl = $null }
    }
    if ($payload -isnot [System.Management.Automation.PSCustomObject]) {
      throw "invalid"
    }
    $properties = @($payload.PSObject.Properties)
    foreach ($property in $properties) {
      if (
        $property.Name -cne "extensionId" -and
        $property.Name -cne "googleOAuthClientId" -and
        $property.Name -cne "browserId" -and
        $property.Name -cne "googleSheetUrl"
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
    $browserProperty = $properties |
      Where-Object { $_.Name -ceq "browserId" } |
      Select-Object -First 1
    $browserId = Normalize-OptionalSetting $browserProperty '^(?i:system|chrome|edge|firefox|brave|opera|vivaldi)$'
    if ($null -ne $browserId) { $browserId = $browserId.ToLowerInvariant() }
    $sheetProperty = $properties |
      Where-Object { $_.Name -ceq "googleSheetUrl" } |
      Select-Object -First 1
    $googleSheetUrl = Normalize-OptionalSetting $sheetProperty '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{1,256}/edit(?:#gid=[0-9]{1,10})?$'
    return [pscustomobject]@{ GoogleOAuthClientId = $googleOAuthClientId; BrowserId = $browserId; GoogleSheetUrl = $googleSheetUrl }
  } catch {
    throw "Existing settings.json is invalid. Registration stopped before making changes."
  }
}

function Write-SettingsAtomically(
  [string]$SettingsPath,
  [string]$ExtensionId,
  [AllowNull()]$GoogleOAuthClientId,
  [AllowNull()]$BrowserId,
  [AllowNull()]$GoogleSheetUrl,
  [scriptblock]$Commit
) {
  $settings = [ordered]@{ extensionId = $ExtensionId }
  if ($null -ne $GoogleOAuthClientId) {
    $settings.googleOAuthClientId = $GoogleOAuthClientId
  }
  if ($null -ne $BrowserId) {
    $settings.browserId = $BrowserId
  }
  if ($null -ne $GoogleSheetUrl) {
    $settings.googleSheetUrl = $GoogleSheetUrl
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
if (
  $GoogleOAuthClientId -and
  $GoogleOAuthClientId -notmatch '^[0-9]{6,30}-[a-z0-9]{8,128}\.apps\.googleusercontent\.com$'
) {
  throw "The Google OAuth client ID is invalid."
}
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$hostPath = [System.IO.Path]::GetFullPath((Join-Path $root "native\OFEnhancerNativeBridge.exe"))
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $hostPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
  throw "The installed native bridge is missing."
}
$settingsDirectory = Resolve-DataRoot $env:OFENHANCER_DATA_ROOT $env:LOCALAPPDATA
$nativeManifestPath = Join-Path $root "native\com.johnnyguides.ofenhancer.json"
foreach ($target in @(& $RegistryReader)) {
  if ([string]::IsNullOrWhiteSpace($target) -or -not [System.IO.Path]::GetFullPath($target).Equals($nativeManifestPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Another installation owns the native bridge registration. No settings or registration were changed."
  }
}
[System.IO.Directory]::CreateDirectory($settingsDirectory) | Out-Null
$settingsPath = Join-Path $settingsDirectory "settings.json"
$existingSettings = Read-ExistingSettings $settingsPath
$effectiveGoogleOAuthClientId = $existingSettings.GoogleOAuthClientId
if ($null -eq $effectiveGoogleOAuthClientId -and $GoogleOAuthClientId) {
  $effectiveGoogleOAuthClientId = $GoogleOAuthClientId
}
Write-SettingsAtomically `
  $settingsPath `
  $ExtensionId `
  $effectiveGoogleOAuthClientId `
  $existingSettings.BrowserId `
  $existingSettings.GoogleSheetUrl `
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
