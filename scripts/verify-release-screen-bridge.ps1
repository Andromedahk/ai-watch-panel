[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$BridgeRoot)

$ErrorActionPreference = 'Stop'
$BridgeRoot = (Resolve-Path -LiteralPath $BridgeRoot).Path
$required = @(
    'XANALI-Panel-Bridge.exe',
    '_internal/resources/streamd-arm64',
    '_internal/resources/ffmpeg/ffmpeg.exe',
    'source/ffmpeg/ffmpeg-9.0.2.tar.xz',
    'source/ffmpeg/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2',
    'source/ffmpeg/build-release-ffmpeg.sh',
    'source/ffmpeg/BUILD-INFO.txt',
    'source/ffmpeg/ENCODER-SHA256SUMS.txt',
    'licenses/ffmpeg/FFmpeg-COPYING.GPLv2.txt',
    'licenses/ffmpeg/x264-COPYING.txt',
    'THIRD-PARTY-NOTICES.md'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $BridgeRoot $relative) -PathType Leaf)) {
        throw "Missing packaged screen bridge resource: $relative"
    }
}
& (Join-Path $BridgeRoot 'XANALI-Panel-Bridge.exe') --check
if ($LASTEXITCODE -ne 0) { throw 'The installed screen bridge runtime failed --check.' }

# Check the exact source archives delivered alongside the installed executable.
$sources = @{
    'ffmpeg-9.0.2.tar.xz' = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
    'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2' = '6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224'
}
foreach ($name in $sources.Keys) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $BridgeRoot "source/ffmpeg/$name")).Hash.ToLowerInvariant()
    if ($actual -ne $sources[$name]) { throw "Packaged corresponding source mismatch: $name" }
}
foreach ($line in Get-Content (Join-Path $BridgeRoot 'source/ffmpeg/ENCODER-SHA256SUMS.txt')) {
    if ($line -notmatch '^([a-f0-9]{64})  \./(ffmpeg\.exe|source/[^/]+|licenses/[^/]+)$') {
        throw 'Invalid installed encoder checksum entry'
    }
    $expected, $relative = $Matches[1], $Matches[2]
    if ($relative -eq 'ffmpeg.exe') { $target = '_internal/resources/ffmpeg/ffmpeg.exe' }
    elseif ($relative.StartsWith('source/')) { $target = 'source/ffmpeg/' + $relative.Substring(7) }
    else { $target = 'licenses/ffmpeg/' + $relative.Substring(9) }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $BridgeRoot $target)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Installed encoder material mismatch: $target" }
}

$projectRoot = Split-Path $PSScriptRoot -Parent
python (Join-Path $projectRoot 'screen-bridge/tests/smoke_panel_stream_bridge.py') --bridge (Join-Path $BridgeRoot 'XANALI-Panel-Bridge.exe')
if ($LASTEXITCODE -ne 0) { throw 'The installed screen bridge failed its no-USB encoding test.' }
Write-Host 'Packaged screen bridge, corresponding source, and real no-USB encoding verified.'
