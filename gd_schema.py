"""Gacha Director — the clip document.

Pure module. Imports nothing from ComfyUI. ``web/gd_doc.js`` mirrors :func:`normalize`;
``tests/test_schema.py`` pins the Python side.

One document describes ONE clip: a single generation window of 5 to 15 seconds.

No task modes
-------------
MiniMax H3 has five mechanisms, and every "mode" people name — text to video, first/last
frame, reference to video, video editing, continuation — is a combination of them:

    prompt        a structured text prompt (two official formats, one per model family)
    anchors       an image, a short clip or audio pinned at a frame of the target video
    references    subjects (images), videos and audio the prompt refers to by label
    source        a clip encoded into the latent the sampler starts from, plus a mask
    control       a control video (not handled here yet)

So the document stores *material with a role*, not a mode. What the panel shows as a mode
("image to video", "reference") is read off the material; nothing is switched.

Material belongs to a shot
--------------------------
The model takes one reference sequence for the whole clip (9 pictures, 3 videos, 3 audio
clips, 12 files), so material is stored clip-wide. Every item says who it belongs to:

    id     never changes. Prompt text refers to material as ``@{id}``.
    name   what the panel shows and what is typed after "@". Unique, no spaces.
    shot   the id of the shot it belongs to; "" means shared by every shot.

An anchor always belongs to a shot, and its place is relative to it (``at``: first frame,
last frame, or ``offset`` frames in), so it moves with the shot when a cut is dragged.
``frame`` is derived. Which shot something belongs to is what lets the prompt name it
without the user typing a label: see gd_compile. The official reference guide
does the same: its task types (keyframe completion, reference generation, video editing,
video continuation, audio reuse, audio reference) are derived from what each asset does.
The only switch is ``family`` — which checkpoint the node drives — because the two
families take different conditioning nodes and different prompt formats:

    reference   ref2va weights, MiniMaxH3ReferenceToVideo, the six-section prompt
    base        fl2va weights,  MiniMaxH3ImageToVideo,     the three-field prompt

Design rules
------------
* **One document, one place.** The whole state lives in the ``gd_timeline`` widget as
  JSON. Nothing is mirrored into ``node.properties`` or a proxy widget.
* **Versioned.** ``schema_version`` plus :func:`migrate`: an older document is upgraded,
  never rejected, and unknown keys survive a round trip.
* **Derived fields are recomputed, never trusted.** Frame count, cells, shot starts,
  resolved anchor frames — anything the grid dictates is rebuilt on every normalize.
* **normalize tidies, it does not veto.** A switch that cannot work in the current family
  stays as the user set it; :func:`problems` reports it and the node refuses to run.

Shots tile the clip
-------------------
``prompt.shots`` covers ``[0, frame_count)`` with no gaps: a shot stores a ``length`` and
``start`` is the running sum. A shot is a section of the *prompt* (``[Shot N] At
MM:SS.mmm, ...``), not a separate generation.
"""

from __future__ import annotations

import copy
import re
from typing import Any

from . import gd_grid as grid

SCHEMA_VERSION = 8

FAMILIES = ("reference", "base")
MASK_MODES = ("whole_clip", "free_cells", "seam_repair")
#: How a shot follows the one before it. "cut": another shot, a hard cut between the two.
#: "continuous": the same shot going on, the boundary being there only so that the two
#: stretches can be described, timed and picked apart.
JOINS = ("cut", "continuous")
PROMPT_MODES = ("structured", "raw")

#: Fixed vocabulary from the official reference guide. An invented word would reach the
#: prompt verbatim, so every marker is clamped to these.
RETENTIONS = ("fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference")
AUDIO_RETENTIONS = ("reference", "fully_copy", "partially_copy", "weak_reference")
SUBJECT_KINDS = ("person", "animal", "object", "environment", "clothing", "prop",
                 "interface", "effect", "style", "action", "expression", "pose")

#: What a source clip is to the target, when it is also sent as a reference video.
#: ``edit`` and ``continue`` are the two whole-video relationships the guide names;
#: ``motion`` is an ordinary reference (camera work, rhythm, movement).
SOURCE_ROLES = ("edit", "continue", "motion")

ANCHOR_KINDS = ("image", "clip", "audio")
#: Where in its shot an anchor sits.
ANCHOR_ATS = ("first", "last", "offset")

#: Material ids: one letter per list and a number. Ids are unique across the lists, so a
#: reference in prompt text needs no kind.
ID_PREFIX = {"subjects": "s", "videos": "v", "audio": "a", "anchors": "k"}
ID_RE = re.compile(r"[a-z][a-z0-9_]{0,23}")
#: A reference to material in prompt text.
MENTION_RE = re.compile(r"@\{([a-z][a-z0-9_]{0,23})\}")
#: The old way of naming a subject by its position.
LEGACY_REF_RE = re.compile(r"@ref([0-9]{1,6})(?![0-9])")
_NAME_SPACE = re.compile("[ \t\r\n\u3000]+")
_NAME_DROP = re.compile("[@{}<>\\[\\]()\"'`,.;:!?\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001\uff08\uff09"
                        "\u201c\u201d\u2018\u2019\u300a\u300b]")
#: Names the prompt syntax already uses: @ref1 is a subject by position, @voice(...) a voice.
_NAME_TAKEN = re.compile(r"(?:ref|char|character)[0-9]+|voice")
#: How a cited anchor image is declared: a frame of the shot it sits in, or a storyboard.
PICTURE_ROLES = ("auto", "storyboard")

#: Official limits (model card): 9 images, 3 videos, 3 audio clips, 12 files in total.
MAX_SUBJECTS = 9          # the planner numbers nine: @ref10 would stay in the prompt as written
MAX_REF_IMAGES = 9
MAX_REF_VIDEOS = 3
MAX_REF_AUDIO = 3
MAX_REF_FILES = 12

