# Build debug APKs, verify signatures, upload to R2, and publish version manifests
# used by in-app update prompts + TCD.
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

function Get-GradleVersion {
    param([string]$Module)
    $gradlePath = Join-Path $repoRoot "$Module\build.gradle.kts"
    $content = Get-Content $gradlePath -Raw
    if ($content -notmatch 'versionCode\s*=\s*(\d+)') {
        Write-Error "Could not parse versionCode from $gradlePath"
    }
    $code = [int]$Matches[1]
    if ($content -notmatch 'versionName\s*=\s*"([^"]+)"') {
        Write-Error "Could not parse versionName from $gradlePath"
    }
    $name = $Matches[1]
    return @{ VersionCode = $code; VersionName = $name }
}

function Get-DownloadUrls {
    $configPath = Join-Path $repoRoot 'marketing\src\config.ts'
    $content = Get-Content $configPath -Raw
    if ($content -notmatch "export const R2_MEDIA_PROXY_BASE_URL = '([^']+)'") {
        Write-Error 'Could not parse R2_MEDIA_PROXY_BASE_URL from marketing/src/config.ts'
    }
    $base = $Matches[1]
    return @{
        Base   = $base
        Child  = "$base/downloads/child.apk"
        Parent = "$base/downloads/parent.apk"
        ChildManifest  = "$base/downloads/child-version.json"
        ParentManifest = "$base/downloads/parent-version.json"
    }
}

function Write-VersionManifest {
    param(
        [string]$OutPath,
        [string]$VersionName,
        [int]$VersionCode,
        [string]$ApkUrl,
        [string]$Changelog
    )
    $releasedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    $obj = [ordered]@{
        versionName = $VersionName
        versionCode = $VersionCode
        apkUrl      = $ApkUrl
        releasedAt  = $releasedAt
        changelog   = $Changelog
    }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path $OutPath -Encoding utf8NoBOM
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

    $urls = Get-DownloadUrls
    $childVer = Get-GradleVersion -Module 'child'
    $parentVer = Get-GradleVersion -Module 'parent'

    $tmpDir = Join-Path $env:TEMP 'sarechild-version-manifests'
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $childManifestPath = Join-Path $tmpDir 'child-version.json'
    $parentManifestPath = Join-Path $tmpDir 'parent-version.json'

    Write-VersionManifest -OutPath $childManifestPath `
        -VersionName $childVer.VersionName -VersionCode $childVer.VersionCode `
        -ApkUrl $urls.Child `
        -Changelog "Child protection updates, diagnostics, and stability improvements (v$($childVer.VersionName))."

    Write-VersionManifest -OutPath $parentManifestPath `
        -VersionName $parentVer.VersionName -VersionCode $parentVer.VersionCode `
        -ApkUrl $urls.Parent `
        -Changelog "Parent app updates and in-app upgrade support (v$($parentVer.VersionName))."

    Write-Host 'Uploading APKs + version manifests to R2...'
    & npx wrangler r2 object put luscsl-uploads/downloads/child.apk --file $childApk --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for child.apk.' }

    & npx wrangler r2 object put luscsl-uploads/downloads/parent.apk --file $parentApk --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for parent.apk.' }

    & npx wrangler r2 object put luscsl-uploads/downloads/child-version.json --file $childManifestPath --content-type application/json --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for child-version.json.' }

    & npx wrangler r2 object put luscsl-uploads/downloads/parent-version.json --file $parentManifestPath --content-type application/json --remote
    if ($LASTEXITCODE -ne 0) { Write-Error 'R2 upload failed for parent-version.json.' }

    Write-Host ''
    Write-Host 'Upload complete:'
    Write-Host "  child APK:       $($urls.Child)  (v$($childVer.VersionName) / $($childVer.VersionCode))"
    Write-Host "  parent APK:      $($urls.Parent) (v$($parentVer.VersionName) / $($parentVer.VersionCode))"
    Write-Host "  child manifest:  $($urls.ChildManifest)"
    Write-Host "  parent manifest: $($urls.ParentManifest)"
}
finally {
    Pop-Location
}
