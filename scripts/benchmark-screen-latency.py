"""Measure real raw BGRA -> H.264 bridge latency without opening USB.

Runs the actual PanelStreamSession encoder/packet queue against a synthetic latest
frame source and a fake USB sink. A timed sink stall exercises backlog recovery.
The FIFO association relies on the production encoder's no-B-frame, one-AU-per-
input configuration; missing/reordered raw inputs fail rather than invent ages.
These numbers exclude Electron paint, USB hardware, device decode and display.

Example: python scripts/benchmark-screen-latency.py --baseline-ref main
Use the bridge build's Python environment (Pillow is required).
"""
from __future__ import annotations

import argparse
from collections import deque
import importlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


class SyntheticFrames:
    """Only retain the latest complete frame, just like the production reader."""
    def __init__(self, width, height, fps, stop):
        self.width, self.height, self.fps, self.stop = width, height, fps, stop
        self.available, self.lock = threading.Event(), threading.Lock()
        self.latest, self.received, self.error = None, 0, None
        self.metadata = {}
        self.thread = threading.Thread(target=self.generate, daemon=True)

    def snapshot(self):
        with self.lock:
            return self.latest, self.received

    def frame_metadata(self, frame):
        with self.lock:
            return dict(self.metadata[id(frame)])

    def generate(self):
        from PIL import Image, ImageDraw
        background = Image.new("RGB", (self.width, self.height), (20, 28, 40))
        draw = ImageDraw.Draw(background)
        for x in range(0, self.width, 32):
            draw.line((x, 0, x, self.height), fill=(45, 55, 70), width=1)
        for y in range(0, self.height, 32):
            draw.line((0, y, self.width, y), fill=(45, 55, 70), width=1)
        due = time.perf_counter()
        try:
            while not self.stop.is_set():
                image = background.copy()
                draw = ImageDraw.Draw(image)
                x = self.received * 11 % max(1, self.width - 32)
                draw.rectangle((x, 4, min(self.width - 1, x + 80), self.height - 5),
                               fill=(100 + self.received % 120, 80, 130))
                frame = image.tobytes("raw", "BGRX")
                with self.lock:
                    self.received += 1
                    self.latest = frame
                    self.metadata[id(frame)] = dict(sequence=self.received, captured=time.perf_counter())
                    # Metadata only: old multi-megabyte bitmaps are not retained.
                    while len(self.metadata) > 256:
                        self.metadata.pop(next(iter(self.metadata)))
                self.available.set()
                due = max(due + 1 / self.fps, time.perf_counter())
                self.stop.wait(max(0, due - time.perf_counter()))
        except Exception as exc:
            self.error = exc
            self.stop.set()


class TracedInput:
    """Observe full raw writes without changing pipe sizes or buffering."""
    def __init__(self, stream, incoming, submitted, lock, frame_bytes):
        self.stream, self.incoming, self.submitted, self.lock = stream, incoming, submitted, lock
        self.frame_bytes, self.offset, self.record = frame_bytes, 0, None

    def write(self, data):
        if self.offset == 0:
            self.record = self.incoming.frame_metadata(data.obj)
            self.record["writeStarted"] = time.perf_counter()
            self.record["writeCompleted"] = None
            with self.lock:
                self.submitted.append(self.record)
        count = self.stream.write(data)
        self.offset += count or 0
        if self.offset == self.frame_bytes:
            self.record["writeCompleted"] = time.perf_counter()
            self.offset = 0
        elif self.offset > self.frame_bytes:
            raise AssertionError("encoder input crossed an untracked frame boundary")
        return count

    def __getattr__(self, name):
        return getattr(self.stream, name)


