"""Gacha Director — run presets and their timing history.

Pure module. Imports nothing from ComfyUI. ``web/gd_presets_doc.js`` mirrors
:func:`normalize`.

Why presets rather than knobs on the node
-----------------------------------------
Sampling settings only ever move together. "Draft", "standard" and "final" are not a dozen
independent numbers, they are three named answers to *how much am I willing to spend on
this run*. So a preset is the unit: the node picks one and shows what it has cost before,
and the panel is where a preset gets edited.

A preset describes **cost**, not content:

* It holds a megapixel budget, not a width and a height. The aspect ratio belongs to the
  clip (``clip.aspect`` in the document), so one preset serves a landscape clip, a portrait
  clip and a square one.
* ``ref_video_edge`` caps the short edge of reference videos. Their tokens ride through
  every sampling step, and in measurement they — not the canvas — dominated step time:
  the same 256x256 render took 15.3 s/step with a 512 px reference clip and 6.3 s/step
  with a 256 px one. A draft preset that only shrinks the canvas is not a draft.
* ``model`` selects the node's ``model`` or ``model_turbo`` input, so a turbo preset is
  self-contained once a distilled model is wired in. Loaders stay outside the node.
* ``seed`` is not here (it is a per-run value on the node), and neither is ``denoise``
  (how much of a source clip survives is a property of the edit, stored with the source).

A draft and a final render of the same seed are different clips: changing the canvas
changes the noise. A draft answers "is this prompt and this material going in the right
direction", not "is this the take".

History
-------
Each preset keeps how many runs it has had, how long the last one took and the average.
Recorded by the panel when a run finishes, because the panel is what knows the wall clock.
Every run stores the parameter signature and the frame count it was measured with, so the
figure shown is for runs that match what is about to be queued.
"""

from __future__ import annotations

import copy
import time
from typing import Any

PRESETS_VERSION = 2

#: What a preset carries. Anything not here is content (the document) or per-run (seed).
PARAM_KEYS = ("megapixels", "steps", "cfg", "sampler_name", "scheduler",
              "shift_video", "shift_audio", "model", "ref_video_edge", "ref_image_size",
              "vram_staging")

SAMPLERS = ("res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_sde", "heun",
            "ddim", "uni_pc", "lcm")
SCHEDULERS = ("simple", "normal", "karras", "beta", "linear_quadratic", "sgm_uniform")
STAGING = ("off", "auto", "on")
MODELS = ("main", "turbo")
REF_IMAGE_SIZES = ("match", "max")
#: 0 keeps the model's own bound (768 px short edge).
REF_VIDEO_EDGES = (0, 768, 640, 512, 384, 256)

#: Keep the run log bounded so the workflow file does not grow without limit.
MAX_RUNS = 50

#: The official templates' own settings: res_multistep / simple, 20 steps, no CFG, and the
#: model's default shifts.
DEFAULT_PARAMS: dict[str, Any] = {
    "megapixels": 0.4, "steps": 20, "cfg": 1.0,
    "sampler_name": "res_multistep", "scheduler": "simple",
    "shift_video": 12.0, "shift_audio": 3.0,
    "model": "main", "ref_video_edge": 0, "ref_image_size": "match",
    "vram_staging": "off",
}

#: How many candidates a "generate" from the takes page queues. Lives beside ``params``:
#: it is not a property of one render, so it must not enter the timing signature.
DEFAULT_TAKES = 2
MAX_TAKES_PER_BATCH = 12

BUILTIN_PRESETS = [
    {
        "id": "draft",
        "name": "Draft",
        "note": "Turbo model, 4 steps, small canvas, small reference videos. For judging "
                "the prompt and the material, not for picking a take.",
        "params": {**DEFAULT_PARAMS, "megapixels": 0.25, "steps": 4, "model": "turbo",
                   "ref_video_edge": 384},
    },
    {
        "id": "standard",
        "name": "Standard",
        "note": "The official template settings: 20 steps at 0.4 MP.",
        "params": {**DEFAULT_PARAMS},
    },
    {
        "id": "final",
        "name": "Final",
        "note": "Native canvas (768 px short edge), 25 steps.",
        "params": {**DEFAULT_PARAMS, "megapixels": 0.98, "steps": 25},
    },
]

DEFAULT_SETTINGS = {
    "auto_reset_on_change": True,
}


def empty_history() -> dict:
    return {"runs": [], "count": 0, "last_seconds": 0.0, "last_at": 0,
            "avg_seconds": 0.0, "signature": ""}


