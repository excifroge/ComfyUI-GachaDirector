"""Gacha Director — refining a face: find it, cut it out, put it back.

A face that is small in the frame is given few pixels and few latent cells, and it shows.
The remedy is the one stills have used for years: cut the face out, generate that region
again at a size where it has room, and put it back. In a video the cut-out has to hold
still on the face, so the region follows the face from frame to frame, and is cut out at
one size whatever size the face is in the frame.

Three steps, three nodes, used by the expansion and nowhere else:

``GachaDirectorFaceTrack``
    frames -> where the main face is in every frame, shot by shot. A shot in which no face
    is found is left alone: its frames go through the run and are not put back.
``GachaDirectorCropRegion``
    frames + regions -> the cut-outs, all at one size.
``GachaDirectorPasteRegion``
    frames + generated cut-outs + regions -> frames, the cut-outs feathered into place.

The track is plain arithmetic on boxes (:func:`main_track`), kept apart from the detector
so that it is tested without one. Cutting out and putting back are a pair of resamplings
that undo each other (:func:`crop_regions`, :func:`paste_regions`).

The detector is YuNet as shipped by kornia, which ComfyUI itself requires: no dependency is
added. kornia fetches YuNet's weights (a few hundred kilobytes) from its own data
repository the first time, into torch's hub cache.

One face is refined: the one that is in a shot longest, followed for as long as the shot
lasts.
"""

from __future__ import annotations

import logging
import math

log = logging.getLogger("GachaDirector")

#: Custom socket type carrying a track between the three nodes.
REGION = "GD_REGION"

#: A face has to be seen in this share of a shot's frames (and in at least this many) for
#: the shot to be refined. Set from what the detector does on this package's own renders:
#: a real face, even a dozen pixels of one in a wide shot, is found in most frames of its
#: shot, and what the detector mistakes for a face (a rock, a creature's head) in a fifth to
#: a third of them. Leaving a face alone costs nothing; painting one where there is none
#: ruins the clip.
MIN_SHARE = 0.4
MIN_FRAMES = 3
#: How many frames a face may go unseen and still be the same face when it is seen again.
MAX_GAP = 12
#: Between two sightings no further apart than this, the face is taken to have been there
#: all along (a blink of the detector). Further apart, it was away: turned from the camera,
#: or out of the frame.
BRIDGE = 2 * MAX_GAP
#: Past its last sighting (and before its first) the region fades out over this many
#: frames, so that it neither pops nor is painted where no face is.
EDGE = 6
#: The faces worth refining, in pixels of the clip (the longer side of the face box, the
#: median over a shot), when the choice of shots is left to the tracker. Measured: a face
#: of 14 px gained nothing (put back, the region cannot hold the detail, and what else is
#: in it drifts), a face of 38 px gained its features, and a face of 160 px, clear already,
#: came back as another face. Between 38 and 160 nothing was measured; 80 px is ten
#: latent cells, where a face is no longer short of room. A shot the user names is refined
#: whatever the size.
FACE_PX = (24, 80)


# ---------------------------------------------------------------------------- the track
def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _main_face(cands: dict, a: int, b: int, reach: float) -> dict:
    """The face that is in the frames [a, b) longest: {frame: (cx, cy, side)}.

    Every sighting either carries on a face seen a moment ago (near where that one was, and
    about its size) or begins a new one. The face with the most sightings is the main one.
    Taking the largest sighting instead hands the shot to whatever the detector mistook for
    a face once: in a wide shot the person's face is a dozen pixels, and one false sighting
    of a rock is a hundred.
    """
    tracks = []
    for f in range(a, b):
        open_ = [t for t in tracks if f - t["last"] <= MAX_GAP]
        for c in sorted(cands.get(f, ()), key=lambda c: -c[3]):
            best = None
            for t in open_:
                prev, gap = t["at"], f - t["last"]
                # the longer a face went unseen, the further it may have moved
                if (_dist(c, prev) <= reach * prev[2] * (1 + 0.25 * (gap - 1))
                        and 0.6 <= c[2] / prev[2] <= 1.67
                        and (best is None or _dist(c, prev) < best[0])):
                    best = (_dist(c, prev), t)
            if best:
                t = best[1]
                open_.remove(t)                    # one sighting a frame for a face
            else:
                t = {"picks": {}}
                tracks.append(t)
            t["picks"][f] = c[:3]
            t["last"], t["at"] = f, c
    if not tracks:
        return {}
    tracks.sort(key=lambda t: (len(t["picks"]), sum(p[2] for p in t["picks"].values())), reverse=True)
    main = dict(tracks[0]["picks"])
    # A face that turned away, or left, and is seen again about where it was and about as
    # large, is the same face: a head does not go far in a shot. Its stretches are one
    # track; what lies between them is not filled in (see BRIDGE in main_track).
    for t in sorted(tracks[1:], key=lambda t: min(t["picks"])):
        first, last = min(t["picks"]), max(t["picks"])
        if any(first <= f <= last for f in main):
            continue                           # there at the same time: somebody else
        near = min(main, key=lambda f: min(abs(f - first), abs(f - last)))
        here = t["picks"][first if abs(near - first) <= abs(near - last) else last]
        was = main[near]
        if _dist(here, was) <= 2.0 * was[2] and 0.5 <= here[2] / was[2] <= 2.0:
            main.update(t["picks"])
    return main


