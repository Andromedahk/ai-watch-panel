import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

from app import panel_stream_bridge as bridge
from app.streaming import StreamConfig


class SmallReads:
    def __init__(self, value, limit=3):
        self.buffer, self.limit = io.BytesIO(value), limit

    def read(self, length):
        return self.buffer.read(min(length, self.limit))


class PanelBridgeTests(unittest.TestCase):
    def fake_runtime(self, root):
        (root / "ffmpeg").mkdir()
        (root / "ffmpeg" / "ffmpeg.exe").write_bytes(b"placeholder")
        (root / "ffmpeg" / "ffmpeg").write_bytes(b"placeholder")
        (root / "streamd-arm64").write_bytes(b"placeholder")

    def test_fragmented_frames_are_reassembled_and_only_latest_is_retained(self):
        stop = threading.Event()
        frames = [b"abcd" * 4, b"wxyz" * 4, b"1234" * 4]
        source = bridge.LatestFrameInput(SmallReads(b"".join(frames)), 16, stop)
        source.start()
        source.thread.join(2)
        self.assertEqual(source.snapshot(), (frames[-1], 3))
        self.assertIsNone(source.error)
        self.assertTrue(source.eof)
        self.assertTrue(stop.is_set())

    def test_incomplete_frame_stops_and_reports_failure(self):
        source = bridge.LatestFrameInput(io.BytesIO(b"incomplete"), 16, threading.Event())
        source.start()
        source.thread.join(2)
        self.assertIsInstance(source.error, ValueError)
        self.assertIsNone(source.snapshot()[0])

    def test_raw_encoder_uses_stdin_and_no_desktop_capture(self):
        args = bridge.raw_ffmpeg_command("ffmpeg.exe", StreamConfig(width=1120, height=540, fps=24))
        self.assertEqual(args[args.index("-pixel_format") + 1], "bgra")
        self.assertEqual(args[args.index("-video_size") + 1], "1120x540")
        self.assertEqual(args[args.index("-i") + 1], "pipe:0")
        self.assertIn("zerolatency", args)
        self.assertNotIn("gdigrab", args)
        self.assertNotIn("desktop", args)

    def test_missing_runtime_does_not_deploy(self):
        with tempfile.TemporaryDirectory() as directory:
            session = bridge.PanelStreamSession(StreamConfig(), directory, lambda *_: None, io.BytesIO())
            with patch.object(session, "_deploy") as deploy:
                with self.assertRaises(FileNotFoundError):
                    session.run(threading.Event())
                deploy.assert_not_called()

    @patch.object(bridge, "os", SimpleNamespace(name="nt"))
    def test_stream_error_closes_usb_and_restores_vendor(self):
        events, actions = [], []
        screen = type("Screen", (), {
            "push_end": lambda self, track: actions.append(("end", track)),
            "close": lambda self: actions.append(("close",))})()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ffmpeg").mkdir()
            (root / "ffmpeg" / "ffmpeg.exe").write_bytes(b"placeholder")
            (root / "streamd-arm64").write_bytes(b"placeholder")
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *event: events.append(event), io.BytesIO())
            def deploy(stop):
                session.takeover = True
            def broken(stop, incoming):
                session.track = 7
                raise RuntimeError("injected USB failure")
            with patch.object(bridge.LatestFrameInput, "start"), \
                 patch.object(session, "_deploy", side_effect=deploy), \
                 patch.object(session, "_raw", side_effect=broken), \
                 patch.object(bridge.streaming, "_open_device", return_value=(screen, {"app": "streamd-1.1"})), \
                 patch.object(bridge.streaming, "restore_device", return_value={"app": "vendor"}) as restore, \
                 patch.object(bridge.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "injected USB failure"):
                    session.run(threading.Event())
                restore.assert_called_once()
        self.assertEqual(actions, [("end", 7), ("close",)])
        stopped = next(data for kind, data in events if kind == "stopped")
        self.assertTrue(stopped["restored"])
        self.assertTrue(stopped["failed"])

    @patch.object(bridge, "os", SimpleNamespace(name="nt"))
    def test_cancel_before_deployment_does_not_take_over_device(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ffmpeg").mkdir()
            (root / "ffmpeg" / "ffmpeg.exe").write_bytes(b"placeholder")
            (root / "streamd-arm64").write_bytes(b"placeholder")
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *_: None, io.BytesIO())
            stop = threading.Event()
            stop.set()
            with patch.object(session, "_deploy") as deploy:
                session.run(stop)
                deploy.assert_not_called()

    @patch.object(bridge, "os", SimpleNamespace(name="nt"))
    def test_deployment_failure_restores_only_if_takeover_has_started(self):
        for takeover in (False, True):
            with self.subTest(takeover=takeover), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fake_runtime(root)
                session = bridge.PanelStreamSession(StreamConfig(), root, lambda *_: None, io.BytesIO())
                def failed_deployment(stop):
                    session.takeover = takeover
                    raise RuntimeError("deployment failed")
                with patch.object(bridge.LatestFrameInput, "start"), \
                     patch.object(session, "_deploy", side_effect=failed_deployment), \
                     patch.object(bridge.streaming, "restore_device", return_value={"app": "vendor"}) as restore, \
                     patch.object(bridge.time, "sleep"):
                    with self.assertRaisesRegex(RuntimeError, "deployment failed"):
                        session.run(threading.Event())
                    self.assertEqual(restore.call_count, int(takeover))

    @patch.object(bridge, "os", SimpleNamespace(name="nt"))
    def test_eof_after_takeover_cleans_up_without_starting_encoder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_runtime(root)
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *_: None, io.BytesIO())
            def deployed_then_disconnected(stop):
                session.takeover = True
                stop.set()
            with patch.object(bridge.LatestFrameInput, "start"), \
                 patch.object(session, "_deploy", side_effect=deployed_then_disconnected), \
                 patch.object(session, "_raw") as raw, \
                 patch.object(bridge.streaming, "restore_device", return_value={"app": "vendor"}) as restore, \
                 patch.object(bridge.time, "sleep"):
                session.run(threading.Event())
                restore.assert_called_once()
                raw.assert_not_called()

    @patch.object(bridge, "os", SimpleNamespace(name="nt"))
    def test_restore_failure_is_not_reported_as_success(self):
        events = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_runtime(root)
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *event: events.append(event), io.BytesIO())
            def cancel_after_takeover(stop):
                session.takeover = True
                stop.set()
            with patch.object(bridge.LatestFrameInput, "start"), \
                 patch.object(session, "_deploy", side_effect=cancel_after_takeover), \
                 patch.object(bridge.streaming, "restore_device", side_effect=TimeoutError("USB missing")), \
                 patch.object(bridge.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "USB missing"):
                    session.run(threading.Event())
        stopped = next(data for kind, data in events if kind == "stopped")
        self.assertTrue(stopped["failed"])
        self.assertFalse(stopped["restored"])

    def test_unsupported_platform_rejects_usb_before_reading_input_or_deploying(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_runtime(root)
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *_: None, io.BytesIO())
            # Replace only this module's platform view; changing the shared os.name
            # would also alter pathlib's native path selection on the host.
            with patch.object(bridge, "os", SimpleNamespace(name="posix")), \
                 patch.object(bridge.sys, "platform", "linux"), \
                 patch.object(bridge.LatestFrameInput, "start") as start, \
                 patch.object(session, "_deploy") as deploy:
                with self.assertRaisesRegex(RuntimeError, "需要 Windows 或 macOS 15"):
                    session.run(threading.Event())
                start.assert_not_called()
                deploy.assert_not_called()

    def test_mac_version_and_architecture_gate_before_any_usb_access(self):
        for version, machine, supported in [("14.7", "arm64", False), ("15.0", "arm64", True),
                                             ("15.1", "x86_64", True), ("26.0", "arm64", True),
                                             ("", "arm64", False), ("15.0", "i386", False)]:
            with self.subTest(version=version, machine=machine), \
                 patch.object(bridge, "os", SimpleNamespace(name="posix")), \
                 patch.object(bridge.sys, "platform", "darwin"), \
                 patch.object(bridge.platform, "mac_ver", return_value=(version, (), "")), \
                 patch.object(bridge.platform, "machine", return_value=machine):
                self.assertEqual(bridge.usb_platform_error() is None, supported)

    def test_mac_checks_library_before_starting_input_or_taking_over_device(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_runtime(root)
            protocol = Mock()
            protocol.backend_check.side_effect = RuntimeError("libusb architecture mismatch")
            session = bridge.PanelStreamSession(StreamConfig(), root, lambda *_: None, io.BytesIO())
            with patch.object(bridge, "os", SimpleNamespace(name="posix")), \
                 patch.object(bridge, "usb_platform_error", return_value=None), \
                 patch.object(bridge.streaming, "_protocol", return_value=protocol), \
                 patch.object(bridge.LatestFrameInput, "start") as start, \
                 patch.object(session, "_deploy") as deploy:
                with self.assertRaisesRegex(RuntimeError, "architecture mismatch"):
                    session.run(threading.Event())
                start.assert_not_called()
                deploy.assert_not_called()
                protocol.configure_resources.assert_called_once_with(root)
                protocol.backend_check.assert_called_once_with(root)
                protocol.Screen.assert_not_called()

    def test_mac_dry_run_encodes_without_loading_or_claiming_usb(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ffmpeg").mkdir()
            (root / "ffmpeg" / "ffmpeg").write_bytes(b"placeholder")
            with patch.object(bridge, "os", SimpleNamespace(name="posix")), \
                 patch.object(bridge.streaming, "_protocol") as protocol:
                bridge.validate_runtime(root, dry_run=True)
                protocol.assert_not_called()
                self.assertEqual(bridge.encoder_path(root), root / "ffmpeg" / "ffmpeg")

    def test_runtime_check_never_opens_a_device_and_reports_unloadable_library(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_runtime(root)
            protocol = Mock()
            for error in (None, OSError("native library missing")):
                protocol.backend_check.side_effect = error
                output = io.StringIO()
                with patch.object(bridge, "os", SimpleNamespace(name="posix")), \
                     patch.object(bridge, "usb_platform_error", return_value=None), \
                     patch.object(bridge.streaming, "_protocol", return_value=protocol), \
                     patch.object(bridge.sys, "stdout", output):
                    result = bridge.main(["--check", "--resources", str(root)])
                message = json.loads(output.getvalue())
                self.assertEqual(result, 1 if error else 0)
                self.assertEqual(message["data"]["available"], error is None)
                protocol.Screen.assert_not_called()

    def test_probe_reads_only_identity_and_closes_without_deployment(self):
        protocol = Mock()
        protocol.Screen.return_value.info.return_value = {"product": "PASE_1021", "app": "vendor", "serial": "private-example"}
        output = io.StringIO()
        with patch.object(bridge, "validate_runtime"), \
             patch.object(bridge.streaming, "_protocol", return_value=protocol), \
             patch.object(bridge.PanelStreamSession, "run") as run, \
             patch.object(bridge.sys, "stdout", output):
            self.assertEqual(bridge.main(["--probe"]), 0)
        run.assert_not_called()
        self.assertEqual(protocol.Screen.return_value.method_calls, [unittest.mock.call.info(), unittest.mock.call.close()])
        payload = json.loads(output.getvalue())
        self.assertFalse(payload["data"]["playbackStarted"])
        self.assertNotIn("serial", payload["data"]["info"])

    def test_slow_usb_applies_backpressure_without_dropping_h264_frames(self):
        stop, sixth_packet = threading.Event(), threading.Event()
        produced, consumed = [], []
        process = FakeEncoder()
        def encoded_frames(_):
            for index in range(100):
                produced.append(index)
                if index == 5:
                    sixth_packet.set()
                yield bytes([index])
        class Screen:
            def push_begin(self, *args): return 1
            def push_frame(self, track, packet):
                consumed.append(packet)
                if not sixth_packet.wait(2):
                    raise AssertionError("encoder did not fill bounded queue")
                # The USB consumer is stalled while encoder output has filled up.
                time.sleep(0.05)
                stop.set()
            def read_frames(self, **kwargs): return []
        config = StreamConfig(width=64, height=64)
        session = bridge.PanelStreamSession(config, Path("."), lambda *_: None, io.BytesIO())
        session.sc = Screen()
        session.started = session.last_stats = time.monotonic()
        incoming = bridge.LatestFrameInput(io.BytesIO(), 64 * 64 * 4, stop)
        with patch.object(bridge.subprocess, "Popen", return_value=process), \
             patch.object(bridge.streaming, "iter_h264_aus", side_effect=encoded_frames):
            session._raw(stop, incoming)
        self.assertEqual(consumed, [b"\x00"])
        self.assertLessEqual(len(produced), 6, "slow USB must backpressure the encoder")
        self.assertTrue(process.terminated)

    def test_cancel_unblocks_a_blocked_encoder_input_and_joins_workers(self):
        stop, writing, terminated = threading.Event(), threading.Event(), threading.Event()
        class BlockedInput(io.BytesIO):
            def write(self, data):
                writing.set()
                if not terminated.wait(3):
                    raise AssertionError("blocked encoder write was not released")
                raise BrokenPipeError("encoder terminated")
        class StopWhenWriting(io.BytesIO):
            def read(self, size):
                if not writing.wait(2):
                    raise AssertionError("encoder input was never written")
                stop.set()
                return b""
        process = FakeEncoder(stdin=BlockedInput(), stdout=StopWhenWriting(), terminated=terminated)
        config = StreamConfig(width=64, height=64)
        session = bridge.PanelStreamSession(config, Path("."), lambda *_: None, io.BytesIO(), dry_run=True)
        incoming = bridge.LatestFrameInput(io.BytesIO(), 64 * 64 * 4, stop)
        incoming.latest = b"\0" * incoming.frame_bytes
        incoming.available.set()
        before = set(threading.enumerate())
        with patch.object(bridge.subprocess, "Popen", return_value=process):
            session._raw(stop, incoming)
        self.assertTrue(writing.is_set())
        self.assertTrue(process.terminated)
        self.assertTrue(process.stdin.closed)
        self.assertFalse([thread for thread in threading.enumerate() if thread not in before
                          and thread.name.startswith("panel-")])

    def test_interpreter_exits_cleanly_when_input_pipe_stays_open_on_failure(self):
        # Regression: BufferedReader held by the input daemon crashed CPython at
        # shutdown after an encoder/USB error while the parent's pipe stayed open.
        code = ("import sys,time,threading; from app.panel_stream_bridge import LatestFrameInput,unbuffered_input; "
                "source=LatestFrameInput(unbuffered_input(sys.stdin.buffer),16,threading.Event()); "
                "source.start(); time.sleep(0.1)")
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=str(Path(__file__).resolve().parent.parent))
        try:
            self.assertEqual(proc.wait(timeout=6), 0)
            self.assertEqual(proc.stderr.read(), b"")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                pipe.close()

    def test_frozen_runtime_resolves_bundled_resources(self):
        with patch.object(bridge.sys, "frozen", True, create=True), \
             patch.object(bridge.sys, "_MEIPASS", "bundle-runtime", create=True):
            self.assertEqual(bridge.default_resources(), Path("bundle-runtime") / "resources")


class FakeEncoder:
    def __init__(self, stdin=None, stdout=None, terminated=None):
        self.stdin = stdin if stdin is not None else io.BytesIO()
        self.stdout = stdout if stdout is not None else io.BytesIO()
        self.stderr = io.BytesIO()
        self.terminated = False
        self.terminated_event = terminated

    def poll(self):
        return 0 if self.terminated else None

    def terminate(self):
        self.terminated = True
        if self.terminated_event:
            self.terminated_event.set()

    def kill(self):
        self.terminate()

    def wait(self, timeout=None):
        return 0


if __name__ == "__main__":
    unittest.main()