#: A shot shorter than this cannot hold a legible label and cannot cover a latent cell.
MIN_SHOT = 5

DEFAULT_MASK: dict[str, Any] = {
    "mode": "whole_clip",
    "cells": "",          # free_cells: "3-4" | "0,2..3,7" | "f39-72"
    "cut_frames": "",     # seam_repair: "68,102"
    "radius": 1,          # seam_repair: cells freed on each side of a cut
    # seam_repair: how far the freed cells are re-noised. 1 renders them from scratch;
    # lower keeps more of the two takes that meet there (the real noise level is bent by
    # the schedule shift, like source.denoise).
    "seam_denoise": 1.0,
}

DEFAULT_VIEW: dict[str, Any] = {
    "zoom": 1.0,
    "playhead": 0,
    "selected_shot": 0,
}

DEFAULT_SOURCE: dict[str, Any] = {
    "video": "",                  # file in input/
    "start": 0,                   # first frame used, counted at 24 fps
    "as_latent": False,           # encode it into the latent the sampler starts from
    "denoise": 1.0,               # how much of that latent is re-noised (as_latent only)
    "as_reference": True,         # reference family: also send it as a <Video N>
    "role": "edit",
    "retention": "fully_preserved",
    "desc": "",                   # replaces the generated <Video N> declaration
    "note": "",                   # replaces the generated retention note
    "audio": False,               # send its soundtrack as an <Audio N> as well
    "splice": [],                 # composite only: [{file, start, length, take}]
}


def empty() -> dict:
    """A fresh document. The editor starts from this."""
    return {
        "schema_version": SCHEMA_VERSION,
        "family": "reference",
        "clip": {
            "length": 124,        # frames at 24 fps, snapped to 17k+5
            "aspect": "source",   # "source" | "16:9" | "1:1" | "896:512" ...
        },
        "source": copy.deepcopy(DEFAULT_SOURCE),
        "anchors": [],            # see _norm_anchor
        "subjects": [],           # see _norm_subject
        "videos": [],             # reference videos besides the source
        "audio": [],              # reference audio
        "prompt": {
            "mode": "structured",
            "global": "",         # style and scene, ahead of [Shot 1]
            "shots": [],          # [{"id", "start" (derived), "length", "text"}]
            "summary": "",        # reference family: the summary sentence(s)
            "soundscape": "",
            "music": "",
            "negative": "",       # only used when the preset's cfg is not 1
            "raw": "",            # mode "raw": sent as written
        },
        "mask": copy.deepcopy(DEFAULT_MASK),
        "view": copy.deepcopy(DEFAULT_VIEW),
        "derived": {},
    }


# --------------------------------------------------------------------------- migration
def _media_files(bag: Any, kind: str) -> list[dict]:
    out = []
    for item in ((bag or {}).get(kind) or []) if isinstance(bag, dict) else []:
        if isinstance(item, str):
            item = {"file": item}
        if isinstance(item, dict) and str(item.get("file") or "").strip():
            out.append(item)
    return out


def _migrate_v5(doc: dict) -> dict:
    """v5 knew one job: edit a plate. Re-express that as material with roles."""
    plate = dict(doc.pop("plate", None) or {})
    old_anchors = doc.pop("anchors", None)
    common = doc.pop("common", None)
    prompt = dict(doc.get("prompt") or {})

    doc["family"] = "reference"
    doc["clip"] = {"length": int(plate.get("length") or 124), "aspect": "source"}
    doc["source"] = {
        "video": str(plate.get("video") or ""),
        "as_latent": True, "as_reference": True, "role": "edit",
        "retention": plate.get("retention") or "fully_preserved",
        "splice": plate.get("splice") or [],
    }

    anchors, subjects = [], []
    a = old_anchors if isinstance(old_anchors, dict) else {}
    if a.get("first"):
        anchors.append({"kind": "image", "file": a["first"], "frame": 0,
                        "pin": False, "cite": True})
    for m in a.get("mids") or []:
        if isinstance(m, dict) and m.get("file"):
            anchors.append({"kind": "image", "file": m["file"],
                            "frame": int(m.get("frame") or 0), "pin": False, "cite": True})
    if a.get("last"):
        anchors.append({"kind": "image", "file": a["last"], "frame": -1,
                        "pin": False, "cite": True})
    if a.get("card"):
        subjects.append({"images": [a["card"]],
                         "description": a.get("card_note") or ""})

    videos, audio = [], []
    for item in _media_files(common, "images"):
        subjects.append({"images": [item["file"]], "description": item.get("note") or ""})
    for item in _media_files(common, "videos"):
        videos.append({"file": item["file"], "desc": item.get("note") or "",
                       "retention": item.get("retention") or "weak_reference"})
    for item in _media_files(common, "audio"):
        audio.append({"file": item["file"], "desc": item.get("note") or ""})

    # v5 kept material inside each shot. That is carried over as it was: once the shots are
    # flattened nothing can say any more which picture went with which shot.
    shots = []
    for s in prompt.get("shots") or []:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "shot%d" % len(shots))
        media = s.get("media")
        for item in _media_files(media, "images"):
            anchors.append({"kind": "image", "file": item["file"], "shot": sid, "at": "first",
                            "pin": False, "cite": True, "note": item.get("note") or ""})
        for item in _media_files(media, "videos"):
            videos.append({"file": item["file"], "desc": item.get("note") or "", "shot": sid,
                           "retention": item.get("retention") or "weak_reference"})
        for item in _media_files(media, "audio"):
            audio.append({"file": item["file"], "desc": item.get("note") or "", "shot": sid})
        kept = {k: v for k, v in s.items() if k != "media"}
        kept["id"] = sid
        shots.append(kept)
    prompt["shots"] = shots
    prompt["mode"] = "raw" if prompt.pop("plan_mode", "") == "raw" else "structured"
    doc["prompt"] = prompt
    doc["anchors"] = anchors
    doc["subjects"] = subjects
    doc["videos"] = videos
    doc["audio"] = audio
    return doc


