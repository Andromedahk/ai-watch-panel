import io
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image
from app.streaming import (StreamConfig, StreamSession, ffmpeg_command, iter_h264_aus,
                           resize_frame, _open_device, restore_device)


class ChunkStream:
    def __init__(self, data, chunk):
        self.buffer = io.BytesIO(data)
        self.chunk = chunk
    def read(self, ignored):
        return self.buffer.read(self.chunk)


class StreamingTests(unittest.TestCase):
    def test_dimensions_and_parameters_are_validated(self):
        StreamConfig(width=2240, height=1080, fps=60).validate()
        for arguments in (dict(width=1919), dict(width=3840, height=2160), dict(fps=0),
                          dict(fps=61), dict(mode="unknown"), dict(fit="unknown"),
                          dict(quality=101), dict(tile_size=16), dict(refresh_interval=float("nan")),
                          dict(show_cursor="invalid")):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                StreamConfig(**arguments).validate()

    def test_negative_monitor_coordinates_pass_as_arguments(self):
        monitor = dict(left=-1920, top=-20, width=1920, height=1080)
        config = StreamConfig(width=1120, height=540, fps=15, show_cursor=False)
        executable = Path("D:/path with spaces/ffmpeg.exe")
        args = ffmpeg_command(executable, config, monitor)
        self.assertEqual(args[0], str(executable))
        self.assertEqual(args[args.index("-offset_x")+1], "-1920")
        self.assertEqual(args[args.index("-draw_mouse")+1], "0")
        self.assertIn("pad=1120:540", args[args.index("-vf")+1])
        self.assertEqual(args[-2:], ["h264", "pipe:1"])

    def test_aspect_modes(self):
        image = Image.new("RGB", (200, 100), "red")
        contain = resize_frame(image, StreamConfig(width=100, height=100))
        self.assertEqual(contain.getpixel((50, 0)), (0, 0, 0))
        self.assertEqual(contain.getpixel((50, 50)), (255, 0, 0))
        for mode in ("cover", "stretch"):
            result = resize_frame(image, StreamConfig(width=100, height=100, fit=mode))
            self.assertEqual(result.getpixel((0, 0)), (255, 0, 0))

    def test_access_units_survive_every_boundary_split(self):
        frames = [b"\x00\x00\x00\x01\x09\xf0\x00\x00\x00\x01\x67sps\x00\x00\x01\x65iframe",
                  b"\x00\x00\x01\x09\xf0\x00\x00\x01\x41pframe",
                  b"\x00\x00\x00\x01\x09\xf0\x00\x00\x01\x41last"]
        for chunk in range(1, 65):
            with self.subTest(chunk=chunk):
                self.assertEqual(list(iter_h264_aus(ChunkStream(b"".join(frames), chunk))), frames)

    def test_cleanup_and_restore_after_stream_error(self):
        events, stop = [], threading.Event()
        session = StreamSession(StreamConfig(mode="delta"), Path("."), lambda *args: events.append(args))
        class Screen:
            closed, ended = False, False
            def info(inner): return dict(app="streamd-1.1")
            def close(inner): inner.closed = True
            def push_end(inner, track): inner.ended = True
        screen = Screen()
        protocol = type("Protocol", (), {"Screen": lambda: screen})
        def deployed(_):
            session.takeover = True
        def broken(*_):
            session.track = 7
            raise RuntimeError("injected USB disconnect")
        with patch("app.streaming.enumerate_monitors", return_value=[dict(index=1)]), \
             patch("app.streaming._protocol", return_value=protocol), \
             patch.object(session, "_deploy", side_effect=deployed), \
             patch.object(session, "_delta", side_effect=broken), \
             patch("app.streaming.restore_device", return_value=dict(app="vendor")) as restore, \
             patch("app.streaming.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "injected USB disconnect"):
                session.run(stop)
            restore.assert_called_once()
        self.assertTrue(screen.closed)
        self.assertTrue(screen.ended)

    def test_missing_encoder_fails_before_device_takeover(self):
        with tempfile.TemporaryDirectory() as directory:
            session = StreamSession(StreamConfig(), directory, lambda *_: None)
            with patch("app.streaming.enumerate_monitors", return_value=[dict(index=1)]), \
                 patch.object(session, "_deploy") as deploy:
                with self.assertRaises(FileNotFoundError):
                    session.run(threading.Event())
                deploy.assert_not_called()

    def test_cancel_after_bootstrap_waits_for_handover_before_restoring(self):
        stop, order = threading.Event(), []
        class Screen:
            track = 0
            def info(self): return dict(app="vendor")
            def command(self, *args, **kwargs): return b""
            def close(self): order.append("close")
        screen = Screen()
        protocol = SimpleNamespace(Screen=lambda: screen, field=lambda *args: b"")
        bootstrap = SimpleNamespace(REMOTE_MEDIA="streamd.mp4.h264_2240x1080", BOOTSTRAP="#!/bin/sh\n")
        def shell(sc, command, **kwargs):
            if command.startswith("setsid"):
                order.append("launch")
                stop.set()
                return ""
            return "READY"
        def wait_handover(predicate, timeout, log=None, stop=None):
            self.assertIsNone(stop, "cancel must not interrupt detached bootstrap handover")
            order.append("handover")
            self.assertTrue(predicate("streamd-1.1"))
            return dict(app="streamd-1.1")
        def restored(*args):
            order.append("restore")
            return dict(app="vendor")
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "streamd-arm64").write_bytes(b"fake daemon")
            session = StreamSession(StreamConfig(mode="delta"), directory, lambda *_: None)
            with patch("app.streaming.enumerate_monitors", return_value=[dict(index=1)]), \
                 patch("app.streaming._protocol", return_value=protocol), \
                 patch("app.streaming.check_device", return_value=dict(app="vendor")), \
                 patch("app.streaming._shell", side_effect=shell), \
                 patch("app.streaming._wait_for_app", side_effect=wait_handover), \
                 patch("app.streaming.restore_device", side_effect=restored), \
                 patch("app.streaming.time.sleep"), \
                 patch.dict("sys.modules", {"deploy_streamd": bootstrap}), \
                 patch.object(session, "_delta") as stream:
                session.run(stop)
                stream.assert_not_called()
        self.assertLess(order.index("launch"), order.index("handover"))
        self.assertLess(order.index("handover"), order.index("restore"))

    def test_open_retries_transient_reenumeration_and_keeps_live_handle(self):
        screen = SimpleNamespace(info=lambda: dict(app="vendor"), close=lambda: self.fail("successful handle closed"))
        attempts = iter([RuntimeError("期望 1 个 PASE 屏幕，实际找到 0：[]"), OSError("disconnected"), screen])
        def open_screen():
            value = next(attempts)
            if isinstance(value, Exception): raise value
            return value
        with patch("app.streaming._protocol", return_value=SimpleNamespace(Screen=open_screen)), \
             patch("app.streaming.time.sleep"):
            actual, info = _open_device()
        self.assertIs(actual, screen)
        self.assertEqual(info["app"], "vendor")

    def test_open_releases_failed_probe_and_can_cancel_waiting(self):
        stop, closed = threading.Event(), []
        def failed_info():
            stop.set()
            raise TimeoutError("USB reset")
        screen = SimpleNamespace(info=failed_info, close=lambda: closed.append(True))
        with patch("app.streaming._protocol", return_value=SimpleNamespace(Screen=lambda: screen)):
            with self.assertRaises(InterruptedError):
                _open_device(stop)
        self.assertEqual(closed, [True])

    def test_open_does_not_hide_vendor_program_ownership_conflict(self):
        def occupied(): raise RuntimeError("kanali.exe 正在运行，请先完全退出 KANALI")
        with patch("app.streaming._protocol", return_value=SimpleNamespace(Screen=occupied)), \
             patch("app.streaming.time.sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "kanali.exe"):
                _open_device()
            sleep.assert_not_called()

    def test_restore_requires_stability_after_vendor_reenumerates(self):
        clock, opened, closed = [0.0], [], []
        def open_screen():
            opened.append(clock[0])
            if 0.3 <= clock[0] < 0.7:
                raise RuntimeError("期望 1 个 PASE 屏幕，实际找到 0：[]")
            return SimpleNamespace(info=lambda: dict(app="vendor"), close=lambda: closed.append(clock[0]))
        with patch("app.streaming._protocol", return_value=SimpleNamespace(Screen=open_screen)), \
             patch("app.streaming.time.monotonic", side_effect=lambda: clock[0]), \
             patch("app.streaming.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)):
            info = restore_device()
        self.assertEqual(info["app"], "vendor")
        self.assertGreaterEqual(clock[0], 2.3)
        self.assertEqual(len(closed), len(opened)-1)

    def test_upload_retry_reopens_device_without_launching_bootstrap_twice(self):
        closed = []
        first = SimpleNamespace(close=lambda: closed.append("first"))
        second = SimpleNamespace(close=lambda: closed.append("second"))
        stop = SimpleNamespace(is_set=lambda: False, wait=lambda _: False)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "streamd-arm64").write_bytes(b"fake daemon")
            session = StreamSession(StreamConfig(mode="delta"), directory, lambda *_: None)
            with patch("app.streaming._open_device", side_effect=[(first, dict(app="vendor")), (second, dict(app="vendor"))]), \
                 patch.object(session, "_prepare_service", side_effect=[TimeoutError("USB reset"), None]) as prepare, \
                 patch("app.streaming._shell") as shell, \
                 patch("app.streaming._wait_for_app", return_value=dict(app="streamd-1.1")):
                session._deploy(stop)
            self.assertIs(prepare.call_args_list[0].args[0], first)
            self.assertIs(prepare.call_args_list[1].args[0], second)
            shell.assert_called_once_with(second, "setsid /tmp/bootstrap.sh >/dev/null 2>&1 &")
        self.assertEqual(closed, ["first", "second"])


if __name__ == "__main__":
    unittest.main()
