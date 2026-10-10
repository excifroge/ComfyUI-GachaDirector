"""Gacha Director — takes: the candidates rendered for a clip, the pick per segment, and the
composite built from the picks.

Pure module. Imports nothing from ComfyUI. ``web/gd_takes_doc.js`` mirrors :func:`normalize`.

The funnel
----------
    candidates  ->  pick per segment  ->  final

A **take** is one finished whole-clip render, identified by the prompt the panel queued.
Every take is a candidate for every segment. There is no "re-render only this segment":
the model renders the whole clip every time, so that would cost exactly what a new take
costs, and it would start from generated frames. Another roll is another seed.

The final clip is one of two things:

* **every segment picked the same take** — that take *is* the final clip. Nothing is
  rendered again.
* **picks span several takes** — a composite: the picked ranges are spliced into one clip,
  which becomes the starting latent of one more run with a ``seam_repair`` mask (cells
  freed on each side of every cut where the take changes). A plain cut does not hide such
  a seam, so this is the one place generated frames go back into generation.

Whether takes can be mixed at all depends on the clip. Takes that share a source clip, a
control video or dense keyframes move alike and tend to cut together; unconstrained takes
are different videos. The document cannot tell which is which — only the result can.
"""

from __future__ import annotations

import time
from typing import Any

TAKES_VERSION = 2
STATUSES = ("queued", "running", "done", "failed", "missing")
MAX_TAKES = 200


def empty() -> dict:
    return {
        "version": TAKES_VERSION,
        # [{id, seed, prompt_id, file, status, at, preset, summary, note, frames}]
        # ``frames`` is the clip length the take was rendered at (0 = not recorded): a take
        # of another length is not material for this clip.
        "takes": [],
        "picks": {},          # {"<segment index>": take id}
        # ``key`` names the picks the composite was rendered from (:func:`plan_key`), so a
        # composite of earlier picks is never shown as the final clip of the current ones.
        "composite": {"prompt_id": "", "file": "", "status": "", "at": 0, "seed": 0, "key": "",
                      "frames": 0, "note": "", "starts": ""},
        # The final clip with its face refined: one more run over ``of`` (a take's file or
        # the composite's). ``key`` names what it was made from and with, as above.
        "refine": {"prompt_id": "", "file": "", "status": "", "at": 0, "seed": 0, "key": "", "of": ""},
    }


def _clampi(v, lo, hi, d):
    try:
        return min(hi, max(lo, int(v)))
    except (TypeError, ValueError):
        return d


