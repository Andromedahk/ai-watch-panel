#!/usr/bin/env bash
# Ubuntu + mingw-w64: build only the Windows encoder used by the panel bridge.
# Keep the exact upstream sources and this build recipe with every binary.
set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work="$project_root/.local/release-ffmpeg-build"
output="$project_root/.local/release-ffmpeg"
ffmpeg_version=9.0.2
ffmpeg_archive="ffmpeg-$ffmpeg_version.tar.xz"
ffmpeg_sha256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
x264_archive="x264-$x264_commit.tar.bz2"
x264_sha256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224
ffmpeg_url="https://ffmpeg.org/releases/$ffmpeg_archive"
x264_url="https://code.videolan.org/videolan/x264/-/archive/$x264_commit/$x264_archive"
cross=x86_64-w64-mingw32-

for command in curl sha256sum tar make pkg-config nasm "${cross}gcc" "${cross}objdump"; do
  command -v "$command" >/dev/null || { echo "Missing build tool: $command" >&2; exit 1; }
done
mkdir -p "$work" "$output/source" "$output/licenses"
for source in "$ffmpeg_archive" "$x264_archive"; do
  if [[ "$source" == "$ffmpeg_archive" ]]; then
    url=$ffmpeg_url; checksum=$ffmpeg_sha256
  else
    url=$x264_url; checksum=$x264_sha256
  fi
  if [[ ! -f "$output/source/$source" ]]; then
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 "$url" -o "$output/source/$source"
  fi
  printf '%s  %s\n' "$checksum" "$output/source/$source" | sha256sum --check --strict
done

# Fixed relative directory names also make configure records independent of the
# checkout location. No untracked input libraries or host autodetection are used.
cd "$work"
rm -rf -- "ffmpeg-$ffmpeg_version" "x264-$x264_commit" prefix
tar -xf "$output/source/$ffmpeg_archive"
tar -xf "$output/source/$x264_archive"
mkdir prefix
jobs=${BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}

cd "x264-$x264_commit"
./configure --prefix=../prefix --host=x86_64-w64-mingw32 --cross-prefix="$cross" \
  --enable-static --disable-cli --disable-opencl --bit-depth=8 --chroma-format=420 \
  --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
  --extra-cflags='-O2' --extra-ldflags='-static -static-libgcc'
make -j"$jobs"
make install
cp COPYING "$output/licenses/x264-COPYING.txt"
cp config.mak "$output/source/x264-config.mak"

cd "../ffmpeg-$ffmpeg_version"
# x264's relocatable pkg-config prefix is relative to this sibling build folder.
export PKG_CONFIG_LIBDIR=../prefix/lib/pkgconfig
export PKG_CONFIG_PATH=
./configure --prefix=../prefix --target-os=mingw32 --arch=x86_64 \
  --enable-cross-compile --cross-prefix="$cross" --pkg-config=pkg-config --pkg-config-flags=--static \
  --disable-autodetect --disable-everything --disable-network --disable-doc --disable-debug \
  --disable-shared --enable-static --enable-small --disable-ffprobe --enable-ffmpeg \
  --enable-gpl --enable-libx264 --enable-encoder=libx264 --enable-decoder=rawvideo \
  --enable-demuxer=rawvideo --enable-muxer=h264 --enable-protocol=pipe \
  --enable-filter=scale,format,setsar,pad,crop --enable-swscale \
  --extra-cflags='-O2 -I../prefix/include' --extra-ldflags='-L../prefix/lib -static -static-libgcc'
make -j"$jobs" ffmpeg.exe
cp ffmpeg.exe "$output/ffmpeg.exe"
cp COPYING.GPLv2 "$output/licenses/FFmpeg-COPYING.GPLv2.txt"
cp COPYING.GPLv3 "$output/licenses/FFmpeg-COPYING.GPLv3.txt"
cp LICENSE.md "$output/licenses/FFmpeg-LICENSE.md"
cp ffbuild/config.mak "$output/source/ffmpeg-config.mak"
cp "$project_root/scripts/build-release-ffmpeg.sh" "$output/source/build-release-ffmpeg.sh"

# A complete static build must only import Windows system DLLs. Reject accidental
# runtime dependencies such as libwinpthread-1.dll or libgcc_s_seh-1.dll.
"${cross}objdump" -p "$output/ffmpeg.exe" > "$work/ffmpeg-pe.txt"
awk '/DLL Name:/ {print $3}' "$work/ffmpeg-pe.txt" > "$output/source/windows-imports.txt"
if grep -Eiv '^(KERNEL32|msvcrt|USER32|ADVAPI32|WS2_32|BCRYPT|SHELL32|OLE32|GDI32|PSAPI)\.dll$' "$output/source/windows-imports.txt"; then
  echo 'Unexpected non-system DLL dependency in the release encoder.' >&2
  exit 1
fi
test -s "$output/source/windows-imports.txt"
"${cross}objdump" -f "$output/ffmpeg.exe" | grep -q 'pei-x86-64'

for package in mingw-w64-common libgcc-13-dev gcc-mingw-w64-x86-64; do
  if [[ -f "/usr/share/doc/$package/copyright" ]]; then
    cp "/usr/share/doc/$package/copyright" "$output/licenses/$package-copyright.txt"
  fi
done
{
  printf 'AI Watch minimal Windows x64 FFmpeg encoder\n'
  printf 'FFmpeg version: %s\nFFmpeg source: %s\nFFmpeg SHA-256: %s\n' "$ffmpeg_version" "$ffmpeg_url" "$ffmpeg_sha256"
  printf 'x264 commit: %s\nx264 source: %s\nx264 SHA-256: %s\n' "$x264_commit" "$x264_url" "$x264_sha256"
  printf '\nThe complete unchanged upstream source archives, configure records, build recipe, and licenses are included.\n'
  printf 'Build requirements: Ubuntu 24.04, mingw-w64, make, nasm, pkg-config, curl, xz-utils, bzip2.\n'
  printf 'Rebuild from a project checkout: bash scripts/build-release-ffmpeg.sh\n'
  printf 'The included recipe can also be placed in scripts/ of a new folder; it recreates .local/ outputs.\n'
  printf '\nCompiler:\n'
  "${cross}gcc" --version
  printf '\nBuild package versions:\n'
  dpkg-query -W gcc-mingw-w64-x86-64 mingw-w64-common make nasm pkg-config xz-utils bzip2
} > "$output/source/BUILD-INFO.txt"
cd "$output"
find . -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
echo 'Built the minimal Windows encoder and its complete corresponding source bundle.'
