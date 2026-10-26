"""Portable tests for the native Mac resource integrity gates (no USB or compiler)."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import macos_stream_support as support


class MacBuildResourcesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def checksum_file(self, extra=""):
        names = (*support.RUNTIME_FILES, *support.REQUIRED_MATERIALS)
        for name in names:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(name, encoding="utf-8")
        (self.root / "resources-manifest.json").write_text(json.dumps({"platform": "darwin", "arch": "arm64", "minimumMacOS": "15.0"}))
        file = self.root / "SHA256SUMS.txt"
        file.write_text("".join(f"{support.digest(self.root / name)}  {name}\n" for name in names) + extra)
        return file

    def test_resources_detect_changed_binary_even_with_valid_manifest(self):
        self.checksum_file()
        with patch.object(support, "verify_source_archives"):
            support.verify_resource_bundle(self.root, "arm64")
            (self.root / "libusb/libusb-1.0.0.dylib").write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                support.verify_resource_bundle(self.root, "arm64")

    def test_checksums_reject_traversal_absolute_and_duplicate_paths(self):
        for name in ("../escape", "/escape", "C:/escape", "source\\escape", "ffmpeg/ffmpeg"):
            with self.subTest(name=name):
                file = self.checksum_file(f"{'0' * 64}  {name}\n")
                with self.assertRaisesRegex(ValueError, "Unsafe or duplicate"):
                    support.checksums(file)

    def test_rejects_wrong_architecture_and_pre_15_deployment_target(self):
        self.checksum_file()
        with self.assertRaisesRegex(ValueError, "native architecture"):
            support.verify_resource_bundle(self.root, "x64")
        (self.root / "resources-manifest.json").write_text(json.dumps({"platform": "darwin", "arch": "arm64", "minimumMacOS": "14.0"}))
        with self.assertRaisesRegex(ValueError, "deployment target"):
            support.verify_resource_bundle(self.root, "arm64")

    def test_unpinned_source_archive_fails(self):
        self.checksum_file()
        with self.assertRaisesRegex(ValueError, "Pinned upstream source mismatch"):
            support.verify_source_archives(self.root / "source")

    def test_external_homebrew_dependency_is_rejected(self):
        with patch.object(support.subprocess, "check_output", side_effect=["arm64\n", "libusb:\n\t/opt/homebrew/lib/libusb.dylib (compatibility version 1)\n"]), patch.object(support.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "Unbundled runtime dependency"):
                support.verify_native_binary(self.root / "libusb-1.0.0.dylib", "arm64")
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
