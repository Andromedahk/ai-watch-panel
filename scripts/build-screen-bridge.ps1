[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$FfmpegDir = '',
    [switch]$SkipDependencies,
    [switch]$RebuildDaemon
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$sourceRoot = Join-Path $projectRoot 'screen-bridge'
$buildRoot = Join-Path $projectRoot '.local/screen-bridge'
$packagedBridge = Join-Path $buildRoot 'XANALI-Panel-Bridge'
$venvRoot = Join-Path $projectRoot '.local/screen-bridge-venv'
$daemonPath = Join-Path $sourceRoot 'resources/streamd-arm64'

function Assert-ExitCode([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)." }
}
function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}
function Get-NativeOutput([string]$File, [string]$Arguments) {
    # Windows PowerShell can turn successful native stderr into a terminating
    # NativeCommandError under ErrorActionPreference=Stop. Read both pipes
    # directly, without a shell, and decide success using the exit code.
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $File
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Native resource check failed (exit $($process.ExitCode))." }
        return ($output.Result + [Environment]::NewLine + $errors.Result)
    } finally {
        $process.Dispose()
    }
}

if ($env:OS -ne 'Windows_NT') { throw 'The display bridge currently builds on Windows x64.' }
if (-not $FfmpegDir) { $FfmpegDir = Join-Path $sourceRoot 'resources/ffmpeg' }
$FfmpegDir = (Resolve-Path -LiteralPath $FfmpegDir).Path
if ($FfmpegDir.StartsWith($packagedBridge + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use an FFmpeg input directory outside the generated bridge bundle.'
}
$ffmpegExe = Join-Path $FfmpegDir 'ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpegExe)) { throw 'Specify -FfmpegDir containing ffmpeg.exe and its companion DLLs.' }
$ffmpegVersion = Get-NativeOutput $ffmpegExe '-version'
if ($ffmpegVersion -match '--enable-nonfree') { throw 'Select an FFmpeg build without --enable-nonfree.' }
$ffmpegEncoders = Get-NativeOutput $ffmpegExe '-hide_banner -encoders'
if ($ffmpegEncoders -notmatch '\blibx264\b') { throw 'FFmpeg must include the libx264 encoder.' }

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
if (-not $Python) {
    $Python = Join-Path $venvRoot 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $Python)) {
        & python -m venv $venvRoot
        Assert-ExitCode 'Create local Python environment (Python 3.10+ required)'
    }
}
& $Python -c "import os,struct,sys; assert os.name == 'nt' and sys.version_info >= (3,10) and struct.calcsize('P') == 8, 'Windows x64 Python 3.10+ required'"
Assert-ExitCode 'Check Python runtime'
if (-not $SkipDependencies) {
    & $Python -m pip install --disable-pip-version-check -r (Join-Path $sourceRoot 'requirements-build.txt')
    Assert-ExitCode 'Install bridge build dependencies'
}

if ($RebuildDaemon -or -not (Test-Path -LiteralPath $daemonPath)) {
    $goCommand = Get-Command go -ErrorAction Stop
    $previousGoos, $previousGoarch, $previousCgo = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
    Push-Location (Join-Path $sourceRoot 'tools/streamd')
    try {
        $env:GOOS = 'linux'; $env:GOARCH = 'arm64'; $env:CGO_ENABLED = '0'
        & $goCommand.Source build -trimpath -ldflags '-s -w' -o $daemonPath .
        Assert-ExitCode 'Build ARM64 display daemon'
    } finally {
        Pop-Location
        $env:GOOS = $previousGoos; $env:GOARCH = $previousGoarch; $env:CGO_ENABLED = $previousCgo
    }
}
$daemonHeader = [IO.File]::ReadAllBytes($daemonPath)
if ($daemonHeader.Length -lt 20 -or $daemonHeader[0] -ne 127 -or $daemonHeader[1] -ne 69 -or
    $daemonHeader[2] -ne 76 -or $daemonHeader[3] -ne 70 -or $daemonHeader[4] -ne 2 -or
    $daemonHeader[5] -ne 1 -or $daemonHeader[18] -ne 183 -or $daemonHeader[19] -ne 0) {
    throw 'streamd-arm64 must be a little-endian ELF64 AArch64 binary.'
}

