#!/usr/bin/env python3
"""Check the installed native bridge and real H.264 encoding without opening USB."""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

from macos_stream_support import (RUNTIME_FILES, checksums, digest, require_native_macos,
                                 validate_manifest, verify_daemon, verify_native_binary,
                                 verify_python_binaries, verify_source_archives)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-root", type=Path, required=True)
    args = parser.parse_args(argv)
    root = args.bridge_root.resolve(strict=True)
    arch = require_native_macos()
    validate_manifest(root / "build-manifest.json", arch)
    material = root / "source" / "native"
    validate_manifest(material / "resources-manifest.json", arch)
    expected = checksums(material / "RESOURCE-SHA256SUMS.txt")
    for name, sha in expected.items():
        if name in RUNTIME_FILES:
            # App signing may replace the embedded code signature. Verify their
            # architecture, dependencies, code signature and behavior below.
            continue
        if name.startswith("source/"):
            target = material / name.removeprefix("source/")
        elif name.startswith("licenses/"):
            target = root / "licenses" / "native" / name.removeprefix("licenses/")
        elif name == "resources-manifest.json":
            target = material / name
        else:
            raise ValueError(f"Unexpected packaged material: {name}")
        if not target.resolve().is_relative_to(root) or digest(target) != sha:
            raise ValueError(f"Packaged source or license checksum mismatch: {name}")
    verify_source_archives(material)
    helper = root / "XANALI-Panel-Bridge"
    runtime = root / "_internal" / "resources"
    verify_daemon(runtime / "streamd-arm64")
    verify_native_binary(helper, arch)
    for name in RUNTIME_FILES:
        verify_native_binary(runtime / name, arch)
    adb = runtime / "adb" / "adb"
    if adb.exists():
        verify_native_binary(adb, arch, allow_universal=True)
    verify_python_binaries(root / "_internal", arch)
    subprocess.run([str(helper), "--check"], check=True)
    smoke = Path(__file__).resolve().parent.parent / "screen-bridge" / "tests" / "smoke_panel_stream_bridge.py"
    if not smoke.is_file():
        smoke = root / "source" / "screen-bridge" / "tests" / "smoke_panel_stream_bridge.py"
    subprocess.run([sys.executable, str(smoke), "--bridge", str(helper)], check=True)
    subprocess.run([sys.executable, str(smoke), "--bridge", str(helper), "--device", "ryuo4",
                    "--width", "2240", "--height", "1080", "--fps", "30", "--bitrate-mbps", "6"], check=True)
    print(f"Native macOS {arch} bridge, sources, signatures and no-USB encoding verified.")


if __name__ == "__main__":
    main()
