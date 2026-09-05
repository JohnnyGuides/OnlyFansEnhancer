param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist"),
  [switch]$StageOnly,
  [string]$ExtensionId = ""
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility

if ($ExtensionId -and $ExtensionId -notmatch '^[a-p]{32}$') {
  throw "The Chrome extension ID must contain exactly 32 letters from a to p."
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "manifest.json") -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -ne "0.20.2") {
  throw "The desktop package requires personal extension version 0.20.2."
}

$outputFull = [System.IO.Path]::GetFullPath($OutputRoot)
$stage = [System.IO.Path]::GetFullPath((Join-Path $outputFull "ofenhancer-desktop-v$version"))
$outputPrefix = $outputFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $stage.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "The desktop stage must stay inside the selected output directory."
}
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}

$desktopDirectory = Join-Path $stage "desktop"
$nativeDirectory = Join-Path $stage "native"
$extensionDirectory = Join-Path $stage "extension"
$assetsDirectory = Join-Path $stage "assets"
$toolsDirectory = Join-Path $stage "tools"
foreach ($directory in @($desktopDirectory, $nativeDirectory, $extensionDirectory, $assetsDirectory, $toolsDirectory)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

dotnet publish (Join-Path $repositoryRoot "desktop\OFEnhancer.Desktop\OFEnhancer.Desktop.csproj") `
  -c Release -r win-x64 --self-contained true -o $desktopDirectory `
  -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "The desktop publish failed." }
dotnet publish (Join-Path $repositoryRoot "native-host\OFEnhancerNativeBridge\OFEnhancerNativeBridge.csproj") `
  -c Release -r win-x64 --self-contained true -o $nativeDirectory `
  -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "The native bridge publish failed." }

$personalBuildOutput = & (Join-Path $repositoryRoot "scripts\build-personal-package.ps1")
if ($LASTEXITCODE -ne 0) { throw "The personal extension package failed." }
$packageLine = @($personalBuildOutput) | Where-Object { $_ -like "PACKAGE=*" } | Select-Object -Last 1
if (-not $packageLine) { throw "The personal extension package path is missing." }
$extensionArchive = $packageLine.Substring("PACKAGE=".Length)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($extensionArchive)
try {
  $actualEntries = @($archive.Entries | Where-Object { $_.FullName -and -not $_.FullName.EndsWith("/") } | ForEach-Object { $_.FullName } | Sort-Object)
} finally {
  $archive.Dispose()
}
$expectedEntries = @(Get-Content -LiteralPath (Join-Path $repositoryRoot "installer\personal-extension-files.txt") | Where-Object { $_.Trim() } | Sort-Object)
$desktopExcludedEntries = @("apps-script/catalogue-bridge.gs")
$permittedArchiveEntries = @(($expectedEntries + $desktopExcludedEntries) | Sort-Object)
$difference = @(Compare-Object -ReferenceObject $permittedArchiveEntries -DifferenceObject $actualEntries)
if ($difference.Count -ne 0) {
  throw "The personal extension contents differ from the installer allow-list."
}
$extensionPrefix = $extensionDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$archive = [System.IO.Compression.ZipFile]::OpenRead($extensionArchive)
try {
  foreach ($entryName in $expectedEntries) {
    $entry = $archive.GetEntry($entryName)
    if (-not $entry) { throw "The personal extension entry is missing: $entryName" }
    $destination = [System.IO.Path]::GetFullPath((Join-Path $extensionDirectory $entryName.Replace("/", "\")))
    if (-not $destination.StartsWith($extensionPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The personal extension entry escapes its stage directory."
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
  }
} finally {
  $archive.Dispose()
}

Copy-Item -LiteralPath (Join-Path $repositoryRoot "native-host\ofenhancer-native-host.json.template") -Destination $nativeDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "finalLogo.png") -Destination $assetsDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "desktop\OFEnhancer.Desktop\Assets\ofenhancer.ico") -Destination $assetsDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "installer\extension-setup.html") -Destination $stage
Copy-Item -LiteralPath (Join-Path $repositoryRoot "installer\extension-reload.html") -Destination $stage
Copy-Item -LiteralPath (Join-Path $repositoryRoot "scripts\register-native-host.ps1") -Destination $toolsDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "scripts\unregister-native-host.ps1") -Destination $toolsDirectory

$versionFile = [ordered]@{
  product = "OFEnhancer"
  productVersion = $version
  protocolVersion = 1
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  (Join-Path $stage "version.json"),
  ($versionFile | ConvertTo-Json),
  $utf8
)

$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Name -ne "package-manifest.json" } | Sort-Object FullName | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
    sha256 = Get-Sha256 $_.FullName
    size = $_.Length
  }
})
$packageManifest = [ordered]@{
  product = "OFEnhancer"
  productVersion = $version
  protocolVersion = 1
  architecture = "win-x64"
  selfContained = $true
  files = $files
}
$packageManifestPath = Join-Path $stage "package-manifest.json"
[System.IO.File]::WriteAllText(
  $packageManifestPath,
  ($packageManifest | ConvertTo-Json -Depth 5),
  $utf8
)
$manifestHash = (Get-Sha256 $packageManifestPath).ToUpperInvariant()
Write-Output "STAGE=$stage"
Write-Output "MANIFEST_SHA256=$manifestHash"
Write-Output $(if ($ExtensionId) { "INSTALL_PROFILE=personal" } else { "INSTALL_PROFILE=generic" })

if ($StageOnly) { exit 0 }

$compilerCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$compiler = $compilerCandidates | Select-Object -First 1
if (-not $compiler) {
  Write-Output "INNO_COMPILER_MISSING=https://jrsoftware.org/isdl.php"
  exit 3
}
$compilerArguments = @(
  "/DStageSource=$stage",
  "/DOutputRoot=$outputFull"
)
if ($ExtensionId) {
  $compilerArguments += "/DPersonalExtensionId=$ExtensionId"
}
$compilerArguments += (Join-Path $repositoryRoot "installer\OFEnhancer.iss")
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "The installer compile failed." }
