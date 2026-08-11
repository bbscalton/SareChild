# Build parent-web and deploy to VPS staging (nginx :8080).
# Usage (from repo root):
#   1. Configure parent-web/.env (including VITE_FIREBASE_API_KEY)
#   2. echo YOUR_ROOT_PASSWORD > .vps-root-password   # gitignored
#   3. .\scripts\vps\deploy-staging.ps1
param(
    [string]$VpsHost = '107.170.15.179',
    [string]$User = 'root'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$passwordFile = Join-Path $repoRoot '.vps-root-password'
$parentWeb = Join-Path $repoRoot 'parent-web'
$envFile = Join-Path $parentWeb '.env'
$distDir = Join-Path $parentWeb 'dist'
$remoteStaging = '/opt/sarechild/staging'

if (-not (Test-Path $envFile)) {
    Write-Error "Missing parent-web/.env — copy from parent-web/.env.example and set Firebase vars."
}

$envBytes = [System.IO.File]::ReadAllBytes($envFile)
if ($envBytes.Length -ge 3 -and $envBytes[0] -eq 0xEF -and $envBytes[1] -eq 0xBB -and $envBytes[2] -eq 0xBF) {
    Write-Error "parent-web/.env starts with a UTF-8 BOM — Vite will not load VITE_FIREBASE_API_KEY. Re-save as UTF-8 without BOM."
}

$hasApiKey = $false
$hasMapsKey = $false
foreach ($line in Get-Content $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('#') -or [string]::IsNullOrWhiteSpace($trimmed)) { continue }
    if ($trimmed -match '^VITE_FIREBASE_API_KEY\s*=\s*(.+)$') {
        $value = $Matches[1].Trim().Trim('"').Trim("'")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $hasApiKey = $true
        }
    }
    if ($trimmed -match '^VITE_GOOGLE_MAPS_API_KEY\s*=\s*(.+)$') {
        $value = $Matches[1].Trim().Trim('"').Trim("'")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $hasMapsKey = $true
        }
    }
}
if (-not $hasApiKey) {
    Write-Error "parent-web/.env must set a non-empty VITE_FIREBASE_API_KEY before staging deploy."
}
Write-Host 'VITE_FIREBASE_API_KEY is set.'
if (-not $hasMapsKey) {
    Write-Warning 'VITE_GOOGLE_MAPS_API_KEY is unset — Live Map will show a missing-key message.'
} else {
    Write-Host 'VITE_GOOGLE_MAPS_API_KEY is set.'
}

if (-not (Test-Path $passwordFile)) {
    Write-Error "Create gitignored .vps-root-password in repo root (see docs/VPS_OPS.md)."
}

$pass = (Get-Content $passwordFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($pass)) {
    Write-Error '.vps-root-password is empty.'
}

$pscp = @(
    "${env:ProgramFiles}\PuTTY\pscp.exe",
    "${env:ProgramFiles(x86)}\PuTTY\pscp.exe",
    "$env:ProgramData\chocolatey\bin\pscp.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$plink = @(
    "${env:ProgramFiles}\PuTTY\plink.exe",
    "${env:ProgramFiles(x86)}\PuTTY\plink.exe",
    "$env:ProgramData\chocolatey\bin\plink.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $pscp -or -not $plink) {
    Write-Error 'Install PuTTY (pscp + plink) or Chocolatey putty package.'
}

Write-Host 'Building parent-web ...'
Push-Location $parentWeb
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $distDir)) {
    Write-Error "Build output missing: parent-web/dist"
}

$authBundle = Get-ChildItem -Path (Join-Path $distDir 'assets') -Filter 'AuthContext-*.js' | Select-Object -First 1
if (-not $authBundle) {
    Write-Error "Build output missing AuthContext bundle in parent-web/dist/assets"
}
$authText = Get-Content $authBundle.FullName -Raw
if ($authText -match 'apiKey:\w+\(void 0,.VITE_FIREBASE_API_KEY') {
    Write-Error 'VITE_FIREBASE_API_KEY was not inlined into the build. Check parent-web/.env encoding (no BOM) and rebuild.'
}
Write-Host 'Firebase API key inlined in AuthContext bundle.'

$appBundle = Get-ChildItem -Path (Join-Path $distDir 'assets') -Filter 'App-*.js' | Select-Object -First 1
if ($hasMapsKey -and $appBundle) {
    $appText = Get-Content $appBundle.FullName -Raw
    if ($appText -notmatch 'maps\.googleapis\.com/maps/api/js\?key=') {
        Write-Error 'VITE_GOOGLE_MAPS_API_KEY was not inlined into the App bundle. Check parent-web/.env and rebuild.'
    }
    Write-Host 'Google Maps API key inlined in App bundle.'
}

$target = "${User}@${VpsHost}"
Write-Host "Uploading dist/ to ${target}:${remoteStaging}/ ..."
& $pscp -batch -pw $pass -r "$distDir\*" "${target}:${remoteStaging}/"
Write-Host 'Setting file permissions on staging ...'
& $plink -batch -pw $pass $target "chmod -R a+rX ${remoteStaging}"
Write-Host ''
Write-Host 'Staging deploy complete:'
Write-Host "  http://${VpsHost}:8080/"
