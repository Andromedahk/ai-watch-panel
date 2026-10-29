"""Portable optional ADB packaging checks; never launch ADB or connect USB."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import optional_adb_resources as packaging
import macos_stream_support as support


class OptionalAdbResourcesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.source = self.root / "platform-tools"
        self.source.mkdir()
        self.bundle = self.root / "bundle"

    def test_absent_optional_input_does_not_disable_existing_bridge_builds(self):
        self.assertIsNone(packaging.adb_input_directory(self.root, env={}))
        self.assertFalse(packaging.copy_optional_adb(None, self.bundle, "darwin", "arm64"))
        self.assertFalse(self.bundle.exists())

    def test_explicit_input_overrides_environment_and_missing_inputs_fail(self):
        adb = self.source / "adb"
        adb.write_bytes(b"synthetic-adb")
        self.assertEqual(packaging.adb_input_directory(self.root, self.source, {"RYUO_ADB_DIR": "missing"}), self.source)
        self.assertEqual(packaging.adb_input_directory(self.root, env={"RYUO_ADB": str(adb)}), self.source)
        with self.assertRaises(FileNotFoundError):
            packaging.adb_input_directory(self.root, env={"RYUO_ADB_DIR": str(self.root / "missing")})

    def test_windows_requires_companion_dlls_and_copies_only_runtime_and_notices(self):
        (self.source / "adb.exe").write_bytes(b"synthetic-adb")
        (self.source / "AdbWinApi.dll").write_bytes(b"synthetic-dll")
        with self.assertRaisesRegex(FileNotFoundError, "AdbWinUsbApi.dll"):
            packaging.copy_optional_adb(self.source, self.bundle, "win32")
        self.assertFalse(self.bundle.exists(), "Incomplete inputs cannot leave a partial ADB runtime")
        (self.source / "AdbWinUsbApi.dll").write_bytes(b"synthetic-dll")
        (self.source / "NOTICE.txt").write_text("upstream notice")
        for private in ("adbkey", "adbkey.pub", "settings.json", "unrelated.exe"):
            (self.source / private).write_text("must not ship")
        self.assertTrue(packaging.copy_optional_adb(self.source, self.bundle, "win32"))
        runtime = self.bundle / "_internal" / "resources" / "adb"
        self.assertEqual({path.name for path in runtime.iterdir()}, {"adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"})
        self.assertEqual((self.bundle / "licenses" / "adb" / "NOTICE.txt").read_text(), "upstream notice")
        self.assertFalse(any(path.name == "adbkey" for path in self.bundle.rglob("*")))

    def test_mac_input_is_checked_before_copying_and_keeps_source_material(self):
        adb = self.source / "adb"
        adb.write_bytes(b"synthetic-adb")
        (self.source / "source").mkdir()
        (self.source / "source" / "build.txt").write_text("source material")
        with patch.object(support, "verify_native_binary", side_effect=ValueError("Wrong architecture")):
            with self.assertRaisesRegex(ValueError, "Wrong architecture"):
                packaging.copy_optional_adb(self.source, self.bundle, "darwin", "arm64")
        self.assertFalse(self.bundle.exists())
        with patch.object(support, "verify_native_binary") as verify:
            packaging.copy_optional_adb(self.source, self.bundle, "darwin", "arm64")
            verify.assert_called_once_with(adb, "arm64", allow_universal=True)
        self.assertEqual((self.bundle / "source" / "adb" / "build.txt").read_text(), "source material")

    def test_mac_universal_adb_requires_current_cpu_and_system_dependencies(self):
        adb = self.source / "adb"
        with patch.object(support.subprocess, "check_output", side_effect=["x86_64 arm64\n", "adb:\n\t/usr/lib/libc++.1.dylib (compatibility version 1)\n"]), \
                patch.object(support.subprocess, "run"):
            support.verify_native_binary(adb, "arm64", allow_universal=True)
        with patch.object(support.subprocess, "check_output", return_value="x86_64\n"), \
                patch.object(support.subprocess, "run") as launch:
            with self.assertRaisesRegex(ValueError, "Wrong architecture"):
                support.verify_native_binary(adb, "arm64", allow_universal=True)
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
