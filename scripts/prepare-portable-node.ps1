param([string]$Version = "v24.18.0")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtimeDir = Join-Path $projectRoot "runtime"
$nodeExe = Join-Path $runtimeDir "node.exe"

if (Test-Path -LiteralPath $nodeExe) {
    Write-Host "[ok] Portable Node.js already exists: $(& $nodeExe --version)"
    exit 0
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "Only 64-bit Windows is supported." }
$fileName = "node-$Version-win-$arch.zip"
$baseUrl = "https://nodejs.org/download/release/$Version"
$tempDir = Join-Path $env:TEMP "codex-zh-portable-node-$Version"
$zipPath = Join-Path $tempDir $fileName
$sumsPath = Join-Path $tempDir "SHASUMS256.txt"

try {
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    Write-Host "[info] Downloading Node.js $Version from nodejs.org (about 37 MB)..."
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$fileName" -OutFile $zipPath
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsPath

    $sumLine = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match "  $([regex]::Escape($fileName))$" } | Select-Object -First 1
    if (-not $sumLine) { throw "The official checksum list does not contain $fileName." }
    $expected = ($sumLine -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Node.js SHA-256 verification failed." }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force
    $extracted = Join-Path $tempDir "node-$Version-win-$arch"
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $extracted "node.exe") -Destination $nodeExe -Force
    Copy-Item -LiteralPath (Join-Path $extracted "LICENSE") -Destination (Join-Path $runtimeDir "NODE-LICENSE.txt") -Force
    @("Node.js $Version (Windows $arch portable)", "Official ZIP SHA-256: $actual") |
        Set-Content -LiteralPath (Join-Path $runtimeDir "VERSION.txt") -Encoding UTF8
    Write-Host "[ok] Node.js embedded and SHA-256 verified: $(& $nodeExe --version)"
} finally {
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
