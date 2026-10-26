"""Exercise real BGRA -> FFmpeg -> H.264 -> NDJSON without opening USB.

Run with the source Python runtime, or --bridge <packaged bridge executable>.
"""
import argparse
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path)
    parser.add_argument("--width", type=int, default=1120)
    parser.add_argument("--height", type=int, default=540)
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    command = [str(args.bridge)] if args.bridge else [sys.executable, str(root / "app" / "panel_stream_bridge.py")]
    command += ["--dry-run", "--width", str(args.width), "--height", str(args.height), "--fps", str(args.fps)]
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    events, messages, errors = queue.Queue(), [], []

    def read_events():
        for line in iter(proc.stdout.readline, b""):
            event = json.loads(line.decode("utf-8"))
            messages.append(event)
            events.put(event)

    def read_errors():
        for line in iter(proc.stderr.readline, b""):
            errors.append(line.decode("utf-8", "replace"))

    readers = [threading.Thread(target=read_events, daemon=True), threading.Thread(target=read_errors, daemon=True)]
    for reader in readers:
        reader.start()
    try:
        deadline = time.monotonic() + 15
        while True:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
            if event["type"] == "ready":
                break
            if event["type"] == "error":
                raise AssertionError(event["data"])
        assert event["data"]["frameBytes"] == args.width * args.height * 4
        assert event["data"]["dryRun"]
        for index in range(args.fps * 2):
            pixel = bytes((index * 5 % 256, index * 3 % 256, 180, 255))
            proc.stdin.write(pixel * (args.width * args.height))
            proc.stdin.flush()
            time.sleep(1 / args.fps)
        # No new paint events: the bridge must keep rendering the last full frame.
        time.sleep(1.2)
        proc.stdin.close()
        result = proc.wait(timeout=15)
        for reader in readers:
            reader.join(timeout=2)
        assert result == 0, (messages, errors)
        assert not [event for event in messages if event["type"] == "error"], messages
        stopped = next(event["data"] for event in messages if event["type"] == "stopped")
        assert stopped["dryRun"] and not stopped["failed"] and not stopped["restored"], stopped
        assert stopped["frames"] >= args.fps * 2, stopped
        stats = [event["data"] for event in messages if event["type"] == "stats"]
        assert stats and stats[-1]["bytes"] > 0, stats
        print(json.dumps(dict(ok=True, deviceAccess=False, width=args.width, height=args.height,
                              targetFps=args.fps, frames=stopped["frames"],
                              bytes=stats[-1]["bytes"], stderr="".join(errors))))
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            pipe.close()


if __name__ == "__main__":
    main()
