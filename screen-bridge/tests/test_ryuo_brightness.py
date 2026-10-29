import contextlib
import io
import json
import unittest
from pathlib import Path
import sys
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import panel_stream_bridge as bridge
from app import ryuo_brightness as brightness
from app import ryuo4


class BrightnessTests(unittest.TestCase):
    def test_frame_uses_only_dedicated_brightness_command_and_correct_lengths(self):
        for value in (1, 60, 100):
            frame = brightness.brightness_frame(value)
            self.assertEqual(frame[0], 0x5a)
            self.assertEqual(frame[-1], 0x5a)
            self.assertEqual(int.from_bytes(frame[1:3], "big"), len(frame))
            self.assertEqual(sum(frame[1:-2]) & 255, frame[-2])
            headers, body = frame[3:-2].split(b"\r\n\r\n")
            self.assertTrue(headers.startswith(b"POST brightness 1\r\n"))
            self.assertIn(f"ContentLength={len(body)}".encode(), headers)
            self.assertEqual(json.loads(body), {"value": value})
            self.assertNotIn(b"config", frame)
            self.assertNotIn(b"media", frame)
            self.assertNotIn(b"Z", frame[3:-2])

    def test_invalid_percentage_never_discovers_or_writes(self):
        for value in (None, True, False, 0, 101, -1, 2.5, "60"):
            with self.subTest(value=value), patch.object(ryuo4, "discover") as discover, patch.object(brightness.ryuo_hid, "send_report") as send:
                with self.assertRaises(ValueError):
                    brightness.set_brightness(Mock(), value)
                discover.assert_not_called()
                send.assert_not_called()

    def fake_adb(self, values):
        adb = Mock()
        values = iter(values)
        def shell(serial, *args):
            if args == ("cat", brightness.BACKLIGHT):
                return next(values)
            self.assertEqual(args, ("dumpsys", "activity", "activities"))
            return "mResumedActivity: " + ryuo4.PLAYER_PACKAGE
        adb.shell.side_effect = shell
        return adb

    def test_verified_usb_identity_and_backlight_without_media_or_lifecycle_commands(self):
        adb = self.fake_adb(["212", "212", "150"])
        with patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report") as send, patch.object(brightness.time, "sleep"):
            self.assertEqual(brightness.set_brightness(adb, 60), {"brightness": 60, "applied": True})
            self.assertEqual(send.call_args.args[0], "screen-example")
            self.assertIn(b'POST brightness 1\r\n', send.call_args.args[1])
            self.assertEqual(adb.run.call_count, 0)

    def test_no_hid_write_when_readback_unavailable(self):
        adb = self.fake_adb(["permission denied"])
        with patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report") as send:
            with self.assertRaisesRegex(RuntimeError, "背光"):
                brightness.set_brightness(adb, 60)
            send.assert_not_called()

    def test_unchanged_or_adjacent_backlight_does_not_report_success(self):
        for value in (147, 148, 149, 151, 152, 153, 212):
            adb = self.fake_adb([str(value), str(value)])
            with self.subTest(value=value), patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report"), patch.object(brightness.time, "monotonic", side_effect=[0, 4]):
                with self.assertRaisesRegex(RuntimeError, "未确认背光生效"):
                    brightness.set_brightness(adb, 60)

    def test_cli_brightness_mode_is_device_specific_and_never_starts_a_session(self):
        for device, code in (("ryuo4", 0), ("zhanyu", 1)):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), patch.object(bridge, "usb_platform_error", return_value=None), patch.object(ryuo4, "adb_path", return_value="example-adb"), patch.object(brightness, "set_brightness", return_value={"brightness": 60, "applied": True}) as apply, patch.object(bridge, "RyuoPanelStreamSession") as stream:
                self.assertEqual(bridge.main(["--device", device, "--brightness", "60"]), code)
                self.assertEqual(apply.call_count, int(code == 0))
                stream.assert_not_called()
                result = json.loads(output.getvalue())
                self.assertEqual(result["type"], "brightness" if code == 0 else "error")


if __name__ == "__main__":
    unittest.main()
