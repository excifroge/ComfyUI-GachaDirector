"""The frame loader on real files: gd_frames.load_frames and the probe in gd_routes.

    python tests/test_frames.py

Writes a few tiny clips into a temporary folder with PyAV and reads them back. What is at
stake: a clip a phone recorded is stored lying on its side with a note saying so. Players
and ComfyUI's own loader turn it upright; if this loader did not, the panel would show the
clip upright and hand the model the picture on its side.

Needs PyAV, numpy and torch (ComfyUI dependencies); no ComfyUI, no model.
"""

import importlib.util
import os
import struct
import sys
import tempfile

import av
import numpy as np

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_frames as F, gd_routes as R  # noqa: E402

failed = []


def check(name, got, want):
    if got != want:
        failed.append("%s: got %r, want %r" % (name, got, want))


W, H, N = 96, 64, 12
TMP = tempfile.mkdtemp(prefix="gd_frames_")
F._folder = lambda source: TMP


def write_clip(name, rate=24, frames=N):
    """A clip with a white block in the stored top-left corner and a red one bottom-right;
    the green level counts the frames (the first thirty: after that it stays)."""
    path = os.path.join(TMP, name)
    with av.open(path, "w") as c:
        s = c.add_stream("libx264", rate=rate)
        s.width, s.height, s.pix_fmt = W, H, "yuv420p"
        for i in range(frames):
            img = np.zeros((H, W, 3), np.uint8)
            img[:, :, 1] = min(252, 20 + i * 8)
            img[: H // 4, : W // 4] = 255
            img[H - H // 4:, W - W // 4:, 0] = 255
            for p in s.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    return path


def turn_header(path, quarter):
    """Mark the clip as turned by `quarter` quarter turns: the display matrix of the track
    header, which is where a phone writes it."""
    data = bytearray(open(path, "rb").read())
    box = data.find(b"tkhd") - 4
    m = box + (48 if data[box + 8] == 0 else 60)
    one, neg = 0x00010000, 0xFFFF0000
    mats = {1: (0, one, 0, neg, 0, 0, 0, 0, 0x40000000),
            2: (neg, 0, 0, 0, neg, 0, 0, 0, 0x40000000),
            3: (0, neg, 0, one, 0, 0, 0, 0, 0x40000000)}
    data[m:m + 36] = struct.pack(">9I", *mats[quarter])
    open(path, "wb").write(bytes(data))


def white_corner(img):
    h, w = img.shape[:2]
    q = {"tl": img[: h // 4, : w // 4], "tr": img[: h // 4, w - w // 4:],
         "bl": img[h - h // 4:, : w // 4], "br": img[h - h // 4:, w - w // 4:]}
    return max(q, key=lambda k: float(q[k].mean()))


# ---- upright as stored: what every clip was before this test
write_clip("plain.mp4")
got = F.load_frames("plain.mp4").numpy()
check("a plain clip: every frame, at its own size", got.shape, (N, H, W, 3))
check("a plain clip: as stored", white_corner(got[0]), "tl")
check("a range of it", F.load_frames("plain.mp4", "input", 3, 4).shape[0], 4)
held = F.load_frames("plain.mp4", "input", 8, 9).numpy()
check("past its end the last frame is held", (held.shape[0], bool((held[4:] == held[3]).all())), (9, True))

# ---- frames are made tensors a few at a time: none lost, none out of order, at any count
def greens(name, *a):
    return [round(float(x) * 255) for x in F.load_frames(name, *a).numpy()[:, H // 2, W // 2, 1]]


write_clip("long.mp4", frames=3 * F.AT_ONCE + 5)
levels = greens("long.mp4")
check("a clip longer than one handful: every frame, in order",
      (len(levels), levels == sorted(levels), len(set(levels))), (3 * F.AT_ONCE + 5,) + (True, 3 * F.AT_ONCE + 5))
check("a range that ends on a handful's edge", len(greens("long.mp4", "input", 0, 2 * F.AT_ONCE)), 2 * F.AT_ONCE)

# ---- brought to another size (needs ComfyUI's own resize: run from its folder)
sys.path.insert(0, os.getcwd())
try:
    from comfy.utils import common_upscale
except Exception:  # noqa: BLE001
    common_upscale = None
    print("(not run from ComfyUI's folder: the resize to a canvas is not checked)")
if common_upscale is not None:
    import comfy.utils
    whole = F.load_frames("long.mp4")
    want = common_upscale(whole.movedim(-1, 1), 48, 32, "lanczos", "center").movedim(1, -1)
    sizes = []

    def counting(samples, *a, **k):
        sizes.append(int(samples.shape[0]))
        return common_upscale(samples, *a, **k)

    comfy.utils.common_upscale = counting
    try:
        got = F.load_frames("long.mp4", "input", 0, 0, 48, 32, "canvas")
    finally:
        comfy.utils.common_upscale = common_upscale
    check("resized a handful at a time: the same picture as resized all at once",
          (tuple(got.shape), bool((got == want).all())), ((3 * F.AT_ONCE + 5, 32, 48, 3), True))
    check("and never more than a handful of frames at the file's own size",
          sizes, [F.AT_ONCE] * 3 + [5])

# ---- lying on its side: where the white block ends up is what ComfyUI's own loader gives
# (measured against comfy_api's VideoFromFile on these very files)
for quarter, size, corner in ((1, (W, H), "tr"), (2, (H, W), "br"), (3, (W, H), "bl")):
    name = "turned%d.mp4" % quarter
    turn_header(write_clip(name), quarter)
    got = F.load_frames(name).numpy()
    check("turned %d quarters: the upright size" % quarter, got.shape[1:3], size)
    check("turned %d quarters: the picture is upright" % quarter, white_corner(got[0]), corner)
    info = R._probe_video(os.path.join(TMP, name), os.path.getmtime(os.path.join(TMP, name)))
    check("turned %d quarters: the probe gives the size it is shown at" % quarter,
          (info.get("height"), info.get("width")), size)
    check("turned %d quarters: and still counts its frames" % quarter, info.get("frames"), N)

# ---- scaled in the decoder (reference videos): the size asked for is the upright one
got = F.load_frames("turned1.mp4", "input", 0, 0, 32, 48, "decode").numpy()
check("a turned clip scaled while decoding: the size asked for", got.shape[1:3], (48, 32))
check("a turned clip scaled while decoding: upright", white_corner(got[0]), "tr")

# ---- another frame rate: read to the clip's real end, and the probe counts the same
def probed(name):
    path = os.path.join(TMP, name)
    return R._probe_video(path, os.path.getmtime(path)).get("frames24")


for rate, frames in ((12, 12), (15, 15), (20, 100), (25, 50), (30, 30), (60, 124)):
    name = "rate%d.mp4" % rate
    write_clip(name, rate=rate, frames=frames)
    got = F.load_frames(name).shape[0]
    check("%d frames at %d fps: as many frames as the probe says" % (frames, rate), got, probed(name))
    check("%d frames at %d fps: its length at 24 a second" % (frames, rate), got,
          -(-frames * 24 // rate))                                  # rounded up
levels = greens("rate12.mp4")
check("12 fps: every one of its frames twice, the last one too",
      (len(set(levels)), levels), (12, [v for v in sorted(set(levels)) for _ in (0, 1)]))
tail = F.load_frames("rate12.mp4", "input", probed("rate12.mp4") - 22, 22)
check("the last 22 frames of a 12 fps clip are all there", tail.shape[0], 22)

# ---- frames that do not come at even intervals are placed by their time stamps, even
# where the file's average is 24 a second
def write_uneven(name, times):
    from fractions import Fraction
    tb = Fraction(1, 12000)
    path = os.path.join(TMP, name)
    with av.open(path, "w") as c:
        s = c.add_stream("libx264", rate=24)
        s.width, s.height, s.pix_fmt = W, H, "yuv420p"
        s.codec_context.time_base = tb
        for i, t in enumerate(times):
            img = np.zeros((H, W, 3), np.uint8)
            img[:, :, 1] = 20 + i * 8
            f = av.VideoFrame.from_ndarray(img, format="rgb24")
            f.pts, f.time_base = int(round(t / tb)), tb
            for p in s.encode(f):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


# 24 frames in one second, but twelve in the first quarter of it and twelve in the last
uneven = [i * 0.229 / 11 for i in range(12)] + [0.729 + i * 0.229 / 11 for i in range(12)]
write_uneven("uneven.mp4", uneven)
which = [round((v - 20) / 8) for v in greens("uneven.mp4")]
want = [min(range(24), key=lambda i: abs(uneven[i] - k / 24.0)) for k in range(24)]
check("uneven frames averaging 24 a second: each moment shows the frame nearest in time", which, want)
check("and that is not the frames in file order", which != list(range(24)), True)
check("the probe counts them the same", probed("uneven.mp4"), len(which))

# ---- another frame rate is conformed to 24 by time, and a turned one too
turn_header(write_clip("turned_30.mp4", rate=30, frames=30), 1)
got = F.load_frames("turned_30.mp4").numpy()
check("a turned 30 fps clip: one second is 24 frames, upright",
      (got.shape[0], got.shape[1:3], white_corner(got[0])), (24, (W, H), "tr"))

if failed:
    print("FAILED:")
    for f in failed:
        print(" -", f)
    sys.exit(1)
print("frame loader tests: all passed")
