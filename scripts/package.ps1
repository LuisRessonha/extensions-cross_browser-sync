<#
.SYNOPSIS
    Automated packaging script for Cross-Browser Extensions Sync.
.DESCRIPTION
    Updates extension version in package.json and manifests, builds dist/chromium and dist/firefox,
    and produces store-ready ZIP archives named "Cross-Browser-Extensions-Sync-<store>-v<version>.zip".
.EXAMPLE
    .\scripts\package.ps1
    .\scripts\package.ps1 patch
    .\scripts\package.ps1 minor
    .\scripts\package.ps1 1.0.2 -Commit -Tag
#>

[CmdletBinding()]
param (
    [Parameter(Position = 0)]
    [string]$Version = "",

    [switch]$Commit,
    [switch]$Tag
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
Set-Location $RootDir

# If node is available in PATH, delegate to package.mjs
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeArgs = @("scripts/package.mjs")
    if ($Version) { $nodeArgs += $Version }
    if ($Commit)  { $nodeArgs += "--commit" }
    if ($Tag)     { $nodeArgs += "--tag" }
    & node $nodeArgs
    exit $LASTEXITCODE
}

# --- Pure PowerShell Fallback (if node is not in path) ---

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Cross-Browser Extensions Sync Packager" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$pkgPath = Join-Path $RootDir "package.json"
$manifestPath = Join-Path $RootDir "manifest.json"
$distDir = Join-Path $RootDir "dist"
$chromiumDir = Join-Path $distDir "chromium"
$firefoxDir = Join-Path $distDir "firefox"

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkg.version
$targetVersion = $currentVersion

if ($Version) {
    if ($Version -match '^(patch|minor|major)$') {
        $parts = $currentVersion.Split('.')
        $maj = [int]$parts[0]
        $min = [int]$parts[1]
        $pat = [int]$parts[2]

        switch ($Version.ToLower()) {
            'patch' { $pat++ }
            'minor' { $min++; $pat = 0 }
            'major' { $maj++; $min = 0; $pat = 0 }
        }
        $targetVersion = "$maj.$min.$pat"
    } else {
        $targetVersion = $Version.TrimStart('v')
    }
}

if ($targetVersion -ne $currentVersion) {
    Write-Host "Bumping version: v$currentVersion -> v$targetVersion" -ForegroundColor Green
    $pkg.version = $targetVersion
    $pkgJson = $pkg | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($pkgPath, $pkgJson + "`n", [System.Text.Encoding]::UTF8)

    $rootManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $rootManifest.version = $targetVersion
    $manJson = $rootManifest | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($manifestPath, $manJson + "`n", [System.Text.Encoding]::UTF8)
} else {
    Write-Host "Packaging current version: v$targetVersion" -ForegroundColor Yellow
}

# Build Chromium & Firefox targets
if (Test-Path $chromiumDir) { Remove-Item $chromiumDir -Recurse -Force }
if (Test-Path $firefoxDir)  { Remove-Item $firefoxDir -Recurse -Force }

New-Item -ItemType Directory -Path $chromiumDir -Force | Out-Null
New-Item -ItemType Directory -Path $firefoxDir -Force | Out-Null

Copy-Item -Path (Join-Path $RootDir "assets") -Destination (Join-Path $chromiumDir "assets") -Recurse
Copy-Item -Path (Join-Path $RootDir "src")    -Destination (Join-Path $chromiumDir "src") -Recurse
Copy-Item -Path (Join-Path $RootDir "assets") -Destination (Join-Path $firefoxDir "assets") -Recurse
Copy-Item -Path (Join-Path $RootDir "src")    -Destination (Join-Path $firefoxDir "src") -Recurse

# Generate Chromium manifest (strip browser_specific_settings, ensure service_worker)
$crManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$crManifest.version = $targetVersion
$crManifest.PSObject.Properties.Remove('browser_specific_settings')
$crManifest.background = [PSCustomObject]@{
    service_worker = "src/background/index.js"
    type = "module"
}
$crManifestJson = $crManifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Join-Path $chromiumDir "manifest.json"), $crManifestJson + "`n", [System.Text.Encoding]::UTF8)

# Generate Firefox manifest (ensure background.scripts and preserve browser_specific_settings)
$ffManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$ffManifest.version = $targetVersion
$ffManifest.background = [PSCustomObject]@{
    scripts = @("src/background/index.js")
    type = "module"
}
$ffManifestJson = $ffManifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Join-Path $firefoxDir "manifest.json"), $ffManifestJson + "`n", [System.Text.Encoding]::UTF8)

Write-Host "Built distribution targets in dist/chromium and dist/firefox" -ForegroundColor Cyan

# Package ZIPs
$chromeZip = Join-Path $distDir "Cross-Browser-Extensions-Sync-chrome-v$targetVersion.zip"
$firefoxZip = Join-Path $distDir "Cross-Browser-Extensions-Sync-firefox-v$targetVersion.zip"

if (Test-Path $chromeZip)  { Remove-Item $chromeZip -Force }
if (Test-Path $firefoxZip) { Remove-Item $firefoxZip -Force }

tar -a -c -f $chromeZip -C $chromiumDir assets manifest.json src
tar -a -c -f $firefoxZip -C $firefoxDir assets manifest.json src

# Copy to generic firefox zip for backward compatibility
Copy-Item $firefoxZip (Join-Path $distDir "extensions-cross-browser-sync.zip") -Force

Write-Host "`nCreated store ZIP packages:" -ForegroundColor Green
Write-Host "  [OK] Chrome Web Store:  dist/Cross-Browser-Extensions-Sync-chrome-v$targetVersion.zip" -ForegroundColor White
Write-Host "  [OK] Firefox Add-ons:   dist/Cross-Browser-Extensions-Sync-firefox-v$targetVersion.zip" -ForegroundColor White

if ($Commit) {
    git add package.json manifest.json dist/
    git commit -m "chore(release): v$targetVersion"
    Write-Host "  [OK] Git commit created: v$targetVersion" -ForegroundColor Green
}
if ($Tag) {
    git tag "v$targetVersion"
    Write-Host "  [OK] Git tag created: v$targetVersion" -ForegroundColor Green
}

Write-Host "`nDone! Packages ready for upload in: $distDir`n" -ForegroundColor Green