def _fill(picks: dict, a: int, b: int) -> list:
    """Every frame of [a, b) given a value: between two sightings a straight line, before
    the first and after the last the nearest one."""
    seen = sorted(picks)
    out = []
    k = 0
    for f in range(a, b):
        while k + 1 < len(seen) and seen[k + 1] <= f:
            k += 1
        lo = seen[k]
        if f <= lo or k + 1 >= len(seen):
            out.append(picks[lo])
            continue
        hi = seen[k + 1]
        t = (f - lo) / (hi - lo)
        out.append(tuple(picks[lo][i] + (picks[hi][i] - picks[lo][i]) * t for i in range(3)))
    return out


def _smooth(values: list, radius: int) -> list:
    """A moving average that does not reach past the ends of the list."""
    n = len(values)
    out = []
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def main_track(dets: list, cuts: list, width: int, height: int, *, pad: float = 2.0,
               min_score: float = 0.6, reach: float = 0.75, smooth: int = 4,
               min_share: float = 0.2, only=None) -> dict:
    """Where to cut every frame, from the faces found in it.

    ``dets``
        one list per frame of ``(x0, y0, x1, y1, score)`` in frame pixels.
    ``cuts``
        the frames at which a new shot starts. A face is followed inside a shot and never
        across a cut: on the other side it is another picture.
    ``pad``
        the side of the cut-out, in face sizes. 2 takes in the head and a little around it.
    ``only``
        the shots to refine, counted from 1; None for every shot whose face is of a size
        worth refining (FACE_PX).
    ``min_share``
        the least a cut-out may be, as a share of the frame's short edge. A face of a dozen
        pixels cut out at two face sizes would be a smear blown up twenty times with
        nothing around it to say what it is; with head and shoulders in it, it is a person.

    Returns ``{"boxes": [(x0, y0, side)], "weight": [0..1], "valid": [bool],
    "size": (width, height), "seen": frames with a sighting, "shots": [{"start", "end",
    "ok", "why", "face"}]}``. ``why`` says what kept a shot from being refined: "" (it is),
    "none" (no face), "small" or "large" (FACE_PX), "skipped" (not among ``only``);
    ``face`` is the size of its face in pixels, 0 where there is none.
    Boxes are squares inside the frame, in frame pixels, not rounded: a cut-out that moved
    in whole pixels would step. ``weight`` is how much of the generated region is put back
    in a frame: 1 where the face is, 0 where it is away, a ramp of a few frames between.
    ``valid`` is ``weight > 0``.
    """
    n = len(dets)
    limit = float(min(width, height))
    # (not a set: a shot that a late cut left nothing of is still a shot, with no frames,
    # and the shots after it keep their numbers)
    bounds = [0] + sorted(int(c) for c in cuts if 0 < int(c) < n) + [n]
    boxes = [(0.0, 0.0, limit)] * n
    weight = [0.0] * n
    shots = []
    seen = 0
    for k, (a, b) in enumerate(zip(bounds, bounds[1:])):
        cands = {}
        for f in range(a, b):
            here = [((x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0), score)
                    for x0, y0, x1, y1, score in dets[f]
                    if score >= min_score and x1 > x0 and y1 > y0]
            if here:
                cands[f] = here
        picks = _main_face(cands, a, b, reach)
        seen += len(picks)
        sizes = sorted(p[2] for p in picks.values())
        size = sizes[len(sizes) // 2] if sizes else 0.0
        if len(picks) < max(MIN_FRAMES, math.ceil((b - a) * MIN_SHARE)):
            why = "none"
        elif only is not None:
            why = "" if k + 1 in only else "skipped"
        else:
            why = "small" if size < FACE_PX[0] else "large" if size > FACE_PX[1] else ""
        shots.append({"start": a, "end": b, "ok": not why, "why": why,
                      "face": round(size) if why != "none" else 0})
        if why:
            continue
        line = _fill(picks, a, b)
        cx = _smooth([p[0] for p in line], smooth)
        cy = _smooth([p[1] for p in line], smooth)
        # the size is smoothed harder than the place: a cut-out that breathes shows more
        # than one that drifts
        side = _smooth([p[2] for p in line], smooth * 3)
        seen_at = sorted(picks)
        k = 0
        for i, f in enumerate(range(a, b)):
            s = max(8.0, limit * min_share, min(limit, side[i] * pad))
            x0 = max(0.0, min(width - s, cx[i] - s / 2))
            y0 = max(0.0, min(height - s, cy[i] - s / 2))
            boxes[f] = (x0, y0, s)
            # how far the nearest sighting is, and whether this frame is in a short gap
            while k + 1 < len(seen_at) and seen_at[k + 1] <= f:
                k += 1
            lo = seen_at[k]
            hi = seen_at[k + 1] if k + 1 < len(seen_at) else None
            if lo <= f and hi is not None and hi - lo <= BRIDGE:
                weight[f] = 1.0
            else:
                away = min(abs(f - lo), abs(hi - f) if hi is not None else n)
                weight[f] = max(0.0, 1.0 - away / (EDGE + 1.0))
    return {"boxes": boxes, "weight": weight, "valid": [w > 0 for w in weight],
            "size": (int(width), int(height)), "seen": seen, "shots": shots}


def describe(track: dict) -> str:
    """One line for the run report."""
    shots = track["shots"]
    done = [i + 1 for i, s in enumerate(shots) if s["ok"]]
    sides = [track["boxes"][f][2] for f, v in enumerate(track["valid"]) if v]
    left = "; ".join(
        "shot %d left alone: %s" % (i + 1, {
            "small": "its face is %d px, too small to gain from it" % s["face"],
            "large": "its face is %d px, clear enough already" % s["face"],
            "skipped": "not among the shots asked for",
            "none": "no face found in it",
        }[s["why"]]) for i, s in enumerate(shots) if s["why"])
    if not done:
        return "face refine: nothing to refine" + ("; " + left if left else ": no face found")
    return ("face refine: a face in %d of %d frames; shot(s) %s refined (%d frames), cut "
            "out at %d-%d px a side%s"
            % (track["seen"], len(track["valid"]), ", ".join(str(i) for i in done),
               len(sides), round(min(sides)), round(max(sides)), "; " + left if left else ""))


# ---------------------------------------------------------------------------- the detector
_detector = None


def detect(frames, *, max_side: int = 960, batch: int = 8, device=None) -> list:
    """The faces of every frame: ``[[(x0, y0, x1, y1, score), ...], ...]`` in frame pixels.

    ``frames`` is an IMAGE batch, (N, H, W, 3) in 0..1. Detection runs on a copy no larger
    than ``max_side``: YuNet does not need more, and a face too small to be found at that
    size is too small to refine.

    The detector is given the channels in the order it was trained on, blue first. Given
    RGB it still finds a large, clear face, but it misses small ones and sees faces in
    rocks and clouds (measured on this package's own renders: a 14 px face in a wide shot
    scored 0.9 one way and was not found the other, where a rock face scored 0.7).
    """
    global _detector
    import torch
    import torch.nn.functional as F
    from kornia.contrib import FaceDetector

    if device is None:
        try:
            import comfy.model_management as mm
            device = mm.get_torch_device()
        except Exception:  # noqa: BLE001 - outside ComfyUI (tests, tools)
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if _detector is None:
        # every candidate the detector has: what counts as a face is decided by min_score
        # in main_track, and the detector's own default threshold would hide part of them
        _detector = FaceDetector(confidence_threshold=0.1).eval()
    det = _detector.to(device)

    n, h, w, _ = frames.shape
    scale = min(1.0, max_side / max(h, w))
    dh, dw = max(32, round(h * scale)), max(32, round(w * scale))
    out = []
    with torch.no_grad():
        for i in range(0, n, batch):
            x = frames[i:i + batch].to(device).movedim(-1, 1).float().flip(1)   # RGB -> BGR
            if (dh, dw) != (h, w):
                x = F.interpolate(x, size=(dh, dw), mode="bilinear", antialias=True, align_corners=False)
            for rows in det(x * 255.0):                # YuNet takes 0..255
                rows = rows.detach().float().cpu()
                out.append([(float(r[0]) * w / dw, float(r[1]) * h / dh,
                             float(r[2]) * w / dw, float(r[3]) * h / dh, float(r[14]))
                            for r in rows])
    _detector.to("cpu")
    return out


# ---------------------------------------------------------------------------- cut out, put back
def _theta(boxes, width: int, height: int):
    """The affine maps grid_sample needs: output square -> the box, in normalised units."""
    import torch
    t = torch.zeros(len(boxes), 2, 3)
    for i, (x0, y0, s) in enumerate(boxes):
        t[i, 0, 0] = s / width
        t[i, 0, 2] = (2 * x0 + s) / width - 1
        t[i, 1, 1] = s / height
        t[i, 1, 2] = (2 * y0 + s) / height - 1
    return t


def crop_regions(frames, track: dict, out_w: int, out_h: int, *, batch: int = 16):
    """The cut-outs: (N, out_h, out_w, 3), frame i's box resampled to the output size."""
    import torch
    import torch.nn.functional as F
    n, h, w, _ = frames.shape
    out = torch.empty(n, out_h, out_w, 3, dtype=frames.dtype)
    for i in range(0, n, batch):
        src = frames[i:i + batch].movedim(-1, 1).float()
        grid = F.affine_grid(_theta(track["boxes"][i:i + batch], w, h),
                             (src.shape[0], 3, out_h, out_w), align_corners=False)
        cut = F.grid_sample(src, grid, mode="bicubic", padding_mode="border", align_corners=False)
        out[i:i + batch] = cut.clamp(0, 1).movedim(1, -1)
    return out


def _ramp(n: int, feather: float):
    """0 at the two ends, 1 in the middle, eased over ``feather`` of the length."""
    import torch
    u = (torch.arange(n, dtype=torch.float32) + 0.5) / n
    d = (torch.minimum(u, 1 - u) / max(feather, 1e-4)).clamp(0, 1)
    return d * d * (3 - 2 * d)


def paste_regions(base, crops, track: dict, *, feather: float = 0.15):
    """``base`` with every valid frame's cut-out put back where it was taken from.

    The cut-out is first brought down to the size of its box (with antialiasing: it was
    generated several times larger), then resampled onto the pixels of the frame it covers
    and blended in through a mask that is 1 in the middle and falls to 0 at its edges.
    """
    import torch
    import torch.nn.functional as F
    n, h, w, _ = base.shape
    if crops.shape[0] != n:
        raise ValueError("Gacha Director: %d cut-outs for %d frames" % (crops.shape[0], n))
    out = base.clone()
    for i in range(n):
        if not track["valid"][i]:
            continue
        x0, y0, s = track["boxes"][i]
        side = max(2, math.ceil(s))
        small = F.interpolate(crops[i:i + 1].movedim(-1, 1).float(), size=(side, side),
                              mode="bicubic", antialias=True, align_corners=False).clamp(0, 1)
        ramp = _ramp(side, feather)
        alpha = (ramp[:, None] * ramp[None, :])[None, None]
        # the pixels of the frame the box touches, and where each falls in the cut-out
        px0, py0 = max(0, math.floor(x0)), max(0, math.floor(y0))
        px1, py1 = min(w, math.ceil(x0 + s)), min(h, math.ceil(y0 + s))
        if px1 <= px0 or py1 <= py0:
            continue
        gx = ((torch.arange(px0, px1, dtype=torch.float32) + 0.5 - x0) / s) * 2 - 1
        gy = ((torch.arange(py0, py1, dtype=torch.float32) + 0.5 - y0) / s) * 2 - 1
        grid = torch.stack(torch.meshgrid(gy, gx, indexing="ij")[::-1], dim=-1)[None]
        # The picture is continued past its edge and only the mask falls to nothing there.
        # Sampled together, the picture would be darkened at the rim and then weighted by a
        # mask that says the same thing again: a dark line round the region.
        rgb = F.grid_sample(small, grid, mode="bilinear", padding_mode="border",
                            align_corners=False)[0].movedim(0, -1)
        a = F.grid_sample(alpha, grid, mode="bilinear", padding_mode="zeros",
                          align_corners=False)[0].movedim(0, -1) * float(track["weight"][i])
        region = out[i, py0:py1, px0:px1]
        out[i, py0:py1, px0:px1] = region * (1 - a) + rgb.to(region.dtype) * a
    return out


# ---------------------------------------------------------------------------- nodes
def real_cuts(frames, asked: list, soft: list = ()) -> list:
    """Where the shots of a clip really start: one frame for every frame of ``asked`` and
    ``soft`` together, in order.

    ``asked`` are the frames a cut was asked for. The model puts a cut a few frames off the
    frame it is asked for, and a clip cut together from several takes has its cuts where
    those takes had theirs. A cut that is not found (the shot goes on, or dissolves) stays
    where it was asked. ``soft`` are the boundaries inside a long take: no cut is asked for
    there and none is looked for (a neighbouring cut, or a quick move, would be taken for
    one). They stay where they are, between the cuts found on either side of them.
    """
    from .gd_splice import _stays, frame_changes, real_cut  # noqa: PLC0415

    n = int(frames.shape[0])
    hard = sorted({int(c) for c in asked if 0 < int(c) < n})
    soft = sorted({int(c) for c in soft if 0 < int(c) < n} - set(hard))
    found = {}
    if hard:
        changes, small = frame_changes(frames)
        stays = _stays(small, changes)
        for cut in hard:
            at = real_cut(changes, stays, hard, cut, n)
            found[cut] = cut if at is None else at
    out = []
    for c in sorted(hard + soft):
        if c in found:
            out.append(found[c])
            continue
        before = max([found[h] for h in hard if h < c], default=0)
        after = min([found[h] for h in hard if h > c], default=n)
        out.append(min(max(c, before), after))
    return out


class GachaDirectorFaceTrack:
    """Where the main face is in every frame of a clip."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = (REGION, "STRING")
    RETURN_NAMES = ("region", "report")
    FUNCTION = "track"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE",),
            "cuts": ("STRING", {"default": "", "tooltip":
                                "Frames at which a new shot starts, comma separated; \"~\" "
                                "after one that goes on from the shot before (no cut there)."}),
            "shots": ("STRING", {"default": "", "tooltip":
                                 "Shots to refine, counted from 1, comma separated. Empty: "
                                 "every shot a face is found in."}),
            "padding": ("FLOAT", {"default": 2.0, "min": 1.2, "max": 4.0, "step": 0.1}),
            "min_score": ("FLOAT", {"default": 0.6, "min": 0.1, "max": 0.99, "step": 0.05}),
        }}

    def track(self, frames, cuts, shots, padding, min_score):
        n, h, w, _ = frames.shape
        numbers = lambda text: [int(x) for x in str(text).replace(" ", "").split(",") if x.isdigit()]  # noqa: E731
        only = set(numbers(shots)) or None
        marks = [x for x in str(cuts).replace(" ", "").split(",") if x.rstrip("~").isdigit()]
        hard = [int(x) for x in marks if not x.endswith("~")]
        soft = [int(x.rstrip("~")) for x in marks if x.endswith("~")]
        track = main_track(detect(frames), real_cuts(frames, hard, soft), w, h,
                           pad=float(padding), min_score=float(min_score), only=only)
        report = describe(track)
        log.info("Gacha Director: %s", report)
        if not any(track["valid"]):
            raise ValueError(
                "Gacha Director: %s. A face is refined when it is seen in at least %d%% of the "
                "frames of its shot and, unless the shots are chosen by hand, is %d to %d px "
                "in the clip." % (report, round(MIN_SHARE * 100), FACE_PX[0], FACE_PX[1]))
        return (track, report)


class GachaDirectorCropRegion:
    """The region of every frame, cut out and brought to one size."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "crop"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE",),
            "region": (REGION,),
            "width": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
            "height": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
        }}

    def crop(self, frames, region, width, height):
        return (crop_regions(frames, region, int(width), int(height)),)


class GachaDirectorPasteRegion:
    """Generated cut-outs put back into the frames they were taken from."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "paste"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE",),
            "crops": ("IMAGE",),
            "region": (REGION,),
            "feather": ("FLOAT", {"default": 0.15, "min": 0.02, "max": 0.45, "step": 0.01}),
        }}

    def paste(self, frames, crops, region, feather):
        return (paste_regions(frames, crops, region, feather=float(feather)),)
