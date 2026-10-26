"""Portable Windows desktop streaming, device lifecycle and capture backend."""
import base64
from collections import deque
import ctypes as ct
from ctypes import wintypes as wt
from dataclasses import dataclass
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

from PIL import Image, ImageOps

try:
    from .delta import DeltaEncoder
except ImportError:
    from delta import DeltaEncoder


DAEMON_VERSION = "streamd-1.1"


def _protocol():
    import kanali_stream
    return kanali_stream


@dataclass
class StreamConfig:
    width: int = 1920
    height: int = 1080
    fps: int = 30
    mode: str = "full"
    bitrate_mbps: int = 8
    quality: int = 85
    monitor: int = 1
    fit: str = "contain"
    show_cursor: bool = True
    tile_size: int = 64
    refresh_interval: float = 5.0

    def validate(self):
        for name in ("width", "height", "fps", "bitrate_mbps", "quality", "monitor", "tile_size"):
            if isinstance(getattr(self, name), bool) or not isinstance(getattr(self, name), int):
                raise ValueError(f"{name} 必须是整数")
        if not (64 <= self.width <= 4096 and 64 <= self.height <= 4096):
            raise ValueError("宽和高需为 64–4096 像素")
        if self.width % 2 or self.height % 2:
            raise ValueError("宽和高必须是偶数")
        if self.width * self.height > 2240 * 1080:
            raise ValueError("总像素数不能超过屏幕原生 2240 × 1080")
        if not 1 <= self.fps <= 60:
            raise ValueError("帧率需为 1–60 FPS")
        if not 1 <= self.bitrate_mbps <= 50:
            raise ValueError("码率需为 1–50 Mbps")
        if not 30 <= self.quality <= 100:
            raise ValueError("JPEG 质量需为 30–100")
        if self.mode not in ("full", "delta") or self.fit not in ("contain", "cover", "stretch"):
            raise ValueError("无效的刷新模式或缩放方式")
        if self.monitor < 0 or self.tile_size not in (32, 64, 128):
            raise ValueError("无效的显示器或分块大小")
        if not isinstance(self.show_cursor, bool):
            raise ValueError("鼠标指针选项必须为 true 或 false")
        if not isinstance(self.refresh_interval, (int, float)) or not 1 <= self.refresh_interval <= 60:
            raise ValueError("完整校准间隔需为 1–60 秒")
        return self


def enable_dpi_awareness():
    if os.name != "nt":
        return
    try:
        ct.windll.user32.SetProcessDpiAwarenessContext(ct.c_void_p(-4))
    except (AttributeError, OSError):
        ct.windll.user32.SetProcessDPIAware()


def enumerate_monitors():
    if os.name != "nt":
        raise RuntimeError("桌面采集仅支持 Windows 10/11")
    user = ct.WinDLL("user32", use_last_error=True)
    monitors = []
    callback_type = ct.WINFUNCTYPE(wt.BOOL, wt.HANDLE, wt.HDC, ct.POINTER(wt.RECT), wt.LPARAM)
    class MonitorInfo(ct.Structure):
        _fields_ = [("size", wt.DWORD), ("monitor", wt.RECT), ("work", wt.RECT), ("flags", wt.DWORD)]
    user.GetMonitorInfoW.argtypes = [wt.HANDLE, ct.POINTER(MonitorInfo)]
    def callback(handle, dc, rect, param):
        info = MonitorInfo()
        info.size = ct.sizeof(info)
        user.GetMonitorInfoW(handle, ct.byref(info))
        r = rect.contents
        monitors.append(dict(left=r.left, top=r.top, width=r.right-r.left, height=r.bottom-r.top,
                             primary=bool(info.flags & 1)))
        return True
    cb = callback_type(callback)
    user.EnumDisplayMonitors.argtypes = [wt.HDC, ct.POINTER(wt.RECT), callback_type, wt.LPARAM]
    if not user.EnumDisplayMonitors(None, None, cb, 0):
        raise ct.WinError(ct.get_last_error())
    monitors.sort(key=lambda m: (not m["primary"], m["left"], m["top"]))
    for index, monitor in enumerate(monitors, 1):
        monitor["index"] = index
        monitor["label"] = f"显示器 {index}{'（主屏）' if monitor['primary'] else ''} · {monitor['width']} × {monitor['height']}"
    if not monitors:
        raise RuntimeError("没有可采集的显示器；请在交互式 Windows 桌面运行")
    left, top = min(m["left"] for m in monitors), min(m["top"] for m in monitors)
    right = max(m["left"]+m["width"] for m in monitors)
    bottom = max(m["top"]+m["height"] for m in monitors)
    return [dict(index=0, label=f"整个桌面 · {right-left} × {bottom-top}", left=left, top=top,
                 width=right-left, height=bottom-top, primary=False)] + monitors


