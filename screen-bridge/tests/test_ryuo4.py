import io
import json
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

from app import panel_stream_bridge as bridge
from app import ryuo4
from app.streaming import StreamConfig


class FakeAdb:
    def __init__(self, devices=None):
        self.devices = devices or {"screen-example": ("device", "usb:example", ryuo4.MODEL, "RK3562", "cm16")}
        self.calls = []
        self.package = True
        self.ids = {"idVendor": "0x0b05", "idProduct": "0x1c76"}
        self.rules = "UsbFfs tcp:34567 tcp:34567"
        self.activity_error = False
        self.home_error = False
        self.foreground = ryuo4.HOME_ACTIVITY

    def run(self, *args, timeout=10):
        self.calls.append(tuple(args))
        if args == ("devices", "-l"):
            return "List of devices attached\n" + "\n".join(serial + " " + data[0] for serial, data in self.devices.items())
        if args[-1] == "get-devpath":
            return self.devices[args[1]][1]
        if args[-2:] == ("reverse", "--list"):
            return self.rules
        return ""

    def shell(self, serial, *args, timeout=10):
        self.calls.append(("shell", serial, *args))
        if args[0] == "getprop":
            index = ("ro.product.version", "ro.soc.model", "ro.product.model").index(args[1])
            return self.devices[serial][2 + index]
        if args[0] == "cat":
            value = self.ids[args[1].rsplit("/", 1)[-1]]
            if value is None:
                raise RuntimeError("not readable")
            return value
        if args[:3] == ("pm", "list", "packages"):
            return "package:" + ryuo4.PLAYER_PACKAGE if self.package else ""
        if args[:2] == ("am", "start"):
            if ryuo4.HOME_ACTIVITY in args and self.home_error:
                raise RuntimeError("device disconnected")
            return "Error type 3\nError: activity missing" if self.activity_error else "Status: ok"
        if args[:3] == ("dumpsys", "activity", "activities"):
            return "mResumedActivity: ActivityRecord{example " + self.foreground + "}"
        return ""


