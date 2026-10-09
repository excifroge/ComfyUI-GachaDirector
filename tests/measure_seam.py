"""How a composite sits between the two takes it was cut from.

    python measure_seam.py TAKE_A TAKE_B COMPOSITE --cut FRAME

Prints, per cell, how close the composite is to each take (PSNR), and the size of the jump
from one frame to the next around the cut, for a plain cut of the two takes and for the
composite, against the takes' own average frame-to-frame change. A plain cut between takes
that differ shows up as a jump well above the ordinary motion; a repaired seam should not.

This is where the composite numbers in the README come from. Needs PyAV and NumPy (both
ComfyUI dependencies); run it with ComfyUI's Python.
"""

import argparse

import av
import numpy as np


def frames(path):
    with av.open(path) as c:
        return [f.to_ndarray(format="rgb24").astype(np.float32) for f in c.decode(video=0)]


def psnr(x, y):
    m = float(np.mean((x - y) ** 2))
    return 99.0 if m == 0 else 10 * np.log10(255 * 255 / m)


def step(seq, f):
    """Mean absolute change from frame f-1 to frame f."""
    return float(np.mean(np.abs(seq[f] - seq[f - 1])))


def cells(n):
    edges = list(range(0, n - 5 + 1, 17)) + [n]
    return [(edges[i], edges[i + 1] - 1) for i in range(len(edges) - 1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("take_a")
    ap.add_argument("take_b")
    ap.add_argument("composite")
    ap.add_argument("--cut", type=int, required=True)
    a = ap.parse_args()
    A, B, C = frames(a.take_a), frames(a.take_b), frames(a.composite)
    n = min(len(A), len(B), len(C))
    print("frames %d, cut at %d" % (n, a.cut))
    print("cell  frames     vs take A   vs take B")
    for i, (lo, hi) in enumerate(cells(n)):
        pa = np.mean([psnr(C[f], A[f]) for f in range(lo, hi + 1)])
        pb = np.mean([psnr(C[f], B[f]) for f in range(lo, hi + 1)])
        mark = "  <- cut" if lo <= a.cut <= hi else ""
        print("%4d  %3d-%-3d   %6.1f dB   %6.1f dB%s" % (i, lo, hi, pa, pb, mark))
    plain = A[:a.cut] + B[a.cut:]
    usual = np.mean([step(A, f) for f in range(1, n)] + [step(B, f) for f in range(1, n)])
    print("\nframe-to-frame change (mean abs, 0-255); the takes' own average is %.2f" % usual)
    print("frame   plain cut   composite")
    for f in range(max(1, a.cut - 3), min(n, a.cut + 4)):
        print("%5d   %9.2f   %9.2f%s" % (f, step(plain, f), step(C, f),
                                         "   <- cut" if f == a.cut else ""))
    worst = max(step(C, f) for f in range(1, n))
    print("\nlargest change anywhere in the composite: %.2f (%.1fx the usual)"
          % (worst, worst / max(usual, 1e-6)))
    print("the plain cut's jump: %.2f (%.1fx the usual)"
          % (step(plain, a.cut), step(plain, a.cut) / max(usual, 1e-6)))


if __name__ == "__main__":
    main()
