import contextlib
import io
import json
import unittest
from pathlib import Path
import sys
import threading
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
        for value in (147, 148, 149, 152, 153, 212):
            adb = self.fake_adb([str(value), str(value)])
            with self.subTest(value=value), patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report"), patch.object(brightness.time, "monotonic", side_effect=[0, 4]):
                with self.assertRaisesRegex(RuntimeError, "未确认背光生效"):
                    brightness.set_brightness(adb, 60)

    def test_hardware_upward_quantization_is_accepted_without_adjacent_false_success(self):
        for percent, actual in ((40, 100), (40, 101), (20, 50), (20, 51), (60, 150), (60, 151), (1, 0), (1, 1)):
            adb = self.fake_adb(["212", str(actual)])
            with self.subTest(percent=percent, actual=actual), patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report"):
                self.assertEqual(brightness.set_brightness(adb, percent), {"brightness": percent, "applied": True})
        for percent, actual in ((40, 99), (40, 102), (20, 49), (20, 52), (60, 149), (60, 152), (1, 2)):
            adb = self.fake_adb([str(actual), str(actual)])
            with self.subTest(percent=percent, actual=actual), patch.object(ryuo4, "discover", return_value="screen-example"), patch.object(brightness.ryuo_hid, "send_report"), patch.object(brightness.time, "monotonic", side_effect=[0, 4]):
                with self.assertRaisesRegex(RuntimeError, "未确认背光生效"):
                    brightness.set_brightness(adb, percent)

    def test_cli_brightness_mode_is_device_specific_and_never_starts_a_session(self):
        for device, code in (("ryuo4", 0), ("zhanyu", 1)):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), patch.object(bridge, "usb_platform_error", return_value=None), patch.object(ryuo4, "adb_path", return_value="example-adb"), patch.object(brightness, "set_brightness", return_value={"brightness": 60, "applied": True}) as apply, patch.object(bridge, "RyuoPanelStreamSession") as stream:
                self.assertEqual(bridge.main(["--device", device, "--brightness", "60"]), code)
                self.assertEqual(apply.call_count, int(code == 0))
                stream.assert_not_called()
                result = json.loads(output.getvalue())
                self.assertEqual(result["type"], "brightness" if code == 0 else "error")

    def test_hold_commands_are_bounded_single_integer_updates(self):
        self.assertEqual(brightness._parse_command(b'{"brightness":60}\n'), 60)
        self.assertEqual(brightness._parse_command('{"brightness":100}\r\n'), 100)
        for command in (b'{"brightness":60}', b'{"brightness":true}\n', b'{"brightness":1.5}\n',
                        b'{"brightness":0}\n', b'{"brightness":101}\n', b'{"brightness":"60"}\n',
                        b'{"brightness":60,"brightness":50}\n', b'{"brightness":60,"serial":"other"}\n',
                        b'[{"brightness":60}]\n', b'null\n', b'\xff\n', b'x' * 257 + b'\n'):
            with self.subTest(command=command[:80]), self.assertRaises(ValueError):
                brightness._parse_command(command)

    def test_input_eof_cancels_and_oversized_input_is_never_read_unbounded(self):
        stop = threading.Event()
        incoming = brightness._BrightnessInput(io.BytesIO(b""), stop)
        incoming._read()
        self.assertTrue(stop.is_set())
        source = Mock()
        source.readline.return_value = b"x" * 257
        stop = threading.Event()
        incoming = brightness._BrightnessInput(source, stop)
        incoming._read()
        source.readline.assert_called_once_with(257)
        with self.assertRaisesRegex(ValueError, "参数无效"):
            incoming.take()

    def hold_fixture(self, *, updates=(), stop_at=6.2, fail_write=False):
        clock = [0.0]
        stop = threading.Event()
        events, writes, applied = [], [], []
        pending = list(updates)
        class Input:
            def start(self):
                pass
            def take(self):
                if pending and clock[0] + 0.00001 >= pending[0][0]:
                    return pending.pop(0)[1]
                return None
            def wait(self, seconds):
                clock[0] += min(seconds, 0.1)
                if clock[0] >= stop_at:
                    stop.set()
        def apply(adb, serial, value, cancel):
            self.assertIs(cancel, stop)
            applied.append((clock[0], serial, value))
            return {"brightness": value, "applied": True}
        def send(serial, frame):
            value = json.loads(frame[3:-2].split(b"\r\n\r\n")[1])["value"]
            writes.append((clock[0], serial, value))
            if fail_write:
                raise RuntimeError("HID disconnected")
        return clock, stop, events, writes, applied, Input(), apply, send

    def run_hold_fixture(self, fixture):
        clock, stop, events, writes, applied, incoming, apply, send = fixture
        with patch.object(brightness.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(brightness, "_BrightnessInput", return_value=incoming), \
             patch.object(brightness, "_apply_brightness", side_effect=apply), \
             patch.object(ryuo4, "discover", return_value="screen-example") as discover, \
             patch.object(brightness.ryuo_hid, "send_report", side_effect=send):
            try:
                brightness.hold_brightness(Mock(), 60, lambda kind, data: events.append((clock[0], kind, data)), None, stop)
            finally:
                discover.assert_called_once()

    def test_hold_sends_every_two_seconds_beyond_five_seconds_to_one_bound_serial(self):
        fixture = self.hold_fixture()
        self.run_hold_fixture(fixture)
        clock, stop, events, writes, applied, *_ = fixture
        self.assertTrue(stop.is_set())
        self.assertGreaterEqual(clock[0], 6)
        self.assertEqual(len(applied), 1)
        self.assertEqual(len(writes), 3)
        for index, (stamp, serial, value) in enumerate(writes, 1):
            self.assertAlmostEqual(stamp, index * 2, places=5)
            self.assertEqual((serial, value), ("screen-example", 60))
        self.assertEqual(events[0][1:], ("brightness", {"brightness": 60, "applied": True, "holding": True}))
        self.assertEqual([event[1] for event in events[1:]], ["brightness-heartbeat"] * 3)

    def test_update_is_acknowledged_before_next_tick_and_old_target_never_returns(self):
        fixture = self.hold_fixture(updates=[(0.5, 80)], stop_at=5.1)
        self.run_hold_fixture(fixture)
        _, _, events, writes, applied, *_ = fixture
        self.assertEqual([item[2] for item in applied], [60, 80])
        self.assertLessEqual(applied[1][0], 0.6)
        self.assertEqual([item[2] for item in writes], [80, 80])
        acks = [event for event in events if event[1] == "brightness"]
        self.assertEqual([event[2]["brightness"] for event in acks], [60, 80])

    def test_stop_before_next_tick_and_before_start_produces_no_heartbeat(self):
        fixture = self.hold_fixture(stop_at=0.4)
        self.run_hold_fixture(fixture)
        self.assertEqual(fixture[3], [])
        stop = threading.Event()
        stop.set()
        with patch.object(ryuo4, "discover") as discover, patch.object(brightness.ryuo_hid, "send_report") as send:
            brightness.hold_brightness(Mock(), 60, Mock(), io.BytesIO(), stop)
            discover.assert_not_called()
            send.assert_not_called()

    def test_hid_failure_ends_hold_and_propagates_without_rediscovery(self):
        fixture = self.hold_fixture(fail_write=True)
        with self.assertRaisesRegex(RuntimeError, "HID disconnected"):
            self.run_hold_fixture(fixture)
        self.assertTrue(fixture[1].is_set())
        self.assertEqual(len(fixture[3]), 1)
        self.assertEqual(len(fixture[2]), 1, 'a failed heartbeat must not be acknowledged')

    def test_input_error_propagates_and_a_cancel_during_readback_prevents_a_write(self):
        fixture = self.hold_fixture()
        fixture[5].take = Mock(side_effect=ValueError("invalid brightness command"))
        with self.assertRaisesRegex(ValueError, "invalid brightness command"):
            self.run_hold_fixture(fixture)
        self.assertTrue(fixture[1].is_set())
        self.assertEqual(fixture[3], [])
        stop = threading.Event()
        adb = self.fake_adb(["50"])
        original = adb.shell.side_effect
        def cancel_on_activity(serial, *args):
            result = original(serial, *args)
            if args[0] == "dumpsys":
                stop.set()
            return result
        adb.shell.side_effect = cancel_on_activity
        with patch.object(brightness.ryuo_hid, "send_report") as send:
            with self.assertRaises(brightness._Stopped):
                brightness._apply_brightness(adb, "screen-example", 60, stop)
            send.assert_not_called()

    def test_hold_cli_validates_mode_and_reports_worker_errors(self):
        for args in (["--hold"], ["--device", "ryuo4", "--check", "--hold"],
                     ["--device", "zhanyu", "--brightness", "60", "--hold"]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), patch.object(ryuo4, "adb_path") as adb:
                with self.assertRaises(SystemExit) as error:
                    bridge.main(args)
                self.assertEqual(error.exception.code, 2)
                adb.assert_not_called()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(bridge, "usb_platform_error", return_value=None), \
             patch.object(ryuo4, "adb_path", return_value="example-adb"), \
             patch.object(brightness, "hold_brightness", side_effect=RuntimeError("HID disconnected")) as hold, \
             patch.object(brightness, "set_brightness") as one_shot, patch.object(bridge, "RyuoPanelStreamSession") as session:
            self.assertEqual(bridge.main(["--device", "ryuo4", "--brightness", "60", "--hold"]), 1)
            hold.assert_called_once()
            self.assertEqual(hold.call_args.args[1], 60)
            self.assertEqual(json.loads(output.getvalue()), {"type": "error", "data": "HID disconnected"})
            one_shot.assert_not_called()
            session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
