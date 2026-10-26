"""Validation shared by native macOS bridge construction and installed-package QA."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import sys

SOURCE_HASHES = {
    "ffmpeg-9.0.2.tar.xz": "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
    "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2": "6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224",
    "libusb-1.0.29.tar.bz2": "5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85",
}
RUNTIME_FILES = ("ffmpeg/ffmpeg", "libusb/libusb-1.0.0.dylib")
REQUIRED_MATERIALS = tuple(f"source/{name}" for name in SOURCE_HASHES) + (
    "source/build-macos-stream-resources.sh", "source/BUILD-INFO.txt",
    "source/ffmpeg-version-buildconf.txt", "source/ffmpeg-config.mak", "source/x264-config.mak",
    "licenses/FFmpeg-COPYING.GPLv2.txt", "licenses/FFmpeg-COPYING.GPLv3.txt",
    "licenses/FFmpeg-LICENSE.md", "licenses/x264-COPYING.txt", "licenses/libusb-COPYING.txt",
    "resources-manifest.json",
)


def native_arch() -> str:
    machine = platform.machine().lower()
    if machine == "arm64":
        return "arm64"
    if machine == "x86_64":
        return "x64"
    raise RuntimeError(f"Unsupported macOS architecture: {machine}")


def require_native_macos() -> str:
    if sys.platform != "darwin" or int(platform.mac_ver()[0].split(".")[0] or 0) < 15:
        raise RuntimeError("Build and verify this bridge on macOS 15 or later.")
    translated = subprocess.run(["sysctl", "-in", "sysctl.proc_translated"], text=True, capture_output=True)
    if translated.returncode == 0 and translated.stdout.strip() == "1":
        raise RuntimeError("Use a native shell and Python, not Rosetta.")
    return native_arch()


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def checksums(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        if not match:
            raise ValueError("Invalid resource checksum entry")
        sha, name = match.groups()
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name or name in result:
            raise ValueError("Unsafe or duplicate resource checksum path")
        result[name] = sha
    for name in (*RUNTIME_FILES, *REQUIRED_MATERIALS):
        if name not in result:
            raise ValueError(f"Missing resource checksum: {name}")
    return result


def validate_manifest(path: Path, arch: str) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("platform") != "darwin" or value.get("arch") != arch or value.get("minimumMacOS") != "15.0":
        raise ValueError("The bridge resources must match the native architecture and macOS 15 deployment target")
    return value


def verify_source_archives(source: Path) -> None:
    for name, expected in SOURCE_HASHES.items():
        if digest(source / name) != expected:
            raise ValueError(f"Pinned upstream source mismatch: {name}")


def verify_resource_bundle(root: Path, arch: str) -> None:
    validate_manifest(root / "resources-manifest.json", arch)
    for name, expected in checksums(root / "SHA256SUMS.txt").items():
        target = root / name
        if not target.is_file() or not target.resolve().is_relative_to(root.resolve()) or digest(target) != expected:
            raise ValueError(f"Resource checksum mismatch: {name}")
    verify_source_archives(root / "source")


def verify_native_architecture(path: Path, arch: str) -> None:
    expected = "arm64" if arch == "arm64" else "x86_64"
    actual = subprocess.check_output(["lipo", "-archs", str(path)], text=True).split()
    if actual != [expected]:
        raise ValueError(f"Wrong architecture in {path.name}: expected {expected}, got {actual}")


def verify_native_binary(path: Path, arch: str, *, system_dependencies_only: bool = True) -> None:
    verify_native_architecture(path, arch)
    if system_dependencies_only:
        listing = subprocess.check_output(["otool", "-L", str(path)], text=True)
        for line in listing.splitlines()[1:]:
            dependency = line.strip().split(" (", 1)[0]
            if dependency.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if dependency == "@rpath/libusb-1.0.0.dylib" and path.name == "libusb-1.0.0.dylib":
                continue  # LC_ID_DYLIB, not a third-party dependency.
            raise ValueError(f"Unbundled runtime dependency in {path.name}: {dependency}")
    subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True)


def framework_bundles(root: Path) -> list[Path]:
    """Return real framework directories inside the runtime, innermost first."""
    return sorted((path for path in root.rglob("*.framework") if path.is_dir() and not path.is_symlink()),
                  key=lambda path: (-len(path.parts), str(path)))


def verify_framework_signature(path: Path) -> None:
    # A framework's executable and resources form one signed bundle. Checking
    # only Versions/<version>/<name> loses the resource-envelope context.
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--all-architectures", str(path)], check=True)


def sign_python_frameworks(root: Path) -> None:
    """Seal PyInstaller's reconstructed frameworks after console COLLECT."""
    for framework in framework_bundles(root):
        # COLLECT signs cached Mach-O files before assembling the slim framework.
        # Sign its final Info.plist/resources as a bundle, from the inside out.
        # Do not use --deep for signing or enable hardened runtime here.
        subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(framework)], check=True)
        verify_framework_signature(framework)


def verify_python_binaries(root: Path, arch: str) -> None:
    """Check PyInstaller's native extensions/frameworks after app re-signing."""
    count = 0
    frameworks = framework_bundles(root)
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as binary:
            magic = binary.read(4)
        if magic not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
            continue
        if any(framework in path.parents for framework in frameworks):
            # Keep checking each real Mach-O's architecture, including nested
            # code. Its signature is verified through the complete bundle below.
            verify_native_architecture(path, arch)
        else:
            verify_native_binary(path, arch, system_dependencies_only=False)
        count += 1
    if not count:
        raise ValueError("The packaged Python native runtime is missing")
    for framework in frameworks:
        verify_framework_signature(framework)


def verify_daemon(path: Path) -> None:
    header = path.read_bytes()[:20]
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or header[18:20] != b"\xb7\x00":
        raise ValueError("The display daemon must be a little-endian ELF64 AArch64 executable")
