"""Turn the frames from record-demo.mjs into a GIF, and optionally a video.

    python3 scripts/frames-to-gif.py ../docs/demo/frames ../docs/demo/p0-demo.gif \\
        --video ../docs/demo/p0-demo.webm --ffmpeg ~/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux

Needs Pillow. Frames are placed by their screencast timestamps; unchanged
frames are merged, so idle moments cost nothing. `--video` pipes JPEG frames
into ffmpeg at a constant frame rate: `.webm` (VP8) works even with the small
ffmpeg build Playwright ships; `.mp4` needs a full ffmpeg with libx264.
"""

import argparse
import io
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageChops

p = argparse.ArgumentParser()
p.add_argument("frames", type=Path)
p.add_argument("out", type=Path)
p.add_argument("--width", type=int, default=800)
p.add_argument("--speed", type=float, default=2.0, help="playback speed-up")
p.add_argument("--video", type=Path, help="also write a video (.webm or .mp4)")
p.add_argument("--ffmpeg", default="ffmpeg")
p.add_argument("--fps", type=int, default=25)
a = p.parse_args()

paths = sorted(a.frames.glob("*.png"))
times = json.loads((a.frames / "times.json").read_text())
MIN_MS = 60  # GIF: drop frames closer than this (after speed-up)
HOLD_S = 2.5  # hold the last frame this long (played time)

frames: list[Image.Image] = []
starts: list[float] = []
prev = None
for path, t in zip(paths, times):
    if starts and (t - starts[-1]) * 1000 / a.speed < MIN_MS:
        continue
    img = Image.open(path).convert("RGB")
    img = img.resize((a.width, round(img.height * a.width / img.width)), Image.LANCZOS)
    if prev is not None and ImageChops.difference(img, prev).getbbox() is None:
        continue
    frames.append(img)
    starts.append(t)
    prev = img

# Played seconds from the start for each frame, and the end.
played = [(t - starts[0]) / a.speed for t in starts]
end = played[-1] + HOLD_S

# Each frame lasts until the next one; GIF delays are in 10 ms units.
nexts = played[1:] + [end]
durations = [max(20, round((n - s) * 100) * 10) for s, n in zip(played, nexts)]
pal = [f.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
pal[0].save(a.out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(a.out, f"{len(frames)} frames, {a.out.stat().st_size / 1e6:.1f} MB")

if a.video:
    codec = ["-c:v", "libx264", "-pix_fmt", "yuv420p"] if a.video.suffix == ".mp4" else ["-c:v", "vp8", "-b:v", "1M"]
    cmd = [a.ffmpeg, "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-r", str(a.fps), "-i", "pipe:0"]
    proc = subprocess.Popen([*cmd, *codec, "-an", str(a.video)], stdin=subprocess.PIPE)
    jpegs: dict[int, bytes] = {}
    i = 0
    for k in range(int(end * a.fps)):
        while i + 1 < len(played) and played[i + 1] <= k / a.fps:
            i += 1
        if i not in jpegs:
            buf = io.BytesIO()
            frames[i].save(buf, "JPEG", quality=90)
            jpegs = {i: buf.getvalue()}
        proc.stdin.write(jpegs[i])
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit(f"ffmpeg failed ({a.ffmpeg})")
    print(a.video, f"{end:.0f} s, {a.video.stat().st_size / 1e6:.1f} MB")
