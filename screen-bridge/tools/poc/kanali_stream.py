#!/usr/bin/env python3
"""
KANALI / TRYX PANORAMA PASE_1021 (2240x1080) —— 本地实时视频流 PoC
Windows usbprint / macOS libusb 传输；共享 TRYX 协议和设备生命周期。

协议来源（全部来自本仓库分析证据，见 analysis/）：
  analysis/protocol-schema.md   —— 确定性 .proto（从 UDB.exe .rdata 的 FileDescriptorProto 还原）
  analysis/udb-native.md        —— USB 帧/超时/MediaPush 线程竞态
  analysis/media-container.md   —— 媒体容器 [u32LE header_len][MediaHeaderPb][payload]
  analysis/stream-feasibility.md—— 可行性、参数建议、测试顺序

USB 帧： "TRYX"(4B) + uint32_le(body_len)(4B) + ReqPackagePb/RspPackagePb(protobuf)
推流：   ReqPackagePb.media_push_begin=407{format,fps,w,h}
         ReqPackagePb.media_push_data =408{bytes media_data}   # 一帧 = 1 个 JPEG 或 1 个 H.264 access unit
         ReqPackagePb.media_push_end  =409{}

安全提示：
  * 必须完全退出 KANALI（含 Screen.exe / UDB.exe），否则设备被占用。
  * 不要调用 SysCtl* / File_Transmit OTA 等命令（有风险），本脚本不包含。
  * 先运行 --info 验证链路；再 --test-pattern 或 --stream-h264。
  * 失败/异常时设备可能停留在上一帧或黑屏；重新跑 KANALI 或重插即可恢复（推测）。

用法：
  python kanali_stream.py --devices
  python kanali_stream.py --info
  python kanali_stream.py --stream-h264 --source screen --fps 30 --bitrate 10M
  python kanali_stream.py --stream-h264 --source "D:\\movie.mp4" --fps 30
  python kanali_stream.py --stream-mjpeg --source screen --fps 15
  python kanali_stream.py --image frame.jpg --fps 10          # 静态 JPEG 循环推
  python kanali_stream.py --send-container C:\\...\\foo.h264_2240x1080   # 用文件容器走 MediaPush（UDB 同款语义）
"""
import argparse
import os
import re
import struct
import subprocess
import sys
import threading
import time

# ============================================================ protobuf wire
def varint(n):
    if not 0 <= n < 2**64:
        raise ValueError("uint64 out of range")
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out) + bytes([n])

def read_varint(data, pos):
    n = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise ValueError("Truncated varint")
        v = data[pos]
        pos += 1
        n |= (v & 127) << shift
        if not v & 128:
            return n, pos
    raise ValueError("Varint overflow")

def field(number, value):
    if isinstance(value, int):
        return varint(number << 3) + varint(value)
    if isinstance(value, str):
        value = value.encode("utf-8")
    return varint(number << 3 | 2) + varint(len(value)) + value

def fields(data):
    pos, out = 0, []
    while pos < len(data):
        tag, pos = read_varint(data, pos)
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = read_varint(data, pos)
        elif wire == 2:
            size, pos = read_varint(data, pos)
            value, pos = data[pos:pos + size], pos + size
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value, pos = data[pos:pos + size], pos + size
        else:
            raise ValueError("Unsupported wire type")
        out.append((number, wire, value))
    return out

def get(data, number, default=None):
    if not data:
        return default
    vals = [v for n, _, v in fields(data) if n == number]
    return vals[-1] if vals else default

# ============================================================ TRYX frames
MAX_PAYLOAD = 64 * 1024 * 1024  # UDB 合法上限 0x4000000

def frame(payload):
    if not 0 < len(payload) <= MAX_PAYLOAD:
        raise ValueError(f"invalid frame size {len(payload)}")
    return b"TRYX" + struct.pack("<I", len(payload)) + payload

def request(command, body, track, version=1):
    header = field(1, version) + field(2, track)
    return frame(field(1, header) + field(command, body))

