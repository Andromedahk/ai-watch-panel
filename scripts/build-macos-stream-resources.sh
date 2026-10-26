#!/usr/bin/env bash
# Build native macOS 15+ FFmpeg/x264 and libusb from pinned upstream releases.
# Each architecture is built on its own native runner; this is not a Rosetta build.
set -euo pipefail

[[ $(uname -s) == Darwin ]] || { echo 'Run this script on macOS 15 or later.' >&2; exit 1; }
macos_major=$(sw_vers -productVersion | cut -d. -f1)
(( macos_major >= 15 )) || { echo 'macOS 15 or later is required.' >&2; exit 1; }
case $(uname -m) in
  arm64) arch=arm64; ffmpeg_arch=aarch64; host=aarch64-apple-darwin ;;
  x86_64) arch=x64; ffmpeg_arch=x86_64; host=x86_64-apple-darwin ;;
  *) echo 'Only native Apple Silicon and Intel builds are supported.' >&2; exit 1 ;;
esac
if [[ $(sysctl -in sysctl.proc_translated 2>/dev/null || true) == 1 ]]; then
  echo 'Use a native shell and Python; Rosetta builds are not supported.' >&2; exit 1
fi
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work="$project_root/.local/macos-stream-resources-build/$arch"
output="$project_root/.local/macos-stream-resources/$arch"
export MACOSX_DEPLOYMENT_TARGET=15.0
ffmpeg_version=9.0.2
ffmpeg_archive="ffmpeg-$ffmpeg_version.tar.xz"
ffmpeg_sha256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
x264_archive="x264-$x264_commit.tar.bz2"
x264_sha256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224
libusb_version=1.0.29
libusb_archive="libusb-$libusb_version.tar.bz2"
libusb_sha256=5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85
for command in curl shasum tar make pkg-config nasm xcrun otool install_name_tool codesign python3; do
  command -v "$command" >/dev/null || { echo "Missing build tool: $command" >&2; exit 1; }
done
mkdir -p "$work" "$output/source" "$output/licenses" "$output/ffmpeg" "$output/libusb"
download() {
  local filename=$1 checksum=$2 url=$3
  if [[ ! -f "$output/source/$filename" ]]; then
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 "$url" -o "$output/source/$filename"
  fi
  printf '%s  %s\n' "$checksum" "$output/source/$filename" | shasum -a 256 --check --strict
}
download "$ffmpeg_archive" "$ffmpeg_sha256" "https://ffmpeg.org/releases/$ffmpeg_archive"
download "$x264_archive" "$x264_sha256" "https://code.videolan.org/videolan/x264/-/archive/$x264_commit/$x264_archive"
download "$libusb_archive" "$libusb_sha256" "https://github.com/libusb/libusb/releases/download/v$libusb_version/$libusb_archive"

# All removal targets are fixed names below this script's isolated build folder.
cd "$work"
rm -rf -- "ffmpeg-$ffmpeg_version" "x264-$x264_commit" "libusb-$libusb_version" prefix
tar -xf "$output/source/$ffmpeg_archive"
tar -xf "$output/source/$x264_archive"
tar -xf "$output/source/$libusb_archive"
mkdir prefix
jobs=${BUILD_JOBS:-$(sysctl -n hw.logicalcpu)}
export CC=$(xcrun --find clang)

cd "x264-$x264_commit"
./configure --prefix=../prefix --host="$host" --enable-static --enable-pic \
  --disable-cli --disable-opencl --bit-depth=8 --chroma-format=420 \
  --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
  --extra-cflags='-O2 -mmacosx-version-min=15.0' --extra-ldflags='-mmacosx-version-min=15.0'
make -j"$jobs"
make install
cp COPYING "$output/licenses/x264-COPYING.txt"
cp config.mak "$output/source/x264-config.mak"

