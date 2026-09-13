param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [Parameter(Mandatory = $true)]
  [ValidateSet("DesktopStage", "DesktopInstaller", "TeaserHost")]
  [string]$Family,

  [Parameter(Mandatory = $true)]
  [string]$CurrentVersion
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-output-safety.ps1')
Assert-ReleaseRoot $OutputRoot

if ($CurrentVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "The current release version must contain three numeric parts."
}

$root = [System.IO.Path]::GetFullPath($OutputRoot)
if (-not [System.IO.Directory]::Exists($root)) {
  throw "The release output directory does not exist."
}
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

$specifications = switch ($Family) {
  "DesktopStage" {
    @{
      Pattern = "ofenhancer-desktop-v*"
      Name = '^ofenhancer-desktop-v\d+\.\d+\.\d+$'
      Current = "ofenhancer-desktop-v$CurrentVersion"
      Directory = $true
    }
  }
  "DesktopInstaller" {
    @{
      Pattern = "OFEnhancer-Setup-*.exe"
      Name = '^OFEnhancer-Setup-\d+\.\d+\.\d+\.exe$'
      Current = "OFEnhancer-Setup-$CurrentVersion.exe"
      Directory = $false
    }
  }
  "TeaserHost" {
    @(
      @{
        Pattern = "x-teaser-native-host-v*"
        Name = '^x-teaser-native-host-v\d+\.\d+\.\d+$'
        Current = "x-teaser-native-host-v$CurrentVersion"
        Directory = $true
      },
      @{
        Pattern = "x-teaser-native-host-v*.zip"
        Name = '^x-teaser-native-host-v\d+\.\d+\.\d+\.zip$'
        Current = "x-teaser-native-host-v$CurrentVersion.zip"
        Directory = $false
      }
    )
  }
}

$stale = @()
foreach ($specification in $specifications) {
  $currentPath = Join-Path $root $specification.Current
  if (-not (Test-Path -LiteralPath $currentPath -PathType $(if ($specification.Directory) { "Container" } else { "Leaf" }))) {
    throw "The current $Family artifact is missing: $($specification.Current)"
  }

  foreach ($item in Get-ChildItem -LiteralPath $root -Filter $specification.Pattern -Force) {
    if ($item.Name -notmatch $specification.Name -or $item.Name -eq $specification.Current) {
      continue
    }
    if ($item.PSIsContainer -ne $specification.Directory) {
      throw "A stale release artifact has an unexpected type: $($item.Name)"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to remove a stale release reparse point: $($item.Name)"
    }
    $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "A stale release artifact escapes the output directory."
    }
    $stale += $item
  }
}

foreach ($item in $stale) {
  if ($item.PSIsContainer) {
    [System.IO.Directory]::Delete($item.FullName, $true)
  } else {
    [System.IO.File]::Delete($item.FullName)
  }
  Write-Output "REMOVED_STALE_RELEASE_OUTPUT=$($item.Name)"
}