def replace(data, updates):
    """按字段号替换 protobuf 字段，保留其它字段原始字节。"""
    out, seen = [], set()
    for n, wire, raw_start in _field_spans(data):
        if n in updates:
            continue
        out.append(raw_start)
    for n, v in updates.items():
        out.append(field(n, v))
    return b"".join(out)

def _field_spans(data):
    """返回 [(field_number, wire, raw_bytes)]，用于 replace。"""
    pos, out = 0, []
    while pos < len(data):
        start = pos
        tag, pos = read_varint(data, pos)
        n, wire = tag >> 3, tag & 7
        if wire == 0:
            _, pos = read_varint(data, pos)
        elif wire == 2:
            size, pos = read_varint(data, pos)
            pos += size
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        else:
            raise ValueError("bad wire")
        out.append((n, wire, data[start:pos]))
    return out

def take_frame(buf):
    if len(buf) < 8:
        return None
    if buf[:4] != b"TRYX":
        raise ValueError("bad magic")
    size = struct.unpack_from("<I", buf, 4)[0]
    if not 0 < size <= MAX_PAYLOAD:
        raise ValueError("bad frame length")
    if len(buf) < 8 + size:
        return None
    payload = bytes(buf[8:8 + size])
    del buf[:8 + size]
    return payload

# ============================================================ 平台传输选择
# Keep protocol parsing independent of native USB APIs and delayed until needed.
_resources_dir = None


def configure_resources(resources_dir):
    """Choose the same bundled resources as the panel bridge's --resources."""
    global _resources_dir
    _resources_dir = resources_dir


def _backend():
    if sys.platform == "win32":
        import usb_windows
        return usb_windows
    if sys.platform == "darwin":
        import usb_macos
        return usb_macos
    raise RuntimeError("展域 USB 串流仅支持 Windows 或 macOS 15 及以上")


def backend_check(resources_dir=None):
    """Validate local libraries without enumerating or claiming USB devices."""
    return _backend().backend_check(_resources_dir if resources_dir is None else resources_dir)


def devices():
    backend = _backend()
    return backend.devices(_resources_dir) if sys.platform == "darwin" else backend.devices()

