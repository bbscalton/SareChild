# Copy the PC archive secret + public tunnel URL into gitignored functions/.env
# Usage:
#   .\scripts\upsert-xampp-storage-env.ps1
#   .\scripts\upsert-xampp-storage-env.ps1 -Url "https://YOUR-STABLE-HOST/sarechild-storage"
param(
  [string]$Url = "https://pamela-camcorder-distribute-framework.trycloudflare.com",
  [string]$EnvPath = "",
  [string]$SecretFile = "C:\xampp2\htdocs\sarechild-storage\.secret"
)
$ErrorActionPreference = "Stop"
if (-not $EnvPath) {
  $EnvPath = Join-Path $PSScriptRoot "..\functions\.env" | Resolve-Path
}
if (-not (Test-Path $SecretFile)) { throw "Missing $SecretFile — run scripts/install-xampp-storage.ps1" }
$secret = (Get-Content $SecretFile -Raw).Trim()
if ($secret.Length -lt 16) { throw "Secret file is empty" }
$keys = @{
  "XAMPP_STORAGE_URL" = $Url.TrimEnd("/")
  "XAMPP_STORAGE_SECRET" = $secret
}
$seen = @{}
$lines = @(Get-Content $EnvPath)
$out = foreach ($line in $lines) {
  if ($line -match '^(XAMPP_STORAGE_URL|XAMPP_STORAGE_SECRET)=') {
    $k = $Matches[1]
    $seen[$k] = $true
    "$k=$($keys[$k])"
  } else {
    $line
  }
}
foreach ($k in @("XAMPP_STORAGE_URL", "XAMPP_STORAGE_SECRET")) {
  if (-not $seen.ContainsKey($k)) { $out += "$k=$($keys[$k])" }
}
Set-Content -Path $EnvPath -Value $out -Encoding utf8
Write-Host "Updated gitignored functions/.env with XAMPP_STORAGE_URL (secret not printed)."
Write-Host "Redeploy functions: cd functions; firebase deploy --only functions --project safechild-f34ac"
