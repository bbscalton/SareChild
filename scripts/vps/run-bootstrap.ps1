# Upload and run scripts/vps/bootstrap.sh on the SareChild VPS.
# Usage (from repo root):
#   1. echo YOUR_ROOT_PASSWORD > .vps-root-password   # gitignored
#   2. .\scripts\vps\run-bootstrap.ps1
param(
    [string]$VpsHost = '107.170.15.179',
    [string]$User = 'root'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$passwordFile = Join-Path $repoRoot '.vps-root-password'
$bootstrap = Join-Path $PSScriptRoot 'bootstrap.sh'

if (-not (Test-Path $passwordFile)) {
    Write-Error "Create gitignored .vps-root-password in repo root (see docs/VPS_OPS.md)."
}
if (-not (Test-Path $bootstrap)) {
    Write-Error "Missing $bootstrap"
}

$pass = (Get-Content $passwordFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($pass)) {
    Write-Error ".vps-root-password is empty."
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
    Write-Error "Install PuTTY (pscp + plink) or Chocolatey putty package."
}

$target = "${User}@${VpsHost}"
Write-Host "Uploading bootstrap.sh to $target ..."
& $pscp -batch -pw $pass $bootstrap "${target}:/tmp/bootstrap.sh"
Write-Host "Running bootstrap (may take several minutes) ..."
& $plink -batch -pw $pass $target "bash /tmp/bootstrap.sh"
Write-Host ""
Write-Host "Done. On the server, read TURN creds with:"
Write-Host "  ssh $target 'sudo grep -E ^TURN_ /opt/sarechild/.env'"
Write-Host "Copy into parent-web/.env and local.properties, then rebuild apps."
