"""Gacha Director — output settings: the live preview, what gets saved, and face refine.

Pure module. ``web/gd_post_doc.js`` mirrors :func:`normalize`.

Kept in its own widget (``gd_post``) rather than in the clip document: the document is
content, this is how a render is watched, written out and touched up afterwards, and
mixing them would make every output tweak dirty the clip.

A second pass over a finished render feeds generated frames back into generation, and each
such pass costs quality, so there is no general refine or upscale stage. Two passes are
narrow enough to be worth it: the seam repair of a composite (the clip's own setting, see
``gd_schema``), and face refine here, which regenerates only the region a face is in, at a
size where a small face has room, and leaves every other pixel of the clip as it was.
"""

from __future__ import annotations

import copy
from typing import Any

POST_VERSION = 3

SAVE_FORMATS = ("auto", "mp4", "webm", "mkv")
#: The codecs core's SaveVideo can write (comfy_api VideoCodec).
SAVE_CODECS = ("auto", "h264", "av1")

DEFAULT: dict[str, Any] = {
    "version": POST_VERSION,
    "preview": {
        "enabled": True,
        "preview_every": 1,            # sampler steps between previews
        "max_resolution": 1024,
        "jpeg_quality": 80,
    },
    "save": {
        "auto_save": True,
        "filename_prefix": "GachaDirector",
        "format": "mp4",
        "codec": "h264",
    },
    # Refining a face: one more run, over the region of a finished clip the face is in.
    "face": {
        # How much of the region is generated again: the share of noise the run starts
        # from. Not a denoise setting, which the schedule shift bends (see denoise_for).
        # Measured on a 38 px face: at 50% the clip comes back as it was, 70% tidies the
        # features, 85% redraws them with the head, the hair and the light unchanged, and
        # at 93% the hair and the background inside the region change as well.
        "strength": 0.85,
        "padding": 2.0,                # side of the region, in face sizes
        "feather": 0.15,               # how much of the region's edge is blended away
        "min_score": 0.6,              # how sure the detector has to be of a face
        "subject": "",                 # id of the subject whose pictures show this face
        "text": "",                    # words added to the description of the face
        "shots": "",                   # shots to refine, from 1: "1,3"; "" = wherever a face is
        # Set by the panel for the one run that refines, and stored nowhere:
        "file": "",                    # the finished clip, a name in output/
        "cuts": "",                    # the frames at which its shots start, "61,122~": "~"
                                       # after one that goes on from the shot before
    },
}


def empty() -> dict:
    return copy.deepcopy(DEFAULT)


def _clampi(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return min(hi, max(lo, int(v)))
    except (TypeError, ValueError):
        return default


def _choice(v: Any, options: tuple, default: str) -> str:
    s = str(v or "").strip().lower()
    return s if s in options else default


def _clampf(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return round(min(hi, max(lo, f)), 3)


def denoise_for(noise: float, shift: float) -> float:
    """The denoise setting that starts the sampler at a given share of noise.

    At schedule shift ``s`` a denoise ``d`` starts at ``s*d / (1 + (s-1)*d)``; this is that
    turned round. At the default shift of 12, half noise is a denoise of 0.077.
    """
    s = max(float(shift), 1e-6)
    p = min(0.999, max(0.001, float(noise)))
    return min(1.0, p / (s - (s - 1.0) * p))


def normalize(cfg: Any) -> dict:
    """Complete, clamped, idempotent. Stages from older versions are dropped."""
    cfg = cfg if isinstance(cfg, dict) else {}
    out = empty()
    for section in ("preview", "save", "face"):
        for k, v in (cfg.get(section) or {}).items() if isinstance(cfg.get(section), dict) else []:
            if k in out[section]:
                out[section][k] = v

    p = out["preview"]
    p["enabled"] = bool(p["enabled"])
    p["preview_every"] = _clampi(p["preview_every"], 1, 100, 1)
    p["max_resolution"] = _clampi(p["max_resolution"], 128, 4096, 1024)
    p["jpeg_quality"] = _clampi(p["jpeg_quality"], 10, 100, 80)

    s = out["save"]
    s["auto_save"] = bool(s["auto_save"])
    s["filename_prefix"] = str(s["filename_prefix"] or "GachaDirector")
    s["format"] = _choice(s["format"], SAVE_FORMATS, "mp4")
    s["codec"] = _choice(s["codec"], SAVE_CODECS, "h264")

    f = out["face"]
    f["strength"] = _clampf(f["strength"], 0.05, 0.95, 0.85)
    f["padding"] = _clampf(f["padding"], 1.2, 4.0, 2.0)
    f["feather"] = _clampf(f["feather"], 0.02, 0.45, 0.15)
    f["min_score"] = _clampf(f["min_score"], 0.1, 0.99, 0.6)
    f["subject"] = str(f["subject"] or "")
    f["text"] = str(f["text"] or "")
    f["file"] = str(f["file"] or "")
    f["shots"] = ",".join(x for x in str(f["shots"] or "").replace(" ", "").split(",")
                          if x.isascii() and x.isdigit())
    # "~" after a frame: the shot that starts there goes on from the one before (no cut)
    f["cuts"] = ",".join(x for x in str(f["cuts"] or "").replace(" ", "").split(",")
                         if x.isascii() and (x[:-1] if x.endswith("~") else x).isdigit())
    return out


def summary(cfg: Any) -> str:
    c = normalize(cfg)
    p, s, f = c["preview"], c["save"], c["face"]
    return " | ".join([
        f"preview {'every ' + str(p['preview_every']) if p['enabled'] else 'off'}",
        f"save {'on ' + s['filename_prefix'] + '.' + s['format'] if s['auto_save'] else 'off'}",
    ] + ([f"face refine of {f['file']} at {round(f['strength'] * 100)}% noise"] if f["file"] else []))