class DesktopCapture:
    """Top-down GDI DIB capture with the real Windows cursor and hotspot."""
    def __init__(self, monitor, cursor=True):
        self.monitor, self.cursor = monitor, cursor
        self.user = ct.WinDLL("user32", use_last_error=True)
        self.gdi = ct.WinDLL("gdi32", use_last_error=True)
        def bind(lib, name, result, *args):
            fn = getattr(lib, name)
            fn.restype, fn.argtypes = result, args
            return fn
        self.get_dc = bind(self.user, "GetDC", wt.HDC, wt.HWND)
        self.release_dc = bind(self.user, "ReleaseDC", ct.c_int, wt.HWND, wt.HDC)
        self.create_dc = bind(self.gdi, "CreateCompatibleDC", wt.HDC, wt.HDC)
        self.delete_dc = bind(self.gdi, "DeleteDC", wt.BOOL, wt.HDC)
        self.delete_object = bind(self.gdi, "DeleteObject", wt.BOOL, wt.HANDLE)
        self.select = bind(self.gdi, "SelectObject", wt.HANDLE, wt.HDC, wt.HANDLE)
        self.bitblt = bind(self.gdi, "BitBlt", wt.BOOL, wt.HDC, ct.c_int, ct.c_int, ct.c_int, ct.c_int,
                           wt.HDC, ct.c_int, ct.c_int, wt.DWORD)
        create_dib = bind(self.gdi, "CreateDIBSection", wt.HANDLE, wt.HDC, ct.c_void_p, wt.UINT,
                          ct.POINTER(ct.c_void_p), wt.HANDLE, wt.DWORD)
        class BitmapInfo(ct.Structure):
            _fields_ = [("size", wt.DWORD), ("width", wt.LONG), ("height", wt.LONG),
                        ("planes", wt.WORD), ("bits", wt.WORD), ("compression", wt.DWORD),
                        ("image_size", wt.DWORD), ("xppm", wt.LONG), ("yppm", wt.LONG),
                        ("colors", wt.DWORD), ("important", wt.DWORD)]
        self.dc = self.mem = self.bitmap = self.old = None
        self.bits = ct.c_void_p()
        try:
            self.dc = self.get_dc(None)
            self.mem = self.create_dc(self.dc)
            info = BitmapInfo(ct.sizeof(BitmapInfo), monitor["width"], -monitor["height"], 1, 32)
            self.bitmap = create_dib(self.dc, ct.byref(info), 0, ct.byref(self.bits), None, 0)
            if not self.dc or not self.mem or not self.bitmap or not self.bits.value:
                raise ct.WinError(ct.get_last_error())
            self.old = self.select(self.mem, self.bitmap)
        except Exception:
            self.close()
            raise

    def _draw_cursor(self):
        class CursorInfo(ct.Structure):
            _fields_ = [("size", wt.DWORD), ("flags", wt.DWORD), ("cursor", wt.HANDLE), ("point", wt.POINT)]
        class IconInfo(ct.Structure):
            _fields_ = [("icon", wt.BOOL), ("x", wt.DWORD), ("y", wt.DWORD),
                        ("mask", wt.HANDLE), ("color", wt.HANDLE)]
        self.user.GetCursorInfo.argtypes = [ct.POINTER(CursorInfo)]
        self.user.GetIconInfo.argtypes = [wt.HANDLE, ct.POINTER(IconInfo)]
        self.user.DrawIconEx.argtypes = [wt.HDC, ct.c_int, ct.c_int, wt.HANDLE, ct.c_int, ct.c_int,
                                       wt.UINT, wt.HANDLE, wt.UINT]
        cursor = CursorInfo()
        cursor.size = ct.sizeof(cursor)
        if self.user.GetCursorInfo(ct.byref(cursor)) and cursor.flags & 1:
            icon = IconInfo()
            if self.user.GetIconInfo(cursor.cursor, ct.byref(icon)):
                try:
                    self.user.DrawIconEx(self.mem, cursor.point.x-self.monitor["left"]-icon.x,
                                         cursor.point.y-self.monitor["top"]-icon.y, cursor.cursor,
                                         0, 0, 0, None, 3)
                finally:
                    if icon.mask:
                        self.delete_object(icon.mask)
                    if icon.color:
                        self.delete_object(icon.color)

    def grab(self):
        m = self.monitor
        if not self.bitblt(self.mem, 0, 0, m["width"], m["height"], self.dc, m["left"], m["top"], 0x40CC0020):
            raise RuntimeError("无法采集桌面；桌面可能已锁定或远程会话已断开")
        if self.cursor:
            self._draw_cursor()
        self.gdi.GdiFlush()
        pixels = ct.string_at(self.bits, m["width"] * m["height"] * 4)
        return Image.frombytes("RGB", (m["width"], m["height"]), pixels, "raw", "BGRX")

    def close(self):
        if self.mem and self.old:
            self.select(self.mem, self.old)
        if self.bitmap:
            self.delete_object(self.bitmap)
        if self.mem:
            self.delete_dc(self.mem)
        if self.dc:
            self.release_dc(None, self.dc)
        self.dc = self.mem = self.bitmap = self.old = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def resize_frame(image, config):
    size = (config.width, config.height)
    resample = Image.Resampling.BILINEAR if hasattr(Image, "Resampling") else Image.BILINEAR
    if config.fit == "stretch":
        return image.resize(size, resample)
    if config.fit == "cover":
        return ImageOps.fit(image, size, method=resample)
    fitted = ImageOps.contain(image, size, method=resample)
    frame = Image.new("RGB", size)
    frame.paste(fitted, ((size[0]-fitted.width)//2, (size[1]-fitted.height)//2))
    return frame


def check_device():
    sc = _protocol().Screen()
    try:
        return sc.info()
    finally:
        sc.close()


def _transient_device_error(error):
    # Do not retry explicit ownership conflicts or an ambiguous device selection.
    return (isinstance(error, (OSError, TimeoutError)) or
            (isinstance(error, RuntimeError) and "实际找到 0" in str(error)))


def _open_device(stop=None, timeout=10):
    """Return a live Screen and its info; the caller keeps this same USB handle."""
    deadline, last_error = time.monotonic()+timeout, None
    while time.monotonic() < deadline:
        if stop is not None and stop.is_set():
            raise InterruptedError("已取消")
        sc = None
        try:
            sc = _protocol().Screen()
            info = sc.info()
            if stop is not None and stop.is_set():
                raise InterruptedError("已取消")
            return sc, info
        except Exception as exc:
            if sc is not None:
                sc.close()
            if isinstance(exc, InterruptedError) or not _transient_device_error(exc):
                raise
            last_error = exc
        if stop is not None:
            if stop.wait(0.3):
                raise InterruptedError("已取消")
        else:
            time.sleep(0.3)
    raise RuntimeError(f"等待 USB 设备连接超时：{last_error}")


def _shell(sc, command, timeout=10):
    ks = _protocol()
    body = sc.command(450, ks.field(1, 5) + ks.field(2, command), expected=850, timeout=timeout)
    return ks.get(body, 2, b"").decode("utf-8", "replace")


def _wait_for_app(predicate, timeout, log=None, stop=None):
    deadline, last_error = time.monotonic()+timeout, None
    while time.monotonic() < deadline:
        if stop is not None and stop.is_set():
            raise InterruptedError("已取消")
        try:
            info = check_device()
            if predicate(info.get("app", "")):
                return info
        except Exception as exc:
            last_error = exc
        if stop is not None:
            stop.wait(0.4)
        else:
            time.sleep(0.4)
    raise RuntimeError(f"等待设备响应超时{': '+str(last_error) if last_error else ''}")


def restore_device(log=None):
    log = log or (lambda message: None)
    ks = _protocol()
    deadline, last_error, requested = time.monotonic()+30, None, False
    stable_since, stable_app = None, None
    while time.monotonic() < deadline:
        sc = None
        try:
            sc = ks.Screen()
            info = sc.info()
            app = info.get("app", "")
            if app and not app.startswith("streamd-"):
                # The vendor app can reply once before its USB re-enumeration.
                # Require several fresh handles to stay healthy across that gap.
                now = time.monotonic()
                if stable_app != app or stable_since is None:
                    stable_since, stable_app = now, app
                elif now-stable_since >= 1.5:
                    log("原厂界面已恢复")
                    return info
            else:
                stable_since, stable_app = None, None
            if app.startswith("streamd-") and not requested:
                log("正在恢复原厂界面…")
                _shell(sc, "__streamd_restore__", timeout=4)
                requested = True
        except Exception as exc:
            if not _transient_device_error(exc):
                raise
            last_error = exc
            stable_since, stable_app = None, None
        finally:
            if sc is not None:
                sc.close()
        time.sleep(0.4)
    raise RuntimeError(f"恢复原厂界面超时：{last_error or '设备仍在串流模式'}")


def ffmpeg_command(binary, config, monitor):
    width, height = config.width, config.height
    if config.fit == "contain":
        scale = f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    elif config.fit == "cover":
        scale = f"scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop={width}:{height}"
    else:
        scale = f"scale={width}:{height}"
    return [str(binary), "-hide_banner", "-loglevel", "warning", "-nostdin", "-f", "gdigrab",
            "-framerate", str(config.fps), "-draw_mouse", str(int(config.show_cursor)),
            "-offset_x", str(monitor["left"]), "-offset_y", str(monitor["top"]),
            "-video_size", f'{monitor["width"]}x{monitor["height"]}', "-i", "desktop",
            "-an", "-vf", scale+",setsar=1,format=yuv420p", "-c:v", "libx264",
            "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", f"{config.bitrate_mbps}M",
            "-maxrate", f"{config.bitrate_mbps}M", "-bufsize", f"{config.bitrate_mbps}M",
            "-x264-params", f"aud=1:repeat-headers=1:annexb=1:keyint={config.fps}:min-keyint={config.fps}:scenecut=0:bframes=0",
            "-f", "h264", "pipe:1"]


def iter_h264_aus(stream):
    """Split Annex-B AUD boundaries, preserving complete NAL start codes."""
    buffer = b""
    boundary = re.compile(b"\x00\x00(?:\x00)?\x01\x09")
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        buffer += chunk
        starts = [match.start() for match in boundary.finditer(buffer)]
        if len(starts) >= 2:
            for index in range(len(starts)-1):
                yield buffer[0 if index == 0 else starts[index]:starts[index+1]]
            buffer = buffer[starts[-1]:]
        if len(buffer) > 16 * 1024 * 1024:
            raise RuntimeError("编码器未输出有效的 H.264 帧边界")
    if buffer:
        yield buffer


class StreamSession:
    def __init__(self, config, resources_dir, emit):
        self.config = config.validate()
        self.resources_dir = Path(resources_dir)
        self.emit = emit
        self.sc = None
        self.track = None
        self.takeover = False
        self.started = self.last_stats = 0.0
        self.frames = self.skipped = self.total_bytes = self.window_bytes = self.window_frames = 0
        self.changed_ratio = 0.0

    def log(self, message):
        self.emit("log", str(message))

    def _cancel(self, stop):
        if stop.is_set():
            raise InterruptedError("已取消")

    def _prepare_service(self, sc, binary, stop):
        ks = _protocol()
        import deploy_streamd
        size = binary.stat().st_size
        track = sc.track = sc.track+1
        sc.command(400, ks.field(1, deploy_streamd.REMOTE_MEDIA)+ks.field(2, size), 800, track, version=0, timeout=30)
        with binary.open("rb") as src:
            sent = 0
            while True:
                self._cancel(stop)
                chunk = src.read(0x40000)
                if not chunk:
                    break
                sc.command(401, ks.field(1, chunk), 801, track, version=0, timeout=15)
                sent += len(chunk)
                self.emit("status", f"正在上传屏幕服务 · {sent*100//size}%")
        sc.command(402, ks.field(1, "media"), 802, track, version=0, timeout=15)
        encoded = base64.b64encode(deploy_streamd.BOOTSTRAP.encode()).decode("ascii")
        result = _shell(sc, f"printf '%s' '{encoded}' | base64 -d > /tmp/bootstrap.sh && chmod +x /tmp/bootstrap.sh && echo READY")
        if "READY" not in result:
            raise RuntimeError("设备无法准备临时启动脚本："+result)

    def _deploy(self, stop):
        binary = self.resources_dir / "streamd-arm64"
        if not binary.is_file():
            raise FileNotFoundError(f"缺少设备端服务：{binary}")
        self.emit("status", "正在连接屏幕…")
        sc = None
        try:
            sc, info = _open_device(stop)
            self.emit("device", info)
            if info.get("app", "").startswith("streamd-"):
                sc.close()
                sc = None
                restore_device(self.log)
                sc, info = _open_device(stop)
            self._cancel(stop)
            self.emit("status", "正在准备屏幕服务…")
            for attempt in range(3):
                try:
                    self._prepare_service(sc, binary, stop)
                    break
                except Exception as exc:
                    if isinstance(exc, InterruptedError) or not _transient_device_error(exc) or attempt == 2:
                        raise
                    self.log("USB 正在重新连接，重试上传屏幕服务…")
                    sc.close()
                    sc = None
                    if stop.wait(0.4):
                        raise InterruptedError("已取消")
                    sc, info = _open_device(stop)
                    if info.get("app", "").startswith("streamd-"):
                        raise RuntimeError("准备期间设备服务意外改变，请停止后重试")
            self._cancel(stop)
            self.takeover = True
            _shell(sc, "setsid /tmp/bootstrap.sh >/dev/null 2>&1 &")
        finally:
            if sc is not None:
                sc.close()
        self.emit("status", "正在接管屏幕…")
        # Once bootstrap starts, finish the handover before honoring cancellation.
        # Otherwise an early vendor reply could be mistaken for completed recovery,
        # while the detached bootstrap is still about to take over the device.
        info = _wait_for_app(lambda app: app == DAEMON_VERSION, 25, self.log)
        self.emit("device", info)
        self.log("设备服务已就绪；停止后自动恢复原厂界面")

    def _stats(self, data_size=0, changed=None, rendered=True, force=False):
        self.total_bytes += data_size
        self.window_bytes += data_size
        if rendered:
            self.frames += 1
            self.window_frames += 1
        if changed is not None:
            self.changed_ratio = changed
        now = time.monotonic()
        interval = now-self.last_stats
        if interval >= 0.5 or force:
            self.emit("stats", dict(fps=self.window_frames/max(interval, 0.001),
                                    mbps=self.window_bytes*8/max(interval, 0.001)/1_000_000,
                                    frames=self.frames, skipped=self.skipped, changed_ratio=self.changed_ratio,
                                    elapsed=now-self.started, bytes=self.total_bytes))
            self.last_stats, self.window_bytes, self.window_frames = now, 0, 0

    def _delta(self, stop, monitor):
        ks, c = _protocol(), self.config
        self.track = self.sc.track = self.sc.track+1
        self.sc.command(407, ks.field(1, 3)+ks.field(2, c.fps)+ks.field(3, c.width)+ks.field(4, c.height),
                        600, self.track, timeout=10)
        encoder = DeltaEncoder(c.width, c.height, c.quality, c.tile_size, c.refresh_interval)
        next_frame, next_preview = time.monotonic(), 0
        with DesktopCapture(monitor, c.show_cursor) as capture:
            while not stop.is_set():
                now = time.monotonic()
                if now < next_frame and stop.wait(next_frame-now):
                    break
                now = time.monotonic()
                image = resize_frame(capture.grab(), c)
                packet = encoder.prepare(image, now)
                if packet is None:
                    self.skipped += 1
                    self._stats(rendered=False, changed=0)
                else:
                    self.sc.command(408, ks.field(1, packet.payload), expected=600, timeout=10)
                    encoder.commit(packet)
                    self._stats(len(packet.payload), packet.changed_ratio, rendered=bool(packet.rectangles))
                if now >= next_preview:
                    preview = image.copy()
                    preview.thumbnail((640, 360))
                    self.emit("preview", preview)
                    next_preview = now+0.75
                next_frame = max(next_frame+1/c.fps, time.monotonic())

    def _full(self, stop, monitor):
        binary = self.resources_dir / "ffmpeg" / "ffmpeg.exe"
        if not binary.is_file():
            raise FileNotFoundError(f"缺少编码器：{binary}")
        c = self.config
        command = ffmpeg_command(binary, c, monitor)
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                bufsize=0, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        packets = queue.Queue(maxsize=4)
        errors = deque(maxlen=12)
        local_stop = threading.Event()
        def read_output():
            try:
                for frame in iter_h264_aus(proc.stdout):
                    while not local_stop.is_set():
                        try:
                            packets.put(frame, timeout=0.1)
                            break
                        except queue.Full:
                            continue
                    if local_stop.is_set():
                        return
            except Exception as exc:
                errors.append(str(exc))
            finally:
                while not local_stop.is_set():
                    try:
                        packets.put(None, timeout=0.1)
                        break
                    except queue.Full:
                        continue
        def read_errors():
            for line in iter(proc.stderr.readline, b""):
                errors.append(line.decode("utf-8", "replace").strip())
        readers = [threading.Thread(target=read_output, daemon=True), threading.Thread(target=read_errors, daemon=True)]
        for reader in readers:
            reader.start()
        try:
            self.track = self.sc.push_begin(1, c.fps, c.width, c.height)
            last_packet, next_preview, next_error_check = time.monotonic(), 0, 0
            with DesktopCapture(monitor, c.show_cursor) as capture:
                while not stop.is_set():
                    try:
                        packet = packets.get(timeout=0.15)
                    except queue.Empty:
                        if time.monotonic()-last_packet > 10:
                            raise RuntimeError("编码器 10 秒未输出画面："+"\n".join(errors))
                        continue
                    if packet is None:
                        raise RuntimeError("编码器已退出："+"\n".join(errors))
                    last_packet = time.monotonic()
                    self.sc.push_frame(self.track, packet)
                    self._stats(len(packet), 1.0)
                    if last_packet >= next_error_check:
                        for _, error, _, _ in self.sc.read_frames(timeout=0.001):
                            if error and error[0]:
                                raise RuntimeError("设备播放失败："+error[1].decode("utf-8", "replace"))
                        next_error_check = last_packet+1
                    if last_packet >= next_preview:
                        preview = resize_frame(capture.grab(), c)
                        preview.thumbnail((640, 360))
                        self.emit("preview", preview)
                        next_preview = last_packet+0.75
        finally:
            local_stop.set()
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
            for reader in readers:
                reader.join(timeout=2)
            proc.stdout.close()
            proc.stderr.close()

    def run(self, stop_event):
        error = None
        monitors = enumerate_monitors()
        monitor = next((m for m in monitors if m["index"] == self.config.monitor), None)
        if monitor is None:
            raise ValueError("所选显示器已断开，请重新选择")
        if self.config.mode == "full" and not (self.resources_dir / "ffmpeg" / "ffmpeg.exe").is_file():
            raise FileNotFoundError("缺少随附的 ffmpeg/ffmpeg.exe，请完整解压便携包")
        try:
            self._deploy(stop_event)
            self._cancel(stop_event)
            self.sc, info = _open_device(stop_event)
            if info.get("app") != DAEMON_VERSION:
                raise RuntimeError("屏幕服务在开始串流前退出，请重试")
            self.started = self.last_stats = time.monotonic()
            self.emit("status", "正在串流 · " + ("全量刷新" if self.config.mode == "full" else "局部刷新"))
            (self._full if self.config.mode == "full" else self._delta)(stop_event, monitor)
        except InterruptedError:
            if not stop_event.is_set():
                raise
        except Exception as exc:
            error = exc
        finally:
            self.emit("status", "正在停止并恢复屏幕…")
            if self.sc is not None:
                try:
                    if self.track is not None:
                        self.sc.push_end(self.track)
                except Exception as exc:
                    self.log("结束信号未确认："+str(exc))
                finally:
                    self.sc.close()
                    self.sc = None
            if self.takeover:
                try:
                    # Give the daemon's graceful exit/supervisor time to release USB.
                    time.sleep(1.1)
                    restored = restore_device(self.log)
                    self.emit("device", restored)
                except Exception as exc:
                    self.log("恢复检查失败："+str(exc))
                    if error is None:
                        error = RuntimeError("串流已结束，但尚未确认原厂界面恢复。请点击“恢复屏幕”。"+str(exc))
            self.emit("status", "已停止" if error is None else "串流出错")
        if error is not None:
            raise error