def empty() -> dict:
    return {
        "version": PRESETS_VERSION,
        "active": "standard",
        "presets": [dict(p, takes=DEFAULT_TAKES, history=empty_history())
                    for p in copy.deepcopy(BUILTIN_PRESETS)],
        "settings": copy.deepcopy(DEFAULT_SETTINGS),
    }


def params_signature(params: dict) -> str:
    """The parameters a timing belongs to, as one stable string.

    Written by the panel and read here, so both sides have to spell it identically:
    ``key=value`` pairs in PARAM_KEYS order joined by ``;``, numbers in their shortest
    form (12.0 -> "12", 0.4 -> "0.4").
    """
    p = normalize_params(params)

    def fmt(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return "%g" % v
        return str(v)
    return ";".join("%s=%s" % (k, fmt(p[k])) for k in PARAM_KEYS)


def _clampf(v, lo, hi, d):
    try:
        return min(hi, max(lo, float(v)))
    except (TypeError, ValueError):
        return d


def _clampi(v, lo, hi, d):
    try:
        return min(hi, max(lo, int(v)))
    except (TypeError, ValueError):
        return d


def _choice(v, options, d):
    s = str(v or "").strip()
    return s if s in options else d


def normalize_params(params: Any) -> dict:
    src = dict(params or {})
    # v1 presets held a width and a height; the area is what they cost
    if "megapixels" not in src and src.get("width") and src.get("height"):
        try:
            src["megapixels"] = float(src["width"]) * float(src["height"]) / (1024 * 1024)
        except (TypeError, ValueError):
            pass
    p = dict(DEFAULT_PARAMS)
    for k, v in src.items():
        if k in DEFAULT_PARAMS:
            p[k] = v
    p["megapixels"] = round(_clampf(p["megapixels"], 0.03, 4.0, 0.4), 3)
    p["steps"] = _clampi(p["steps"], 1, 200, 20)
    p["cfg"] = round(_clampf(p["cfg"], 0.0, 30.0, 1.0), 3)
    p["sampler_name"] = _choice(p["sampler_name"], SAMPLERS, "res_multistep")
    p["scheduler"] = _choice(p["scheduler"], SCHEDULERS, "simple")
    p["shift_video"] = round(_clampf(p["shift_video"], 0.01, 100.0, 12.0), 3)
    p["shift_audio"] = round(_clampf(p["shift_audio"], 0.01, 100.0, 3.0), 3)
    p["model"] = _choice(p["model"], MODELS, "main")
    edge = _clampi(p["ref_video_edge"], 0, 768, 0)
    p["ref_video_edge"] = edge if edge in REF_VIDEO_EDGES else min(
        (e for e in REF_VIDEO_EDGES if e), key=lambda e: abs(e - edge))
    p["ref_image_size"] = _choice(p["ref_image_size"], REF_IMAGE_SIZES, "match")
    p["vram_staging"] = _choice(p["vram_staging"], STAGING, "off")
    return p


def _normalize_history(hist: Any, signature: str, auto_reset: bool) -> dict:
    h = empty_history()
    src = hist if isinstance(hist, dict) else {}
    runs = []
    for r in (src.get("runs") or []):
        if not isinstance(r, dict):
            continue
        secs = _clampf(r.get("seconds"), 0.0, 10 ** 7, 0.0)
        if secs <= 0:
            continue
        runs.append({
            "at": _clampi(r.get("at"), 0, 10 ** 13, 0),
            "seconds": secs,
            "frames": _clampi(r.get("frames"), 0, 10 ** 5, 0),
            "signature": str(r.get("signature") or ""),
            "summary": str(r.get("summary") or ""),
        })
    runs.sort(key=lambda r: r["at"])
    # A timing measured with different parameters does not describe this preset any more.
    if auto_reset and signature:
        runs = [r for r in runs if not r["signature"] or r["signature"] == signature]
    runs = runs[-MAX_RUNS:]
    h["runs"] = runs
    h["count"] = len(runs)
    if runs:
        h["last_seconds"] = runs[-1]["seconds"]
        h["last_at"] = runs[-1]["at"]
        h["avg_seconds"] = round(sum(r["seconds"] for r in runs) / len(runs), 2)
    h["signature"] = signature
    return h


def normalize(store: Any) -> dict:
    """Complete, clamped, idempotent. Always leaves at least one preset and a valid active."""
    base = empty()
    src = store if isinstance(store, dict) else {}
    out = {"version": PRESETS_VERSION}

    settings = dict(DEFAULT_SETTINGS)
    for k, v in (src.get("settings") or {}).items():
        settings[k] = v
    settings["auto_reset_on_change"] = bool(settings.get("auto_reset_on_change", True))
    out["settings"] = settings

    raw = src.get("presets")
    if not isinstance(raw, list) or not raw:
        raw = base["presets"]

    seen_ids = set()
    presets = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or f"preset{i}").strip() or f"preset{i}"
        while pid in seen_ids:
            pid = f"{pid}_2"
        seen_ids.add(pid)
        params = normalize_params(item.get("params"))
        sig = params_signature(params)
        presets.append({
            "id": pid,
            "name": str(item.get("name") or pid),
            "note": str(item.get("note") or ""),
            "takes": _clampi(item.get("takes"), 1, MAX_TAKES_PER_BATCH, DEFAULT_TAKES),
            "params": params,
            "history": _normalize_history(item.get("history"), sig,
                                          settings["auto_reset_on_change"]),
        })
    if not presets:
        presets = [dict(p, takes=DEFAULT_TAKES, history=empty_history())
                   for p in copy.deepcopy(BUILTIN_PRESETS)]
    out["presets"] = presets

    active = str(src.get("active") or "")
    ids = [p["id"] for p in presets]
    out["active"] = active if active in ids else (
        "standard" if "standard" in ids else ids[0])

    for k, v in src.items():
        if k not in out:
            out[k] = v
    return out


