"""Stream Electron offscreen BGRA frames to a supported cooling screen.

stdin contains consecutive width * height * 4 byte BGRA frames, with no headers.
stdout is newline-delimited JSON. Closing stdin stops the stream and restores the
vendor UI. The parent must keep stdout/stderr drained and honour stdin backpressure.
This bridge never captures the desktop and never accepts renderer commands.
"""
from __future__ import annotations

import argparse
from collections import deque
import json
import os
import platform
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "poc"))

try:
    from . import streaming
except ImportError:
    import streaming


DEVICE_ID = "zhanyu"
PROTOCOL_VERSION = 1


def default_resources():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "resources"
    return ROOT / "resources"


def encoder_path(resources):
    return Path(resources) / "ffmpeg" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")


def usb_platform_error():
    if os.name == "nt":
        return None
    if sys.platform != "darwin":
        return "展域 USB 串流需要 Windows 或 macOS 15 及以上；其他平台可以使用面板预览"
    version = platform.mac_ver()[0].split(".")[0]
    if not version.isdigit() or int(version) < 15:
        return "Mac USB 串流需要 macOS 15 及以上"
    if platform.machine() not in ("arm64", "x86_64"):
        return "Mac USB 串流支持 Apple Silicon 和 Intel 64 位处理器"
    return None


def validate_runtime(resources, dry_run=False):
    resources = Path(resources)
    if not encoder_path(resources).is_file():
        raise FileNotFoundError("缺少随附的 FFmpeg 编码器；请重新构建完整的 AI Watch 串流组件")
    if dry_run:
        return
    error = usb_platform_error()
    if error:
        raise RuntimeError(error)
    if not (resources / "streamd-arm64").is_file():
        raise FileNotFoundError("缺少 resources/streamd-arm64；请先构建设备端服务")
    if os.name != "nt":
        # Load the bundled native library before any takeover or input worker.
        # Checking its symbols does not enumerate or claim a USB device.
        protocol = streaming._protocol()
        protocol.configure_resources(resources)
        protocol.backend_check(resources)


def unbuffered_input(stream):
    # A daemon thread can still be blocked on an inherited pipe when the encoder
    # or USB fails. Reading BufferedReader would hold its lock during interpreter
    # shutdown and cause CPython's fatal _enter_buffered_busy abort on Windows.
    # FileIO has no buffered lock; process exit closes the outstanding pipe read.
    return getattr(stream, "raw", stream)


def raw_ffmpeg_command(binary, config):
    """Encode the renderer's full BGRA bitmap without desktop/window capture."""
    return [str(binary), "-hide_banner", "-loglevel", "warning", "-nostdin",
            "-f", "rawvideo", "-pixel_format", "bgra", "-video_size",
            f"{config.width}x{config.height}", "-framerate", str(config.fps),
            "-i", "pipe:0", "-an", "-vf", "setsar=1,format=yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-b:v", f"{config.bitrate_mbps}M", "-maxrate", f"{config.bitrate_mbps}M",
            "-bufsize", f"{config.bitrate_mbps}M", "-x264-params",
            f"aud=1:repeat-headers=1:annexb=1:keyint={config.fps}:min-keyint={config.fps}:scenecut=0:bframes=0",
            "-flush_packets", "1", "-f", "h264", "pipe:1"]


class LatestFrameInput:
    """Keep only one complete raw frame; never queue obsolete animation frames."""
    def __init__(self, source, frame_bytes, stop):
        self.source, self.frame_bytes, self.stop = source, frame_bytes, stop
        self.lock = threading.Lock()
        self.available = threading.Event()
        self.latest = None
        self.received = 0
        self.error = None
        self.eof = False
        self.thread = threading.Thread(target=self._read, name="panel-input", daemon=True)

    def start(self):
        self.thread.start()

    def snapshot(self):
        with self.lock:
            return self.latest, self.received

    def _read(self):
        try:
            while not self.stop.is_set():
                frame = bytearray()
                while len(frame) < self.frame_bytes:
                    chunk = self.source.read(min(262144, self.frame_bytes - len(frame)))
                    if not chunk:
                        if frame:
                            raise ValueError("串流帧不完整；请发送完整 BGRA 位图")
                        self.eof = True
                        return
                    frame.extend(chunk)
                with self.lock:
                    self.latest = bytes(frame)
                    self.received += 1
                self.available.set()
        except Exception as exc:
            self.error = exc
        finally:
            self.stop.set()
            self.available.set()


