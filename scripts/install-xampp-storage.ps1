# Install / refresh SareChild XAMPP storage under C:\xampp2\htdocs
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "..\pc-storage" | Resolve-Path
$dest = "C:\xampp2\htdocs\sarechild-storage"
$secretFile = Join-Path $dest ".secret"

New-Item -ItemType Directory -Force -Path (Join-Path $dest "store") | Out-Null
Copy-Item (Join-Path $src "lib.php") $dest -Force
Copy-Item (Join-Path $src "health.php") $dest -Force
Copy-Item (Join-Path $src "api.php") $dest -Force
Copy-Item (Join-Path $src "index.php") $dest -Force
Copy-Item (Join-Path $src ".htaccess") $dest -Force
Copy-Item (Join-Path $src "store\.htaccess") (Join-Path $dest "store") -Force

if (-not (Test-Path $secretFile) -or (Get-Content $secretFile -Raw).Trim().Length -lt 16) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  Set-Content -Path $secretFile -Value $secret -NoNewline -Encoding ascii
}

Write-Host "Installed $dest"
Write-Host "Health http://127.0.0.1/sarechild-storage/health.json"
