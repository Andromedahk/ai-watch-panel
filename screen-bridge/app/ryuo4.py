"""ROG RYUO IV custom-firmware transport, using its preinstalled HTTP player.

Streaming performs no flashing, package installation or root commands.
The separate brightness adapter uses the vendor HID brightness command.
Only a USB ADB device with the RYUO IV model/SoC identity is eligible.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import threading
import time

DEVICE_ID = "ryuo4"
PLAYER_PACKAGE = "com.ryuo.stream"
PLAYER_ACTIVITY = PLAYER_PACKAGE + "/.StreamActivity"
HOME_PACKAGE = "com.baiyi.homeui.hshomeui"
HOME_ACTIVITY = HOME_PACKAGE + "/.MainActivity"
MODEL = "ROG_RYUO_IV_Standard"


def adb_path(resources):
    bundled = Path(resources) / "adb" / ("adb.exe" if os.name == "nt" else "adb")
    if bundled.is_file():
        return bundled
    if not getattr(sys, "frozen", False):
        override = os.environ.get("RYUO_ADB")
        if override and not Path(override).is_absolute():
            raise FileNotFoundError("RYUO_ADB 必须是 ADB 可执行文件的绝对路径")
        candidate = Path(override) if override else shutil.which("adb")
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise FileNotFoundError("缺少 ROG 龙王 4 的 ADB 组件；请构建包含 resources/adb 的串流桥（源码模式可设置 RYUO_ADB）")


def validate_config(config):
    config.validate()
    if config.width > 2240 or config.height > 1080:
        raise ValueError("ROG 龙王 4 的 HEVC 串流最大为原生 2240 × 1080")
    return config


def validate_muxer(binary):
    result = subprocess.run([str(binary), "-hide_banner", "-muxers"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or not re.search(rb"\bE\s+mpegts\b", result.stdout):
        raise RuntimeError("ROG 龙王 4 需要 FFmpeg MPEG-TS 封装支持；请重新构建串流编码器和桥")
    result = subprocess.run([str(binary), "-hide_banner", "-encoders"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or not re.search(rb"\blibx265\b", result.stdout):
        raise RuntimeError("ROG 龙王 4 原生分辨率需要 FFmpeg libx265 / HEVC 编码支持；请重新构建串流编码器和桥")


class Adb:
    def __init__(self, binary):
        self.binary = str(binary)

    def run(self, *args, timeout=10):
        result = subprocess.run([self.binary, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out = result.stdout.decode("utf-8", "replace").strip()
        err = result.stderr.decode("utf-8", "replace").strip()
        if result.returncode:
            raise RuntimeError("ADB 操作失败：" + (err or out or str(result.returncode))[-350:])
        return out

    def shell(self, serial, *args, timeout=10):
        return self.run("-s", serial, "shell", *args, timeout=timeout)


def discover(adb):
    matches, unavailable, usb_unconfirmed = [], False, False
    usb_serial = None
    output = adb.run("devices", "-l", timeout=15)
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 2 or line.startswith("List of devices") or line.startswith("*"):
            continue
        if parts[1] in ("unauthorized", "offline"):
            unavailable = True
            continue
        if parts[1] != "device":
            continue
        serial = parts[0]
        devpath = adb.run("-s", serial, "get-devpath")
        if sys.platform == "win32" and devpath == "unknown":
            # The native Windows ADB backend can omit the USB path even for an
            # authorized USB device. -d selects USB only and fails on ambiguity;
            # never treat "unknown" or matching Android properties as USB proof.
            if usb_serial is None:
                try:
                    usb_serial = adb.run("-d", "get-serialno")
                except RuntimeError:
                    usb_serial = ""
            if serial != usb_serial:
                usb_unconfirmed = True
                continue
        elif not devpath.startswith("usb:"):
            # A TCP/wireless Android device is never eligible for takeover.
            continue
        identity = [adb.shell(serial, "getprop", prop) for prop in
                    ("ro.product.version", "ro.soc.model", "ro.product.model")]
        if identity != [MODEL, "RK3562", "cm16"]:
            continue
        # Android custom firmware may not expose configfs to the shell. Exact
        # product/SoC/device properties are mandatory; readable USB IDs add a
        # second check and mismatches are rejected, never silently ignored.
        ids = []
        for key in ("idVendor", "idProduct"):
            try:
                value = adb.shell(serial, "cat", "/config/usb_gadget/g1/" + key)
                ids.append(int(value, 16))
            except (RuntimeError, ValueError):
                ids.append(None)
        if any(value is not None and value != expected for value, expected in zip(ids, (0x0B05, 0x1C76))):
            continue
        packages = adb.shell(serial, "pm", "list", "packages", PLAYER_PACKAGE)
        if "package:" + PLAYER_PACKAGE not in packages.splitlines():
            raise RuntimeError("ROG 龙王 4 未预置 com.ryuo.stream 播放器；请先准备匹配的定制固件")
        matches.append(serial)
    if len(matches) > 1:
        raise RuntimeError("检测到多台 ROG 龙王 4；请仅连接一台目标屏幕后重试")
    if not matches:
        suffix = "；有设备未授权或离线，请检查 USB ADB 授权" if unavailable else ""
        if usb_unconfirmed:
            suffix += "；Windows ADB 未提供 USB 路径且无法确认唯一 USB 设备，请暂时只保留目标屏幕的 USB ADB 连接后重试"
        raise RuntimeError("未找到已预置播放器的 ROG 龙王 4 USB 设备（0b05:1c76 / cm16 / RK3562）" + suffix)
    return matches[0]


def public_identity():
    return dict(product=MODEL, device="cm16", soc="RK3562", usb="0b05:1c76", player=PLAYER_PACKAGE)


def check_activity_result(output):
    if re.search(r"(?:Error:|Exception|Error type|Permission Denial)", output, re.I):
        raise RuntimeError("设备界面启动失败：" + output[-350:])


def is_resumed(activities, package):
    return any(package in line and re.search(r"(?:mResumedActivity|topResumedActivity)", line)
               for line in activities.splitlines())


class DeviceSession:
    """Own exactly one reverse rule and the player launched by this session."""
    def __init__(self, adb, serial):
        self.adb, self.serial = adb, serial
        self.port = None
        self.player_attempted = False

    def launch(self, port):
        activities = self.adb.shell(self.serial, "dumpsys", "activity", "activities")
        if is_resumed(activities, PLAYER_PACKAGE):
            raise RuntimeError("ROG 龙王 4 播放器正在使用中；请先停止其他串流软件后重试")
        # Never replace another program's ADB reverse rule, even on collision.
        self.adb.run("-s", self.serial, "reverse", "--no-rebind", f"tcp:{port}", f"tcp:{port}")
        self.port = port
        self.player_attempted = True
        # The supplied player uses singleTask and reads URL only in onCreate.
        # Clear a paused prior instance so its old relay URL cannot be reused.
        # A foreground player was rejected above before acquiring any resource.
        check_activity_result(self.adb.shell(self.serial, "am", "force-stop", PLAYER_PACKAGE))
        output = self.adb.shell(self.serial, "am", "start", "-W", "-n", PLAYER_ACTIVITY,
                                "--es", "url", f"http://127.0.0.1:{port}/live.ts",
                                "--ez", "hud", "false", "--ez", "restart", "true", timeout=20)
        check_activity_result(output)

    def cleanup(self):
        errors = []
        if self.player_attempted:
            try:
                check_activity_result(self.adb.shell(self.serial, "am", "force-stop", PLAYER_PACKAGE))
                result = self.adb.shell(self.serial, "am", "start", "-W", "-n", HOME_ACTIVITY, timeout=20)
                check_activity_result(result)
                # am start exit status alone is insufficient proof of recovery.
                deadline = time.monotonic() + 4
                while True:
                    activities = self.adb.shell(self.serial, "dumpsys", "activity", "activities")
                    if is_resumed(activities, HOME_PACKAGE):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("尚未确认 HomeUI 恢复到前台")
                    time.sleep(0.2)
            except Exception as exc:
                errors.append(str(exc))
        if self.port is not None:
            try:
                token = f"tcp:{self.port}"
                rows = [line.split() for line in self.adb.run("-s", self.serial, "reverse", "--list").splitlines()]
                matching = [row for row in rows if len(row) >= 3 and row[-2] == token]
                if matching and any(row[-1] != token for row in matching):
                    raise RuntimeError("ADB reverse 规则已被其他程序修改；未移除该规则")
                if matching:
                    self.adb.run("-s", self.serial, "reverse", "--remove", token)
            except Exception as exc:
                errors.append(str(exc))
        if errors:
            raise RuntimeError("ROG 龙王 4 清理或界面恢复失败：" + "；".join(errors))
        return self.player_attempted


class TsRelay:
    """Loopback HTTP server with one lossless device consumer and backpressure."""
    def __init__(self, output, stop):
        self.output, self.stop = output, stop
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.socket.bind(("127.0.0.1", 0))
            self.socket.listen(1)
            self.socket.settimeout(0.2)
        except BaseException:
            self.socket.close()
            raise
        self.port = self.socket.getsockname()[1]
        self.connection = None
        self.connected = threading.Event()
        self.error = None
        self.bytes = 0
        self.last_sent = time.monotonic()
        self.thread = threading.Thread(target=self._run, name="ryuo-http", daemon=True)

    def start(self):
        self.thread.start()

    def _run(self):
        try:
            while not self.stop.is_set():
                try:
                    connection, _ = self.socket.accept()
                except socket.timeout:
                    continue
                self.connection = connection
                connection.settimeout(5)
                connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                request = bytearray()
                while b"\r\n\r\n" not in request and len(request) < 8192:
                    chunk = connection.recv(1024)
                    if not chunk:
                        break
                    request.extend(chunk)
                if not request.startswith(b"GET /live.ts HTTP/") or b"\r\n\r\n" not in request:
                    connection.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    connection.close()
                    self.connection = None
                    continue
                connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                self.connected.set()
                while not self.stop.is_set():
                    read = getattr(self.output, "read1", self.output.read)
                    chunk = read(16 * 1024)
                    if not chunk:
                        if not self.stop.is_set():
                            raise RuntimeError("ROG 龙王 4 编码器输出已关闭")
                        return
                    connection.sendall(chunk)
                    self.bytes += len(chunk)
                    self.last_sent = time.monotonic()
                return
        except Exception as exc:
            if not self.stop.is_set():
                self.error = exc
        finally:
            self.close_sockets()

    def close_sockets(self):
        for sock in (self.connection, self.socket):
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()

    def close(self):
        self.close_sockets()
        if self.thread.ident is not None:
            self.thread.join(timeout=2)
