param([Parameter(Mandatory = $true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$manifest = Join-Path $root 'native\com.johnnyguides.ofenhancer.json'
$subkey = 'Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer'
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
  $user = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    $key = $user.OpenSubKey($subkey)
    if ($null -eq $key) { continue }
    try { $target = [string]$key.GetValue('') } finally { $key.Dispose() }
    if ($target -and [System.IO.Path]::GetFullPath($target).Equals($manifest, [System.StringComparison]::OrdinalIgnoreCase)) {
      $user.DeleteSubKey($subkey, $false)
    }
  } finally { $user.Dispose() }
}
# File removal is limited to the exact generated manifest in the explicit install root.
if (Test-Path -LiteralPath $manifest -PathType Leaf) {
  foreach ($candidate in @($root, (Join-Path $root 'native'), $manifest)) {
    if (((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'The owned manifest path is redirected. Its file was preserved.'
    }
  }
  Remove-Item -LiteralPath $manifest -Force
}
Write-Output 'UNREGISTERED=owned-current-user-entries'
