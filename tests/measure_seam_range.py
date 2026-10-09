"""What a seam looks like in the frames around it: is the join closed, and what did it cost?

    python measure_seam_range.py TAKE_A TAKE_B COMPOSITE --cut F --free LO-HI [--plain NOTHING_GENERATED]

The composite is take A until frame F and take B from it, with the frames LO..HI generated
again (the range of a seam inside a long take). Printed:

  plain cut   the step from A's frame F-1 to B's frame F, as a multiple of the step the takes
              make themselves at that frame (what there would be without generating anything)
  worst       the largest step of the composite, each as a multiple of the larger of the two
              takes' own steps at that frame, and the frame it is at. Takes that follow one
              source move alike, so about 1 is their own motion; a jump shows as well above
              it. (Against the takes' usual step a fast stretch of the footage reads as a
              jump.) Looked for in the same frames for every run of one seam, 24 on either
              side of it, and besides in the 6 frames beyond either end of what was
              generated again, where a jump that was pushed outwards would be.
  kept        how much the frames that were kept changed, in the 12 frames before LO and the
              12 after HI: the least PSNR against the take they were kept from (what the
              user loses).
  drop        the same frames in a run of the same seam with nothing generated around it
              (--plain; it goes through the same encoding and decoding): frame by frame, how
              many dB further from the take the kept frame is than it is there, and the most
              of that on either side. About 0 means the kept frames came back as they would
              have anyway. (Frame by frame the two runs are never the same picture: the
              decoder reads seven latent frames at a time, so every kept frame near a freed
              one comes out a little different, around 38 dB between the runs. What counts
              is whether it is further from the take.)

The ratio is forgiving in two ways that the numbers do not show: a dissolve, a blur or a
freeze lowers a step as well as a good join does, and a take that jumps by itself hides a
jump of the composite at that frame. Look at the pictures too.

This is how the numbers of the seam range in AGENTS.md (section 13) are measured. A composite with a
given range is made in the panel (drag the ends of the seam's bar on the Generate page), or
from a document whose key "x_free_latents" names the latent frames to free ("17-19"; the
time mask reads it and nothing else does). The --plain run is the same join with a latent
frame far from the seam freed instead ("0"): nothing is generated near the seam, and the
clip still goes through the encoder and the decoder, which a join with nothing freed at all
does not (that one is cut together without the model).
Needs PyAV and NumPy (both ComfyUI dependencies); run it with ComfyUI's Python.
"""

import argparse

import av
import numpy as np

SIDE = 24                # frames looked at on either side of a seam
EDGE = 12                # kept frames looked at beyond either end of what was generated again
_cache = {}


def frames(path):
    if path not in _cache:
        with av.open(path) as c:
            _cache[path] = [f.to_ndarray(format="rgb24").astype(np.float32) for f in c.decode(video=0)]
    return _cache[path]


def psnr(x, y):
    m = float(np.mean((x - y) ** 2))
    return 99.0 if m == 0 else 10 * np.log10(255 * 255 / m)


def step(a, b):
    return float(np.mean(np.abs(a - b)))


def profile(take_a, take_b, composite, cut, lo, hi, plain=None):
    a, b, c = frames(take_a), frames(take_b), frames(composite)
    p = frames(plain) if plain else None
    n = min(len(a), len(b), len(c))
    own = lambda f: max(step(a[f], a[f - 1]), step(b[f], b[f - 1]), 1e-6)   # noqa: E731
    span = sorted(set(range(max(1, cut - SIDE), min(n - 1, cut + SIDE) + 1))
                  | set(range(max(1, lo - 6), min(n - 1, hi + 6) + 1)))
    over = {f: step(c[f], c[f - 1]) / own(f) for f in span}
    worst = max(over, key=over.get)
    before = list(range(max(0, lo - EDGE), lo))
    after = list(range(hi + 1, min(n, hi + 1 + EDGE)))
    least = lambda fs, ref: min((psnr(c[f], ref[f]) for f in fs), default=None)   # noqa: E731
    out = {"plain": step(b[cut], a[cut - 1]) / own(cut), "worst": over[worst], "worst_at": worst, "over": over,
           "kept_a": least(before, a), "kept_b": least(after, b), "drop_a": None, "drop_b": None}
    if p is not None:
        cost = lambda fs, ref: max((psnr(p[f], ref[f]) - psnr(c[f], ref[f]) for f in fs), default=None)   # noqa: E731
        out["drop_a"], out["drop_b"] = cost(before, a), cost(after, b)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("take_a")
    ap.add_argument("take_b")
    ap.add_argument("composite")
    ap.add_argument("--cut", type=int, required=True)
    ap.add_argument("--free", required=True, help="LO-HI: the frames generated again")
    ap.add_argument("--plain", help="a run of the same seam with nothing generated around it")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.free.split("-"))
    r = profile(a.take_a, a.take_b, a.composite, a.cut, lo, hi, a.plain)
    db = lambda v: "-" if v is None else "%.1f" % v   # noqa: E731
    print("plain cut %.2fx   worst %.2fx at frame %d   (frames %d-%d generated again: %d frames)"
          % (r["plain"], r["worst"], r["worst_at"], lo, hi, hi - lo + 1))
    print("kept, least dB against the take: %s before, %s after" % (db(r["kept_a"]), db(r["kept_b"])))
    if a.plain:
        print("what generating cost the worst kept frame: %s dB before, %s dB after" % (db(r["drop_a"]), db(r["drop_b"])))
    print("steps over the takes' own: " + "  ".join("%d:%.2f" % (f, v) for f, v in sorted(r["over"].items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