def measure(args):
    sys.path.insert(0, str(args.bridge_root))
    bridge = importlib.import_module("app.panel_stream_bridge")
    # Fail closed: this harness must never enumerate, deploy or open USB.
    def forbidden_usb(*_args, **_kwargs):
        raise AssertionError("USB access is forbidden in the latency benchmark")
    bridge.streaming._protocol = forbidden_usb
    bridge.streaming._open_device = forbidden_usb
    config = bridge.streaming.StreamConfig(width=args.width, height=args.height,
                                           fps=args.fps, bitrate_mbps=args.bitrate_mbps).validate()
    encoder_command = bridge.raw_ffmpeg_command(bridge.encoder_path(args.resources), config)
    if not any("bframes=0" in item for item in encoder_command):
        raise AssertionError("FIFO benchmark requires an encoder without B-frame reordering")
    if not bridge.encoder_path(args.resources).is_file():
        raise FileNotFoundError("Build/provide the bundled FFmpeg resources first")
    stop, trace_lock = threading.Event(), threading.Lock()
    incoming = SyntheticFrames(args.width, args.height, args.fps, stop)
    submitted, delivered, events, processes = deque(), [], [], []
    started, stall_start, stall_end = time.perf_counter(), None, None
    real_popen = subprocess.Popen

    def spawn(*command, **kwargs):
        process = real_popen(*command, **kwargs)
        process.stdin = TracedInput(process.stdin, incoming, submitted, trace_lock,
                                   args.width * args.height * 4)
        processes.append(process)
        return process

    bridge.subprocess = SimpleNamespace(Popen=spawn, PIPE=subprocess.PIPE,
                                       CREATE_NO_WINDOW=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                       TimeoutExpired=subprocess.TimeoutExpired)

    class Sink:
        def push_begin(self, *_args):
            return 1

        def push_frame(self, _track, packet):
            nonlocal stall_start, stall_end
            if not packet:
                raise AssertionError("empty encoded packet")
            if args.stall_ms and stall_start is None and time.perf_counter() - started >= args.seconds / 2:
                stall_start = time.perf_counter()
                stop.wait(args.stall_ms / 1000)
                stall_end = time.perf_counter()
            with trace_lock:
                if not submitted:
                    raise AssertionError("encoded AU has no matching raw frame")
                item = submitted.popleft()
            now = time.perf_counter()
            delivered.append(dict(sequence=item["sequence"], elapsed=now - started,
                                  ageMs=(now - item["captured"]) * 1000,
                                  encoderMs=(now - item["writeStarted"]) * 1000,
                                  bytes=len(packet)))

        def read_frames(self, **_kwargs):
            return []

    session = bridge.PanelStreamSession(config, args.resources, lambda *event: events.append(event),
                                       source=None, dry_run=False)
    session.sc = Sink()
    session._deploy = forbidden_usb
    session.started = session.last_stats = started
    incoming.thread.start()
    timer = threading.Timer(args.seconds, stop.set)
    timer.start()
    try:
        session._raw(stop, incoming)
    finally:
        stop.set()
        timer.cancel()
        incoming.thread.join(timeout=3)
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    if incoming.error:
        raise incoming.error
    if len(delivered) < args.fps:
        raise AssertionError(f"too few encoded frames: {len(delivered)}")
    # Keep startup and the injected transport stall out of normal steady samples.
    steady = [item for item in delivered if 1 <= item["elapsed"] < args.seconds / 2]
    if not steady:
        raise AssertionError("no steady-state samples")
    ages = [item["ageMs"] for item in steady]
    p95 = percentile(ages, .95)
    recovery = None
    if stall_end:
        threshold = p95 + 1000 / args.fps
        after_stall = [item for item in delivered if item["elapsed"] + started >= stall_end]
        for index in range(len(after_stall) - 2):
            if all(item["ageMs"] <= threshold for item in after_stall[index:index + 3]):
                recovery = max(0, after_stall[index]["elapsed"] + started - stall_end) * 1000
                break
    result = dict(deviceAccess=False, source=str(args.bridge_root), width=args.width,
                  height=args.height, fps=args.fps, encodedFrames=len(delivered),
                  generatedFrames=incoming.received, steadySamples=len(steady),
                  firstPacketMs=round(delivered[0]["elapsed"] * 1000, 2),
                  steadyAgeMedianMs=round(statistics.median(ages), 2),
                  steadyAgeP95Ms=round(p95, 2),
                  steadyEncoderMedianMs=round(statistics.median(item["encoderMs"] for item in steady), 2),
                  maximumAgeMs=round(max(item["ageMs"] for item in delivered), 2),
                  simulatedStallMs=args.stall_ms,
                  recoveryAfterStallMs=None if recovery is None else round(recovery, 2),
                  limitation="Host raw-frame availability to fake USB sink only; excludes Electron, real USB and display")
    if args.samples:
        result["samples"] = delivered
    return result


def run_child(args, bridge_root):
    command = [sys.executable, str(Path(__file__).resolve()), "--bridge-root", str(bridge_root),
               "--resources", str(args.resources.resolve()), "--width", str(args.width),
               "--height", str(args.height), "--fps", str(args.fps),
               "--bitrate-mbps", str(args.bitrate_mbps), "--seconds", str(args.seconds),
               "--stall-ms", str(args.stall_ms)]
    if args.samples:
        command.append("--samples")
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                            timeout=args.seconds + 30, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, default=ROOT / "screen-bridge" / "resources")
    parser.add_argument("--baseline-ref", help="Compare a Git revision without switching the working tree")
    parser.add_argument("--bridge-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--width", type=int, default=1120)
    parser.add_argument("--height", type=int, default=540)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bitrate-mbps", type=int, default=8)
    parser.add_argument("--seconds", type=float, default=6)
    parser.add_argument("--stall-ms", type=int, default=250)
    parser.add_argument("--samples", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.seconds < 4 or args.seconds > 60 or not 0 <= args.stall_ms <= 2000:
        parser.error("seconds must be 4–60 and stall-ms must be 0–2000")
    if args.bridge_root:
        result = measure(args)
    else:
        result = {}
        if args.baseline_ref:
            revision = subprocess.check_output(["git", "rev-parse", "--verify", args.baseline_ref + "^{commit}"],
                                               cwd=ROOT, text=True).strip()
            with tempfile.TemporaryDirectory(prefix="ai-watch-latency-") as directory:
                root = Path(directory) / "screen-bridge"
                (root / "app").mkdir(parents=True)
                for name in ("__init__.py", "panel_stream_bridge.py", "streaming.py", "delta.py"):
                    source = subprocess.check_output(["git", "show", f"{revision}:screen-bridge/app/{name}"], cwd=ROOT)
                    (root / "app" / name).write_bytes(source)
                result["baseline"] = run_child(args, root)
                result["baseline"]["source"] = revision
        result["current"] = run_child(args, ROOT / "screen-bridge")
        result["current"]["source"] = "working-tree"
    output = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