def normalize(store: Any) -> dict:
    src = store if isinstance(store, dict) else {}
    out = empty()

    seen = set()
    takes = []
    for i, t in enumerate(src.get("takes") or []):
        if not isinstance(t, dict):
            continue
        # v1 had takes scoped to one segment (rendered from other takes); they are not
        # candidates in this model
        if t.get("scope") not in (None, "whole"):
            continue
        tid = str(t.get("id") or f"take{i}").strip() or f"take{i}"
        if tid in seen:
            continue
        seen.add(tid)
        status = str(t.get("status") or "queued")
        takes.append({
            "id": tid,
            "seed": _clampi(t.get("seed"), 0, 2 ** 64, 0),
            "prompt_id": str(t.get("prompt_id") or ""),
            "file": str(t.get("file") or ""),
            "status": status if status in STATUSES else "queued",
            "at": _clampi(t.get("at"), 0, 10 ** 13, 0),
            "preset": str(t.get("preset") or ""),
            "summary": str(t.get("summary") or ""),
            "note": str(t.get("note") or ""),
            "frames": _clampi(t.get("frames"), 0, 10 ** 6, 0),
            # how the clip was divided into shots when this take was rendered
            # (:func:`layout_key`); "" for a take from before that was recorded
            "layout": str(t.get("layout") or ""),
        })
    takes.sort(key=lambda t: t["at"])
    out["takes"] = takes[-MAX_TAKES:]
    ids = {t["id"] for t in out["takes"]}

    picks = {}
    for k, v in (src.get("picks") or {}).items():
        try:
            seg = int(k)
        except (TypeError, ValueError):
            continue
        if seg >= 0 and str(v) in ids:
            picks[str(seg)] = str(v)
    out["picks"] = picks

    c = src.get("composite") if isinstance(src.get("composite"), dict) else {}
    out["composite"] = {
        "prompt_id": str(c.get("prompt_id") or ""),
        "file": str(c.get("file") or ""),
        "status": str(c.get("status") or "") if str(c.get("status") or "") in STATUSES else "",
        "at": _clampi(c.get("at"), 0, 10 ** 13, 0),
        "seed": _clampi(c.get("seed"), 0, 2 ** 64, 0),
        "key": str(c.get("key") or ""),
        # what the run reported once it was done: how long the clip came out (a cut
        # between two takes can cost a few frames) and what was done at each join
        "frames": _clampi(c.get("frames"), 0, 10 ** 6, 0),
        "note": str(c.get("note") or ""),
        # and the frame each shot starts at in it, "0,58,120": the cuts of a joined clip
        # are where its takes had theirs, not where the document asks for them
        "starts": ",".join(x for x in str(c.get("starts") or "").replace(" ", "").split(",")
                           if x.isascii() and x.isdigit()),
    }
    r = src.get("refine") if isinstance(src.get("refine"), dict) else {}
    out["refine"] = {
        "prompt_id": str(r.get("prompt_id") or ""),
        "file": str(r.get("file") or ""),
        "status": str(r.get("status") or "") if str(r.get("status") or "") in STATUSES else "",
        "at": _clampi(r.get("at"), 0, 10 ** 13, 0),
        "seed": _clampi(r.get("seed"), 0, 2 ** 64, 0),
        "key": str(r.get("key") or ""),
        "of": str(r.get("of") or ""),
    }
    for k, v in src.items():
        if k not in out:
            out[k] = v
    return out


def finished(store: Any) -> list[dict]:
    """Takes a segment can pick from."""
    return [t for t in normalize(store)["takes"] if t["status"] == "done" and t["file"]]


def segment_status(store: Any, segment: int) -> str:
    """'picked' | 'takes' | 'none' — what the navigation timeline paints."""
    s = normalize(store)
    if str(int(segment)) in s["picks"]:
        return "picked"
    return "takes" if finished(s) else "none"


def all_picked(store: Any, segment_count: int) -> bool:
    s = normalize(store)
    return segment_count > 0 and all(str(i) in s["picks"] for i in range(segment_count))


def splice_plan(store: Any, shots: list[dict]) -> list[dict]:
    """[{file, start, length, take}] per segment, in order.

    Raises ValueError when a segment has no pick, its take has no finished file, or the
    take was rendered at another clip length.
    """
    s = normalize(store)
    by_id = {t["id"]: t for t in s["takes"]}
    plan = []
    for i, shot in enumerate(shots):
        tid = s["picks"].get(str(i))
        if not tid:
            raise ValueError(f"segment {i + 1} has no pick")
        t = by_id.get(tid)
        if not t or t["status"] != "done" or not t["file"]:
            raise ValueError(f"segment {i + 1}: take {tid} has no finished file")
        if t["frames"]:
            total = sum(int(x["length"]) for x in shots)
            if t["frames"] != total:
                raise ValueError(f"segment {i + 1}: take {tid} is {t['frames']} frames long, "
                                 f"the clip is {total}")
        plan.append({"file": t["file"], "start": int(shot["start"]),
                     "length": int(shot["length"]), "take": tid,
                     "join": "continuous" if plan and shot.get("join") == "continuous" else "cut",
                     "sound": "continuous" if plan and shot.get("sound") == "continuous" else "cut"})
    return plan