def active_preset(store: Any) -> dict:
    s = normalize(store)
    for p in s["presets"]:
        if p["id"] == s["active"]:
            return p
    return s["presets"][0]


def active_params(store: Any) -> dict:
    return dict(active_preset(store)["params"])


def timing_for(preset: dict, frames: int = 0) -> dict:
    """{"count", "last_seconds", "avg_seconds"} over the runs measured at ``frames``.

    A 5 second clip and a 15 second clip cost very different amounts under one preset, so
    an average over both describes neither. ``frames=0`` takes every run.
    """
    runs = [r for r in preset["history"]["runs"]
            if not frames or not r.get("frames") or r["frames"] == int(frames)]
    if not runs:
        return {"count": 0, "last_seconds": 0.0, "avg_seconds": 0.0}
    return {"count": len(runs), "last_seconds": runs[-1]["seconds"],
            "avg_seconds": round(sum(r["seconds"] for r in runs) / len(runs), 2)}


def record_run(store: Any, preset_id: str, seconds: float, summary: str = "",
               at_ms: int | None = None, frames: int = 0) -> dict:
    """Append one timing to a preset and return the new store. Used by the panel."""
    s = normalize(store)
    for p in s["presets"]:
        if p["id"] != preset_id:
            continue
        p["history"]["runs"].append({
            "at": int(at_ms if at_ms is not None else time.time() * 1000),
            "seconds": round(float(seconds), 2),
            "frames": int(frames or 0),
            "signature": params_signature(p["params"]),
            "summary": summary or "",
        })
        break
    return normalize(s)


def clear_history(store: Any, preset_id: str | None = None) -> dict:
    """Drop timings for one preset, or for all of them when ``preset_id`` is None."""
    s = normalize(store)
    for p in s["presets"]:
        if preset_id is None or p["id"] == preset_id:
            p["history"] = empty_history()
            p["history"]["signature"] = params_signature(p["params"])
    return normalize(s)


def param_summary(params: dict) -> str:
    p = normalize_params(params)
    return (f"{p['megapixels']}MP {p['steps']}st cfg{p['cfg']} "
            f"{p['sampler_name']}/{p['scheduler']} shift {p['shift_video']}/{p['shift_audio']}"
            + (" turbo" if p["model"] == "turbo" else "")
            + (f" ref{p['ref_video_edge']}" if p["ref_video_edge"] else "")
            + (" staging" if p["vram_staging"] != "off" else ""))


def summary(store: Any, frames: int = 0) -> str:
    s = normalize(store)
    p = active_preset(s)
    t = timing_for(p, frames)
    timing = (f"last {t['last_seconds']:.0f}s, avg {t['avg_seconds']:.0f}s over "
              f"{t['count']} run(s)" if t["count"] else "no runs recorded")
    return f"preset {p['name']} [{param_summary(p['params'])}] — {timing}"
