param(
    [string]$Version = "",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ([string]::IsNullOrWhiteSpace($Version)) {
    $releaseJson = Get-Content -LiteralPath (Join-Path $Root "resources\release.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = $releaseJson.release
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = $Root
}

$zipName = "codex-zh-CN-v$Version.zip"
$zipPath = Join-Path $OutputDir $zipName
$stageName = "codex-zh-CN-v$Version"
$stageRoot = Join-Path $env:TEMP $stageName

$include = @(
    "install-windows.bat",
    "uninstall-codex.bat",
    "LICENSE",
    "README.md",
    "RELEASE_NOTES_v$Version.md",
    "launchers",
    "resources",
    "runtime",
    "scripts"
)

$nodeExe = Join-Path $Root "runtime\node.exe"
if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Host "[info] Portable Node.js is missing; preparing it now..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\prepare-portable-node.ps1")
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nodeExe)) {
        throw "Unable to prepare portable Node.js."
    }
}

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

foreach ($item in $include) {
    $source = Join-Path $Root $item
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing release file: $source"
    }
    $target = Join-Path $stageRoot $item
    if (Test-Path -LiteralPath $source -PathType Container) {
        Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    } else {
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $zipPath)

Remove-Item -LiteralPath $stageRoot -Recurse -Force

Write-Host "[ok] Release package: $zipPath"
Write-Host "[ok] Version: v$Version"
