"""MiniMax H3 grid math: frames, latent steps, mask cells, canvas sizes.

Pure module. Imports nothing from ComfyUI.

Time has two granularities that must not be confused:

* **latent timesteps** — what the tensor actually has. 5 per 17-frame block, then 2 for
  the last 5 frames. 124 frames -> 37.
* **cells** — the blocks the video VAE encodes: 17 frames at a time from frame 0, each
  block on its own, and what is left at the end is the short cell: 124 frames are seven
  cells of 17 and one of 5 (frames 119-123). A cell is five latent frames: its first
  frame alone, then four times four frames (the short cell: its first frame, then four).

A mask is made per latent frame, and a latent frame can be pinned or freed by itself: that
is the finest a mask goes (`latent_bounds`, `seam_latents`). What a cell gives on top is
this: frames of one cell never reach another cell's latent frames on the way IN (measured:
tests/measure_vae_cells.py). On the way out there is no such wall. The decoder reads seven
latent frames at a time, two of them the next cell's, with attention across all of them
and five frames blended between windows, so a kept frame next to a freed latent frame can
come out a little different (measured: one or two frames, a few dB). "Kept"
therefore means "not generated again", not "the same pixels".
"""

from __future__ import annotations

import math

FPS = 24
AUDIO_LATENT_FPS = 40
SHORT_CELL = 5
CELL = 17
#: Latent frames per full cell, and in the short cell at the end.
CELL_LATENT = 5
SHORT_CELL_LATENT = 2
#: Canvas sizes are multiples of this (comfy_extras/nodes_minimax_h3.CANVAS_MULTIPLE).
CANVAS_MULTIPLE = 32
#: The model's native canvas is a 768 px short edge, 1344x768 at 16:9.
NATIVE_MEGAPIXELS = 1344 * 768 / (1024 * 1024)


def align_frame_count(n: int) -> int:
    """Snap up to the model's 17k+5 grid. Mirrors comfy_extras.nodes_minimax_h3."""
    n = max(SHORT_CELL, int(n))
    while n % CELL != SHORT_CELL:
        n += 1
    return n