cd "../ffmpeg-$ffmpeg_version"
export PKG_CONFIG_LIBDIR=../prefix/lib/pkgconfig
export PKG_CONFIG_PATH=
./configure --prefix=../prefix --target-os=darwin --arch="$ffmpeg_arch" \
  --cc="$CC" --pkg-config=pkg-config --pkg-config-flags=--static \
  --disable-autodetect --disable-everything --disable-network --disable-doc --disable-debug \
  --disable-shared --enable-static --enable-small --disable-ffprobe --enable-ffmpeg \
  --enable-gpl --enable-libx264 --enable-encoder=libx264 --enable-decoder=rawvideo \
  --enable-demuxer=rawvideo --enable-muxer=h264 --enable-protocol=pipe \
  --enable-filter=scale,format,setsar,pad,crop --enable-swscale \
  --extra-cflags='-O2 -I../prefix/include -mmacosx-version-min=15.0' \
  --extra-ldflags='-L../prefix/lib -mmacosx-version-min=15.0'
make -j"$jobs" ffmpeg
cp ffmpeg "$output/ffmpeg/ffmpeg"
cp COPYING.GPLv2 "$output/licenses/FFmpeg-COPYING.GPLv2.txt"
cp COPYING.GPLv3 "$output/licenses/FFmpeg-COPYING.GPLv3.txt"
cp LICENSE.md "$output/licenses/FFmpeg-LICENSE.md"
cp ffbuild/config.mak "$output/source/ffmpeg-config.mak"

cd "../libusb-$libusb_version"
# Only the system IOKit/CoreFoundation/Security frameworks are linked. No system
# package-manager libusb path is retained in the packaged dynamic library.
PKG_CONFIG_LIBDIR= PKG_CONFIG_PATH= CFLAGS='-O2 -mmacosx-version-min=15.0' \
  LDFLAGS='-mmacosx-version-min=15.0' ./configure --prefix=/usr/local --host="$host" \
  --disable-static --enable-shared --disable-examples-build --disable-tests-build
make -j"$jobs"
cp libusb/.libs/libusb-1.0.0.dylib "$output/libusb/libusb-1.0.0.dylib"
install_name_tool -id '@rpath/libusb-1.0.0.dylib' "$output/libusb/libusb-1.0.0.dylib"
cp COPYING "$output/licenses/libusb-COPYING.txt"
cp "$project_root/scripts/build-macos-stream-resources.sh" "$output/source/build-macos-stream-resources.sh"

for binary in "$output/ffmpeg/ffmpeg" "$output/libusb/libusb-1.0.0.dylib"; do
  # The first dylib line is its own ID. Every actual dependency must be a system
  # library/framework; a Homebrew path would break on another user's computer.
  while IFS= read -r dependency; do
    case "$dependency" in
      /usr/lib/*|/System/Library/*|@rpath/libusb-1.0.0.dylib) ;;
      *) echo "Unexpected runtime dependency in $binary: $dependency" >&2; exit 1 ;;
    esac
  done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
  codesign --force --sign - --timestamp=none "$binary"
  codesign --verify --strict "$binary"
done
"$output/ffmpeg/ffmpeg" -hide_banner -encoders 2>&1 | grep -q libx264
"$output/ffmpeg/ffmpeg" -version > "$output/source/ffmpeg-version-buildconf.txt"
{
  printf 'AI Watch native macOS %s streaming resources; deployment target 15.0\n' "$arch"
  printf 'FFmpeg: %s (%s)\nx264: %s (%s)\nlibusb: %s (%s)\n' "$ffmpeg_version" "$ffmpeg_sha256" "$x264_commit" "$x264_sha256" "$libusb_version" "$libusb_sha256"
  printf '\nComplete upstream archives, license files, configure records and this build recipe accompany the binaries.\n'
  printf 'Rebuild on the matching native macOS architecture: bash scripts/build-macos-stream-resources.sh\n'
  printf 'Build tools: Xcode command-line tools, make, pkg-config, nasm, Python 3, curl, tar.\n\n'
  "$CC" --version
  xcrun --show-sdk-version
} > "$output/source/BUILD-INFO.txt"
python3 - "$output" "$arch" <<'PY'
import hashlib, json, pathlib, sys
root, arch = pathlib.Path(sys.argv[1]), sys.argv[2]
(root / 'resources-manifest.json').write_text(json.dumps({'platform': 'darwin', 'arch': arch, 'minimumMacOS': '15.0'}, indent=2) + '\n')
files = sorted(path for path in root.rglob('*') if path.is_file() and path.name != 'SHA256SUMS.txt')
(root / 'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}\n' for path in files))
PY
echo "Built native macOS $arch streaming resources and corresponding source."
