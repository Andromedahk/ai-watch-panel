"""Copy explicitly supplied Android platform-tools into an optional bridge runtime.

Only adb and its required Windows libraries are runtime inputs. Never collect
the user's ADB keys, configuration, other SDK tools, or the local screen project.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil


def adb_input_directory(source_root: Path, explicit=None, env=None):
    env = os.environ if env is None else env
    supplied = explicit or env.get("RYUO_ADB_DIR") or env.get("RYUO_ADB")
    if supplied:
        path = Path(supplied).expanduser().resolve(strict=True)
        return path.parent if path.is_file() else path
    default = source_root / "resources" / "adb"
    return default if default.is_dir() else None


def copy_optional_adb(source, bundle: Path, platform: str, arch=None):
    if source is None:
        return False
    source = Path(source).resolve(strict=True)
    if not source.is_dir():
        raise ValueError("Supply an Android platform-tools directory containing adb.")
    if source.is_relative_to(bundle.resolve()):
        raise ValueError("Keep ADB inputs outside the generated bridge bundle.")
    names = ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll") if platform == "win32" else ("adb",)
    for name in names:
        if not (source / name).is_file():
            raise FileNotFoundError(f"The supplied ADB runtime is incomplete: {name}")
    if platform == "darwin":
        from macos_stream_support import verify_native_binary
        verify_native_binary(source / "adb", arch, allow_universal=True)
    target = bundle / "_internal" / "resources" / "adb"
    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copy2(source / name, target / name)
    # Preserve distribution notices/source materials when the supplied runtime
    # includes them. Copy only these explicit locations, never its whole parent.
    notices = bundle / "licenses" / "adb"
    for path in source.iterdir():
        if path.is_file() and path.name.lower().startswith(("notice", "license", "copying", "source.properties")):
            notices.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, notices / path.name)
    for name, destination in (("licenses", notices), ("source", bundle / "source" / "adb")):
        if (source / name).is_dir():
            shutil.copytree(source / name, destination, dirs_exist_ok=True)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--adb-dir", type=Path)
    parser.add_argument("--platform", choices=("win32", "darwin"), required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"))
    args = parser.parse_args(argv)
    supplied = adb_input_directory(args.source_root, args.adb_dir)
    included = copy_optional_adb(supplied, args.bundle_root, args.platform, args.arch)
    print("Included optional RYUO IV ADB runtime." if included else "ADB omitted; RYUO IV is unavailable in this package.")


if __name__ == "__main__":
    main()
