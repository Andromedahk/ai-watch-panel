"""Bounded RYUO IV brightness control; never writes a backlight node via ADB."""
from __future__ import annotations

import json
import re
import struct
import threading
import time

try:
    from . import ryuo4, ryuo_hid
except ImportError:
    import ryuo4
    import ryuo_hid


BACKLIGHT = "/sys/class/backlight/backlight/brightness"
HOLD_INTERVAL = 2.0
MAX_COMMAND_BYTES = 256


class _Stopped(Exception):
    pass


def _check_stopped(stop):
    if stop is not None and stop.is_set():
        raise _Stopped()


def validate_brightness(value):
    if type(value) is not int or not 1 <= value <= 100:
        raise ValueError("龙王 IV 亮度必须是 1–100 的整数百分比")
    return value


def brightness_frame(brightness):
    validate_brightness(brightness)
    # The firmware has a dedicated brightness command. Its handler reads only
    # value and calls doBrightness; the config handler also replaces media.
    body = json.dumps({"value": brightness}, separators=(",", ":"), ensure_ascii=True).replace("Z", "\\u005A").encode("ascii")
    stamp = int(time.time() * 1000)
    payload = (f"POST brightness 1\r\nSeqNumber={stamp & 0x7fffffff}\r\nDate={stamp}\r\n"
               f"ContentType=json\r\nContentLength={len(body)}\r\n\r\n").encode("ascii") + body
    length = struct.pack(">H", len(payload) + 5)
    frame = b"\x5a" + length + payload + bytes([(sum(length) + sum(payload)) & 255, 0x5a])
    if len(frame) > 1024:
        raise ValueError("亮度配置超过 HID 报告长度")
    return frame


def read_backlight(adb, serial):
    value = adb.shell(serial, "cat", BACKLIGHT)
    if not re.fullmatch(r"\d{1,3}", value) or not 0 <= int(value) <= 256:
        raise RuntimeError("无法读取龙王 IV 背光值；未确认亮度调节结果")
    return int(value)


def set_brightness(adb, brightness):
    validate_brightness(brightness)
    serial = ryuo4.discover(adb)
    return _apply_brightness(adb, serial, brightness)


def _apply_brightness(adb, serial, brightness, stop=None):
    _check_stopped(stop)
    # Verify that the documented readback exists before changing the device.
    read_backlight(adb, serial)
    player_running = ryuo4.is_resumed(adb.shell(serial, "dumpsys", "activity", "activities"), ryuo4.PLAYER_PACKAGE)
    _check_stopped(stop)
    ryuo_hid.send_report(serial, brightness_frame(brightness))
    deadline = time.monotonic() + 3
    while True:
        _check_stopped(stop)
        actual = read_backlight(adb, serial)
        # Firmware maps percentages by 2.5 but hardware readback can quantize
        # upward by one (20% -> 50/51, 40% -> 100/101). These one-sided ranges
        # never overlap the adjacent percentage, unlike a symmetric tolerance.
        # The documented 1% case maps to zero rather than nominal 2.
        expected = 0 if brightness == 1 else int(brightness * 2.5)
        if expected <= actual <= expected + 1:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("亮度配置已发送，但未确认背光生效；请关闭其他控制亮度的软件后重试")
        if stop is None:
            time.sleep(0.1)
        elif stop.wait(0.1):
            raise _Stopped()
    if player_running and not ryuo4.is_resumed(adb.shell(serial, "dumpsys", "activity", "activities"), ryuo4.PLAYER_PACKAGE):
        raise RuntimeError("亮度已发送，但串流播放器状态发生变化，请检查屏幕")
    return dict(brightness=brightness, applied=True)


def _parse_command(line):
    try:
        encoded = line.encode("utf-8") if isinstance(line, str) else line
        if not isinstance(encoded, bytes) or len(encoded) > MAX_COMMAND_BYTES or not encoded.endswith(b"\n"):
            raise ValueError()
        pairs = json.loads(encoded, object_pairs_hook=lambda values: values)
        if (not isinstance(pairs, list) or len(pairs) != 1 or not isinstance(pairs[0], tuple)
                or pairs[0][0] != "brightness"):
            raise ValueError()
        return validate_brightness(pairs[0][1])
    except (ValueError, TypeError, UnicodeError):
        raise ValueError("龙王 IV 亮度保活收到无效参数；请重新应用亮度") from None


class _BrightnessInput:
    """One pending validated value; EOF is the parent's lifetime signal."""
    def __init__(self, source, stop):
        self.source, self.stop = source, stop
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.pending, self.error = None, None
        self.thread = threading.Thread(target=self._read, name="ryuo-brightness-input", daemon=True)

    def start(self):
        self.thread.start()

    def _read(self):
        try:
            while not self.stop.is_set():
                line = self.source.readline(MAX_COMMAND_BYTES + 1)
                if line in (b"", ""):
                    self.stop.set()
                    return
                value = _parse_command(line)
                with self.lock:
                    self.pending = value
                    self.wake.set()
        except Exception:
            with self.lock:
                # Don't echo malformed commands or source paths into IPC.
                self.error = ValueError("龙王 IV 亮度保活输入已断开或参数无效；请重新应用亮度")
            self.stop.set()
        finally:
            self.wake.set()

    def take(self):
        with self.lock:
            if self.error:
                raise self.error
            value, self.pending = self.pending, None
            self.wake.clear()
            return value

    def wait(self, seconds):
        # Bound signal/stop latency even when stdin is blocked in the reader.
        self.wake.wait(min(seconds, 0.1))


def hold_brightness(adb, initial, emit, source, stop):
    """Keep one verified USB target awake, accepting bounded brightness updates.

    Startup and new values are read back before acknowledgement. Heartbeats use
    only the already-bound serial and HID, avoiding slow repeated ADB discovery.
    EOF, signals, invalid input or a failed HID write end this worker; no other
    device, media, player lifecycle or ADB reverse rule is touched.
    """
    validate_brightness(initial)
    incoming = _BrightnessInput(source, stop)
    incoming.start()
    try:
        _check_stopped(stop)
        serial = ryuo4.discover(adb)
        current = initial
        result = _apply_brightness(adb, serial, current, stop)
        _check_stopped(stop)
        emit("brightness", dict(result, holding=True))
        deadline = time.monotonic() + HOLD_INTERVAL
        while True:
            # Check input errors before cancellation so malformed input does not
            # look like a successful normal shutdown.
            updated = incoming.take()
            _check_stopped(stop)
            if updated is not None:
                result = _apply_brightness(adb, serial, updated, stop)
                _check_stopped(stop)
                current = updated
                emit("brightness", dict(result, holding=True))
                deadline = time.monotonic() + HOLD_INTERVAL
            now = time.monotonic()
            if now >= deadline:
                _check_stopped(stop)
                ryuo_hid.send_report(serial, brightness_frame(current))
                _check_stopped(stop)
                emit("brightness-heartbeat", dict(brightness=current))
                deadline = time.monotonic() + HOLD_INTERVAL
            incoming.wait(max(0, deadline - time.monotonic()))
    except _Stopped:
        incoming.take()  # An invalid input is an error, unlike normal EOF/signal.
        return
    finally:
        stop.set()