class PanelStreamSession(streaming.StreamSession):
    """Reuse XANALI's device deployment/recovery with a dedicated panel source."""
    def __init__(self, config, resources_dir, emit, source, dry_run=False):
        super().__init__(config, resources_dir, emit)
        self.source, self.dry_run = source, dry_run

    def _raw(self, stop, incoming):
        config = self.config
        binary = encoder_path(self.resources_dir)
        proc = subprocess.Popen(raw_ffmpeg_command(binary, config), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        # Backpressure must preserve H.264 references; never discard encoded P
        # frames. Keep just one waiting access unit so a slow USB write does not
        # turn the four-frame queue into another ~100 ms of lag at 30 FPS.
        packets = queue.Queue(maxsize=1)
        errors = deque(maxlen=12)
        local_stop = threading.Event()

        def enqueue(packet):
            while not local_stop.is_set() and not stop.is_set():
                try:
                    packets.put(packet, timeout=0.1)
                    return
                except queue.Full:
                    pass

        def read_output():
            try:
                for packet in streaming.iter_h264_aus(proc.stdout):
                    if local_stop.is_set() or stop.is_set():
                        return
                    enqueue(packet)
                    if local_stop.is_set() or stop.is_set():
                        return
            except Exception as exc:
                errors.append(str(exc))
            finally:
                enqueue(None)

        def read_errors():
            for line in iter(proc.stderr.readline, b""):
                errors.append(line.decode("utf-8", "replace").strip())

        def write_input():
            next_frame = time.monotonic()
            try:
                while not local_stop.is_set() and not stop.is_set():
                    if not incoming.available.wait(0.1):
                        continue
                    delay = next_frame - time.monotonic()
                    if delay > 0 and local_stop.wait(delay):
                        return
                    if stop.is_set():
                        return
                    # Paint may advance while pacing the encoder. Sample after
                    # the wait so the next write contains the newest full frame,
                    # rather than an image saved up to one frame period earlier.
                    frame, _ = incoming.snapshot()
                    if frame is None:
                        continue
                    # FileIO.write may be short on a pipe. Never mix frame edges.
                    remaining = memoryview(frame)
                    while remaining and not local_stop.is_set() and not stop.is_set():
                        written = proc.stdin.write(remaining)
                        if not written:
                            raise BrokenPipeError("编码器输入已关闭")
                        remaining = remaining[written:]
                    next_frame = max(next_frame + 1 / config.fps, time.monotonic())
            except Exception as exc:
                if not local_stop.is_set() and not stop.is_set():
                    errors.append(str(exc))
                    enqueue(None)
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        readers = [threading.Thread(target=read_output, name="panel-h264", daemon=True),
                   threading.Thread(target=read_errors, name="panel-ffmpeg-errors", daemon=True),
                   threading.Thread(target=write_input, name="panel-encoder-input", daemon=True)]
        try:
            if not self.dry_run:
                self.track = self.sc.push_begin(1, config.fps, config.width, config.height)
            for reader in readers:
                reader.start()
            self.emit("ready", dict(protocol=PROTOCOL_VERSION, device=DEVICE_ID,
                                    width=config.width, height=config.height, fps=config.fps,
                                    pixelFormat="bgra", frameBytes=config.width * config.height * 4,
                                    dryRun=self.dry_run))
            self.emit("status", "正在串流 · AI 面板" if not self.dry_run else "编码自检 · 未连接设备")
            last_packet, next_error_check = time.monotonic(), 0
            while not stop.is_set():
                try:
                    packet = packets.get(timeout=0.15)
                except queue.Empty:
                    if time.monotonic() - last_packet > 10:
                        raise RuntimeError("10 秒未收到有效画面：" + "\n".join(errors))
                    continue
                if packet is None:
                    raise RuntimeError("编码器已退出：" + "\n".join(errors))
                last_packet = time.monotonic()
                if not self.dry_run:
                    self.sc.push_frame(self.track, packet)
                self._stats(len(packet), 1.0)
                if not self.dry_run and last_packet >= next_error_check:
                    for _, error, _, _ in self.sc.read_frames(timeout=0.001):
                        if error and error[0]:
                            raise RuntimeError("设备播放失败：" + error[1].decode("utf-8", "replace"))
                    next_error_check = last_packet + 1
            if incoming.error:
                raise incoming.error
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
                if reader.ident is not None:
                    reader.join(timeout=2)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except OSError:
                    pass

    def run(self, stop):
        error, restored = None, False
        validate_runtime(self.resources_dir, self.dry_run)
        incoming = LatestFrameInput(self.source, self.config.width * self.config.height * 4, stop)
        incoming.start()
        try:
            self._cancel(stop)
            if not self.dry_run:
                self._deploy(stop)
                self._cancel(stop)
                self.sc, info = streaming._open_device(stop)
                if info.get("app") != streaming.DAEMON_VERSION:
                    raise RuntimeError("屏幕服务在开始串流前退出，请重试")
            self.started = self.last_stats = time.monotonic()
            self._raw(stop, incoming)
        except InterruptedError:
            if not stop.is_set():
                raise
        except Exception as exc:
            error = exc
        finally:
            stop.set()
            self.emit("status", "正在停止并恢复屏幕…" if self.takeover else "正在停止…")
            if self.sc is not None:
                try:
                    if self.track is not None:
                        self.sc.push_end(self.track)
                except Exception as exc:
                    self.log("结束信号未确认：" + str(exc))
                finally:
                    self.sc.close()
                    self.sc = None
            if self.takeover:
                try:
                    time.sleep(1.1)
                    info = streaming.restore_device(self.log)
                    restored = True
                    self.emit("device", info)
                except Exception as exc:
                    self.log("恢复检查失败：" + str(exc))
                    error = error or RuntimeError("串流已停止，但尚未确认原厂界面恢复：" + str(exc))
            if incoming.error and error is None:
                error = incoming.error
            if self.started:
                self._stats(rendered=False, force=True)
            self.emit("stopped", dict(restored=restored, dryRun=self.dry_run,
                                      frames=self.frames, failed=error is not None))
        if error:
            raise error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=[DEVICE_ID], default=DEVICE_ID)
    parser.add_argument("--width", type=int, default=2240)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bitrate-mbps", type=int, default=8)
    parser.add_argument("--resources", type=Path, default=default_resources())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Check local runtime files without opening USB")
    mode.add_argument("--dry-run", action="store_true", help="Encode input without accessing any USB device")
    mode.add_argument("--probe", action="store_true", help="Read device information without deploying or starting playback")
    args = parser.parse_args(argv)
    stop, output_lock = threading.Event(), threading.Lock()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n", line_buffering=True)

    def emit(kind, data):
        with output_lock:
            try:
                print(json.dumps(dict(type=kind, data=data), ensure_ascii=False), flush=True)
            except (BrokenPipeError, OSError):
                stop.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_: stop.set())
    try:
        config = streaming.StreamConfig(width=args.width, height=args.height, fps=args.fps,
                                        bitrate_mbps=args.bitrate_mbps, show_cursor=False).validate()
        if args.check:
            encoder = encoder_path(args.resources).is_file()
            daemon = (args.resources / "streamd-arm64").is_file()
            problem = None
            try:
                validate_runtime(args.resources)
            except (OSError, RuntimeError) as exc:
                problem = str(exc)
            emit("check", dict(protocol=PROTOCOL_VERSION, device=DEVICE_ID, encoder=encoder,
                               daemon=daemon, platform=sys.platform,
                               available=problem is None, reason=problem))
            return 0 if problem is None else 1
        if args.probe:
            validate_runtime(args.resources)
            screen = streaming._protocol().Screen()
            try:
                info = screen.info()
                emit("probe", dict(device=DEVICE_ID, platform=sys.platform,
                                   info={key: info[key] for key in ("product", "firmware", "app") if key in info},
                                   playbackStarted=False))
            finally:
                screen.close()
            return 0
        session = PanelStreamSession(config, args.resources, emit, unbuffered_input(sys.stdin.buffer), args.dry_run)
        session.run(stop)
        return 0
    except Exception as exc:
        emit("error", str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