def _migrate_v6(doc: dict) -> dict:
    """v6 named a subject by its place in the list (``@ref2``, ``audio.subject = 2``).

    Places change as soon as material is grouped by shot, so both become ids here, while the
    list is still in the order those numbers were written against.
    """
    subjects = []
    for item in doc.get("subjects") if isinstance(doc.get("subjects"), list) else []:
        n = _norm_subject(item)
        if n is not None:
            n["id"] = "s%d" % (len(subjects) + 1)
            subjects.append(n)
    doc["subjects"] = subjects

    def by_place(m):
        k = int(m.group(1))
        return "@{s%d}" % k if 1 <= k <= len(subjects) else m.group(0)

    pr = doc.get("prompt")
    if isinstance(pr, dict):
        for key in ("global", "summary"):
            if isinstance(pr.get(key), str):
                pr[key] = LEGACY_REF_RE.sub(by_place, pr[key])
        for shot in pr.get("shots") if isinstance(pr.get("shots"), list) else []:
            if isinstance(shot, dict) and isinstance(shot.get("text"), str):
                shot["text"] = LEGACY_REF_RE.sub(by_place, shot["text"])
    for item in doc.get("audio") if isinstance(doc.get("audio"), list) else []:
        if isinstance(item, dict):
            k = _clampi(item.get("subject"), 0, len(subjects), 0)
            item["subject"] = "s%d" % k if k else ""
    return doc


def _migrate_v7(doc: dict) -> dict:
    """v7 had no word for how a shot follows the one before it. Every boundary was a cut in
    the prompt, and wherever a composite changed take the frames around were rendered again.

    A clip made over a source clip keeps that way of joining: the footage is given, its
    shots divide it, and they are marked as going on from one another. In a clip made from
    nothing a boundary stays the cut it was written as. A shot that already says is left
    as it says.

    The document of a composite (queued by a panel of that time, found in a history or sent
    over the API) carries the picked takes as ``source.splice``. Its pieces go on from one
    another whatever the clip is made over: that is what "rendered again around the join"
    was. Read as cuts they would be joined where the takes really cut, and the cells the
    mask frees there would be held back as holding a cut.
    """
    src = doc.get("source")
    if not isinstance(src, dict):
        return doc
    pieces = src.get("splice")
    for p in pieces if isinstance(pieces, list) else []:
        if isinstance(p, dict) and "join" not in p:
            p["join"] = "continuous"
    if not str(src.get("video") or "").strip():
        return doc
    pr = doc.get("prompt")
    shots = pr.get("shots") if isinstance(pr, dict) else None
    for s in shots if isinstance(shots, list) else []:
        if isinstance(s, dict) and "join" not in s:
            s["join"] = "continuous"
    return doc


def migrate(doc: dict) -> dict:
    """Upgrade an older document. Unknown keys are kept."""
    if not isinstance(doc, dict):
        return empty()
    doc = copy.deepcopy(doc)
    v = int(doc.get("schema_version") or 0)
    if not doc:
        return empty()
    if v == 0:
        # an unversioned document is a current one unless it carries the old layout
        legacy = "plate" in doc or "common" in doc or isinstance(doc.get("anchors"), dict)
        v = 1 if legacy else SCHEMA_VERSION
    if v == 1:
        # v1 held a single whole-clip prompt in prompt.shot
        pr = dict(doc.get("prompt") or {})
        text = pr.pop("shot", "") or ""
        if not pr.get("shots"):
            pr["shots"] = [{"id": "shot0", "length": 0, "text": text}] if text else []
        doc["prompt"] = pr
        v = 2
    if v == 2:
        # v3 moved the sampling knobs out of the document; the panel folds this into a
        # preset once and drops the key
        run = doc.pop("run", None)
        if isinstance(run, dict) and run:
            doc["_legacy_run"] = run
        v = 5
    if v in (3, 4):
        v = 5
    if v == 5:
        doc = _migrate_v5(doc)
        v = 6
    if v == 6:
        doc = _migrate_v6(doc)
        v = 7
    if v == 7:
        doc = _migrate_v7(doc)
        v = 8
    doc["schema_version"] = SCHEMA_VERSION
    return doc


# --------------------------------------------------------------------------- pieces
def _merge_defaults(src: Any, defaults: dict) -> dict:
    out = copy.deepcopy(defaults)
    for k, v in (src if isinstance(src, dict) else {}).items():
        out[k] = v
    return out