$bridgeArgs = @(
    '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console', '--noupx',
    '--name', 'XANALI-Panel-Bridge', '--distpath', $buildRoot,
    '--workpath', (Join-Path $buildRoot 'pyinstaller'), '--specpath', $buildRoot,
    '--paths', (Join-Path $sourceRoot 'app'),
    '--paths', (Join-Path $sourceRoot 'tools/poc'),
    '--hidden-import', 'kanali_stream', '--hidden-import', 'deploy_streamd',
    '--hidden-import', 'usb_windows', '--exclude-module', 'usb_macos',
    '--exclude-module', 'tkinter', '--exclude-module', '_tkinter',
    '--add-data', ($daemonPath + ';resources'),
    (Join-Path $sourceRoot 'app/panel_stream_bridge.py')
)
& $Python @bridgeArgs
Assert-ExitCode 'Bundle headless display bridge'
$packagedFfmpeg = Join-Path $packagedBridge '_internal/resources/ffmpeg'
New-Item -ItemType Directory -Path $packagedFfmpeg -Force | Out-Null
Copy-Item -LiteralPath $ffmpegExe -Destination $packagedFfmpeg -Force
Get-ChildItem -LiteralPath $FfmpegDir -Filter '*.dll' -File | Copy-Item -Destination $packagedFfmpeg -Force

$licenseRoot = Join-Path $packagedBridge 'licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'licenses') -File | Copy-Item -Destination $licenseRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'THIRD-PARTY-NOTICES.md') -Destination $packagedBridge -Force
Write-Utf8 (Join-Path $licenseRoot 'ffmpeg-version-buildconf.txt') $ffmpegVersion
$sitePackages = (& $Python -c "import importlib.metadata as m; print(m.distribution('Pillow').locate_file(''))").Trim()
Assert-ExitCode 'Locate Python dependency notices'
Get-ChildItem -LiteralPath $sitePackages -Directory -Filter '*.dist-info' | ForEach-Object {
    $metadataDir = $_
    $licenseEntries = Get-ChildItem -LiteralPath $metadataDir.FullName | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE|licenses)' }
    if ($licenseEntries) {
        $target = Join-Path $licenseRoot $metadataDir.Name
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        $licenseEntries | Copy-Item -Destination $target -Recurse -Force
    }
}
$pythonBase = (& $Python -c 'import sys; print(sys.base_prefix)').Trim()
Assert-ExitCode 'Locate Python runtime notice'
Copy-Item -LiteralPath (Join-Path $pythonBase 'LICENSE.txt') -Destination (Join-Path $licenseRoot 'Python-LICENSE.txt') -Force

# Ship the bridge and daemon sources alongside their runtime notices.
$packagedSource = Join-Path $packagedBridge 'source'
foreach ($relative in @('app', 'tools/poc', 'tools/streamd')) {
    $target = Join-Path $packagedSource $relative
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $sourceRoot $relative) -File |
        Where-Object { $_.Extension -in @('.py', '.go', '.md') -or $_.Name -eq 'go.mod' } |
        Copy-Item -Destination $target -Force
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.md'), (Join-Path $sourceRoot 'requirements-build.txt') -Destination $packagedSource -Force

# Release CI supplies the complete, checksum-pinned FFmpeg/x264 sources and
# build recipe next to its source-built encoder. Keep those materials outside
# the Python resource directory, alongside the bridge/daemon source bundle.
$encoderSource = Join-Path $FfmpegDir 'source'
if (Test-Path -LiteralPath $encoderSource -PathType Container) {
    $target = Join-Path $packagedSource 'ffmpeg'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath $encoderSource -File | Copy-Item -Destination $target -Force
    Copy-Item -LiteralPath (Join-Path $FfmpegDir 'SHA256SUMS.txt') -Destination (Join-Path $target 'ENCODER-SHA256SUMS.txt') -Force
}
$encoderLicenses = Join-Path $FfmpegDir 'licenses'
if (Test-Path -LiteralPath $encoderLicenses -PathType Container) {
    $target = Join-Path $licenseRoot 'ffmpeg'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath $encoderLicenses -File | Copy-Item -Destination $target -Force
}
& (Join-Path $packagedBridge 'XANALI-Panel-Bridge.exe') --check
Assert-ExitCode 'Validate packaged bridge resources without USB access'
Write-Host "Packaged display bridge: $packagedBridge"
