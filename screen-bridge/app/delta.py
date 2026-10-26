"""XDP1 changed-rectangle encoder; transport-independent and testable offline."""
from dataclasses import dataclass
from io import BytesIO
import struct
import time

from PIL import Image, ImageChops


@dataclass
class DeltaFrame:
    payload: bytes
    image: Image.Image
    sequence: int
    rectangles: int
    changed_ratio: float
    full: bool
    timestamp: float


def changed_rectangles(before, after, tile_size=64):
    """Merge adjacent dirty tiles into rectangles without losing sparse changes."""
    difference = ImageChops.difference(before, after)
    bounds = difference.getbbox()
    if bounds is None:
        return []
    width, height = after.size
    active, completed = {}, []
    start_y = bounds[1] // tile_size * tile_size
    stop_y = min(height, ((bounds[3] + tile_size - 1) // tile_size) * tile_size)
    for y in range(start_y, stop_y, tile_size):
        runs, start = [], None
        for x in range(0, width, tile_size):
            dirty = difference.crop((x, y, min(x + tile_size, width), min(y + tile_size, height))).getbbox() is not None
            if dirty and start is None:
                start = x
            if start is not None and (not dirty or x + tile_size >= width):
                end = x if not dirty else width
                runs.append((start, end))
                start = None
        next_active = {}
        for span in runs:
            previous = active.pop(span, None)
            next_active[span] = (span[0], previous[1] if previous else y, span[1], min(y + tile_size, height))
        completed.extend(active.values())
        active = next_active
    completed.extend(active.values())
    return completed


class DeltaEncoder:
    """Only acknowledged frames advance the comparison baseline and sequence."""

    def __init__(self, width, height, quality=85, tile_size=64, refresh_interval=5.0):
        self.size = (width, height)
        self.quality = quality
        self.tile_size = tile_size
        self.refresh_interval = refresh_interval
        self.reference = None
        self.sequence = 0
        self.last_sent = None
        self.last_full = None

    def prepare(self, image, now=None, force=False):
        now = time.monotonic() if now is None else now
        image = image.convert("RGB")
        if image.size != self.size:
            raise ValueError("局部刷新图像尺寸与串流尺寸不一致")
        width, height = self.size
        full = (force or self.reference is None or
                (self.last_full is not None and now - self.last_full >= self.refresh_interval))
        rectangles = [(0, 0, width, height)] if full else changed_rectangles(self.reference, image, self.tile_size)
        if not rectangles and self.last_sent is not None and now - self.last_sent < 2.0:
            return None
        pixels = sum((r[2] - r[0]) * (r[3] - r[1]) for r in rectangles)
        if len(rectangles) > 256 or pixels > width * height * 0.65:
            rectangles, pixels, full = [(0, 0, width, height)], width * height, True
        sequence = (self.sequence + 1) & 0xFFFFFFFF
        packet = bytearray(struct.pack("<4sIHH", b"XDP1", sequence, len(rectangles), int(full)))
        for left, top, right, bottom in rectangles:
            output = BytesIO()
            image.crop((left, top, right, bottom)).save(output, "JPEG", quality=self.quality, subsampling=0)
            jpeg = output.getvalue()
            packet.extend(struct.pack("<HHHHI", left, top, right - left, bottom - top, len(jpeg)))
            packet.extend(jpeg)
        return DeltaFrame(bytes(packet), image, sequence, len(rectangles), pixels / (width * height), full, now)

    def commit(self, frame):
        if frame.sequence != (self.sequence + 1) & 0xFFFFFFFF:
            raise ValueError("局部刷新确认顺序错误")
        self.sequence = frame.sequence
        self.last_sent = frame.timestamp
        if frame.rectangles:
            self.reference = frame.image.copy()
        if frame.full:
            self.last_full = frame.timestamp
