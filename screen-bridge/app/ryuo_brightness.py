"""Bounded RYUO IV brightness control; never writes a backlight node via ADB."""
from __future__ import annotations

import json
import re
import struct
import time

try:
    from . import ryuo4, ryuo_hid
except ImportError:
    import ryuo4
    import ryuo_hid


BACKLIGHT = "/sys/class/backlight/backlight/brightness"


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
    # Verify that the documented readback exists before changing the device.
    read_backlight(adb, serial)
    player_running = ryuo4.is_resumed(adb.shell(serial, "dumpsys", "activity", "activities"), ryuo4.PLAYER_PACKAGE)
    ryuo_hid.send_report(serial, brightness_frame(brightness))
    deadline = time.monotonic() + 3
    while True:
        actual = read_backlight(adb, serial)
        # Documented percentage mapping: 20 -> 50, 80 -> 200, 100 -> 250;
        # firmware clamps 1% to zero and rounds other percentages.
        expected = 0 if brightness == 1 else int(brightness * 2.5)
        if actual == expected:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("亮度配置已发送，但未确认背光生效；请关闭其他控制亮度的软件后重试")
        time.sleep(0.1)
    if player_running and not ryuo4.is_resumed(adb.shell(serial, "dumpsys", "activity", "activities"), ryuo4.PLAYER_PACKAGE):
        raise RuntimeError("亮度已发送，但串流播放器状态发生变化，请检查屏幕")
    return dict(brightness=brightness, applied=True)