class RyuoDeviceTests(unittest.TestCase):
    def test_discovery_requires_usb_and_exact_target_properties(self):
        adb = FakeAdb({"phone-example": ("device", "usb:phone", "phone", "RK3562", "cm16"),
                       "network-example": ("device", "localhost:5555", ryuo4.MODEL, "RK3562", "cm16"),
                       "screen-example": ("device", "usb:target", ryuo4.MODEL, "RK3562", "cm16")})
        self.assertEqual(ryuo4.discover(adb), "screen-example")
        self.assertFalse(any("am" in call or "reverse" in call for call in adb.calls))

    def test_discovery_accepts_unreadable_usb_ids_but_rejects_known_mismatch(self):
        adb = FakeAdb()
        adb.ids = {"idVendor": None, "idProduct": None}
        self.assertEqual(ryuo4.discover(adb), "screen-example")
        adb.ids["idVendor"] = "0x1234"
        with self.assertRaisesRegex(RuntimeError, "未找到"):
            ryuo4.discover(adb)

    def test_discovery_rejects_unauthorized_multiple_or_unprepared_devices(self):
        adb = FakeAdb({"screen-example": ("unauthorized", "", "", "", "")})
        with self.assertRaisesRegex(RuntimeError, "未授权"):
            ryuo4.discover(adb)
        adb = FakeAdb()
        adb.devices["second-example"] = adb.devices["screen-example"]
        with self.assertRaisesRegex(RuntimeError, "多台"):
            ryuo4.discover(adb)
        adb = FakeAdb()
        adb.package = False
        with self.assertRaisesRegex(RuntimeError, "未预置"):
            ryuo4.discover(adb)

    def test_no_reverse_overwrite_and_cleanup_only_own_mapping_and_player(self):
        adb = FakeAdb()
        session = ryuo4.DeviceSession(adb, "screen-example")
        session.launch(34567)
        self.assertTrue(session.cleanup())
        self.assertIn(("-s", "screen-example", "reverse", "--no-rebind", "tcp:34567", "tcp:34567"), adb.calls)
        self.assertIn(("-s", "screen-example", "reverse", "--remove", "tcp:34567"), adb.calls)
        self.assertIn(("shell", "screen-example", "am", "force-stop", ryuo4.PLAYER_PACKAGE), adb.calls)
        force_stop = adb.calls.index(("shell", "screen-example", "am", "force-stop", ryuo4.PLAYER_PACKAGE))
        launch = next(index for index, call in enumerate(adb.calls) if ryuo4.PLAYER_ACTIVITY in call)
        self.assertLess(force_stop, launch, "singleTask player must read this session's URL in a new onCreate")
        self.assertFalse(any("--remove-all" in call or "kill-server" in call or "root" in call or "install" in call for call in adb.calls))

    def test_failed_player_launch_still_restores_and_removes_reverse(self):
        adb = FakeAdb()
        session = ryuo4.DeviceSession(adb, "screen-example")
        adb.activity_error = True
        with self.assertRaisesRegex(RuntimeError, "启动失败"):
            session.launch(34567)
        adb.activity_error = False
        self.assertTrue(session.cleanup())
        self.assertIn(("-s", "screen-example", "reverse", "--remove", "tcp:34567"), adb.calls)

    def test_home_restore_failure_still_removes_reverse_and_reports_failure(self):
        adb = FakeAdb()
        session = ryuo4.DeviceSession(adb, "screen-example")
        session.launch(34567)
        adb.home_error = True
        with self.assertRaisesRegex(RuntimeError, "device disconnected"):
            session.cleanup()
        self.assertIn(("-s", "screen-example", "reverse", "--remove", "tcp:34567"), adb.calls)

    def test_changed_reverse_mapping_is_preserved(self):
        adb = FakeAdb()
        session = ryuo4.DeviceSession(adb, "screen-example")
        session.launch(34567)
        adb.rules = "UsbFfs tcp:34567 tcp:55555"
        with self.assertRaisesRegex(RuntimeError, "其他程序修改"):
            session.cleanup()
        self.assertFalse(any("--remove" in call for call in adb.calls))

    def test_busy_player_is_rejected_before_reverse_or_takeover(self):
        adb = FakeAdb()
        adb.foreground = ryuo4.PLAYER_ACTIVITY
        session = ryuo4.DeviceSession(adb, "screen-example")
        with self.assertRaisesRegex(RuntimeError, "正在使用中"):
            session.launch(34567)
        self.assertFalse(session.cleanup())
        self.assertFalse(any("am" in call or "reverse" in call for call in adb.calls))

    def test_never_touched_session_has_no_cleanup_actions(self):
        adb = FakeAdb()
        self.assertFalse(ryuo4.DeviceSession(adb, "screen-example").cleanup())
        self.assertEqual(adb.calls, [])

    def test_config_enforces_native_panel_limits(self):
        self.assertEqual(ryuo4.validate_config(StreamConfig(width=2240, height=1080)).width, 2240)
        for width, height in ((2242, 1000), (1080, 1920)):
            with self.assertRaisesRegex(ValueError, "HEVC"):
                ryuo4.validate_config(StreamConfig(width=width, height=height))

    def test_packaged_adb_is_preferred_and_frozen_never_uses_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "adb").mkdir()
            binary = root / "adb" / ("adb.exe" if ryuo4.os.name == "nt" else "adb")
            binary.write_bytes(b"placeholder")
            with patch.object(ryuo4.shutil, "which") as which:
                self.assertEqual(ryuo4.adb_path(root), binary)
                which.assert_not_called()
            binary.unlink()
            with patch.object(ryuo4.sys, "frozen", True, create=True), patch.object(ryuo4.shutil, "which") as which:
                with self.assertRaisesRegex(FileNotFoundError, "ADB"):
                    ryuo4.adb_path(root)
                which.assert_not_called()

    def test_relative_adb_override_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(ryuo4.os.environ, {"RYUO_ADB": "relative/adb"}):
            with self.assertRaisesRegex(FileNotFoundError, "绝对路径"):
                ryuo4.adb_path(directory)

    def test_muxer_validation_has_actionable_error_and_does_not_start_adb(self):
        with patch.object(ryuo4.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b" E h264 Raw")) as run:
            with self.assertRaisesRegex(RuntimeError, "MPEG-TS"):
                ryuo4.validate_muxer("ffmpeg")
            self.assertEqual(run.call_args.args[0], ["ffmpeg", "-hide_banner", "-muxers"])

    def test_native_stream_requires_hevc_encoder_even_when_mpegts_exists(self):
        responses = [SimpleNamespace(returncode=0, stdout=b" E mpegts MPEG-TS"),
                     SimpleNamespace(returncode=0, stdout=b" V..... libx264")]
        with patch.object(ryuo4.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "libx265 / HEVC"):
                ryuo4.validate_muxer("ffmpeg")

    def test_loopback_http_relay_preserves_order_and_rejects_wrong_path(self):
        stop = threading.Event()
        payload = (b"\x47" + b"example" * 26 + b"12345") * 512
        relay = ryuo4.TsRelay(io.BytesIO(payload), stop)
        self.assertEqual(relay.socket.getsockname()[0], "127.0.0.1")
        relay.start()
        try:
            with socket.create_connection(("127.0.0.1", relay.port), timeout=2) as client:
                client.sendall(b"GET /private HTTP/1.1\r\nHost: localhost\r\n\r\n")
                self.assertIn(b"404", client.recv(1024))
            with socket.create_connection(("127.0.0.1", relay.port), timeout=2) as client:
                client.sendall(b"GET /live.ts HTTP/1.1\r\nHost: localhost\r\n\r\n")
                data = bytearray()
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    data.extend(chunk)
            header, actual = bytes(data).split(b"\r\n\r\n", 1)
            self.assertIn(b"video/mp2t", header)
            self.assertEqual(actual, payload)
            self.assertEqual(relay.bytes, len(payload))
        finally:
            stop.set()
            relay.close()
        self.assertFalse(relay.thread.is_alive())

    def test_relay_client_disconnect_is_reported_and_worker_exits(self):
        stop, read_entered, disconnected = threading.Event(), threading.Event(), threading.Event()
        class Output:
            def read(self, size):
                read_entered.set()
                if not disconnected.wait(2):
                    raise AssertionError("test client did not disconnect")
                return b"\x47" * size
        relay = ryuo4.TsRelay(Output(), stop)
        relay.start()
        try:
            with socket.create_connection(("127.0.0.1", relay.port), timeout=2) as client:
                client.sendall(b"GET /live.ts HTTP/1.1\r\nHost: localhost\r\n\r\n")
                self.assertTrue(read_entered.wait(2))
                self.assertIn(b"200", client.recv(1024))
                client.shutdown(socket.SHUT_RDWR)
            disconnected.set()
            relay.thread.join(timeout=3)
            self.assertFalse(relay.thread.is_alive())
            self.assertIsNotNone(relay.error)
        finally:
            stop.set()
            relay.close()