def _choice(value: Any, options: tuple, default: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in options else default


def _clampi(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _clampf(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def _file(value: Any) -> str:
    return str(value or "").strip().replace("\\", "/")


def clean_name(value: Any) -> str:
    """A material's name as it can be typed after "@": no spaces, no punctuation."""
    text = _NAME_DROP.sub("", _NAME_SPACE.sub("_", str(value or ""))).strip("_")[:40]
    return text + "_" if _NAME_TAKEN.fullmatch(text) else text


def file_stem(value: Any) -> str:
    """``shots/ella_front.png [output]`` -> ``ella_front``."""
    base = _file(value).rsplit("/", 1)[-1]
    if base.endswith("]") and " [" in base:
        base = base[:base.rindex(" [")]
    return base.rsplit(".", 1)[0] if "." in base else base


def _assign_ids(groups: list) -> None:
    """Give every item an id of its own. ``groups`` is [(items, prefix)]; an id that is
    already there and not taken is kept, so ids survive every round trip."""
    seen: set = set()
    for items, _ in groups:
        for it in items:
            i = str(it.get("id") or "")
            if ID_RE.fullmatch(i) and i not in seen:
                it["id"] = i
                seen.add(i)
            else:
                it["id"] = ""
    for items, prefix in groups:
        n = 1
        for it in items:
            if not it["id"]:
                while "%s%d" % (prefix, n) in seen:
                    n += 1
                it["id"] = "%s%d" % (prefix, n)
                seen.add(it["id"])


def _assign_names(groups: list) -> None:
    """Give every item a name of its own. ``groups`` is [(items, default name of an item)]."""
    seen: set = set()
    for items, default in groups:
        for it in items:
            base = clean_name(it.get("name")) or clean_name(default(it)) or it["id"]
            name, n = base, 2
            while name in seen:
                name = "%s_%d" % (base, n)
                n += 1
            it["name"] = name
            seen.add(name)


def _shot_ids(raw: list) -> list[str]:
    """One id per shot, each its own: a repeated or missing id gets the first free shotN."""
    taken = {str(s.get("id") or "") for s in raw}
    seen: set = set()
    out = []
    for s in raw:
        sid = str(s.get("id") or "")
        if not sid or sid in seen:
            n = 0
            while "shot%d" % n in taken or "shot%d" % n in seen:
                n += 1
            sid = "shot%d" % n
        seen.add(sid)
        out.append(sid)
    return out


def _norm_shots(shots: Any, frame_count: int, moved: dict | None = None) -> list[dict]:
    """Tile ``[0, frame_count)`` contiguously. Idempotent.

    Lengths are honoured where they fit, clamped to ``MIN_SHOT``, and the last shot absorbs
    any remainder. A document with no shots gets one covering the whole clip. When a clip
    is shortened until some shots no longer fit, their text moves into the last shot that
    does, on lines of its own: a paragraph of prompt is never lost to a change of length,
    and a spoken line stays a line (run into another, it would be read as part of what the
    other speaker says). ``moved`` receives
    {id of a shot that no longer fits: id of the shot its text went to}, so the material of
    those shots can follow.
    """
    raw = [s for s in (shots or []) if isinstance(s, dict)]
    whole = [{"id": "shot0", "start": 0, "length": frame_count, "text": "",
              "collapsed": False, "join": "cut", "sound": "cut", "seam": None}]
    if not raw:
        return whole
    ids = _shot_ids(raw)

    out: list[dict] = []
    used = 0
    for i, s in enumerate(raw):
        left = frame_count - used
        if left < MIN_SHOT:
            if out:
                rest = [str(x.get("text") or "").strip() for x in raw[i:]]
                out[-1]["text"] = "\n".join(t for t in [out[-1]["text"].strip()] + rest if t)
                if moved is not None:
                    for gone in ids[i:]:
                        moved[gone] = out[-1]["id"]
            break
        remaining_after = len(raw) - i - 1
        reserve = min(remaining_after, max(0, (left - MIN_SHOT) // MIN_SHOT)) * MIN_SHOT
        want = _clampi(s.get("length"), 0, 10 ** 6, 0)
        if want <= 0:
            want = left - reserve
        length = max(MIN_SHOT, min(want, left - reserve))
        out.append({
            "id": ids[i],
            "start": used,
            "length": length,
            "text": str(s.get("text") or ""),
            "collapsed": bool(s.get("collapsed")),
            # the first shot follows nothing
            "join": "continuous" if out and s.get("join") == "continuous" else "cut",
            # the sound across a cut: "continuous" keeps it with the take it was with (the
            # picture changes take, the sound does not). Inside a long take it is not asked:
            # there the sound goes on with the picture, and this is kept for when it is cut.
            "sound": "continuous" if out and s.get("sound") == "continuous" else "cut",
            # how much is generated again around the seam when this shot goes on from the
            # one before it and the two picked different takes: "auto" (from a little
            # before the seam to the end of its cell), or [latent frames before the
            # boundary, latent frames from it on]. None: the rule from before there was
            # such a setting, `mask.radius` cells on either side. Kept while the shot is
            # cut to, for when it goes on again.
            "seam": _norm_seam(s.get("seam")) if out else None,
        })
        used += length
    if not out:
        return whole
    if used < frame_count:
        out[-1]["length"] += frame_count - used
    return out


#: The most latent frames a seam frees on one side (eight cells).
SEAM_MOST = 40


def _norm_seam(value: Any) -> list[int] | str | None:
    """A seam's range: "auto" (to the end of the seam's cell: `gd_grid.seam_auto`),
    [before, after] in latent frames, or None when there is none (or it is neither)."""
    if value == "auto":
        return "auto"
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    return [_clampi(value[0], 0, SEAM_MOST, 0), _clampi(value[1], 0, SEAM_MOST, 0)]


def _norm_anchor(item: Any, frame_count: int, shots: list[dict],
                 moved: dict | None = None) -> dict | None:
    """One anchor: an image, a short clip or audio at a frame of the target.

    ``pin``  — hold it at that frame (first/last frame input or an Add Guide node).
    ``cite`` — give it a ``<Picture N>`` so the prompt can name it. Images only.
    ``shot``, ``at``, ``offset`` — where it sits: the first frame of its shot, the last, or
    ``offset`` frames in. ``frame`` is worked out from those. An anchor written before
    schema 7 has only a ``frame`` (-1 = the last frame of the clip); it goes to the shot
    that frame is in.
    """
    if not isinstance(item, dict):
        return None
    f = _file(item.get("file"))
    if not f:
        return None
    kind = _choice(item.get("kind"), ANCHOR_KINDS, "image")
    by_id = {x["id"]: x for x in shots}
    sid = str(item.get("shot") or "")
    sid = (moved or {}).get(sid, sid)
    at = str(item.get("at") or "")
    if sid in by_id and at in ANCHOR_ATS:
        shot = by_id[sid]
        offset = _clampi(item.get("offset"), 0, shot["length"] - 1, 0)
    else:
        old = _clampi(item.get("frame"), -1, frame_count - 1, 0)
        old = frame_count - 1 if old < 0 else old
        shot = next(x for x in shots if x["start"] <= old < x["start"] + x["length"])
        at, offset = "offset", old - shot["start"]
    # the two ends are places of their own: an anchor on one stays on it when the shot grows
    if at == "first" or (at == "offset" and offset == 0):
        at, offset = "first", 0
    elif at == "last" or offset == shot["length"] - 1:
        at, offset = "last", shot["length"] - 1
    if kind == "clip" and at == "last":
        at, offset = "first", 0                  # a clip cannot hang off the last frame
    frame = shot["start"] + offset
    out = {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "shot": shot["id"],
        "at": at,
        "offset": offset,
        "kind": kind,
        "file": f,
        "frame": frame,
        "pin": bool(item.get("pin", True)),
        "cite": bool(item.get("cite", False)) and kind == "image",
        "role": _choice(item.get("role"), PICTURE_ROLES, "auto"),
        "retention": _choice(item.get("retention"), RETENTIONS, "fully_preserved"),
        "note": str(item.get("note") or ""),
        "clip_start": 0, "clip_length": 0, "with_audio": False,
    }
    if kind == "clip":
        room = frame_count - frame
        want = _clampi(item.get("clip_length"), 0, 10 ** 6, 22) or 22
        out["clip_start"] = _clampi(item.get("clip_start"), 0, 10 ** 6, 0)
        out["clip_length"] = grid.guide_clip_length(min(want, room))
        out["with_audio"] = bool(item.get("with_audio"))
        out["pin"] = True                        # a clip has no other use
    if kind == "audio":
        out["pin"] = True
    return out


def resolved_frame(anchor: dict, frame_count: int) -> int:
    f = int(anchor.get("frame") or 0)
    return frame_count - 1 if f < 0 else min(f, frame_count - 1)


def _norm_subject(item: Any) -> dict | None:
    """Something the prompt refers to as ``@ref1`` and the model sees as ``<Subject N>``."""
    if isinstance(item, str):
        item = {"images": [item]}
    if not isinstance(item, dict):
        return None
    images = []
    listed = item.get("images") or []
    for img in ([listed] if isinstance(listed, (str, dict)) else listed):
        f = _file(img.get("file") if isinstance(img, dict) else img)
        if f and f not in images:
            images.append(f)
    description = str(item.get("description") or "")
    if not images and not description.strip():
        return None
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "shot": str(item.get("shot") or ""),
        "images": images,
        "description": description,
        "short_name": str(item.get("short_name") or ""),
        "kind": _choice(item.get("kind"), SUBJECT_KINDS, "person"),
        "retention": _choice(item.get("retention"), RETENTIONS, "fully_preserved"),
        "note": str(item.get("note") or ""),
    }


def _norm_video(item: Any) -> dict | None:
    if isinstance(item, str):
        item = {"file": item}
    if not isinstance(item, dict) or not _file(item.get("file")):
        return None
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "shot": str(item.get("shot") or ""),
        "file": _file(item.get("file")),
        "desc": str(item.get("desc") or ""),
        "retention": _choice(item.get("retention"), RETENTIONS, "fully_preserved"),
        "note": str(item.get("note") or ""),
        "audio": bool(item.get("audio")),
    }


def _norm_audio(item: Any) -> dict | None:
    if isinstance(item, str):
        item = {"file": item}
    if not isinstance(item, dict) or not _file(item.get("file")):
        return None
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "shot": str(item.get("shot") or ""),
        "file": _file(item.get("file")),
        "subject": str(item.get("subject") or ""),      # the id of the subject whose voice it is
        "retention": _choice(item.get("retention"), AUDIO_RETENTIONS, "reference"),
        "desc": str(item.get("desc") or ""),
        "note": str(item.get("note") or ""),
    }


def _list(items: Any, fn, limit: int | None = None) -> list:
    out = []
    for item in items if isinstance(items, list) else []:
        v = fn(item)
        if v is not None:
            out.append(v)
    return out if limit is None else out[:limit]


# --------------------------------------------------------------------------- normalize
def normalize(doc: Any) -> dict:
    """Return a complete, consistent document. Idempotent."""
    base = empty()
    doc = migrate(doc if isinstance(doc, dict) else {})

    out = dict(base)
    for k in ("clip", "source", "prompt", "mask", "view"):
        out[k] = _merge_defaults(doc.get(k), base[k])
    for k, v in doc.items():
        if k not in out:
            out[k] = v                     # unknown top-level keys survive
    out["schema_version"] = SCHEMA_VERSION
    out["family"] = _choice(doc.get("family"), FAMILIES, "reference")

    # --- clip and grid
    g = grid.make_grid(_clampi(out["clip"].get("length"), 5, 3600, 124))
    fc = g["frame_count"]
    out["clip"]["length"] = fc
    out["clip"]["aspect"] = str(out["clip"].get("aspect") or "source").strip() or "source"

    # --- source
    s = out["source"]
    s["video"] = _file(s.get("video"))
    s["start"] = _clampi(s.get("start"), 0, 10 ** 6, 0)
    s["as_latent"] = bool(s.get("as_latent"))
    s["as_reference"] = bool(s.get("as_reference"))
    s["denoise"] = _clampf(s.get("denoise"), 0.05, 1.0, 1.0)
    s["role"] = _choice(s.get("role"), SOURCE_ROLES, "edit")
    s["retention"] = _choice(s.get("retention"), RETENTIONS, "fully_preserved")
    s["desc"] = str(s.get("desc") or "")
    s["note"] = str(s.get("note") or "")
    s["audio"] = bool(s.get("audio"))
    s.pop("cite_ends", None)      # removed in 2.0: measured to change nothing
    pieces = []
    for item in s.get("splice") or []:
        if not isinstance(item, dict) or not _file(item.get("file")):
            continue
        start = _clampi(item.get("start"), 0, fc - 1, 0)
        pieces.append({"file": _file(item["file"]), "start": start,
                       "length": _clampi(item.get("length"), 1, fc - start, 1),
                       "take": str(item.get("take") or ""),
                       "join": "continuous" if item.get("join") == "continuous" else "cut",
                       "sound": "continuous" if item.get("sound") == "continuous" else "cut"})
    pieces.sort(key=lambda x: x["start"])
    if pieces:
        pieces[0]["join"] = pieces[0]["sound"] = "cut"
    s["splice"] = pieces

    # --- shots, which the material hangs on
    pr = out["prompt"]
    moved: dict = {}
    shots = _norm_shots(pr.get("shots"), fc, moved)
    shot_ids = {x["id"] for x in shots}

    # --- material
    out["subjects"] = _list(doc.get("subjects"), _norm_subject)
    out["videos"] = _list(doc.get("videos"), _norm_video)
    out["audio"] = _list(doc.get("audio"), _norm_audio)
    anchors = _list(doc.get("anchors"), lambda x: _norm_anchor(x, fc, shots, moved))
    for items in (out["subjects"], out["videos"], out["audio"]):
        for it in items:
            home = moved.get(it["shot"], it["shot"])
            it["shot"] = home if home in shot_ids else ""      # "" = shared by every shot
    _assign_ids([(out["subjects"], "s"), (out["videos"], "v"), (out["audio"], "a"),
                 (anchors, "k")])
    _assign_names([
        (out["subjects"], lambda x: file_stem(x["images"][0]) if x["images"]
         else x["short_name"] or x["description"][:24]),
        (out["videos"], lambda x: file_stem(x["file"])),
        (out["audio"], lambda x: file_stem(x["file"])),
        (anchors, lambda x: file_stem(x["file"])),
    ])
    known = {x["id"] for x in out["subjects"]}
    for it in out["audio"]:
        if it["subject"] not in known:
            it["subject"] = ""
    if out["family"] == "base":
        # The base model is shown a picture through its first / last frame input, and that
        # input holds the frame as well: there is no citing without pinning.
        for a in anchors:
            if a["cite"]:
                a["pin"] = True
    anchors.sort(key=lambda a: (resolved_frame(a, fc), ANCHOR_KINDS.index(a["kind"])))
    out["anchors"] = anchors

    # --- prompt
    pr["mode"] = _choice(pr.get("mode"), PROMPT_MODES, "structured")
    for k in ("global", "summary", "soundscape", "music", "negative", "raw"):
        pr[k] = str(pr.get(k) or "")
    pr["shots"] = shots

    # --- mask
    m = out["mask"]
    m["mode"] = _choice(m.get("mode"), MASK_MODES, "whole_clip")
    m["cells"] = str(m.get("cells") or "")
    m["cut_frames"] = str(m.get("cut_frames") or "")
    m["radius"] = _clampi(m.get("radius"), 1, 4, 1)
    m["seam_denoise"] = _clampf(m.get("seam_denoise"), 0.05, 1.0, 1.0)

    # --- view
    view = out["view"]
    view["zoom"] = _clampf(view.get("zoom"), 1.0, 16.0, 1.0)
    view["playhead"] = _clampi(view.get("playhead"), 0, fc - 1, 0)
    view["selected_shot"] = _clampi(view.get("selected_shot"), 0, len(pr["shots"]) - 1, 0)

    # --- derived
    try:
        free_latents, free = _free(m, g, pr["shots"])
    except ValueError:
        free_latents, free = [], []
    out["derived"] = {
        "frame_count": fc,
        "seconds": round(fc / grid.FPS, 3),
        "latent_t": g["latent_t"],
        "audio_t": g["audio_t"],
        "cell_count": g["cell_count"],
        "cells": g["cells"],
        # What a masked run generates again: the latent frames are what the mask is made
        # of, the cells are those that hold any of them (a summary: a cell in this list
        # need not be free as a whole).
        "free_latents": free_latents,
        "free_cells": free,
        "latent_source": latent_source(out),
        "anchor_frames": [resolved_frame(a, fc) for a in anchors],
        # only shots overlapping a free cell are re-read by a masked run
        "live_shot_indices": _live_shots(pr["shots"], free, g),
    }
    return out


def latent_source(doc: dict) -> str:
    """What the sampler starts from: "splice", "source" or "empty"."""
    s = doc.get("source") or {}
    if s.get("splice"):
        return "splice"
    if s.get("video") and s.get("as_latent"):
        return "source"
    return "empty"


def reference_source(doc: dict) -> bool:
    """Is the source clip also sent as a reference video?"""
    s = doc.get("source") or {}
    return bool(doc.get("family") == "reference" and s.get("video") and s.get("as_reference"))


def long_takes(shots: list[dict]) -> list[tuple[int, int]]:
    """The long takes of a clip as ``(first frame, frame after the last)``: every run of
    shots of which each but the first continues the one before it. A shot that is cut to
    and cut from is a long take of its own."""
    out: list[list[int]] = []
    for s in shots:
        a, b = int(s["start"]), int(s["start"]) + int(s["length"])
        if out and s.get("join") == "continuous":
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _free(mask: dict, g: dict, shots: list[dict] | None = None) -> tuple[list[int], list[int]]:
    """(latent frames, cells) a masked run generates again.

    The cells of "whole_clip" and "free_cells" are free as a whole. Around a seam it is
    the shot's own range, in latent frames, when it has one (`shots[].seam`), and
    `mask.radius` cells on either side when it has none: the rule from before a seam had
    a range of its own, which documents saved then keep.
    """
    n = g["cell_count"]
    mode = mask.get("mode", "whole_clip")
    if mode != "seam_repair":
        cells = list(range(n)) if mode == "whole_clip" else grid.parse_cells(mask.get("cells") or "", g)
        return grid.cells_latents(cells, n), cells
    cuts = [int(x) for x in str(mask.get("cut_frames") or "").replace(" ", "").split(",") if x]
    radius = int(mask.get("radius") or 1)
    bounds = grid.latent_bounds(g["frame_count"])
    # A frame inside a long take is repaired inside that long take: what reaches past its
    # ends holds a cut, and a cut generated again lands somewhere else. (That goes for a
    # frame named by hand as well as for one where a shot begins. A frame ON a cut is the
    # cut itself: redoing around it is what was asked.)
    takes = long_takes(shots or [])
    inside = {f: take for f in cuts for take in takes if take[0] < f < take[1]}
    own = {int(s["start"]): s.get("seam") for s in (shots or [])
           if s.get("join") == "continuous" and s.get("seam")}
    out: set[int] = set()
    for f in cuts:
        if f in own:
            latents = (grid.seam_auto(f, g) if own[f] == "auto"
                       else grid.seam_latents(f, g, own[f][0], own[f][1]))
            if f in inside:
                a, b = inside[f]
                # a latent frame is freed whole or not at all
                latents = [t for t in latents if bounds[t][0] >= a and bounds[t][1] < b]
        else:
            cells = grid.seam_cells([f], g, radius=radius)
            if f in inside:
                a, b = inside[f]
                cells = [c for c in cells if g["cells"][c][0] >= a and g["cells"][c][1] < b]
            latents = grid.cells_latents(cells, n)
        out.update(latents)
    return sorted(out), sorted({grid.cell_of_latent(t, n) for t in out})


def _free_cells(mask: dict, g: dict, shots: list[dict] | None = None) -> list[int]:
    """The cells that hold anything a masked run generates again (see `_free`)."""
    return _free(mask, g, shots)[1]


def _live_shots(shots: list[dict], free: list[int], g: dict) -> list[int]:
    out = []
    for i, s in enumerate(shots):
        a, b = int(s["start"]), int(s["start"]) + int(s["length"]) - 1
        if any(not (b < g["cells"][c][0] or a > g["cells"][c][1]) for c in free):
            out.append(i)
    return out


# --------------------------------------------------------------------------- validation
#: Every state that cannot run, as a code and the English sentence for it. The panel words
#: the same codes in its own language (web/gd_i18n.js, keys "problem.<code>"), so a code or
#: its arguments cannot change without changing those rows.
PROBLEM_TEXT = {
    "mask_no_source": "the mask keeps part of a clip, but there is no source clip in the "
                      "latent to keep (turn on \"start from the source clip\" or set the "
                      "mask to the whole clip)",
    "mask_frees_nothing": "the mask frees no cells, so the run would only reproduce its source",
    "seam_no_cut": "seam repair needs at least one cut frame",
    "splice_length": "the composite splice covers %d frames but the clip is %d: every "
                     "segment needs a pick",
    "base_source_reference": "the base model takes no reference videos: the source clip can "
                             "only be used as the starting latent here",
    "base_videos": "the base model takes no reference videos (%d listed); switch to the "
                   "reference model or remove them",
    "base_audio": "the base model takes no reference audio (%d listed); pin audio at a frame "
                  "instead, or switch to the reference model",
    "subjects": "%d subjects, but the limit is %d (subjects without a picture count too)",
    "ref_images": "%d reference images, but the model takes at most %d",
    "ref_videos": "%d reference videos, but the model takes at most %d",
    "ref_audio": "%d reference audio clips, but the model takes at most %d",
    "ref_audio_tracks": "%d reference audio clips (%d of them soundtracks), but the model "
                        "takes at most %d",
    "ref_files": "%d reference files in all, but the model takes at most %d",
    "two_cited": "two pictures are cited at frame %d (%s and %s); a frame of the target can "
                 "be shown one picture",
    "clip_past_end": "the clip pinned at frame %d runs past the end of the video",
    "two_pinned": "two pictures are pinned at frame %d (%s and %s)",
    "raw_empty": "the prompt is in free-text mode but the text is empty",
    "mention_gone": "the text of shot %d refers to material that is no longer there (%s)",
    "mention_gone_other": "the ambient sound, the music or a subject's description refers to "
                          "material that is no longer there (%s)",
    "mention_gone_global": "the overall description refers to material that is no longer "
                           "there (%s)",
}


def problems_coded(doc: dict) -> list[list]:
    """States that cannot run, as ``[code, [arguments]]``. Empty means runnable as far as
    the document can tell.

    normalize never rewrites these away: a switch the user set stays set, and this says
    why it will not work.
    """
    d = normalize(doc)
    out: list[list] = []

    def add(code, *args):
        out.append([code, list(args)])

    fam, s, fc = d["family"], d["source"], d["derived"]["frame_count"]
    src = d["derived"]["latent_source"]

    if d["mask"]["mode"] != "whole_clip":
        if src == "empty":
            add("mask_no_source")
        elif not d["derived"]["free_cells"] and not (src == "splice"
                                                     and d["mask"]["mode"] == "seam_repair"):
            # (a composite whose takes meet only at cuts repairs no seam: nothing is free,
            # and nothing is rendered)
            add("mask_frees_nothing" if d["mask"]["mode"] == "free_cells" else "seam_no_cut")
    if s["splice"]:
        # the pieces lie end to end from the first frame to the last: adding up to the
        # clip's length is not enough, two pieces can do that and overlap
        covered, at, tiled = sum(p["length"] for p in s["splice"]), 0, True
        for p in s["splice"]:
            tiled = tiled and p["start"] == at
            at += p["length"]
        if covered != fc or not tiled:
            add("splice_length", covered, fc)

    if len(d["subjects"]) > MAX_SUBJECTS:
        add("subjects", len(d["subjects"]), MAX_SUBJECTS)
    if fam == "base":
        if s["video"] and s["as_reference"] and not s["as_latent"]:
            add("base_source_reference")
        if d["videos"]:
            add("base_videos", len(d["videos"]))
        if d["audio"]:
            add("base_audio", len(d["audio"]))
    else:
        images = sum(len(x["images"]) for x in d["subjects"]) + sum(
            1 for a in d["anchors"] if a["cite"])
        if images > MAX_REF_IMAGES:
            add("ref_images", images, MAX_REF_IMAGES)
        videos = len(d["videos"]) + (1 if reference_source(d) else 0)
        if videos > MAX_REF_VIDEOS:
            add("ref_videos", videos, MAX_REF_VIDEOS)
        # a soundtrack is an audio reference like any other
        tracks = (1 if reference_source(d) and s["audio"] else 0) + sum(
            1 for v in d["videos"] if v["audio"])
        audio = len(d["audio"]) + tracks
        if audio > MAX_REF_AUDIO:
            if tracks:
                add("ref_audio_tracks", audio, tracks, MAX_REF_AUDIO)
            else:
                add("ref_audio", audio, MAX_REF_AUDIO)
        if images + videos + audio > MAX_REF_FILES:
            add("ref_files", images + videos + audio, MAX_REF_FILES)

    pinned, cited = {}, {}
    for a in d["anchors"]:
        if not (a["pin"] or a["cite"]):
            continue
        f = resolved_frame(a, fc)
        if a["cite"]:
            if f in cited:
                add("two_cited", f, cited[f], a["file"])
            cited[f] = a["file"]
        if a["kind"] == "clip" and f + a["clip_length"] > fc:
            add("clip_past_end", f)
        if a["pin"] and a["kind"] in ("image", "clip"):
            if f in pinned:
                add("two_pinned", f, pinned[f], a["file"])
            pinned[f] = a["file"]
    if d["prompt"]["mode"] == "raw" and not d["prompt"]["raw"].strip():
        add("raw_empty")
    ids = set(material(d))
    for key in ("global", "summary"):
        for gone in sorted({m for m in MENTION_RE.findall(d["prompt"][key]) if m not in ids}):
            add("mention_gone_global", "@{%s}" % gone)
    for n, shot in enumerate(d["prompt"]["shots"], 1):
        for gone in sorted({m for m in MENTION_RE.findall(shot["text"]) if m not in ids}):
            add("mention_gone", n, "@{%s}" % gone)
    # every other text that may name material: see MENTION_FIELDS in web/gd_material.js
    other = [d["prompt"]["soundscape"], d["prompt"]["music"]] + [x["description"] for x in d["subjects"]]
    for gone in sorted({m for text in other for m in MENTION_RE.findall(text) if m not in ids}):
        add("mention_gone_other", "@{%s}" % gone)
    return out


def material(doc: dict) -> dict:
    """Every piece of material of a normalized document by id:
    {id: (list name, index in that list, the item)}."""
    out = {}
    for key in ("subjects", "videos", "audio", "anchors"):
        for i, it in enumerate(doc.get(key) or []):
            out[it["id"]] = (key, i, it)
    return out


def problems(doc: dict) -> list[str]:
    """:func:`problems_coded`, as English sentences."""
    return [PROBLEM_TEXT[code] % tuple(args) for code, args in problems_coded(doc)]


def summary(doc: dict) -> str:
    """One paragraph a human can check in a report."""
    d = normalize(doc)
    s, dv = d["source"], d["derived"]
    shots = d["prompt"]["shots"]
    src = {"empty": "empty latent", "source": "source clip, denoise %s" % s["denoise"],
           "splice": ("splice of %d takes, seam denoise %s" % (len(s["splice"]),
                                                               d["mask"]["seam_denoise"])
                      if dv["free_cells"] else
                      "the picks of %d takes cut together, nothing rendered" % len(s["splice"]))}
    lines = [
        "%s family  %df (%.2fs)  aspect %s" % (d["family"], dv["frame_count"], dv["seconds"],
                                               d["clip"]["aspect"]),
        "start: %s" % src[dv["latent_source"]],
    ]
    if s["video"]:
        lines.append("source %s  latent=%s reference=%s (%s)%s" % (
            s["video"], "on" if s["as_latent"] else "off",
            "on" if reference_source(d) else "off", s["role"],
            "  +soundtrack" if s["audio"] else ""))
    if d["anchors"]:
        lines.append("anchors: " + ", ".join(
            "%s@%d%s%s" % (a["kind"], resolved_frame(a, dv["frame_count"]),
                           "p" if a["pin"] else "", "c" if a["cite"] else "")
            for a in d["anchors"]))
    if d["subjects"] or d["videos"] or d["audio"]:
        lines.append("references: %d subject(s) with %d image(s), %d video(s), %d audio"
                     % (len(d["subjects"]), sum(len(x["images"]) for x in d["subjects"]),
                        len(d["videos"]), len(d["audio"])))
    lines.append("shots %d: " % len(shots) + " | ".join(
        "%d+%d" % (x["start"], x["length"]) for x in shots))
    if dv["latent_source"] != "empty":
        lines.append("mask %s  free cells %s of %d"
                     % (d["mask"]["mode"], dv["free_cells"], dv["cell_count"]))
        whole = grid.cells_latents(dv["free_cells"], dv["cell_count"])
        if dv["free_latents"] != whole:
            # a seam with a range of its own frees less than whole cells
            bounds = grid.latent_bounds(dv["frame_count"])
            lines.append("  of them only the latent frames %s (frames %s)" % (
                dv["free_latents"], ", ".join("%d-%d" % tuple(bounds[t]) for t in dv["free_latents"])))
    return "\n".join(lines)
