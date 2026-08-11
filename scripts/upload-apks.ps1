# Build debug APKs, verify signatures, upload to R2.
# Usage (from repo root): .\scripts\upload-apks.ps1

param()

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

function Get-AndroidSdkDir {
    $localProps = Join-Path $repoRoot 'local.properties'
    if (Test-Path $localProps) {
        foreach ($line in Get-Content $localProps) {
            if ($line -match '^sdk\.dir=(.+)$') {
                $dir = $Matches[1].Trim() -replace '\\(.)', '$1'
                if (Test-Path $dir) { return $dir }
            }
        }
    }
    foreach ($envVar in @('ANDROID_HOME', 'ANDROID_SDK_ROOT')) {
        $dir = [Environment]::GetEnvironmentVariable($envVar)
        if ($dir -and (Test-Path $dir)) { return $dir }
    }
    Write-Error 'Android SDK not found. Set sdk.dir in local.properties or ANDROID_HOME.'
}

function Get-ApkSigner {
    param([string]$SdkDir)
    $signer = Get-ChildItem (Join-Path $SdkDir 'build-tools\*\apksigner.bat') -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Directory.Name } -Descending |
        Select-Object -First 1
    if (-not $signer) {
        Write-Error "apksigner.bat not found under $SdkDir\build-tools"
    }
    return $signer.FullName
}

function Test-ApkSigned {
    param([string]$ApkSigner, [string]$ApkPath, [string]$Label)
    if (-not (Test-Path $ApkPath)) {
        Write-Error "$Label APK not found at $ApkPath (build may have failed)."
    }
    Write-Host "Verifying signature: $Label"
    & $ApkSigner verify --verbose $ApkPath 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Error @"
APK signature verification FAILED for $Label.
File: $ApkPath
The APK is unsigned or corrupt (e.g. missing META-INF/MANIFEST.MF).
Debug APKs are signed automatically by Gradle — do not upload release-unsigned or repacked APKs.
"@
    }
    Write-Host "OK: $Label is signed."
}

function Get-DownloadUrls {
    $configPath = Join-Path $repoRoot 'marketing\src\config.ts'
    $content = Get-Content $configPath -Raw
    if ($content -notmatch "export const R2_MEDIA_PROXY_BASE_URL = '([^']+)'") {
        Write-Error 'Could not parse R2_MEDIA_PROXY_BASE_URL from marketing/src/config.ts'
    }
    $base = $Matches[1]
    return @{
        Child  = "$base/downloads/child.apk"
        Parent = "$base/downloads/parent.apk"
    }
}

Push-Location $repoRoot
try {
    Write-Host 'Building debug APKs...'
    & .\gradlew.bat :child:assembleDebug :parent:assembleDebug
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Gradle build failed.'
    }

    $sdkDir = Get-AndroidSdkDir
    $apkSigner = Get-ApkSigner -SdkDir $sdkDir
    Write-Host "Using apksigner: $apkSigner"

    $childApk = Join-Path $repoRoot 'child\build\outputs\apk\debug\child-debug.apk'
    $parentApk = Join-Path $repoRoot 'parent\build\outputs\apk\debug\parent-debug.apk'

    Test-ApkSigned -ApkSigner $apkSigner -ApkPath $childApk -Label 'child-debug'
    Test-ApkSigned -ApkSigner $apkSigner -ApkPath $parentApk -Label 'parent-debug'

    Write-Host 'Uploading to R2...'
    & npx wrangler r2 object put luscsl-uploads/downloads/child.apk --file $childApk --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for child.apk.' }

    & npx wrangler r2 object put luscsl-uploads/downloads/parent.apk --file $parentApk --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for parent.apk.' }

    $urls = Get-DownloadUrls
    Write-Host ''
    Write-Host 'Upload complete. Download URLs (from marketing/src/config.ts):'
    Write-Host "  child:  $($urls.Child)"
    Write-Host "  parent: $($urls.Parent)"
}
finally {
    Pop-Location
}