def single_take(plan: list[dict]) -> str:
    """The take id when every segment picked the same one, else "".

    A plan like that needs no composite: the take is already the final clip.
    """
    ids = {p["take"] for p in plan}
    return next(iter(ids)) if len(ids) == 1 else ""


def plan_key(plan: list[dict]) -> str:
    """What a composite is made from, as one string: equal keys mean equal picks, joined
    the same way."""
    def mark(p):
        if p.get("join") == "continuous":
            return "~"
        return "^" if p.get("sound") == "continuous" else ""        # the sound goes on across a cut

    return "|".join("%s:%d+%d%s" % (p["file"], int(p["start"]), int(p["length"]), mark(p)) for p in plan)


def layout_key(shots: list[dict]) -> str:
    """How a clip is divided into shots, as one string: the frame each shot starts at, with
    "~" where it goes on from the shot before (a long take).

    A take keeps the one it was rendered with. Its cuts lie where the shots were then, so
    when the division has changed since, the panel can say that the take is of another one.
    """
    return ",".join("%d%s" % (int(s["start"]), "~" if i and s.get("join") == "continuous" else "")
                    for i, s in enumerate(shots))


def cut_frames(plan: list[dict]) -> list[int]:
    """Frames where the take changes: the joins a composite has to make."""
    return [int(b["start"]) for a, b in zip(plan, plan[1:]) if a["take"] != b["take"]]


def seam_frames(plan: list[dict]) -> list[int]:
    """The joins inside a long take: two takes of one shot meet, and the frames around the
    join are rendered again so that the one runs into the other."""
    return [int(b["start"]) for a, b in zip(plan, plan[1:])
            if a["take"] != b["take"] and b.get("join") == "continuous"]


def hard_cuts(plan: list[dict]) -> list[int]:
    """The joins at a cut: two shots from two takes, put one after the other as they are."""
    return [int(b["start"]) for a, b in zip(plan, plan[1:])
            if a["take"] != b["take"] and b.get("join") != "continuous"]


def add_take(store: Any, *, seed: int, prompt_id: str, preset: str = "",
             summary: str = "", at_ms: int | None = None, take_id: str | None = None,
             frames: int = 0, layout: str = "") -> dict:
    s = normalize(store)
    tid = take_id or f"t{(at_ms or int(time.time() * 1000)):x}{len(s['takes']):02d}"
    s["takes"].append({
        "id": tid, "seed": int(seed), "prompt_id": prompt_id,
        "file": "", "status": "queued",
        "at": int(at_ms if at_ms is not None else time.time() * 1000),
        "preset": preset, "summary": summary, "note": "", "frames": frames,
        "layout": layout,
    })
    return normalize(s)


def update_take(store: Any, take_id: str, **fields) -> dict:
    s = normalize(store)
    for t in s["takes"]:
        if t["id"] == take_id:
            for k, v in fields.items():
                if k in t:
                    t[k] = v
    return normalize(s)


def pick(store: Any, segment: int, take_id: str | None) -> dict:
    s = normalize(store)
    if take_id is None:
        s["picks"].pop(str(int(segment)), None)
    else:
        s["picks"][str(int(segment))] = str(take_id)
    return normalize(s)


def pick_all(store: Any, segment_count: int, take_id: str) -> dict:
    """Pick one take for every segment."""
    s = normalize(store)
    for i in range(int(segment_count)):
        s["picks"][str(i)] = str(take_id)
    return normalize(s)


def summary(store: Any, segment_count: int) -> str:
    s = normalize(store)
    done = sum(1 for t in s["takes"] if t["status"] == "done")
    picked = sum(1 for i in range(segment_count) if str(i) in s["picks"])
    comp = s["composite"]
    comp_txt = (f"composite {comp['status']}" + (f" {comp['file']}" if comp["file"] else "")
                if comp["status"] else "no composite")
    return f"{done}/{len(s['takes'])} takes done, {picked}/{segment_count} segments picked, {comp_txt}"
