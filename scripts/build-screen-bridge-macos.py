#!/usr/bin/env python3
"""Build the native macOS 15+ helper and all of its portable runtime resources."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from macos_stream_support import (require_native_macos, sign_python_frameworks, verify_daemon,
                                 verify_native_binary, verify_resource_bundle)
from optional_adb_resources import adb_input_directory, copy_optional_adb

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "screen-bridge"
BUILD = ROOT / ".local" / "screen-bridge"
BUNDLE = BUILD / "XANALI-Panel-Bridge"


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def copy_rebuild_sources(repository, resources, bundle):
    """Keep the repository layout so the supplied build scripts run unchanged."""
    source = repository / "screen-bridge"
    packaged_source = bundle / "source"
    bridge_source = packaged_source / "screen-bridge"
    for relative in ("app", "tools/poc", "tools/streamd", "tests"):
        target = bridge_source / relative
        target.mkdir(parents=True, exist_ok=True)
        for path in (source / relative).iterdir():
            if path.is_file() and (path.suffix in (".py", ".go", ".md") or path.name == "go.mod"):
                shutil.copy2(path, target)
    for name in ("README.md", "requirements-macos.txt", "THIRD-PARTY-NOTICES.md"):
        shutil.copy2(source / name, bridge_source / name)
    shutil.copytree(source / "licenses", bridge_source / "licenses", dirs_exist_ok=True)
    scripts = packaged_source / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    for name in ("build-screen-bridge-macos.py", "build-macos-stream-resources.sh",
                 "macos_stream_support.py", "optional_adb_resources.py", "verify-release-screen-bridge-macos.py"):
        shutil.copy2(repository / "scripts" / name, scripts / name)
    shutil.copytree(resources / "source", packaged_source / "native", dirs_exist_ok=True)
    shutil.copy2(resources / "resources-manifest.json", packaged_source / "native" / "resources-manifest.json")
    shutil.copy2(resources / "SHA256SUMS.txt", packaged_source / "native" / "RESOURCE-SHA256SUMS.txt")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources-dir", type=Path, help="A complete native resource bundle made by build-macos-stream-resources.sh")
    parser.add_argument("--rebuild-resources", action="store_true")
    parser.add_argument("--skip-dependencies", action="store_true")
    parser.add_argument("--adb-dir", type=Path, help="Optional native Android platform-tools directory for RYUO IV")
    args = parser.parse_args(argv)
    arch = require_native_macos()
    if sys.version_info[:2] != (3, 13):
        raise RuntimeError("Use native Python 3.13 to build the reproducible macOS bridge.")
    resources = (args.resources_dir or ROOT / ".local" / "macos-stream-resources" / arch).resolve()
    if args.rebuild_resources or not resources.exists():
        if args.resources_dir:
            raise ValueError("Prepare the supplied resource directory before building the bridge.")
        run("bash", ROOT / "scripts" / "build-macos-stream-resources.sh")
    verify_resource_bundle(resources, arch)
    for name in ("ffmpeg/ffmpeg", "libusb/libusb-1.0.0.dylib"):
        verify_native_binary(resources / name, arch)
    muxers = subprocess.check_output([str(resources / "ffmpeg" / "ffmpeg"), "-hide_banner", "-muxers"], text=True)
    if "mpegts" not in muxers.split():
        raise RuntimeError("Rebuild streaming resources with MPEG-TS support: use --rebuild-resources.")
    encoders = subprocess.check_output([str(resources / "ffmpeg" / "ffmpeg"), "-hide_banner", "-encoders"], text=True)
    if "libx265" not in encoders.split():
        raise RuntimeError("Rebuild streaming resources with HEVC/libx265 support: use --rebuild-resources.")
    adb_directory = adb_input_directory(SOURCE, args.adb_dir)

    BUILD.mkdir(parents=True, exist_ok=True)
    venv = ROOT / ".local" / "screen-bridge-venv"
    python = venv / "bin" / "python"
    if not python.is_file():
        run(sys.executable, "-m", "venv", venv)
    check_python = "import platform,sys; assert sys.version_info[:2] == (3,13); assert platform.machine() == sys.argv[1], 'Use a native matching Python environment'"
    run(python, "-c", check_python, "arm64" if arch == "arm64" else "x86_64")
    if not args.skip_dependencies:
        run(python, "-m", "pip", "install", "--disable-pip-version-check", "-r", SOURCE / "requirements-macos.txt")

    # The device CPU is ARM64 on both Intel and Apple Silicon host computers.
    daemon = SOURCE / "resources" / "streamd-arm64"
    daemon.parent.mkdir(parents=True, exist_ok=True)
    go_env = {**os.environ, "GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"}
    run("go", "build", "-trimpath", "-ldflags", "-s -w", "-o", daemon, ".", cwd=SOURCE / "tools" / "streamd", env=go_env)
    verify_daemon(daemon)
    work = BUILD / f"pyinstaller-macos-{arch}"
    env = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": "15.0"}
    run(python, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console", "--noupx",
        "--name", "XANALI-Panel-Bridge", "--distpath", BUILD, "--workpath", work, "--specpath", work,
        # PyInstaller's default ad-hoc signing does not enable hardened runtime.
        # An explicit '-' identity would enable it without helper entitlements.
        "--target-architecture", "arm64" if arch == "arm64" else "x86_64",
        "--paths", SOURCE / "app", "--paths", SOURCE / "tools" / "poc",
        "--hidden-import", "kanali_stream", "--hidden-import", "deploy_streamd", "--hidden-import", "usb_macos",
        "--exclude-module", "usb_windows", "--exclude-module", "tkinter", "--exclude-module", "_tkinter",
        "--add-data", f"{daemon}:resources", SOURCE / "app" / "panel_stream_bridge.py", env=env)
    sign_python_frameworks(BUNDLE / "_internal")

    # Copy these after PyInstaller's analysis. The backend loads the explicit
    # bundled path; FFmpeg is a separate process. Neither needs a Homebrew path.
    internal = BUNDLE / "_internal" / "resources"
    for name in ("ffmpeg", "libusb"):
        shutil.copytree(resources / name, internal / name, dirs_exist_ok=True)
    copy_optional_adb(adb_directory, BUNDLE, "darwin", arch)
    copy_rebuild_sources(ROOT, resources, BUNDLE)
    shutil.copytree(SOURCE / "licenses", BUNDLE / "licenses", dirs_exist_ok=True)
    shutil.copytree(resources / "licenses", BUNDLE / "licenses" / "native", dirs_exist_ok=True)
    shutil.copy2(SOURCE / "THIRD-PARTY-NOTICES.md", BUNDLE / "THIRD-PARTY-NOTICES.md")

    # Keep the actual Python runtime and installed dependency license files.
    metadata = json.loads(subprocess.check_output([str(python), "-c",
        "import importlib.metadata as m,json,sys,sysconfig; print(json.dumps({'base':sys.base_prefix,'stdlib':sysconfig.get_path('stdlib'),'distributions':[str(d._path) for d in m.distributions()]}))"], text=True))
    python_license = next((path for path in (Path(metadata["base"]) / "LICENSE.txt", Path(metadata["stdlib"]) / "LICENSE.txt", Path(metadata["base"]) / "LICENSE") if path.is_file()), None)
    if python_license is None:
        raise FileNotFoundError("The Python runtime license is missing from this interpreter installation.")
    shutil.copy2(python_license, BUNDLE / "licenses" / "Python-LICENSE.txt")
    for location in metadata["distributions"]:
        distribution = Path(location)
        for path in distribution.iterdir():
            if path.name.lower() not in ("license", "license.txt", "license.md", "copying", "notice", "licenses"):
                continue
            target = BUNDLE / "licenses" / distribution.name
            target.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path, target / path.name, dirs_exist_ok=True)
            else:
                shutil.copy2(path, target / path.name)
    (BUNDLE / "build-manifest.json").write_text(json.dumps({"platform": "darwin", "arch": arch, "minimumMacOS": "15.0"}, indent=2) + "\n", encoding="utf-8")
    run(sys.executable, ROOT / "scripts" / "verify-release-screen-bridge-macos.py", "--bridge-root", BUNDLE)
    print(f"Packaged native macOS {arch} display bridge: {BUNDLE}")


if __name__ == "__main__":
    main()