class RyuoPanelTests(unittest.TestCase):
    def runtime(self, directory):
        root = Path(directory)
        (root / "ffmpeg").mkdir()
        (root / "ffmpeg" / ("ffmpeg.exe" if bridge.os.name == "nt" else "ffmpeg")).write_bytes(b"placeholder")
        return root

    def test_mpegts_encoder_consumes_only_bgra_stdin(self):
        command = bridge.raw_ffmpeg_command("ffmpeg", StreamConfig(width=2240, height=1080, bitrate_mbps=6), "mpegts", "hevc")
        self.assertEqual(command[command.index("-i") + 1], "pipe:0")
        self.assertEqual(command[-1], "pipe:1")
        self.assertIn("mpegts", command)
        self.assertIn("libx265", command)
        self.assertNotIn("libx264", command)
        self.assertNotIn("desktop", command)

    def test_default_ryuo_parameters_are_native_30fps_6mbps(self):
        with patch.object(bridge, "RyuoPanelStreamSession") as session:
            self.assertEqual(bridge.main(["--device", "ryuo4", "--dry-run"]), 0)
        config = session.call_args.args[0]
        self.assertEqual((config.width, config.height, config.fps, config.bitrate_mbps), (2240, 1080, 30, 6))
        self.assertTrue(session.call_args.args[-1])

    def test_dry_run_never_resolves_adb_or_opens_usb_or_server(self):
        events = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ffmpeg").mkdir()
            (root / "ffmpeg" / ("ffmpeg.exe" if bridge.os.name == "nt" else "ffmpeg")).write_bytes(b"placeholder")
            session = bridge.RyuoPanelStreamSession(StreamConfig(width=1920, height=926), root,
                                                   lambda *event: events.append(event), io.BytesIO(), dry_run=True)
            with patch.object(ryuo4, "validate_muxer"), patch.object(ryuo4, "adb_path") as adb, \
                 patch.object(ryuo4, "TsRelay") as relay, patch.object(bridge.streaming, "_protocol") as usb, \
                 patch.object(bridge.LatestFrameInput, "start"), patch.object(session, "_raw"):
                session.run(threading.Event())
            adb.assert_not_called()
            relay.assert_not_called()
            usb.assert_not_called()
        stopped = next(data for kind, data in events if kind == "stopped")
        self.assertTrue(stopped["dryRun"])
        self.assertFalse(stopped["restored"])
        self.assertEqual(stopped["frameMetric"], "submitted")

    def test_check_does_not_enumerate_adb_devices(self):
        output = io.StringIO()
        with patch.object(bridge.sys, "stdout", output), patch.object(bridge, "encoder_path") as encoder, \
             patch.object(ryuo4, "validate_muxer"), patch.object(bridge, "usb_platform_error", return_value=None), \
             patch.object(ryuo4, "adb_path", return_value=Path("example-adb")), patch.object(ryuo4, "Adb") as adb:
            encoder.return_value.is_file.return_value = True
            self.assertEqual(bridge.main(["--device", "ryuo4", "--check"]), 0)
            adb.assert_not_called()
        self.assertTrue(json.loads(output.getvalue())["data"]["available"])

    def test_canceled_startup_does_not_launch_or_claim_device_resources(self):
        stop = threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            root = self.runtime(directory)
            session = bridge.RyuoPanelStreamSession(StreamConfig(width=1920, height=926), root, lambda *_: None, io.BytesIO())
            def canceled_discovery(adb):
                stop.set()
                return "screen-example"
            with patch.object(ryuo4, "validate_muxer"), patch.object(bridge, "usb_platform_error", return_value=None), \
                 patch.object(ryuo4, "adb_path", return_value=Path("example-adb")), \
                 patch.object(bridge.LatestFrameInput, "start"), patch.object(ryuo4, "discover", side_effect=canceled_discovery), \
                 patch.object(ryuo4, "DeviceSession") as device, patch.object(session, "_raw") as raw:
                session.run(stop)
            device.assert_not_called()
            raw.assert_not_called()

    def test_failed_encoder_after_launch_cleans_up_and_reports_restore_failure(self):
        events = []
        with tempfile.TemporaryDirectory() as directory:
            root = self.runtime(directory)
            session = bridge.RyuoPanelStreamSession(StreamConfig(width=1920, height=926), root,
                                                   lambda *event: events.append(event), io.BytesIO())
            device = Mock()
            device.cleanup.side_effect = RuntimeError("HomeUI recovery unconfirmed")
            with patch.object(ryuo4, "validate_muxer"), patch.object(bridge, "usb_platform_error", return_value=None), \
                 patch.object(ryuo4, "adb_path", return_value=Path("example-adb")), \
                 patch.object(bridge.LatestFrameInput, "start"), patch.object(ryuo4, "discover", return_value="screen-example"), \
                 patch.object(ryuo4, "DeviceSession", return_value=device), \
                 patch.object(session, "_raw", side_effect=RuntimeError("encoder failed")):
                with self.assertRaisesRegex(RuntimeError, "encoder failed.*HomeUI recovery unconfirmed"):
                    session.run(threading.Event())
            device.cleanup.assert_called_once()
        stopped = next(data for kind, data in events if kind == "stopped")
        self.assertFalse(stopped["restored"])
        self.assertTrue(stopped["failed"])

    def test_probe_is_read_only_and_does_not_expose_device_serial(self):
        output = io.StringIO()
        adb = FakeAdb()
        with patch.object(bridge.sys, "stdout", output), patch.object(bridge, "encoder_path") as encoder, \
             patch.object(ryuo4, "validate_muxer"), patch.object(bridge, "usb_platform_error", return_value=None), \
             patch.object(ryuo4, "adb_path", return_value=Path("example-adb")), patch.object(ryuo4, "Adb", return_value=adb), \
             patch.object(bridge.RyuoPanelStreamSession, "run") as run:
            encoder.return_value.is_file.return_value = True
            self.assertEqual(bridge.main(["--device", "ryuo4", "--probe"]), 0)
            run.assert_not_called()
        data = json.loads(output.getvalue())["data"]
        self.assertFalse(data["playbackStarted"])
        self.assertNotIn("serial", data["info"])
        self.assertNotIn("screen-example", output.getvalue())
        self.assertFalse(any("am" in call or "reverse" in call for call in adb.calls))


if __name__ == "__main__":
    unittest.main()