def video_latent_t(frame_count: int) -> int:
    return 2 if frame_count <= SHORT_CELL else ((frame_count - SHORT_CELL) // CELL) * 5 + 2


def audio_latent_t(frame_count: int) -> int:
    return round(frame_count / FPS * AUDIO_LATENT_FPS)


def temporal_shape(length: int) -> tuple[int, int, int]:
    fc = align_frame_count(length)
    return fc, video_latent_t(fc), audio_latent_t(fc)


def cell_bounds(frame_count: int) -> list[list[int]]:
    """[[first_frame, last_frame]] per cell, inclusive. frame_count must be on-grid.

    Lists, not tuples: these end up inside the document's ``derived`` block, which is
    JSON. A tuple survives ``json.dumps`` as an array and comes back as a list, so a
    tuple here makes ``normalize(json_roundtrip(doc)) != doc`` and the JS mirror can never
    match exactly.
    """
    fc = align_frame_count(frame_count)
    edges = list(range(0, fc - SHORT_CELL + 1, CELL)) + [fc]
    return [[edges[i], edges[i + 1] - 1] for i in range(len(edges) - 1)]


def cell_latent(cell: int, cell_total: int) -> tuple[int, int]:
    """[first, end) latent frames of a cell: five per full cell, two for the last one."""
    first = cell * CELL_LATENT
    return first, first + (SHORT_CELL_LATENT if cell == cell_total - 1 else CELL_LATENT)


def latent_bounds(frame_count: int) -> list[list[int]]:
    """[[first_frame, last_frame]] per latent frame of the video, inclusive.

    A cell's first latent frame is its first frame alone; each one after it is four
    frames. (A full cell is 1 + 4 x 4 frames in five latent frames, the short cell at the
    end 1 + 4 in two.)
    """
    out = []
    for a, b in cell_bounds(frame_count):
        out.append([a, a])
        for first in range(a + 1, b + 1, 4):
            out.append([first, min(first + 3, b)])
    return out


def cell_of_latent(t: int, cell_total: int) -> int:
    """The cell a latent frame belongs to."""
    return min(int(t) // CELL_LATENT, cell_total - 1)


def cells_latents(cells: list[int], cell_total: int) -> list[int]:
    """Every latent frame of the cells given, in order."""
    out: list[int] = []
    for c in sorted(set(cells)):
        a, b = cell_latent(c, cell_total)
        out += list(range(a, b))
    return out


def seam_latents(frame: int, grid: dict, before: int, after: int) -> list[int]:
    """Latent frames to free around a seam at `frame`: `before` of them in front of it and
    `after` from it on.

    A seam on the first frame of a latent frame lies between two of them: exactly `before`
    and `after` are freed. A seam INSIDE a latent frame has that latent frame as its own:
    it holds frames of both takes and is always freed, with `before` in front of it and
    `after` behind it. (So 0 and 0 is nothing at all in the first case and one latent
    frame in the second: it is a range, not a switch.)
    """
    bounds = latent_bounds(grid["frame_count"])
    f = max(0, min(int(frame), grid["frame_count"] - 1))
    t = next(i for i, (a, b) in enumerate(bounds) if a <= f <= b)
    end = t + int(after) + (0 if bounds[t][0] == f else 1)
    return [k for k in range(t - int(before), end) if 0 <= k < len(bounds)]


#: A seam left to itself: how many frames are generated again at the least, and how many of
#: them lie before the seam at the least. (Measured: 12 frames ending on a cell's first
#: frame closed a join between takes that look alike at 1.3 times their own motion, 8 and 4
#: frames at 1.5 and 1.6; a plain cut was 3.0.)
SEAM_AUTO_FRAMES = 12
SEAM_AUTO_BEFORE = 4


def seam_auto(frame: int, grid: dict) -> list[int]:
    """Latent frames to free around a seam at `frame` that has no range of its own.

    The stretch ENDS where the next cell begins (at the seam itself, when the seam is on a
    cell's first frame). Inside a cell every latent frame is encoded leaning on the frames
    before it, so kept latent frames behind a freed one no longer fit what is in front of
    them: measured, the frames after a stretch that ends inside a cell come out 3 to 5 dB
    further from the take, and a stretch that ends one frame into a cell does not close
    the join at all. Ending on a cell's first frame costs the frames after it little (0
    to 1.6 dB in the runs).
    It BEGINS on the first frame of a latent frame, far enough back for the stretch to be
    at least `SEAM_AUTO_FRAMES` long and to have `SEAM_AUTO_BEFORE` frames in front of the
    seam (it comes to 12, 16, 17 or 21 frames, 13 on the last frames of a clip; fewer where the
    clip begins, and whoever asks
    may cut it off further at the ends of a long take).
    """
    fc = grid["frame_count"]
    bounds = latent_bounds(fc)
    f = max(0, min(int(frame), fc - 1))
    a, b = grid["cells"][cell_of_frame(f, fc)]
    end = a if a == f else b + 1
    want = min(end - SEAM_AUTO_FRAMES, f - SEAM_AUTO_BEFORE)
    lo = max([first for first, _ in bounds if first <= want], default=0)
    return [t for t, (first, last) in enumerate(bounds) if first >= lo and last < end]


def parse_latents(spec: str, latent_t: int) -> list[int] | None:
    """Latent frames named one by one: "18-21,30"; "none" for none at all; "" (nothing was
    said) gives None. A range the wrong way round or past the end is an error: a slip of the
    pen must not read as "keep everything"."""
    text = str(spec or "").replace(" ", "")
    if not text:
        return None
    if text.lower() == "none":
        return []
    out: set[int] = set()
    for part in text.split(","):
        if not part:
            continue
        lo_text, _, hi_text = part.partition("-")
        lo, hi = int(lo_text), int(hi_text or lo_text)
        if lo > hi or lo < 0 or hi >= latent_t:
            raise ValueError("latent frames %r: a clip of %d latent frames has 0-%d" % (part, latent_t, latent_t - 1))
        out.update(range(lo, hi + 1))
    return sorted(out)


def cell_count(frame_count: int) -> int:
    return len(cell_bounds(frame_count))


def cell_of_frame(frame: int, frame_count: int) -> int:
    """Which cell a source frame falls in."""
    for i, (a, b) in enumerate(cell_bounds(frame_count)):
        if a <= frame <= b:
            return i
    raise ValueError(f"frame {frame} outside 0..{align_frame_count(frame_count) - 1}")


def frames_of_cells(cells: list[int], frame_count: int) -> tuple[int, int]:
    """Inclusive frame span covered by a set of cells (must be contiguous)."""
    if not cells:
        raise ValueError("no cells given")
    cs = sorted(set(cells))
    if cs != list(range(cs[0], cs[-1] + 1)):
        raise ValueError(f"cells {cs} are not contiguous")
    b = cell_bounds(frame_count)
    return b[cs[0]][0], b[cs[-1]][1]


def make_grid(length: int) -> dict:
    """The H3_GRID object every other node in this package consumes."""
    fc, lt, at = temporal_shape(length)
    bounds = cell_bounds(fc)
    return {
        "requested_length": int(length),
        "frame_count": fc,
        "latent_t": lt,
        "audio_t": at,
        "cell_count": len(bounds),
        "cells": bounds,
        "snapped": fc != int(length),
    }


def parse_cells(spec: str, grid: dict) -> list[int]:
    """Parse a cell spec into a sorted cell list.

    Accepted, comma separated: ``3`` ``3-4`` ``3..4`` ``all`` ``none``
    and ``f39-72`` (a source-frame range, snapped outward to whole cells).
    """
    n = grid["cell_count"]
    fc = grid["frame_count"]
    spec = (spec or "").strip().lower()
    if spec in ("", "none"):
        return []
    if spec == "all":
        return list(range(n))
    out: set[int] = set()
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if part.startswith("f"):
            body = part[1:]
            a, _, b = body.partition("-")
            if not b:
                b = a
            lo = cell_of_frame(max(0, int(a)), fc)
            hi = cell_of_frame(min(fc - 1, int(b)), fc)
            out.update(range(lo, hi + 1))
            continue
        body = part.replace("..", "-")
        a, _, b = body.partition("-")
        if not b:
            b = a
        lo, hi = int(a), int(b)
        if lo > hi:
            lo, hi = hi, lo
        if lo < 0 or hi >= n:
            raise ValueError(f"cell range {lo}-{hi} outside 0..{n - 1}")
        out.update(range(lo, hi + 1))
    return sorted(out)


def seam_cells(cut_frames: list[int], grid: dict, radius: int = 1) -> list[int]:
    """Cells to free for a seam-repair pass: `radius` cells on each side of each cut.

    All seams are repaired in a single pass, with no cross-dissolve.

    A cut ON a cell boundary (the normal case, since shot edges snap to boundaries) is the
    seam between cell c-1 and cell c: free c-radius .. c+radius-1, i.e. exactly `radius`
    cells on each side. A cut INSIDE a cell has that cell as the seam itself: free
    c-radius .. c+radius.
    """
    n = grid["cell_count"]
    fc = grid["frame_count"]
    cells = grid["cells"]
    out: set[int] = set()
    for f in cut_frames:
        f = max(0, min(int(f), fc - 1))
        c = cell_of_frame(f, fc)
        on_boundary = c > 0 and cells[c][0] == f
        hi = c + radius - 1 if on_boundary else c + radius
        for k in range(c - radius, hi + 1):
            if 0 <= k < n:
                out.add(k)
    return sorted(out)


def guide_clip_length(frames: int) -> int:
    """Largest valid guide-clip length (5, 22, 39 ... = 17k+5) not above ``frames``.

    Below 5 a batch is anchored as a single image, which is what core does too.
    """
    frames = int(frames)
    if frames < SHORT_CELL:
        return 1
    return frames - ((frames - SHORT_CELL) % CELL)


def parse_aspect(aspect: str, fallback: tuple[float, float] = (16.0, 9.0)) -> tuple[float, float]:
    """"16:9" / "896x512" / "1.5" -> (w, h) ratio terms. Anything unreadable -> fallback."""
    text = str(aspect or "").strip().lower().replace("x", ":").replace("/", ":")
    try:
        if ":" in text:
            a, b = text.split(":", 1)
            w, h = float(a), float(b)
        else:
            w, h = float(text), 1.0
        if w > 0 and h > 0:
            return w, h
    except ValueError:
        pass
    return fallback


def canvas_size(aspect: str, megapixels: float,
                source_size: tuple[int, int] | None = None) -> tuple[int, int]:
    """(width, height) for an aspect ratio and a megapixel budget, snapped to 32.

    Same arithmetic as core's ResolutionSelector (1 MP = 1024 * 1024 pixels), so a preset
    reading "16:9 at 0.4 MP" lands on the very canvas the official templates use (864x480).
    ``aspect="source"`` follows ``source_size`` when one is known.
    """
    if str(aspect or "").strip().lower() in ("", "source", "auto"):
        ratio = (float(source_size[0]), float(source_size[1])) if (
            source_size and source_size[0] > 0 and source_size[1] > 0) else (16.0, 9.0)
    else:
        ratio = parse_aspect(aspect)
    total = max(0.01, float(megapixels)) * 1024 * 1024
    scale = math.sqrt(total / (ratio[0] * ratio[1]))
    w = max(CANVAS_MULTIPLE, round(ratio[0] * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    h = max(CANVAS_MULTIPLE, round(ratio[1] * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    return int(w), int(h)


def describe(grid: dict, free_cells: list[int] | None = None) -> str:
    lines = [
        f"length {grid['requested_length']} -> frame_count {grid['frame_count']}"
        + (" (snapped up)" if grid["snapped"] else ""),
        f"latent_t {grid['latent_t']}   audio_t {grid['audio_t']}   cells {grid['cell_count']}",
    ]
    free = set(free_cells or [])
    for i, (a, b) in enumerate(grid["cells"]):
        tag = "FREE  " if i in free else "pinned"
        lines.append(f"  cell {i:>2} {tag} frames {a:>3}-{b:<3} ({b - a + 1}f)")
    if free_cells is not None and free:
        lo, hi = frames_of_cells(sorted(free), grid["frame_count"]) if _contig(free) else (None, None)
        if lo is not None:
            lines.append(f"free span = frames {lo}-{hi}")
    return "\n".join(lines)


def _contig(cells) -> bool:
    cs = sorted(cells)
    return bool(cs) and cs == list(range(cs[0], cs[-1] + 1))
