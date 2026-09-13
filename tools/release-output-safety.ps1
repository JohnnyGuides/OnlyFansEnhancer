# Build-only helpers. Validate before traversing or replacing owned output.
function Assert-ReleasePath([string]$Path, [bool]$Directory, [switch]$Tree) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $current = $full
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($item) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unsafe release reparse point." }
      if ($current -ne $full -and -not $item.PSIsContainer) { throw "Invalid release ancestor." }
      if ($current -eq $full -and $item.PSIsContainer -ne $Directory) { throw "Invalid release output type." }
    }
    $parent = [System.IO.Directory]::GetParent($current)
    $current = if ($parent) { $parent.FullName } else { $null }
  }
  if ($Tree -and (Test-Path -LiteralPath $full -PathType Container)) {
    foreach ($child in Get-ChildItem -LiteralPath $full -Force) {
      Assert-ReleasePath $child.FullName $child.PSIsContainer -Tree
    }
  }
}

function Assert-ReleaseRoot([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.TrimEnd('\') -eq [System.IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw "Release output cannot be a volume root." }
  Assert-ReleasePath $full $true
  if (Test-Path -LiteralPath $full -PathType Container) {
    foreach ($item in Get-ChildItem -LiteralPath $full -Force) {
      if ($item.Name -match '^(ofenhancer-desktop-v|x-teaser-native-host-v)\d+\.\d+\.\d+$') { Assert-ReleasePath $item.FullName $true -Tree }
      elseif ($item.Name -match '^(OFEnhancer-Setup-\d+\.\d+\.\d+\.exe|x-teaser-native-host-v\d+\.\d+\.\d+\.zip)$') { Assert-ReleasePath $item.FullName $false }
    }
  }
}

function Publish-ReleaseArtifact([string]$Staged, [string]$Destination, [bool]$Directory) {
  Assert-ReleasePath $Staged $Directory -Tree
  Assert-ReleasePath $Destination $Directory -Tree
  $backup = "$Destination.previous-$([guid]::NewGuid().ToString('N'))"
  $exists = Test-Path -LiteralPath $Destination
  if ($exists) { Move-Item -LiteralPath $Destination -Destination $backup }
  try { Move-Item -LiteralPath $Staged -Destination $Destination }
  catch {
    if ($exists) { Move-Item -LiteralPath $backup -Destination $Destination }
    throw
  }
  if ($exists) {
    Assert-ReleasePath $backup $Directory -Tree
    Remove-Item -LiteralPath $backup -Recurse -Force
  }
}