# ============================================================ 客户端
class Screen:
    def __init__(self, path=None):
        paths = devices()
        if path is None:
            if len(paths) != 1:
                raise RuntimeError(f"期望 1 个 PASE 屏幕，实际找到 {len(paths)}：{paths}")
            path = paths[0]
        backend = _backend()
        self.transport = backend.Transport(path, _resources_dir) if sys.platform == "darwin" else backend.Transport(path)
        self.path = path
        self.read_error = None
        self.track = int(time.time() * 1000) & 0xFFFFFF
        self.buffer = bytearray()
        self.syncing = True
        self.rx = []
        self.rx_lock = threading.Lock()
        self.stop = False
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        try:
            self.reader.start()
        except Exception:
            self.transport.close()
            raise

    # ---- 低层 ----
    def _read_loop(self):
        try:
            while not self.stop:
                try:
                    chunk = self.transport.read(1000)
                except TimeoutError:
                    continue
                if chunk:
                    with self.rx_lock:
                        self.rx.append(chunk)
        except (OSError, RuntimeError) as exc:
            if not self.stop:
                self.read_error = exc
        finally:
            self.transport.finish_read()

    def write(self, data, timeout_ms=5000):
        if self.read_error is not None:
            raise self.read_error
        self.transport.write(data, timeout_ms)

    def _drain(self):
        if self.read_error is not None:
            raise self.read_error
        with self.rx_lock:
            chunks, self.rx = self.rx, []
        for ch in chunks:
            self.buffer.extend(ch)

    def command(self, cmd, body=b"", expected=None, track=None, version=1, timeout=5.0):
        if track is None:
            self.track += 1
            track = self.track
        data = request(cmd, body, track, version)
        self.write(data, 5000 if cmd in (400, 401, 402) else 2000)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._drain()
            try:
                payload = take_frame(self.buffer)
            except ValueError:
                payload = None
                # 重同步
                off = self.buffer.find(b"TRYX")
                del self.buffer[:off if off > 0 else 1]
                continue
            if payload is None:
                time.sleep(0.002)
                continue
            header = get(payload, 1)
            if header is None or get(header, 2, 0) != track:
                continue
            error = get(payload, 2, b"")
            if get(error, 1, 0):
                raise RuntimeError(f"device error {get(error, 1)}: {get(error, 2, b'')!r}")
            if expected is None:
                return payload
            body2 = get(payload, expected)
            if body2 is None:
                continue
            if expected in (800, 801, 802) and get(body2, 1, 0) != 0:
                raise RuntimeError(f"transfer rejected status={get(body2, 1)}")
            return body2
        if expected is None:
            return None
        raise TimeoutError(f"no response for cmd={cmd} track={track}")

    # ---- 信息 ----
    def info(self):
        body = self.command(100, expected=500)
        names = {1: "os", 2: "os_version", 3: "firmware", 4: "product", 5: "app",
                 8: "serial", 9: "sn_locked", 10: "chip_id"}
        return {names[n]: (v.decode("utf-8", "replace") if isinstance(v, bytes) else v)
                for n, _, v in fields(body) if n in names}

    def sys_config(self):
        body = self.command(102, expected=502)
        out = {}
        for n, _, v in fields(body):
            if n in (10, 11, 12):
                out[{10: "vdec", 11: "vpss", 12: "vo"}[n]] = {
                    m: vv for m2, _, vv in fields(v) for m in [m2]}
        return out

    def file_list(self):
        body = self.command(103, expected=503, timeout=8)
        return [{"path": get(v, 1, b"").decode("utf-8", "replace"),
                 "size": get(v, 3, 0), "preset": (n == 2)}
                for n, wire, v in fields(body) if n in (1, 2)]

    # ---- 文件上传 / 显示配置（本地视频路径） ----
    def get_user_config(self):
        return self.command(104, expected=504, timeout=8)

    def upload(self, path, remote, progress=print):
        size = os.path.getsize(path)
        if not 0 < size <= 256 * 1024 * 1024:
            raise ValueError("文件大小需在 1B..256MiB")
        track = self.track = self.track + 1
        self.command(400, field(1, remote) + field(2, size), 800, track, version=0, timeout=30)
        sent = 0
        with open(path, "rb") as f:
            while True:
                chunk = f.read(0x40000)
                if not chunk:
                    break
                self.command(401, field(1, chunk), 801, track, version=0, timeout=30)
                sent += len(chunk)
                if progress and sent % (0x40000 * 4) < 0x40000:
                    progress(f"[*] upload {sent}/{size}")
        if sent != size:
            raise RuntimeError("上传过程中源文件变化")
        self.command(402, field(1, "media"), 802, track, version=0, timeout=30)
        if progress:
            progress(f"[*] upload done {size} bytes")

    def apply_media(self, remote):
        old = self.get_user_config()
        work, display = get(old, 3), get(old, 5)
        if work is None or display is None:
            raise RuntimeError("设备配置不完整，拒绝臆造默认值")
        new_work = replace(work, {1: 0, 2: 0, 3: remote})   # Single 模式
        new_display = replace(display, {1: 1})              # 打开背光
        new = replace(old, {3: new_work, 5: new_display})
        self.command(200, new, 600, version=1, timeout=8)
        self.command(201, b"", None, version=1, timeout=1.0)  # 空 OverlayLayout，可选 ack
        rb = self.get_user_config()
        got = get(get(rb, 3, b""), 3, b"")
        if got != remote.encode():
            raise RuntimeError(f"写后回读不一致: {got!r} != {remote!r}")
        return old

    def restore_config(self, saved):
        self.command(200, saved, 600, version=1, timeout=8)
        self.command(201, b"", None, version=1, timeout=1.0)
        rb = self.get_user_config()
        ok = get(get(rb, 3, b""), 3, b"") == get(get(saved, 3, b""), 3, b"")
        return ok

    # ---- MediaPush ----
    def push_begin(self, payload_format, fps, width, height, track=None):
        if track is None:
            track = self.track = self.track + 1
        body = field(1, payload_format) + field(2, fps) + field(3, width) + field(4, height)
        self.write(request(407, body, track, 1), 2000)
        return track

    def push_frame(self, track, data):
        self.write(request(408, field(1, data), track, 1), 200)

    def push_end(self, track):
        self.write(request(409, b"", track, 1), 2000)

    def send_raw(self, data, timeout_ms=2000):
        """直接写一帧并返回其消耗的字节数（不做响应等待）。"""
        self.write(data, timeout_ms)

    def read_frames(self, timeout=1.0):
        """在 timeout 内收集并解析所有 RspPackagePb 帧，返回 [(track, error, top_fields)]。"""
        deadline = time.monotonic() + timeout
        out = []
        while time.monotonic() < deadline:
            self._drain()
            while True:
                try:
                    payload = take_frame(self.buffer)
                except ValueError:
                    off = self.buffer.find(b"TRYX")
                    del self.buffer[:off if off > 0 else 1]
                    payload = None
                if payload is None:
                    break
                header = get(payload, 1)
                track = get(header, 2, 0) if header else 0
                error = get(payload, 2, b"")
                err = (get(error, 1, 0), get(error, 2, b"")) if error else None
                tops = [(n, w) for n, w, _ in fields(payload)]
                out.append((track, err, tops, payload))
            time.sleep(0.005)
        return out

    def close(self):
        if self.stop:
            return
        self.stop = True
        # The native handle must outlive the reader's transfer buffer.
        self.transport.cancel()
        self.reader.join()
        self.transport.close()

