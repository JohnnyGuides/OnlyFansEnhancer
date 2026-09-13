param([ValidateSet('setup', 'reload')][string]$Page = 'setup')
$ErrorActionPreference = 'Stop'
try {
  $desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop\OFEnhancer.Desktop.exe'
  if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) { throw 'The installed OFEnhancer desktop is missing. Repair OFEnhancer.' }
  Start-Process -FilePath $desktop -ArgumentList '--chrome-setup' -WindowStyle Hidden
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'OFEnhancer Chrome setup') | Out-Null
  exit 1
}