# ============================================================ 视频源
def ffmpeg_bin():
    for cand in [os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg.exe"),
                 r"C:\Program Files\KANALI\resources\Connect\ffmpeg\ffmpeg.exe"]:
        if os.path.isfile(cand):
            return cand
    return "ffmpeg"

def ffmpeg_source(src, fps, w, h, codec, bitrate, duration=0):
    ff = ffmpeg_bin()
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1")
    base = [ff, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if src == "screen":
        base += ["-f", "gdigrab", "-framerate", str(fps), "-i", "desktop"]
        if duration:
            base += ["-t", str(duration)]
    elif src == "test":
        base += ["-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate={fps}"]
        if duration:
            base += ["-t", str(duration)]
    else:
        base += ["-re", "-stream_loop", "-1", "-i", src]
        if duration:
            base += ["-t", str(duration)]
    if codec == "h264":
        base += ["-map", "0:v:0", "-an", "-vf", vf + ",format=yuv420p",
                 "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                 "-profile:v", "main", "-level", "4.1", "-b:v", bitrate,
                 "-x264-params", f"aud=1:repeat-headers=1:annexb=1:keyint={max(1, fps)}:min-keyint={max(1, fps)}:scenecut=0:bframes=0",
                 "-f", "h264", "-"]
    else:
        base += ["-map", "0:v:0", "-an", "-vf", vf,
                 "-c:v", "mjpeg", "-q:v", "7", "-f", "mjpeg", "-"]
    print("[*] ffmpeg:", " ".join(base))
    return subprocess.Popen(base, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

def iter_h264_aus(stream, chunk_size=65536):
    """从 Annex-B 流中增量切出 access unit（以 AUD(09) 为 AU 边界）。"""
    buf = b""
    while True:
        chunk = stream.read(chunk_size)
        if not chunk:
            break
        buf += chunk
        # 找 AUD 起点
        starts = [m.start() for m in re.finditer(b"\x00\x00\x01\x09", buf)]
        if len(starts) >= 2:
            # 只在 "倒数第二个 AUD 之前" 切，保留最后一个可能未完成的 AU
            cut = starts[-1]
            if cut > 0 and buf[cut - 1] == 0:
                cut -= 1
            segment = buf[:cut]
            buf = buf[cut:]
            # segment 内的 AU 数 = starts 里 < cut 的个数
            seg_starts = [m.start() for m in re.finditer(b"\x00\x00\x01\x09", segment)]
            for i in range(len(seg_starts)):
                s = seg_starts[i]
                e = seg_starts[i + 1] if i + 1 < len(seg_starts) else len(segment)
                if s > 0 and segment[s - 1] == 0:
                    s -= 1
                au = segment[s:e]
                if au:
                    yield au
    if buf:
        yield buf

# ============================================================ 模式
def prepare_h264(src, out, fps=30, w=2240, h=1080, bitrate="10M"):
    ff = ffmpeg_bin()
    ext = os.path.splitext(src)[1].lower()
    still = ext in (".png", ".jpg", ".jpeg", ".bmp", ".webp")
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if still:
        cmd += ["-loop", "1", "-framerate", str(fps), "-t", "10", "-i", src]
    else:
        cmd += ["-i", src]
    cmd += ["-map", "0:v:0", "-an", "-vf", vf + ",format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-level", "4.1",
            "-b:v", bitrate, "-g", str(max(1, fps)),
            "-x264-params", "aud=1:repeat-headers=1:annexb=1", "-f", "h264", out]
    print("[*] ffmpeg:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    return out

def cmd_upload(args):
    sc = Screen()
    try:
        print("[*] opened", sc.path)
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "saved_config.bin")
        old = sc.get_user_config()
        open(cfg_path, "wb").write(old)
        print(f"[*] 原配置已保存: {cfg_path} ({len(old)} bytes)")
        name = args.remote_name or (time.strftime("%Y-%m-%d_%H-%M-%S") + ".mp4.h264_2240x1080")
        tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upload.h264")
        prepare_h264(args.upload, tmp, args.fps, args.width, args.height, args.bitrate)
        print(f"[*] 编码后裸流: {tmp} ({os.path.getsize(tmp)} bytes) -> /userdata/user/{name}")
        sc.upload(tmp, name)
        if not args.no_apply:
            sc.apply_media(name)
            print("[*] 已切换显示; 设备应开始播放该本地视频")
        if args.restore_after:
            time.sleep(args.restore_after)
            ok = sc.restore_config(old)
            print(f"[*] 已尝试恢复原配置: {ok}")
    finally:
        sc.close()

def cmd_devices():
    for p in devices():
        print(p)

def run_stream(args):
    sc = Screen()
    print("[*] opened", sc.path, "track", sc.track)
    info = sc.info()
    print("[*] device:", info)
    fps, w, h = args.fps, args.width, args.height
    if args.stream_h264:
        fmt = 1
        proc = ffmpeg_source(args.source, fps, w, h, "h264", args.bitrate, args.duration)
        track = sc.push_begin(fmt, fps, w, h)
        print(f"[*] media_push_begin H264Raw fps={fps} {w}x{h} track={track}")
        sent = 0
        t0 = time.time()
        try:
            for au in iter_h264_aus(proc.stdout):
                sc.push_frame(track, au)
                sent += 1
                if sent % max(1, fps) == 0:
                    print(f"\r[*] {sent} frames  {sent/(time.time()-t0):.1f} fps  ", end="")
                if args.pace:
                    due = t0 + sent / fps
                    dt = due - time.time()
                    if dt > 0:
                        time.sleep(dt)
        except KeyboardInterrupt:
            pass
        finally:
            print("\n[*] media_push_end")
            sc.push_end(track)
            try: proc.kill()
            except Exception: pass
    elif args.stream_mjpeg:
        fmt = 2
        proc = ffmpeg_source(args.source, fps, w, h, "mjpeg", args.bitrate, args.duration)
        track = sc.push_begin(fmt, fps, w, h)
        print(f"[*] media_push_begin MJPEGRaw fps={fps} {w}x{h} track={track}")
        buf = b""
        sent = 0
        t0 = time.time()
        try:
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    s = buf.find(b"\xff\xd8")
                    if s < 0:
                        buf = buf[-2:] if len(buf) > 2 else buf
                        break
                    e = buf.find(b"\xff\xd9", s + 2)
                    if e < 0:
                        buf = buf[s:]
                        break
                    jpg = buf[s:e + 2]
                    buf = buf[e + 2:]
                    sc.push_frame(track, jpg)
                    sent += 1
                    if sent % max(1, fps) == 0:
                        print(f"\r[*] {sent} frames  {sent/(time.time()-t0):.1f} fps  ", end="")
                    if args.pace:
                        due = t0 + sent / fps
                        dt = due - time.time()
                        if dt > 0:
                            time.sleep(dt)
        except KeyboardInterrupt:
            pass
        finally:
            print("\n[*] media_push_end")
            sc.push_end(track)
            try: proc.kill()
            except Exception: pass
    elif args.image:
        data = open(args.image, "rb").read()
        track = sc.push_begin(2, args.fps, 2240, 1080)
        print(f"[*] push static JPEG {len(data)} bytes")
        try:
            while True:
                sc.push_frame(track, data)
                time.sleep(1.0 / args.fps)
        except KeyboardInterrupt:
            pass
        finally:
            sc.push_end(track)
    elif args.send_container:
        import io
        data = open(args.send_container, "rb").read()
        if data[:4] == b"TRYX":
            print("[!] 这是 USB 帧文件，不是媒体容器；改用 --raw-frames")
            return
        hlen = struct.unpack_from("<I", data, 0)[0]
        head = data[4:4 + hlen]
        payload = data[4 + hlen:]
        fmt = get(head, 4, 0)
        rfps = get(head, 5, 30)
        width = get(head, 6, 2240)
        height = get(head, 7, 1080)
        print(f"[*] container: format={fmt} fps={rfps} {width}x{height} header={hlen} payload={len(payload)}")
        track = sc.push_begin(fmt, rfps, width, height)
        sent = 0
        if fmt == 1:
            for au in iter_h264_aus(io.BytesIO(payload)):
                sc.push_frame(track, au)
                sent += 1
        else:
            pos = 0
            while True:
                s = payload.find(b"\xff\xd8", pos)
                if s < 0:
                    break
                e = payload.find(b"\xff\xd9", s + 2)
                if e < 0:
                    break
                sc.push_frame(track, payload[s:e + 2])
                sent += 1
                pos = e + 2
        print(f"[*] pushed {sent} frames")
        sc.push_end(track)
    sc.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--devices", action="store_true")
    ap.add_argument("--info", action="store_true")
    ap.add_argument("--stream-h264", action="store_true")
    ap.add_argument("--stream-mjpeg", action="store_true")
    ap.add_argument("--source", default="screen")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--width", type=int, default=2240)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--bitrate", default="10M")
    ap.add_argument("--image")
    ap.add_argument("--send-container")
    ap.add_argument("--upload", help="本地视频/图片：转码为裸 Annex-B 后上传并切换显示")
    ap.add_argument("--remote-name", help="设备端文件名，默认自动生成")
    ap.add_argument("--no-apply", action="store_true", help="只上传，不切换显示")
    ap.add_argument("--restore-after", type=int, default=0, help="显示 N 秒后恢复原配置")
    ap.add_argument("--duration", type=int, default=0, help="秒；0=无限")
    ap.add_argument("--no-pace", dest="pace", action="store_false", help="不限速（默认按 fps 节流）")
    ap.set_defaults(pace=True)
    args = ap.parse_args()
    if args.devices:
        return cmd_devices()
    if args.info:
        sc = Screen()
        try:
            print("device:", sc.info())
            print("sys_config:", sc.sys_config())
            for f in sc.file_list()[:40]:
                print("  ", f)
        finally:
            sc.close()
        return
    if args.upload:
        return cmd_upload(args)
    return run_stream(args)

if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, TimeoutError) as e:
        print("[!]", e, file=sys.stderr)
        raise SystemExit(1)
