r"""Write the JS/Python parity fixtures.

``web/gd_doc.js``, ``web/gd_presets_doc.js``, ``web/gd_post_doc.js`` and
``web/gd_takes_doc.js`` re-implement the pure Python modules so the panel can show derived
values without a round trip to the server. Two implementations of one rule drift, and the
drift is invisible: the panel says cells 3-4 are free, the run frees something else. So
the Python side writes its answers here and the JS side is checked against them.

    python tests/make_parity_fixtures.py
    node --experimental-default-type=module tests/parity.mjs

Re-run both whenever either side changes. The fixtures are generated and are not kept in
the repository.

The file has one list per section. A case is ``{"fn", "in": [arguments], "out"}``, or
``"error": true`` in place of ``out`` where Python raises. ``"stable": true`` says a second
pass over the result gives the result back; ``"again"`` holds the second pass where it
does not.

    --fuzz N    add N random cases per section, drawn from a fixed seed. A way to hunt
                for drift, not something to commit: write those with --out elsewhere.
    --seed S    the seed for --fuzz (default 1)
    --out PATH  where to write (default tests/_parity_fixtures.json)

Things the inputs here avoid on purpose, because the JS side cannot see them the way
Python does: a whole-number float in a text field (Python prints 2.0, JSON hands JS a 2),
integers above 2**53, digits other than 0-9 in numeric text, objects whose keys collide
once read as numbers ("1" and "01"), and a list of pairs where a dict is expected (dict()
takes it, the JS side refuses it like any other non-dict).
"""
import argparse
import copy
import importlib.util
import json
import os
import random
import re
import sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_grid as G, gd_post as O, gd_presets as P  # noqa: E402
from gdpkg import gd_schema as S, gd_takes as T  # noqa: E402

SECTIONS = ("doc", "problems", "canvas", "grid", "presets", "post", "takes")
FIX: dict[str, list] = {name: [] for name in SECTIONS}
#: What a pure function raises on input it cannot digest. Anything else is a bug here.
RAISES = (ValueError, TypeError, AttributeError, ZeroDivisionError, OverflowError)


def _splice_plan(store, shots):
    """splice_plan in the shape the JS side returns: it reports instead of throwing."""
    try:
        return {"plan": T.splice_plan(store, shots), "why": ""}
    except ValueError as exc:
        m = re.match(r"segment (\d+)(:?)", str(exc))
        w = re.search(r"is (\d+) frames long, the clip is (\d+)", str(exc))
        if w:
            return {"plan": None, "why": {"key": "takesdoc.wrongLength", "args": [
                int(m.group(1)), int(w.group(1)), int(w.group(2))]}}
        key = "takesdoc.noFile" if m.group(2) else "takesdoc.noPick"
        return {"plan": None, "why": {"key": key, "args": [int(m.group(1))]}}


def _remove_take(store, take_id):
    """JS has removeTake; here it is two normalizes around dropping the take."""
    s = T.normalize(store)
    s["takes"] = [t for t in s["takes"] if t["id"] != take_id]
    return T.normalize(s)


CALLS = {
    "doc": {
        "empty": S.empty,
        "normalize": S.normalize,
        "resolved_frame": S.resolved_frame,
        "latent_source": S.latent_source,
        "reference_source": S.reference_source,
        "clean_name": S.clean_name,
        "file_stem": S.file_stem,
    },
    # the sentences and the codes behind them, checked together
    "problems": {"problems": lambda doc: {"text": S.problems(doc),
                                          "coded": S.problems_coded(doc)}},
    "canvas": {"canvas_size": lambda aspect, mp, source=None: G.canvas_size(aspect, mp, source)},
    "grid": {
        "make_grid": G.make_grid,
        "align_frame_count": G.align_frame_count,
        "parse_cells": lambda text, length: G.parse_cells(text, G.make_grid(length)),
        "seam_cells": lambda cuts, length, radius=1: G.seam_cells(cuts, G.make_grid(length), radius),
        "guide_clip_length": G.guide_clip_length,
        "latent_bounds": G.latent_bounds,
        "cells_latents": G.cells_latents,
        "cell_of_latent": G.cell_of_latent,
        "seam_latents": lambda frame, length, before, after:
            G.seam_latents(frame, G.make_grid(length), before, after),
        "seam_auto": lambda frame, length: G.seam_auto(frame, G.make_grid(length)),
    },
    "presets": {
        "empty": P.empty,
        "empty_history": P.empty_history,
        "normalize": P.normalize,
        "normalize_params": P.normalize_params,
        "params_signature": P.params_signature,
        "param_summary": P.param_summary,
        "active_preset": P.active_preset,
        "active_params": P.active_params,
        "timing_for": lambda preset, frames=0: P.timing_for(preset, frames),
        "record_run": lambda store, pid, seconds, summary="", at_ms=None, frames=0:
            P.record_run(store, pid, seconds, summary, at_ms, frames),
        "clear_history": lambda store, pid=None: P.clear_history(store, pid),
    },
    "post": {"empty": O.empty, "normalize": O.normalize},
    "takes": {
        "empty": T.empty,
        "normalize": T.normalize,
        "finished": T.finished,
        "segment_status": T.segment_status,
        "all_picked": T.all_picked,
        "splice_plan": _splice_plan,
        "single_take": T.single_take,
        "cut_frames": T.cut_frames,
        "seam_frames": T.seam_frames,
        "hard_cuts": T.hard_cuts,
        "plan_key": T.plan_key,
        "layout_key": T.layout_key,
        "add_take": lambda store, f: T.add_take(
            store, seed=f["seed"], prompt_id=f["prompt_id"], preset=f.get("preset", ""),
            summary=f.get("summary", ""), at_ms=f.get("at"), take_id=f.get("id"),
            frames=f.get("frames", 0), layout=f.get("layout", "")),
        "update_take": lambda store, tid, fields: T.update_take(store, tid, **fields),
        "remove_take": _remove_take,
        "pick": T.pick,
        "pick_all": T.pick_all,
        "summary": T.summary,
    },
}


def wire(value):
    """The value as it exists on the other side of a JSON round trip."""
    return json.loads(json.dumps(value, allow_nan=False))


def _canon(value):
    """For comparing two passes: 1.0 and 1 are one number in JSON, True and 1 are not."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_canon(v) for v in value]
    if isinstance(value, dict):
        return {k: _canon(v) for k, v in value.items()}
    return value


def case(section, fn, *args, raises=False, twice=False, loose=False):
    """Record one call. ``raises``: Python is expected to raise. ``twice``: also record a
    second pass over the result. ``loose``: either outcome is fine (random input)."""
    args = wire(list(args))
    entry = {"fn": fn, "in": args}
    try:
        out = wire(CALLS[section][fn](*copy.deepcopy(args)))
    except RAISES as exc:
        if not (raises or loose):
            raise AssertionError(f"{section}.{fn} raised {exc!r} for {args!r}") from exc
        entry["error"] = True
        entry["raised"] = type(exc).__name__
        FIX[section].append(entry)
        return None
    if raises:
        raise AssertionError(f"{section}.{fn} was expected to raise for {args!r}")
    entry["out"] = out
    if twice:
        again = wire(CALLS[section][fn](copy.deepcopy(out)))
        if json.dumps(_canon(again), sort_keys=True) == json.dumps(_canon(out), sort_keys=True):
            entry["stable"] = True
        else:
            entry["again"] = again
    FIX[section].append(entry)
    return out


# ============================================================================ document
#: A realistic v5 document: one plate, keyframes, a character card, shared media and
#: media hung on shots.
V5 = {
    "schema_version": 5,
    "plate": {"video": "plate.mp4", "length": 124, "bg": "black",
              "retention": "fully_preserved", "splice": []},
    "anchors": {"first": "", "mids": [{"file": "m.png", "frame": 35}], "last": "",
                "card": "card.png", "card_note": "the character reference"},
    "prompt": {"global": "g", "plan_mode": "official_six_section", "soundscape": "N/A",
               "music": "",
               "shots": [{"id": "shot0", "length": 60, "text": "one", "collapsed": False,
                          "media": {"images": [{"file": "s.png", "note": ""}],
                                    "videos": [], "audio": []}},
                         {"id": "shot1", "length": 64, "text": "two",
                          "media": {"images": [], "videos": [], "audio": []}}]},
    "common": {"images": [{"file": "c.png", "note": "a prop"}], "videos": [], "audio": []},
    "mask": {"mode": "free_cells", "cells": "3-4", "cut_frames": "", "radius": 1,
             "pinned_value": 0.0},
    "view": {"zoom": 1.0, "playhead": 0, "selected_shot": 0},
    "derived": {"frame_count": 124, "live_anchor_frames": [35]},
}

V5_FULL = {
    "schema_version": 5,
    "plate": {"video": "takes\\plate.mp4", "length": 243, "bg": "gray",
              "retention": "partially_preserved",
              "splice": [{"file": "b.mp4", "start": 124, "length": 119, "take": "t2"},
                         {"file": "a.mp4", "start": 0, "length": 124, "take": "t1"}]},
    "anchors": {"first": "first.png", "last": "last.png",
                "mids": [{"file": "m90.png", "frame": 90}, {"file": "m35.png", "frame": 35},
                         {"file": "", "frame": 50}, {"file": "far.png", "frame": 999},
                         "loose.png", {"frame": 12}],
                "card": "card.png", "card_note": ""},
    "prompt": {"global": "night street", "plan_mode": "raw", "soundscape": "rain",
               "music": "N/A", "raw": "trigger, sparks",
               "shots": [{"length": 73, "text": "one",
                          "media": {"images": ["s0.png", {"file": "s1.png", "note": "her face"}],
                                    "videos": [{"file": "move.mp4", "note": "camera",
                                                "retention": "attribute_transfer"}],
                                    "audio": ["voice.wav"]}},
                         "not a shot",
                         {"length": 85, "text": "two",
                          "media": {"images": [{"file": "s2.png"}], "videos": ["plain.mp4"],
                                    "audio": [{"file": "line.wav", "note": "a line"}]}},
                         {"length": 85, "text": "three", "media": None}]},
    "common": {"images": ["c0.png", {"file": "c1.png", "note": "a prop"}, {"note": "no file"}],
               "videos": [{"file": "style.mp4", "note": "grade", "retention": "weak_reference"},
                          {"file": "ref.mp4"}],
               "audio": [{"file": "amb.wav", "note": "room tone"}, "hum.wav"]},
    "mask": {"mode": "seam_repair", "cut_frames": "124", "radius": 2},
    "view": {"zoom": 2.0, "playhead": 100, "selected_shot": 2},
    "mystery": {"kept": True},
}

SHOTS3 = [{"text": "one", "length": 39}, {"text": "two", "length": 34},
          {"text": "three", "length": 51}]

#: Every entry is a document to normalize. Together they walk each field through its
#: clamps and each enum through a bad value, in both families.
DOCS = [
    # --- nothing, or not a document at all
    {}, None, [], "text", 5, True,
    {"schema_version": 6},
    {"schema_version": 6, "derived": {"frame_count": 5, "free_cells": [99], "stale": True}},

    # --- clip
    {"clip": {"length": 121}}, {"clip": {"length": 5}}, {"clip": {"length": 4}},
    {"clip": {"length": 0}}, {"clip": {"length": -10}}, {"clip": {"length": 22}},
    {"clip": {"length": 23}}, {"clip": {"length": 39}}, {"clip": {"length": 125}},
    {"clip": {"length": 300}}, {"clip": {"length": 3600}}, {"clip": {"length": 99999}},
    {"clip": {"length": "124"}}, {"clip": {"length": " 243 "}},
    {"clip": {"length": "12.5"}}, {"clip": {"length": 124.9}}, {"clip": {"length": None}},
    {"clip": {"length": True}}, {"clip": {"length": [124]}}, {"clip": {"length": "1_07"}},
    {"clip": {"aspect": "16:9"}}, {"clip": {"aspect": " 1:1 "}}, {"clip": {"aspect": ""}},
    {"clip": {"aspect": None}}, {"clip": {"aspect": 1.5}}, {"clip": {"aspect": 2}},
    {"clip": {"aspect": "SOURCE"}}, {"clip": {"aspect": ["16:9"]}},
    {"clip": {"aspect": {"w": 16, "h": "9"}}}, {"clip": {"aspect": False}},
    {"clip": {"aspect": True}}, {"clip": {"aspect": "   "}},
    {"clip": [124, "16:9"]}, {"clip": "124"}, {"clip": None},
    {"clip": {"length": 107, "aspect": "9:16", "fps": 30}},

    # --- family
    {"family": "base"}, {"family": " BASE "}, {"family": "Reference"}, {"family": "turbo"},
    {"family": None}, {"family": 5}, {"family": ["base"]}, {"family": True},

    # --- source
    {"source": {"video": "s.mp4"}},
    {"source": {"video": " dir\\sub\\s.mp4 ", "start": 12, "denoise": 0.5, "role": "continue",
                "retention": "weak_reference", "desc": "d", "note": "n", "audio": True,
                "cite_ends": True, "as_latent": False, "as_reference": False}},
    {"source": {"video": None, "start": "7", "denoise": "0.3", "role": " MOTION",
                "retention": "Attribute_Transfer ", "as_latent": 0, "as_reference": "",
                "audio": "yes", "cite_ends": [], "desc": 5, "note": None}},
    {"source": {"video": 12, "as_latent": "no", "as_reference": [0], "audio": {},
                "cite_ends": {"a": 0}, "desc": True, "note": ["a", 1, None, "it's"]}},
    {"source": {"video": "s.mp4", "as_latent": None, "as_reference": None}},
    {"source": {"video": "s.mp4", "custom": {"a": 1}, "role": "edit "}},
    {"source": "s.mp4"}, {"source": ["s.mp4"]}, {"source": None},
    # (how numeric text is read is walked through more cheaply in the preset cases)
    *[{"source": {"denoise": v}} for v in (
        0, 0.05, 1, 1.5, -1, "nan", "inf", "-inf", "abc", None, True, " .5 ", [0.5])],
    *[{"source": {"start": v}} for v in (-5, 1000001, 3.9, "3.9", "1_000", " 12 ", True)],
    {"source": {"splice": [{"file": "b.mp4", "start": 60, "length": 64, "take": "t2"},
                           {"file": "a.mp4", "start": 0, "length": 60, "take": "t1"}]}},
    {"source": {"splice": [{"file": "x.mp4", "start": 999, "length": 0},
                           {"file": "y.mp4", "start": -4, "length": 9999, "take": 7},
                           {"file": " ", "start": 3}, {"start": 3, "length": 4}, "z.mp4", None,
                           {"file": "w\\w.mp4", "start": "10", "length": "20", "take": None},
                           {"file": "v.mp4", "start": 10, "length": 5, "take": "first at 10"},
                           {"file": "u.mp4", "start": 10.9, "length": 5.9, "take": "second at 10"}]}},
    {"source": {"splice": "abc"}}, {"source": {"splice": {"file": "x.mp4"}}},
    {"source": {"splice": None}}, {"source": {"splice": []}},
    {"source": {"video": "s.mp4", "splice": [{"file": "t.mp4", "start": 0, "length": 124}]}},

    # --- subjects
    {"subjects": ["a.png", {"images": ["b.png", "b.png", {"file": "c.png"}, "", None, 5,
                                      {"file": None}, {"name": "x"}, " d\\e.png ", "d/e.png"],
                            "description": "hero", "short_name": "H", "kind": "Animal",
                            "retention": "weak_reference", "note": "n", "extra": 1},
                  {}, {"description": "  "}, {"description": "words only"}, None, 7,
                  ["x.png"], "", {"images": [], "description": 12},
                  {"images": ["k.png"], "kind": "robot", "retention": "kept", "short_name": 3,
                   "description": 0}]},
    {"subjects": [{"images": "ab.png"}, {"images": {"k1": 1, "k2": 2}},
                  {"images": [["nested.png"]]}, {"images": [True, 1.5]}]},
    {"subjects": ["s%d.png" % i for i in range(12)]},
    {"subjects": {"images": ["a.png"]}}, {"subjects": "a.png"}, {"subjects": None},
    {"subjects": [{"images": ["a.png"], "kind": k} for k in S.SUBJECT_KINDS[:9]]},
    {"subjects": [{"images": ["a.png"], "kind": k.upper() + " "} for k in S.SUBJECT_KINDS[9:]]},

    # --- reference videos and audio
    {"videos": ["v.mp4", {"file": "w.mp4", "desc": "d", "retention": "partially_preserved",
                          "note": "n", "audio": 1, "extra": True},
                {"file": ""}, {"desc": "no file"}, 3, None, {"file": " x\\y.mp4 "},
                {"file": "z.mp4", "retention": "reference", "desc": None, "audio": "0"}]},
    {"videos": "v.mp4"}, {"videos": {"file": "v.mp4"}},
    {"subjects": ["a.png", "b.png"],
     "audio": ["a.wav", {"file": "b.wav", "subject": 9, "retention": "fully_copy", "desc": "d",
                         "note": "n"},
               {"file": "c.wav", "subject": -1}, {"file": "d.wav", "subject": "1"},
               {"file": "e.wav", "subject": 1.9}, {"file": "f.wav", "subject": None,
                                                   "retention": "FULLY_COPY"},
               {"file": "g.wav", "retention": "fully_preserved"}, {"subject": 1}, 4,
               {"file": "h.wav", "subject": "two", "retention": "partially_copy"},
               {"file": "i.wav", "subject": 2, "retention": "weak_reference"}]},
    {"audio": [{"file": "v.wav", "subject": 1}]},

    # --- anchors
    {"family": "base", "anchors": [
        {"file": "z.png", "frame": -1, "cite": True},
        {"file": "a.png", "frame": 0, "cite": True},
        {"kind": "clip", "file": "c.mp4", "frame": 110, "clip_length": 30},
        {"kind": "audio", "file": "s.wav", "frame": 10, "cite": True},
        {"file": "a.png", "frame": 0},
        {"file": ""}]},
    {"anchors": [{"kind": "image", "file": "k.png", "frame": 40, "pin": False, "cite": True,
                  "role": "storyboard", "retention": "attribute_transfer", "note": "n",
                  "clip_start": 9, "clip_length": 39, "with_audio": True, "extra": 1},
                 {"file": "p.png", "frame": 41, "pin": None},
                 {"file": "q.png", "frame": 42, "pin": 0, "cite": "yes", "role": "STORYBOARD "},
                 {"file": "r.png", "frame": 43, "pin": "", "cite": [], "role": "frame",
                  "retention": "nope", "note": 5}]},
    {"anchors": [{"kind": "clip", "file": "c%d.mp4" % i, "frame": 10 * i, "clip_length": n}
                 for i, n in enumerate([0, None, "abc", 39, 40, 21, 4, 22, 5, 1000, "39", 38.9])]},
    {"anchors": [{"kind": "clip", "file": "end.mp4", "frame": 122},
                 {"kind": "clip", "file": "last.mp4", "frame": -1, "clip_length": 39},
                 {"kind": "clip", "file": "tail.mp4", "frame": 110, "clip_length": 22},
                 {"kind": "clip", "file": "start.mp4", "frame": 0, "clip_start": -3,
                  "pin": False, "cite": True, "with_audio": 1},
                 {"kind": "clip", "file": "start.mp4", "frame": 0, "clip_start": 12},
                 {"kind": "clip", "file": "start.mp4", "frame": 0, "clip_start": 12,
                  "clip_length": 5},
                 {"kind": "clip", "file": "s2.mp4", "frame": 0, "clip_start": "8"}]},
    {"anchors": [{"kind": "audio", "file": "s.wav", "frame": -1, "pin": False, "cite": True},
                 {"kind": "audio", "file": "t.wav", "frame": 60, "with_audio": True},
                 {"kind": "AUDIO ", "file": "u.wav", "frame": 60},
                 {"kind": "video", "file": "v.png", "frame": 60},
                 {"kind": None, "file": "w.png", "frame": 60},
                 {"kind": "Clip", "file": "x.mp4", "frame": 60}]},
    {"anchors": [{"file": "f%d.png" % i, "frame": v} for i, v in enumerate(
        [999, -7, "35", "abc", None, 35.7, -0.5, "-1", True, " 12 ", [3], "1e1"])]},
    {"anchors": [{"file": "same.png", "frame": -1}, {"file": "same.png", "frame": 123},
                 {"file": "same.png", "frame": 123}, {"file": "same.png", "frame": -1},
                 {"kind": "audio", "file": "same.png", "frame": 123},
                 {"kind": "clip", "file": "same.png", "frame": 123}]},
    {"anchors": [{"kind": "audio", "file": "a.wav", "frame": 20},
                 {"kind": "clip", "file": "c.mp4", "frame": 20},
                 {"kind": "image", "file": "i.png", "frame": 20},
                 {"kind": "image", "file": "h.png", "frame": 20},
                 {"kind": "image", "file": "early.png", "frame": 3}]},
    {"anchors": ["x.png", None, 5, ["y.png"], {"file": None}, {"file": " dir\\a.png "}]},
    {"schema_version": 6, "anchors": {"first": "f.png"}},
    {"anchors": "x.png"}, {"anchors": None},
    {"clip": {"length": 22}, "anchors": [{"file": "a.png", "frame": 30},
                                         {"kind": "clip", "file": "c.mp4", "frame": 20},
                                         {"kind": "clip", "file": "d.mp4", "frame": 3,
                                          "clip_length": 22}]},

    # --- prompt
    {"prompt": {"mode": "raw", "raw": "trigger, sparks"}},
    {"prompt": {"mode": " RAW ", "raw": "  "}}, {"prompt": {"mode": "free"}},
    {"prompt": {"mode": None, "global": 5, "summary": None, "soundscape": ["a", "b"],
                "music": {"k": "v"}, "negative": True, "raw": 0}},
    {"prompt": {"global": "g", "summary": "s", "soundscape": "wind", "music": "N/A",
                "negative": "blurry", "raw": "unused", "unknown_key": "kept"}},
    {"prompt": {"global": "it's \"quoted\"", "summary": ["it's", "say \"hi\"", "both ' and \"",
                                                        "tab\there", "line\nbreak", "back\\slash",
                                                        "caf\u00e9", "\u00a0nbsp", "\x7f"]}},
    {"prompt": {"global": 1.5, "summary": -0.25, "soundscape": 0.00001, "music": 1e-7,
                "negative": 123456789012, "raw": 0.0001}},
    {"prompt": "just text"}, {"prompt": ["a"]}, {"prompt": None},
    {"prompt": {"shots": []}},
    {"prompt": {"shots": [{"text": "a", "length": 40}, {"text": "b", "length": 40}]}},
    {"prompt": {"shots": [{"length": 200}, {"length": 200}, {"length": 200}]}},
    {"prompt": {"shots": [{"length": 200}, {"length": 3}]}},
    {"prompt": {"shots": [{"length": 1}, {"length": 1}, {"length": 1}]}},
    {"prompt": {"shots": [{"length": 0}, {"length": 0}]}},
    {"prompt": {"shots": [{"length": 119}, {"length": 5}]}},
    {"prompt": {"shots": [{"length": 120}, {"length": 5}]}},
    {"prompt": {"shots": [{"id": "keep", "text": "t", "length": 39}], "global": "g"}},
    {"prompt": {"shots": SHOTS3}},
    {"prompt": {"shots": [{"length": "40"}, {"length": 40.9}, {"length": -5}, {"length": None},
                          {"length": "x"}, {"length": True}]}},
    {"prompt": {"shots": [{"id": 7, "text": 5, "collapsed": 1, "media": {"images": ["m.png"]}},
                          {"id": 0, "text": None, "collapsed": "", "note": "dropped"},
                          "loose", None, 3, {"id": "", "text": ["a"], "collapsed": [0]}]}},
    {"prompt": {"shots": [{"length": 5, "text": "s%d" % i} for i in range(30)]}},
    {"clip": {"length": 5}, "prompt": {"shots": [{"length": 3}, {"length": 2}]}},
    {"clip": {"length": 22}, "prompt": {"shots": [{"length": 7}] * 6}},
    {"clip": {"length": 39}, "prompt": {"shots": [{"length": 30}, {"length": 30}, {}]}},
    {"prompt": {"shots": "abc"}}, {"prompt": {"shots": {"a": 1}}}, {"prompt": {"shots": None}},
    {"prompt": {"shots": [[1, 2], "x"]}},

    # --- mask
    # (the spec grammar itself is walked through in the grid cases; these are about a
    # spec that cannot be read freeing nothing, and about what is not text at all)
    *[{"mask": {"mode": "free_cells", "cells": c}} for c in (
        "3-4", "f39-72", "0,2..3,7", "all", " None ", "", "8", "  3 , 4  ", "4-3", "-3", "f200",
        "f72-39", "f100-999", "1, x", "F39-72", "f124", "3-4-5", "1.5",
        3, None, ["3"], 0, True)],
    {"clip": {"length": 300}, "mask": {"mode": "free_cells", "cells": "1_0, 17-18, f300-310"}},
    {"clip": {"length": 5}, "mask": {"mode": "free_cells", "cells": "0"}},
    {"clip": {"length": 5}, "mask": {"mode": "free_cells", "cells": "1"}},
    *[{"mask": {"mode": "seam_repair", "cut_frames": c, "radius": r}} for c, r in (
        ("39,90", 1), ("39", 4), ("", 1), ("40", 1), ("0", 1), ("999", 2), ("-5", 1),
        ("39, 90 ,", 1), ("39;90", 1), ("39.5", 1), (39, 1), ("73", 0), ("73", 99), ("73", "2"),
        ("73", 2.9), ("73", None), ("22,22,107", 3), ("x", 1), ([39], 1), (None, 1))],
    {"clip": {"length": 5}, "mask": {"mode": "seam_repair", "cut_frames": "2", "radius": 3}},
    {"mask": {"mode": "???", "radius": 99, "pinned_value": 5}},
    {"mask": {"mode": " FREE_CELLS ", "cells": "1"}}, {"mask": {"mode": None}},
    {"mask": {"mode": 3}}, {"mask": {"mode": "whole_clip", "cells": "3", "cut_frames": "39"}},
    *[{"mask": {"pinned_value": v}} for v in (5, -1, "0.25", None, "nan", "x")],
    {"mask": {"radius": "abc", "extra": 1}}, {"mask": "whole_clip"}, {"mask": ["free_cells"]},

    # --- view
    {"view": {"zoom": 99, "playhead": 9999, "selected_shot": 5}},
    {"view": {"zoom": 0, "playhead": -3, "selected_shot": -1}},
    {"view": {"zoom": "2.5", "playhead": "50", "selected_shot": "1", "scroll": 12},
     "prompt": {"shots": SHOTS3}},
    {"view": {"zoom": None, "playhead": 60.7, "selected_shot": 7}, "prompt": {"shots": SHOTS3}},
    {"view": {"zoom": "nan"}}, {"view": {"zoom": "inf"}}, {"view": {"zoom": 16.5}},
    {"view": [1, 2]}, {"view": None},

    # --- unknown keys
    {"mystery": 7, "prompt": {"unknown_key": "kept"}, "clip": {"extra": [1, 2]},
     "mask": {"extra": 1}, "_legacy_run": {"steps": 48}, "toString": "kept too",
     "constructor": {"a": 1}},

    # --- whole documents, one per family
    {"family": "reference", "clip": {"length": 243, "aspect": "16:9"},
     "source": {"video": "src.mp4", "start": 24, "as_latent": False, "role": "edit",
                "audio": True, "cite_ends": True},
     "subjects": [{"images": ["hero.png", "hero_back.png"], "description": "a boy in a red cape",
                   "short_name": "the boy", "kind": "person"},
                  {"images": ["kite.png"], "description": "a paper kite", "kind": "prop",
                   "retention": "partially_preserved"}],
     "videos": [{"file": "move.mp4", "desc": "the camera move", "retention": "attribute_transfer"}],
     "audio": [{"file": "voice.wav", "subject": 1, "retention": "fully_copy"}],
     "anchors": [{"file": "board.png", "frame": 124, "pin": False, "cite": True,
                  "role": "storyboard"},
                 {"kind": "clip", "file": "lead.mp4", "frame": 0, "clip_length": 22,
                  "with_audio": True}],
     "prompt": {"global": "Live-action.", "summary": "A kite climbs and dives.",
                "soundscape": "Wind.", "music": "N/A",
                "shots": [{"length": 124, "text": "A kite climbs."},
                          {"length": 119, "text": "It dives."}]},
     "mask": {"mode": "free_cells", "cells": "8-14"}, "view": {"zoom": 2, "playhead": 130,
                                                              "selected_shot": 1}},
    {"family": "base", "clip": {"length": 124, "aspect": "1:1"},
     "source": {"video": "src.mp4", "denoise": 0.6, "as_reference": False},
     "anchors": [{"file": "a.png", "frame": 0, "cite": True}, {"file": "m.png", "frame": 40},
                 {"file": "z.png", "frame": -1, "cite": True},
                 {"kind": "audio", "file": "line.wav", "frame": 48}],
     "prompt": {"shots": [{"length": 60, "text": "A kite climbs."},
                          {"length": 64, "text": "It dives."}], "negative": "blur"},
     "mask": {"mode": "seam_repair", "cut_frames": "60", "radius": 1}},

    # --- migrations
    {"schema_version": 1, "prompt": {"shot": "a v1 whole-clip prompt"}},
    {"schema_version": 1, "prompt": {"shot": ""}},
    {"schema_version": 1, "plate": {"video": "x.mp4"}, "prompt": {"shot": "only"}},
    {"schema_version": 1, "prompt": {"shot": "ignored", "shots": [{"text": "kept", "length": 50}]}},
    {"schema_version": 1, "prompt": {"shot": 5}}, {"schema_version": 1},
    {"schema_version": 1, "clip": {"length": 39}, "source": {"video": "gone.mp4"},
     "subjects": ["gone.png"], "anchors": [{"file": "gone.png"}]},
    {"schema_version": 2, "plate": {"video": "p.mp4", "length": 121},
     "run": {"width": 960, "height": 960, "steps": 48, "denoise": 0.85, "cfg": 1.0,
             "seed": 914000, "sampler": "res_multistep", "scheduler": "simple"},
     "prompt": {"shots": [{"length": 60, "text": "a"}, {"length": 64, "text": "b"}]}},
    {"schema_version": 2, "run": {}}, {"schema_version": 2, "run": "fast"},
    {"schema_version": 2, "run": {"steps": 4}, "_legacy_run": {"steps": 99}},
    {"run": {"steps": 4}},
    {"schema_version": 3, "plate": {"video": "p.mp4", "length": 124}, "run": {"steps": 4}},
    {"schema_version": 4, "plate": {"video": "p.mp4"}, "anchors": {"last": "end.png"}},
    V5, V5_FULL,
    {**V5, "schema_version": "5"}, {**V5, "schema_version": 5.0},
    {k: v for k, v in V5.items() if k != "schema_version"},
    {k: v for k, v in V5_FULL.items() if k != "schema_version"},
    {**V5, "anchors": {"first": "f.png", "last": "l.png"}},
    {**V5, "anchors": {"first": "f.png"}}, {**V5, "anchors": {"last": "l.png"}},
    {**V5, "anchors": [{"file": "list.png", "frame": 3}]}, {**V5, "anchors": None},
    {**V5, "common": ["x.png"]}, {**V5, "common": {"images": "ab"}},
    {**V5, "anchors": {"mids": "abc"}}, {**V5, "anchors": {"mids": {"file": "m.png"}}},
    {**V5, "plate": []}, {**V5, "plate": None},
    {**V5, "plate": {"length": "121", "video": 7, "retention": "invented", "splice": "x"}},
    {**V5, "plate": {"length": 121.9}}, {**V5, "plate": {"length": True}},
    {**V5, "plate": {"length": 0}}, {**V5, "plate": {"video": "p.mp4", "retention": None}},
    {**V5, "prompt": {"shots": [{"length": 60, "media": {"images": ["a.png"]}},
                                {"length": -100, "media": {"images": ["b.png"]}},
                                {"length": "30", "media": {"images": ["c.png"]}},
                                {"length": 30.9, "media": {"images": ["d.png"]}},
                                {"media": {"images": ["e.png"], "videos": "v", "audio": {"k": 1}}},
                                {"length": 500, "media": ["not a bag"]},
                                {"media": {"images": ["f.png"]}}]}},
    {**V5, "prompt": None}, {**V5, "prompt": {"plan_mode": "raw"}},
    {**V5, "prompt": {"plan_mode": "RAW", "mode": "raw", "raw": "kept text"}},
    {**V5, "family": "base", "clip": {"length": 39, "aspect": "1:1"},
     "source": {"video": "overwritten.mp4"}, "subjects": ["overwritten.png"],
     "videos": ["overwritten.mp4"], "audio": ["overwritten.wav"]},
    {"plate": {"length": 121}}, {"plate": {"length": 5}}, {"plate": {"length": 300}},
    {"plate": {"bg": "neon", "retention": "invented"}},
    {"plate": {"retention": "weak_reference"}}, {"plate": {}}, {"common": {}},
    {"common": {"images": ["only.png"]}},
    {"anchors": {"mids": [{"file": "b", "frame": 65}, {"file": "a", "frame": 35},
                          {"file": "dup", "frame": 35}, {"file": "", "frame": 50},
                          {"file": "z", "frame": 999}]}},
    {"anchors": {"first": "f", "last": "l", "card": "c", "mids": [{"file": "m", "frame": 65}]},
     "mask": {"mode": "free_cells", "cells": "3-4"}},
    {"anchors": {}},
    {"plate": {"video": "p.mp4", "length": 124},
     "anchors": {"first": "f.png", "mids": [{"file": "m35.png", "frame": 35},
                                            {"file": "m65.png", "frame": 65}]},
     "prompt": {"shots": SHOTS3}, "mask": {"mode": "free_cells", "cells": "3-4"}},
    {"schema_version": 7, "plate": {"video": "ignored.mp4"}}, {"schema_version": 99},
    {"schema_version": -1, "plate": {"video": "ignored.mp4"}},
    {"schema_version": True, "prompt": {"shot": "v1 by accident"}},
    {"schema_version": 0, "clip": {"length": 39}}, {"schema_version": None, "family": "base"},
    {"schema_version": "6", "family": "base"}, {"schema_version": 6.9, "family": "base"},
]

#: Schema 7: material has an id, a name and a shot; an anchor sits relative to its shot.
TWO_SHOTS = {"shots": [{"id": "a", "length": 68, "text": "one"}, {"id": "b", "length": 56, "text": "two"}]}
#: Shots that continue one another, and what a seam inside such a long take frees.
def _seam_doc(cut, seam, joins=("continuous",), radius=1, length=124):
    """A clip of two (or three) stretches joined inside a long take, as a composite of two
    takes that meet at `cut`, with the second stretch's own range around the seam."""
    lengths = [cut, length - cut] if len(joins) == 1 else [cut, 34, length - cut - 34]
    shots = [{"id": "a", "length": lengths[0]}]
    for i, j in enumerate(joins):
        shot = {"id": "bc"[i], "length": lengths[i + 1], "join": j}
        if i == 0 and seam != "none":
            shot["seam"] = seam
        shots.append(shot)
    pieces, start = [], 0
    for i, n in enumerate(lengths):
        pieces.append({"file": "ab"[min(i, 1)] + ".mp4", "start": start, "length": n, "take": "AB"[min(i, 1)],
                       "join": "cut" if not i else joins[i - 1]})
        start += n
    return {"clip": {"length": length}, "prompt": {"shots": shots}, "source": {"splice": pieces},
            "mask": {"mode": "seam_repair", "cut_frames": str(cut), "radius": radius}}


SEAMS = [
    _seam_doc(68, [2, 2]), _seam_doc(68, [1, 1]), _seam_doc(68, [0, 0]), _seam_doc(68, [0, 4]),
    _seam_doc(68, [4, 0]), _seam_doc(62, [1, 1]), _seam_doc(62, [0, 0]), _seam_doc(62, [2, 2]),
    # none of its own: the cells of before, at either radius
    _seam_doc(68, "none"), _seam_doc(62, "none"), _seam_doc(68, "none", radius=2), _seam_doc(68, None),
    # not a pair, out of range, not numbers: read the way the other side reads them
    _seam_doc(68, [2]), _seam_doc(68, [2, 2, 2]), _seam_doc(68, "2,2"), _seam_doc(68, [99, -3]),
    _seam_doc(68, [1.9, "3"]), _seam_doc(68, [None, True]), _seam_doc(68, {"before": 2, "after": 2}),
    # a range that reaches past the long take is cut off at its ends, a latent frame at a time
    _seam_doc(68, [40, 40]), _seam_doc(68, [3, 3], joins=("continuous", "cut")),
    _seam_doc(68, [3, 30], joins=("continuous", "cut")), _seam_doc(20, [9, 2]),
    # kept while the shot is cut to: it frees nothing then
    _seam_doc(68, [2, 2], joins=("cut",)),
    # the first shot follows nothing
    {"clip": {"length": 124}, "prompt": {"shots": [{"id": "a", "length": 68, "seam": [2, 2]},
                                                   {"id": "b", "length": 56, "join": "continuous"}]}},
    _seam_doc(122, [2, 2], length=243), _seam_doc(119, [2, 2], length=124),
    # left to itself: to the end of the seam's cell, wherever the seam is
    _seam_doc(68, "auto"), _seam_doc(62, "auto"), _seam_doc(70, "auto"), _seam_doc(20, "auto"),
    _seam_doc(120, "auto"), _seam_doc(68, "auto", joins=("continuous", "cut")), _seam_doc(68, "AUTO"),
    _seam_doc(122, "auto", length=243), _seam_doc(68, "auto", joins=("cut",)),
    # frames named by hand: one inside a long take stays inside it, one on a cut is the cut
    *[{"clip": {"length": 124}, "prompt": {"shots": [
        {"id": "a", "length": 51}, {"id": "b", "length": 17}, {"id": "c", "length": 17, "join": "continuous"},
        {"id": "d", "length": 39}]},
       "source": {"video": "src.mp4", "as_latent": True},
       "mask": {"mode": "seam_repair", "cut_frames": cuts, "radius": 1}}
      for cuts in ("60", "51", "68", "60,90", "124", "0", "84,85")],
]

LONG_TAKES = [
    {"clip": {"length": 243}, "prompt": {"shots": [
        {"id": "a", "length": 61, "join": "continuous"}, {"id": "b", "length": 61, "join": "continuous"},
        {"id": "c", "length": 61, "join": "cut"}, {"id": "d", "length": 60, "join": "continuous"}]}},
    {"clip": {"length": 243}, "prompt": {"shots": [
        {"id": "a", "length": 61}, {"id": "b", "length": 61, "join": "CONTINUOUS"},
        {"id": "c", "length": 61, "join": 1}, {"id": "d", "length": 60, "join": None}]}},
    *[{"clip": {"length": 243},
       "prompt": {"shots": [{"id": "a", "length": 61}, {"id": "b", "length": 61, "join": j1},
                            {"id": "c", "length": 61, "join": j2}, {"id": "d", "length": 60, "join": j3}]},
       "source": {"splice": [{"file": "a.mp4", "start": 0, "length": 61, "take": "A"},
                             {"file": "b.mp4", "start": 61, "length": 61, "take": "B", "join": j1},
                             {"file": "c.mp4", "start": 122, "length": 61, "take": "C", "join": j2},
                             {"file": "d.mp4", "start": 183, "length": 60, "take": "D", "join": j3}]},
       "mask": {"mode": "seam_repair", "cut_frames": cuts, "radius": radius}}
      for j1, j2, j3 in (("cut", "cut", "cut"), ("continuous", "cut", "cut"),
                         ("continuous", "continuous", "cut"), ("continuous", "continuous", "continuous"),
                         ("cut", "continuous", "continuous"))
      for cuts in ("", "61", "122", "61,122,183")
      for radius in (1, 2)],
    {"source": {"splice": [{"file": "a.mp4", "start": 0, "length": 60, "join": "continuous"},
                           {"file": "b.mp4", "start": 60, "length": 64, "join": "continuous"}]}},
    {"source": {"splice": [{"file": "b.mp4", "start": 60, "length": 64, "join": "continuous"},
                           {"file": "a.mp4", "start": 0, "length": 60, "join": 5}]}},
    # the sound across a boundary, said apart from the picture: it goes on wherever the picture
    # does, may go on across a cut, and never before the first shot or the first piece
    *[{"clip": {"length": 243},
       "prompt": {"shots": [{"id": "a", "length": 61, "sound": s0}, {"id": "b", "length": 61, "join": j1, "sound": s1},
                            {"id": "c", "length": 61, "sound": s2}, {"id": "d", "length": 60, "join": "cut", "sound": s1}]},
       "source": {"splice": [{"file": "a.mp4", "start": 0, "length": 61, "take": "A", "sound": s0},
                             {"file": "b.mp4", "start": 61, "length": 61, "take": "B", "join": j1, "sound": s1},
                             {"file": "c.mp4", "start": 122, "length": 121, "take": "C", "sound": s2}]}}
      for j1 in ("cut", "continuous")
      for s0, s1, s2 in (("continuous", "continuous", "cut"), ("cut", "cut", "continuous"),
                         (None, "CONTINUOUS", 1), ("cut", ["continuous"], "continuous"))],
]

DOCS_V7 = [
    # from before shots said how they follow one another: over a source clip they go on
    {"schema_version": 7, "source": {"video": "s.mp4"},
     "prompt": {"shots": [{"length": 60}, {"length": 34}, {"length": 30, "join": "cut"}]}},
    {"schema_version": 7, "source": {"video": "  "}, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "source": {"video": 7}, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "source": {"video": "s.mp4"}, "prompt": {"shots": "x"}},
    {"schema_version": 7, "source": {"video": "s.mp4"}, "prompt": None},
    {"schema_version": 8, "source": {"video": "s.mp4"}, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 6, "source": {"video": "s.mp4"}, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    # a composite of that time: its pieces go on from one another, over a source clip or not
    {"schema_version": 7, "source": {"video": "s.mp4", "splice": [
        {"file": "a.mp4", "start": 0, "length": 60}, {"file": "b.mp4", "start": 60, "length": 64}]},
     "mask": {"mode": "seam_repair", "cut_frames": "60"},
     "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "source": {"splice": [
        {"file": "a.mp4", "start": 0, "length": 60}, {"file": "b.mp4", "start": 60, "length": 64, "join": "cut"},
        "loose", {"file": "c.mp4", "start": 90, "length": 34}]},
     "mask": {"mode": "seam_repair", "cut_frames": "60"},
     "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "source": {"splice": "abc"}, "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    {"schema_version": 7, "source": {"splice": {"file": "a.mp4"}}, "prompt": {"shots": [{"length": 124}]}},
    {"schema_version": 8, "source": {"splice": [
        {"file": "a.mp4", "start": 0, "length": 60}, {"file": "b.mp4", "start": 60, "length": 64}]},
     "prompt": {"shots": [{"length": 60}, {"length": 64}]}},
    # ids: kept, repeated, malformed, across the lists
    {"subjects": [{"images": ["a.png"], "id": "s1"}, {"images": ["b.png"], "id": "s1"},
                  {"images": ["c.png"], "id": "Bad Id"}, {"images": ["d.png"], "id": "v1"},
                  {"images": ["e.png"], "id": 7}, {"images": ["f.png"], "id": "s2"}],
     "videos": [{"file": "x.mp4", "id": "v1"}, {"file": "y.mp4"}, {"file": "z.mp4", "id": "s1"}],
     "audio": [{"file": "x.wav", "id": "a9"}, "y.wav"],
     "anchors": [{"file": "k.png", "id": "k1"}, {"file": "l.png", "id": "k1"}, {"file": "m.png"}]},
    {"subjects": [{"images": ["a.png"], "id": "s1\n"}, {"images": ["b.png"], "id": "a" * 24},
                  {"images": ["c.png"], "id": "a" * 25}, {"images": ["d.png"], "id": "_x"},
                  {"images": ["e.png"], "id": "x_1"}, {"images": ["f.png"], "id": ""}]},
    # names: cleaned, defaulted from the file, made unique, kept clear of the prompt's own words
    {"subjects": [{"images": ["in/ella front.png"]}, {"images": ["ella front.png"]},
                  {"description": "an old man, bent"}, {"images": ["x.png"], "name": "ref1"},
                  {"images": ["y.png"], "name": " Hero (main) "}, {"images": ["z.png"], "name": "voice"},
                  {"images": ["w.png"], "name": "char12"}, {"images": ["v.png"], "name": "@{<>}"},
                  {"description": "x", "short_name": "The Kid"}],
     "videos": ["run.mp4 [output]", "a/b/run.mp4", {"file": "noext"}, {"file": ".hidden"},
                {"file": "trail.", "name": "\u3000wide\u3000shot\u3000"}],
     "audio": ["voice.wav", {"file": "v.wav", "name": "x" * 60}, {"file": "w.wav", "name": 5},
               {"file": "u.wav", "name": "\u827e\u62c9\uff0c\u7684\u58f0\u97f3"}],
     "anchors": [{"file": "a.png"}, {"file": "a.png", "name": "a"}, {"file": "b.png", "name": "__b__"}]},
    {"subjects": [{"description": "\U0001f600" * 30}, {"images": ["\U0001f600" * 45 + ".png"]}]},
    # which shot material belongs to
    {"prompt": TWO_SHOTS, "subjects": [{"images": ["s.png"], "shot": "b"}, {"images": ["t.png"], "shot": "nowhere"},
                                       {"images": ["u.png"], "shot": 5}, {"images": ["v.png"], "shot": None}],
     "videos": [{"file": "v.mp4", "shot": "a"}, {"file": "w.mp4", "shot": ""}],
     "audio": [{"file": "a.wav", "shot": "b", "subject": "s1"}, {"file": "b.wav", "subject": "s9"},
               {"file": "c.wav", "subject": 1}, {"file": "d.wav", "subject": "v1"}]},
    # anchors relative to their shot
    {"prompt": TWO_SHOTS, "anchors": [
        {"file": "f.png", "shot": "b", "at": "first"}, {"file": "l.png", "shot": "a", "at": "last"},
        {"file": "m.png", "shot": "b", "at": "offset", "offset": 10},
        {"file": "c.mp4", "kind": "clip", "shot": "b", "at": "last"},
        {"file": "d.mp4", "kind": "clip", "shot": "a", "at": "offset", "offset": 60, "clip_length": 39},
        {"file": "s.wav", "kind": "audio", "shot": "a", "at": "last"},
        {"file": "x.png", "shot": "a", "at": "offset", "offset": 0},
        {"file": "y.png", "shot": "a", "at": "offset", "offset": 67},
        {"file": "z.png", "shot": "a", "at": "offset", "offset": 999},
        {"file": "n.png", "shot": "a", "at": "offset", "offset": -4},
        {"file": "o.png", "shot": "a", "at": "offset", "offset": "12"},
        {"file": "p.png", "shot": "a", "at": "First", "offset": 3},
        {"file": "q.png", "shot": "a", "at": "middle", "frame": 100},
        {"file": "r.png", "shot": "gone", "at": "first", "frame": 70},
        {"file": "t.png", "shot": "a", "frame": 5}, {"file": "u.png", "at": "last", "frame": 5},
        {"file": "w.png", "frame": -1}, {"file": "v.png", "frame": 68}, {"file": "j.png", "frame": 67}]},
    {"prompt": TWO_SHOTS, "family": "base", "anchors": [
        {"file": "f.png", "shot": "a", "at": "first", "cite": True, "pin": False},
        {"file": "l.png", "shot": "b", "at": "last", "cite": True, "pin": False},
        {"file": "m.png", "shot": "b", "at": "first", "cite": True}]},
    # shots: ids of their own, and material follows a shot that no longer fits
    {"prompt": {"shots": [{"id": "a", "length": 40}, {"id": "a", "length": 40}, {"length": 44}]}},
    {"prompt": {"shots": [{"id": "shot1", "length": 40}, {"length": 40}, {"id": "shot0", "length": 44}]}},
    {"prompt": {"shots": [{"id": 3, "length": 40}, {"id": "", "length": 40}, {"id": None, "length": 44}]}},
    {"clip": {"length": 5}, "prompt": TWO_SHOTS,
     "subjects": [{"images": ["s.png"], "shot": "b"}], "videos": [{"file": "v.mp4", "shot": "b"}],
     "audio": [{"file": "a.wav", "shot": "b"}],
     "anchors": [{"file": "f.png", "shot": "b", "at": "first"}, {"file": "l.png", "shot": "b", "at": "last"},
                 {"file": "m.png", "shot": "b", "at": "offset", "offset": 10}]},
    {"clip": {"length": 22}, "prompt": {"shots": [{"id": "a", "length": 5}, {"id": "b", "length": 5},
                                                 {"id": "c", "length": 5}, {"id": "d", "length": 5},
                                                 {"id": "e", "length": 5}, {"id": "f", "length": 5}]},
     "anchors": [{"file": "f.png", "shot": "f", "at": "first"}, {"file": "e.png", "shot": "e", "at": "last"}],
     "subjects": [{"images": ["s.png"], "shot": "f"}, {"images": ["t.png"], "shot": "e"}]},
    # schema 6: a subject was named by its place
    {"schema_version": 6, "subjects": [{}, {"images": ["a.png"]}, {"description": "an old man"}],
     "audio": [{"file": "v.wav", "subject": 2}, {"file": "w.wav", "subject": 9},
               {"file": "x.wav", "subject": "1"}, {"file": "y.wav", "subject": None}, "z.wav", 5],
     "anchors": [{"file": "e.png", "frame": -1, "cite": True}],
     "prompt": {"global": "@ref1 and @ref2, @ref02, @ref0, @ref3, @ref1234567, @ref12a, @refs.",
                "summary": "@ref3 is nobody. @ref1.",
                "shots": [{"length": 60, "text": "@ref2 nods.\n@ref1 says: hello"},
                          {"length": 64, "text": "@char1 waits. @{s1} stays."}, {"text": 5}, "junk"]}},
    {"schema_version": 6, "subjects": "x", "audio": {"file": "v.wav", "subject": 1},
     "prompt": {"global": 5, "shots": {"text": "@ref1"}}},
    {"schema_version": 6, "prompt": "text"}, {"schema_version": 6, "subjects": [{"images": ["a.png"]}],
                                              "prompt": {"shots": [{"text": "@ref1"}]}, "audio": [{"subject": 1}]},
    # schema 5: a shot's own material stays with the shot
    {"schema_version": 5, "plate": {"video": "p.mp4"},
     "prompt": {"shots": [{"length": 60, "text": "one", "media": {
         "images": [{"file": "s.png"}, "t.png"], "videos": ["v.mp4"], "audio": ["a.wav"]}},
         {"id": "second", "length": 64, "text": "two", "media": {"images": ["u.png"]}},
         {"id": "second", "media": {"videos": [{"file": "w.mp4", "note": "n"}]}}]}},
    {"schema_version": 5, "prompt": {"shots": [{"length": "abc", "media": {"images": ["s.png"]}}]}},
    {"schema_version": 3, "prompt": {"shots": [{"id": 0, "media": {"images": ["s.png"]}},
                                               {"media": {"audio": ["a.wav"]}}]}},
]

#: Documents Python refuses outright. normalize is meant never to do that, so each of
#: these is also a robustness gap on the Python side; the JS side must fail the same way.
DOCS_THAT_RAISE = [
    {"schema_version": "abc"}, {"schema_version": [5]}, {"schema_version": {"a": 1}},
    {"schema_version": "6.0"},
    {"source": {"splice": 5}}, {"source": {"splice": True}}, {"source": {"splice": 1.5}},
    {"prompt": {"shots": 7}}, {"subjects": [{"images": 5}]}, {"subjects": [{"images": True}]},
    {"plate": "x"}, {"plate": {"length": "abc"}}, {"plate": {"length": [1]}}, {"plate": 5},
    {"schema_version": 5, "prompt": "text"}, {"schema_version": 1, "prompt": 5},
    {"schema_version": 1, "prompt": "text"},
    {"schema_version": 5, "anchors": {"mids": [{"file": "m.png", "frame": "x"}]}},
    {"schema_version": 5, "anchors": {"mids": 3}},
    {"schema_version": 5, "prompt": {"shots": 4}},
    {"schema_version": 5, "common": {"images": 5}},
    {"schema_version": 5, "prompt": {"shots": [{"media": {"videos": 1.5}}]}},
]

#: Documents for problems(), each built to trip one sentence (or, deliberately, none).
PROBLEM_DOCS = [
    {},
    {"subjects": [{"description": "thing %d" % i} for i in range(10)]},
    {"family": "base", "subjects": [{"description": "thing %d" % i} for i in range(9)]},
    {"family": "reference", "subjects": [{"images": ["%d.png" % i]} for i in range(11)]},
    {"family": "base", "videos": [{"file": "m.mp4"}]},
    {"family": "base", "videos": ["a.mp4", "b.mp4"], "audio": ["a.wav", "b.wav", "c.wav"]},
    {"family": "base", "source": {"video": "s.mp4", "as_latent": False}},
    {"family": "base", "source": {"video": "s.mp4"}},
    {"family": "base", "source": {"video": "s.mp4", "as_latent": False, "as_reference": False}},
    {"family": "base", "anchors": [{"file": "a.png", "frame": 0, "cite": True},
                                   {"file": "m.png", "frame": 40, "cite": True},
                                   {"file": "n.png", "frame": 41, "cite": True, "pin": False},
                                   {"file": "z.png", "frame": -1, "cite": True},
                                   {"file": "y.png", "frame": 123, "cite": True}]},
    {"subjects": [{"images": ["%d.png" % i for i in range(6)]},
                  {"images": ["x%d.png" % i for i in range(6)]}]},
    {"subjects": [{"images": ["%d.png" % i for i in range(9)]}]},
    {"subjects": [{"images": ["%d.png" % i for i in range(8)]}],
     "source": {"video": "s.mp4", "cite_ends": True}},
    {"subjects": [{"images": ["%d.png" % i for i in range(8)]}], "source": {"cite_ends": True}},
    {"subjects": [{"images": ["%d.png" % i for i in range(9)]}],
     "anchors": [{"file": "k.png", "frame": 10, "cite": True}]},
    {"videos": ["a.mp4", "b.mp4", "c.mp4"]},
    {"videos": ["a.mp4", "b.mp4", "c.mp4"], "source": {"video": "s.mp4"}},
    {"videos": ["a.mp4", "b.mp4", "c.mp4"], "source": {"video": "s.mp4", "as_reference": False}},
    {"videos": ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]},
    {"audio": ["a.wav", "b.wav", "c.wav"]}, {"audio": ["a.wav", "b.wav", "c.wav", "d.wav"]},
    {"mask": {"mode": "seam_repair", "cut_frames": "60"}},
    {"mask": {"mode": "free_cells", "cells": "3"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "free_cells"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "free_cells", "cells": "99"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "free_cells", "cells": "3-4"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "seam_repair"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "seam_repair", "cut_frames": "x"}},
    {"source": {"video": "s.mp4"}, "mask": {"mode": "seam_repair", "cut_frames": "60"}},
    {"source": {"video": "s.mp4", "as_latent": False}, "mask": {"mode": "seam_repair",
                                                                "cut_frames": "60"}},
    {"source": {"splice": [{"file": "t.mp4", "start": 0, "length": 124}]}},
    {"source": {"splice": [{"file": "t.mp4", "start": 0, "length": 60}]}},
    # two pieces that add up to the clip and lie on top of each other
    {"source": {"splice": [{"file": "a.mp4", "start": 0, "length": 62},
                           {"file": "b.mp4", "start": 0, "length": 62}]},
     "mask": {"mode": "seam_repair", "cut_frames": ""}},
    {"source": {"splice": [{"file": "a.mp4", "start": 0, "length": 60},
                           {"file": "b.mp4", "start": 60, "length": 64}]},
     "mask": {"mode": "seam_repair", "cut_frames": ""}},
    {"source": {"splice": [{"file": "a.mp4", "start": 0, "length": 60},
                           {"file": "b.mp4", "start": 60, "length": 64}]},
     "mask": {"mode": "seam_repair", "cut_frames": "60"}},
    {"source": {"splice": [{"file": "a.mp4", "start": 0, "length": 60},
                           {"file": "b.mp4", "start": 50, "length": 64}]},
     "mask": {"mode": "free_cells", "cells": ""}},
    {"anchors": [{"file": "a.png", "frame": 10}, {"file": "b.png", "frame": 10}]},
    {"anchors": [{"file": "a.png", "frame": 10}, {"kind": "clip", "file": "c.mp4", "frame": 10}]},
    {"anchors": [{"file": "a.png", "frame": -1}, {"file": "b.png", "frame": 123},
                 {"file": "c.png", "frame": 999}]},
    {"anchors": [{"file": "a.png", "frame": 10, "pin": False, "cite": True},
                 {"file": "b.png", "frame": 10, "pin": False},
                 {"file": "c.png", "frame": 10}]},
    {"anchors": [{"kind": "audio", "file": "a.wav", "frame": 10},
                 {"kind": "audio", "file": "b.wav", "frame": 10}, {"file": "c.png", "frame": 10}]},
    {"anchors": [{"file": "it's.png", "frame": 7}, {"file": "dir\\b.png", "frame": 7}]},
    {"prompt": {"mode": "raw"}}, {"prompt": {"mode": "raw", "raw": " \n\t "}},
    {"prompt": {"mode": "raw", "raw": "trigger"}}, {"prompt": {"raw": ""}},
    {"family": "base", "videos": ["a.mp4"], "prompt": {"mode": "raw"},
     "mask": {"mode": "free_cells", "cells": "1"},
     "anchors": [{"file": "a.png", "frame": 10}, {"file": "b.png", "frame": 10, "cite": True}]},
]


def _doc_cases():
    case("doc", "empty")
    for doc in DOCS + DOCS_V7 + LONG_TAKES + SEAMS:
        case("doc", "normalize", doc, twice=True)
        # problems() normalizes whatever it is given
        case("problems", "problems", doc)
    for doc in (
        {"prompt": {"global": "@{s9} and @{s1}", "summary": "@{zz} @{zz} @{a}",
                    "shots": [{"length": 60, "text": "@{v3} @{v3} @{k1}"}, {"length": 64, "text": "@{s1}"}]},
         "subjects": [{"images": ["a.png"]}], "anchors": [{"file": "k.png"}]},
        {"prompt": {"shots": [{"text": "@{S1} @{1s} @{} @{s1 } @ {s1} @{" + "a" * 25 + "}"}]}},
        {"prompt": {"mode": "raw", "raw": "@{s9}", "global": "@{s9}"}},
        # names in the texts that are not shots: the ambient sound, the music, a description
        {"prompt": {"soundscape": "@{a9} and @{a1}", "music": "@{zz} @{a9}"},
         "subjects": [{"images": ["a.png"], "description": "like @{v7}, not @{s1}"},
                      {"description": "@{k3} @{v7}"}],
         "audio": [{"file": "a.wav"}]},
    ):
        case("problems", "problems", doc)
    for doc in DOCS_THAT_RAISE:
        case("doc", "normalize", doc, raises=True)
        case("problems", "problems", doc, raises=True)
    for doc in (None, [], "text", 5):                 # normalize shrugs these off, so problems does
        case("problems", "problems", doc)

    for anchor, fc in (({"frame": -1}, 124), ({"frame": 0}, 124), ({"frame": 500}, 124),
                       ({"frame": 123}, 124), ({}, 124), ({"frame": None}, 5),
                       ({"frame": "7"}, 22), ({"frame": 7.9}, 22), ({"frame": -3}, 39)):
        case("doc", "resolved_frame", anchor, fc)
    case("doc", "resolved_frame", {"frame": "x"}, 124, raises=True)
    for value in ("ella front", " Hero (main) ", "ref1", "voice", "char12", "character3", "refs", "voices",
                  "@{<>}", "__b__", "a.b,c;d", "x" * 60, "", None, 5, True, "tab	here", "a  b",
                  "　wide　shot　", "艾拉，的声音", "😀" * 45,
                  "ref1_", "_ref1", "REF1", "ref", "ref01"):
        case("doc", "clean_name", value)
    for value in ("ella.png", "in/ella front.png", "a\\b\\c.d.png", "run.mp4 [output]", "x [y].png",
                  "noext", ".hidden", "trail.", "a/b/", "", None, 5, " spaced.png ", "x.png [temp]",
                  "we [ird].png [output]", "]"):
        case("doc", "file_stem", value)
    for doc in ({}, {"source": None}, {"source": {"video": "s.mp4"}},
                {"source": {"video": "s.mp4", "as_latent": True}},
                {"source": {"video": "s.mp4", "as_latent": True, "as_reference": True}},
                {"family": "reference", "source": {"video": "s.mp4", "as_reference": True}},
                {"family": "reference", "source": {"video": "", "as_reference": True}},
                {"family": "base", "source": {"video": "s.mp4", "as_reference": True}},
                {"family": "reference", "source": {"video": "s.mp4", "as_reference": 0}},
                {"source": {"splice": [{"file": "t.mp4"}], "video": "s.mp4", "as_latent": True}},
                {"source": {"splice": [], "video": "s.mp4", "as_latent": 0}}):
        case("doc", "latent_source", doc)
        case("doc", "reference_source", doc)

    for doc in PROBLEM_DOCS:
        case("problems", "problems", S.normalize(doc))
    # a derived block that came with the document is not trusted: these are judged on what
    # normalize makes of them, whatever was written into them afterwards
    d = S.normalize({"anchors": [{"kind": "clip", "file": "c.mp4", "frame": 110}]})
    d["anchors"][0]["clip_length"] = 39
    case("problems", "problems", d)
    d = S.normalize({"family": "base", "anchors": [{"file": "a.png", "frame": 50, "cite": True}]})
    d["anchors"][0]["pin"] = False
    d["anchors"].append(dict(d["anchors"][0], pin=False, cite=False, file="silent.png"))
    case("problems", "problems", d)
    d = S.normalize({"source": {"video": "s.mp4"}, "mask": {"mode": "free_cells", "cells": "2"}})
    d["derived"]["free_cells"] = []
    d["derived"]["latent_source"] = "source"
    case("problems", "problems", d)


# ============================================================================ grid, canvas
def _grid_cases():
    for n in (0, 1, 4, 5, 6, 21, 22, 23, 39, 107, 121, 124, 125, 243, 300, 3600, -3, 124.7,
              "124", " 39 ", True):
        case("grid", "make_grid", n)
        case("grid", "align_frame_count", n)
    for bad in ("abc", None, "12.5", [124]):
        case("grid", "make_grid", bad, raises=True)
        case("grid", "align_frame_count", bad, raises=True)

    ok = ["3-4", "f39-72", "0,2..3,7", "all", "ALL", "none", " None ", "", "  3 , 4  ", "4-3",
          "3-", "f0", "f5-", "f72-39", "f100-999", "1,,2", "3..", "0-7", "2-2", "+1",
          "f39 - 72", "F39-72", "f4,f5", "f123", "7,0", "1\t,2", "0..7", "f5-4", "f1_0",
          "0, 0, 0", ",", " , ", "f0-0", "f4-5", "f21-22", "f22-38", "f38-39", "1-+3", "0_1",
          None, 0, False, [], {}]
    bad = ["8", "-3", "f200", "f-5", "1, x", "3...4", "3....4", "0-8", "f", "ff5", "f124",
           "n one", "al l", "3-4-5", "f5--3", "1.5", "f1.5", "3;4", "0x1", "three", "f3..4",
           "--", "f3-x", "99", "1-99", 3, True, ["3"], {"a": 1}, 1.5]
    for text in ok:
        case("grid", "parse_cells", text, 124)
    for text in bad:
        case("grid", "parse_cells", text, 124, raises=True)
    for text, length in (("0", 5), ("all", 5), ("f0-4", 5), ("18", 311), ("f0-310", 311),
                         ("1_0,17-18", 300), ("all", 3600), ("f3000-3608", 3600), ("212", 3600)):
        case("grid", "parse_cells", text, length)
    for text, length in (("1", 5), ("f5", 5), ("19", 311), ("213", 3600)):
        case("grid", "parse_cells", text, length, raises=True)

    for cuts, length, radius in (
            ([39, 90], 124, 1), ([39], 124, 4), ([], 124, 1), ([40], 124, 1), ([0], 124, 1),
            ([5], 124, 1), ([4], 124, 1), ([123], 124, 1), ([999], 124, 2), ([-5], 124, 1),
            ([73], 124, 2), ([73], 124, 3), ([22, 22, 107], 124, 3), ([56.9], 124, 1),
            (["39", " 90 "], 124, 1), ([True], 124, 1), ([2], 5, 3), ([0], 5, 1),
            ([5, 22, 39, 56, 73, 90, 107], 124, 1), ([124], 243, 1), ([123, 125], 243, 2),
            ([60], 124, 0), ([60], 124, 1), ([56], 124, 0)):
        case("grid", "seam_cells", cuts, length, radius)
    case("grid", "seam_cells", [39, 90], 124)
    # latent frames: a cell is its first frame and then four times four
    for n in (5, 22, 39, 124, 243, 362):
        case("grid", "latent_bounds", n)
    for cells, total in (([], 8), ([0], 8), ([7], 8), ([3, 4], 8), ([4, 3, 3], 8), ([0, 14], 15), ([0], 1)):
        case("grid", "cells_latents", cells, total)
    for t, total in ((0, 8), (4, 8), (5, 8), (34, 8), (35, 8), (36, 8), (1, 1), (71, 15)):
        case("grid", "cell_of_latent", t, total)
    # a seam on the first frame of a latent frame, and one inside a latent frame
    for frame, length, before, after in (
            (68, 124, 2, 2), (68, 124, 1, 1), (68, 124, 0, 0), (68, 124, 0, 4), (68, 124, 4, 0),
            (62, 124, 1, 1), (62, 124, 0, 0), (62, 124, 2, 2), (69, 124, 1, 1), (73, 124, 1, 1),
            (1, 124, 3, 3), (0, 124, 2, 2), (123, 124, 2, 2), (119, 124, 1, 5), (120, 124, 40, 40),
            (122, 243, 2, 2), (183, 243, 3, 1), (999, 124, 1, 1), (-4, 124, 1, 1), (3, 5, 1, 1)):
        case("grid", "seam_latents", frame, length, before, after)
    # a seam left to itself, at every frame of a clip and at the ends of others
    for frame in range(0, 124):
        case("grid", "seam_auto", frame, 124)
    for frame, length in ((1, 5), (4, 5), (3, 22), (17, 22), (21, 22), (122, 243), (242, 243), (999, 243), (-3, 243)):
        case("grid", "seam_auto", frame, length)
    case("grid", "seam_cells", ["x"], 124, 1, raises=True)
    case("grid", "seam_cells", [None], 124, 1, raises=True)

    for n in list(range(-2, 46)) + [124, 125, 243, 1000, "22", " 40 ", 22.9, True]:
        case("grid", "guide_clip_length", n)
    for bad in ("x", None, "22.9"):
        case("grid", "guide_clip_length", bad, raises=True)


def _canvas_cases():
    aspects = ["16:9", "9:16", "1:1", "4:3", "3:2", "21:9", "2.39:1", "896x512", "5:4", "3:4"]
    budgets = [0.03, 0.1, 0.25, 0.4, 0.5, 0.879, 0.98, G.NATIVE_MEGAPIXELS, 1, 1.5, 2, 4]
    for aspect in aspects:
        for mp in budgets:
            case("canvas", "canvas_size", aspect, mp)
    for source in (None, [1920, 1080], [720, 1280], [1000, 1000], [0, 100], [100, 0], [-5, 5],
                   [1920.5, 1080.25], [], [864, 480]):
        for aspect in ("source", "auto", "", None, " Source ", "AUTO"):
            case("canvas", "canvas_size", aspect, 0.4, source)
        case("canvas", "canvas_size", "1:1", 0.4, source)
    case("canvas", "canvas_size", "source", 0.25, [720, 1280])
    for aspect in ("896X512", "1920/1080", "1.5", 1.5, 2, "abc", "16:9:1", "0:9", "-16:9", "16:",
                   ":9", " 16 : 9 ", "1e3:1e3", "nan:1", "1:nan", "16x9", "16/9", "1_6:9",
                   "+16:+9", ".5:1", "5.:1", "1e-3:1", "max", "0x10:1", "x", ":", "16:0",
                   "16:-9", True, False, 0, ["16:9"], "1024:1", "1:1024", "1e308:1e308",
                   "1e-160:1", "-inf:1"):
        for mp in (0.4, 1):
            case("canvas", "canvas_size", aspect, mp)
    for mp in (0, -1, 0.001, 0.01, 0.0100001, "0.4", " 1 ", True, False, "nan", "1e-9", 100, 1e6,
               "2_0", 0.5625, 3.9999):
        case("canvas", "canvas_size", "16:9", mp)
        case("canvas", "canvas_size", "1:1", mp)

    # Exact halves: the side lands precisely between two multiples of 32, where Python's
    # round() goes to the even one and a plain Math.round would go up.
    ties = [("1:1", (2 * k + 1) ** 2 / 4096) for k in range(1, 40)]
    ties += [("16:9", j * j / 256) for j in range(1, 32, 2)]
    ties += [("9:16", j * j / 256) for j in range(1, 32, 2)]
    ties += [("4:1", (2 * k + 1) ** 2 / 1024) for k in range(0, 24)]
    ties += [("1:4", (2 * k + 1) ** 2 / 1024) for k in range(0, 24)]
    ties += [("1024:1", (k + 0.5) ** 2) for k in range(0, 12)]
    ties += [("4:3", 3 * (2 * k + 1) ** 2 / 4096) for k in range(1, 30)]
    # One step off a tie is deliberately not pinned. There the answer hangs on the last
    # bit of the square root, and canvas_size takes it with ``** 0.5``, which the C
    # runtime does not always round correctly (the JS side uses Math.sqrt, which is).
    for aspect, mp in ties:
        case("canvas", "canvas_size", aspect, mp)

    for aspect, mp in (("16:9", None), ("16:9", "abc"), ("16:9", [1]), ("16:9", ""),
                       ("inf:1", 0.4), ("1:inf", 0.4), ("inf:inf", 0.4), ("infinity:9", 1), ("16:9", "inf"),
                       ("1e-200:1e-200", 0.4), ("1e300:1e-300", 1e300)):
        case("canvas", "canvas_size", aspect, mp, raises=True)


# ============================================================================ presets
def _small(value, limit=1500):
    """Is this cheap enough to hand to every helper as well? The long stores are there
    for normalize; repeating them a dozen times would only make the file large."""
    return len(json.dumps(value)) < limit


SIG = P.params_signature(P.DEFAULT_PARAMS)
OTHER_SIG = P.params_signature({**P.DEFAULT_PARAMS, "steps": 30})

PARAMS = [
    {}, None, [], 0, False, dict(P.DEFAULT_PARAMS), {"unknown": 1, "steps": 30, "seed": 5},
    {"width": 960, "height": 960, "steps": 48}, {"width": "960", "height": "540"},
    {"width": "abc", "height": 960}, {"width": 0, "height": 960}, {"width": 960},
    {"width": 960, "height": 960, "megapixels": 0.25}, {"width": 960, "height": None},
    {"width": "nan", "height": 960}, {"width": "inf", "height": 960}, {"width": 1e200, "height": 1e200},
    {"width": True, "height": 524288}, {"width": [960], "height": 960},
    {"width": 864, "height": 480}, {"width": 1344, "height": 768}, {"width": 32, "height": 32},
    *[{"megapixels": v} for v in (
        0.0625, 0.1875, 0.3125, 0.4375, 0.5625, 0.6875, 1.0625, 3.9375, 0.0005, 0.03, 0.0304,
        0.0305, 0.0295, 4.5, 4, "0.5", None, "nan", "inf", "-inf", True, False, "abc", [0.5],
        0.2505, 0.2515, 0.2525, 1.0005, 2.0015, 0.9995, 0.99949, 0.123456, 1e-9, -1, " 1.5 ",
        "1_0", 0.3, 1 / 3, 2 / 3, G.NATIVE_MEGAPIXELS, 0.4, 0.98, 0.25)],
    # how whole-number text is read
    *[{"steps": v} for v in (0, 1, 200, 500, "30", 12.7, "12.7", None, -4, True, " 25 ", "2_5",
                             [20], "", 199.999, "+7", "-0", "1e3", "12abc", "0x10", "7.0", "07",
                             "2__5", "_25", "25_", " \t9\n", "1 0", "--5", "+-5", {"n": 5})],
    # how decimal text is read, and how three decimals are kept
    *[{"cfg": v} for v in (-1, 0, 31, 30, 7.5555, 7.5545, 2.0005, 0.0005, 0.0015, 1, "4.5", None,
                           "nan", "x", 6.0625, 3.14159, 1e-12, 29.9995, "inf", True, False,
                           "1e-1", " .5 ", "5.", "0_5", "1_0", "0x1", "1e999", ".", "",
                           "Infinity", "NaN", "-inf", "+2", "-0", "2e0", "1e", "e1", "1__0",
                           "_1", "1_", "1._5", "1_.5", "1e1_0", "1e+1", "1E1", "+.5e+1", "5e-1_0",
                           "INF", "+nan", "-NAN", "in f", "infinit", "1,5", "1 .5", [0.5])],
    *[{"sampler_name": v} for v in ("euler", " euler ", "EULER", "nope", None, 5, ["euler"],
                                    "lcm", "uni_pc", "dpmpp_2m", "", True)],
    *[{"scheduler": v} for v in ("karras", " beta ", "Karras", "nope", None, "sgm_uniform", 0)],
    *[{"shift_video": v, "shift_audio": w} for v, w in (
        (0, 0), (150, 150), (12.3456, 3.3335), (0.01, 0.0149), (0.015, 0.0125), ("7", "2.5"),
        (None, None), ("nan", "inf"), (99.9995, 0.0005), (100, 100.0001), (5, 0.1875))],
    *[{"model": v} for v in ("turbo", "Turbo", " turbo ", "main", "xl", None, 1)],
    *[{"ref_video_edge": v} for v in (
        0, 256, 384, 512, 640, 768, 300, 320, 448, 576, 704, 1, 255, 257, 9999, -5, "512",
        383.9, 319, 321, 447, 449, 575, 577, 703, 705, None, "x", True, 100, 767, 128)],
    *[{"ref_image_size": v} for v in ("max", "MAX", " max ", "match", "auto", None)],
    *[{"vram_staging": v} for v in ("auto", "on", "off", "maybe", "ON", None, True)],
    {"megapixels": 0.25, "steps": 4, "cfg": 1.5, "sampler_name": "euler", "scheduler": "beta",
     "shift_video": 8.5, "shift_audio": 2.25, "model": "turbo", "ref_video_edge": 384,
     "ref_image_size": "max", "vram_staging": "auto"},
    {"megapixels": 3.999, "steps": 200, "cfg": 29.999, "shift_video": 99.999,
     "shift_audio": 0.011, "ref_video_edge": 768, "vram_staging": "on"},
    {"megapixels": 4, "steps": 1, "cfg": 0, "shift_video": 100, "shift_audio": 0.01},
]


FIFTY_RUNS = {"presets": [{"id": "standard", "history": {"runs": [
    {"at": 1000 + i, "seconds": 33.33} for i in range(50)]}}]}


def _runs(*seconds, signature="", frames=124, start=1000):
    return [{"at": start + i, "seconds": s, "frames": frames, "signature": signature,
             "summary": "run %d" % i} for i, s in enumerate(seconds)]


STORES = [
    {}, None, [], "store", 3,
    {"version": 1, "active": "final"},
    {"active": "missing"}, {"active": None}, {"active": 5},
    {"presets": []}, {"presets": "x"}, {"presets": None}, {"presets": {"id": "a"}},
    {"presets": ["junk", None, 5]},
    {"presets": [{"id": "a"}, {"id": "a"}, {"id": "a"}, {"id": " a "}, {"id": "a_2"}],
     "active": "a_2"},
    {"presets": [{}, {"id": None}, {"id": ""}, {"id": "  "}, {"id": 7}, {"id": 0},
                 {"id": "preset0"}, "skipped", {"id": True}, {"id": ["x"]}]},
    {"presets": [{"id": "x", "name": "", "note": None, "takes": 0},
                 {"id": "y", "name": 12, "note": 5, "takes": 99, "extra": "dropped"},
                 {"id": "z", "name": None, "note": ["a"], "takes": "3"},
                 {"id": "w", "takes": None}, {"id": "v", "takes": 2.7}, {"id": "u", "takes": "x"},
                 {"id": "t", "takes": -3}, {"id": "s", "takes": 12}, {"id": "r", "takes": True}],
     "active": "y"},
    {"presets": [{"id": "only", "params": {"steps": 30}}], "active": "standard"},
    {"presets": [{"id": "b"}, {"id": "standard"}, {"id": "c"}], "active": "nope"},
    {"presets": [{"id": 5, "name": "five"}], "active": 5},
    {"settings": {"auto_reset_on_change": False}}, {"settings": {"auto_reset_on_change": None}},
    {"settings": {"auto_reset_on_change": 0}}, {"settings": {"auto_reset_on_change": "no"}},
    {"settings": {"auto_reset_on_change": []}}, {"settings": {"theme": "dark"}},
    {"settings": []}, {"settings": None}, {"settings": {}}, {"settings": 0},
    {"mystery": {"kept": [1, 2]}, "version": 99, "toString": "kept"},
    # --- history
    {"presets": [{"id": "standard", "history": {"runs": _runs(100.0, 300.0, 200.0)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(0.1, 0.2, 0.3)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(0.005, 0.015, 0.025, 0.035)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(1.005, 2.675, 1.115)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(0.125, 0.375)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(1e7, 0.1, 1e-3, 123456.789)}}]},
    {"presets": [{"id": "standard", "history": {"runs": _runs(*[0.1] * 10)}}]},
    # more runs than are kept, not in time order
    {"presets": [{"id": "standard", "history": {"runs": [
        {"at": (i * 37) % 61, "seconds": 1.1 * i} for i in range(1, 61)]}}]},
    FIFTY_RUNS,
    {"presets": [{"id": "standard", "history": {"runs": [
        {"at": 30, "seconds": 3}, {"at": 10, "seconds": 1}, {"at": 20, "seconds": 2},
        {"at": 10, "seconds": 4, "summary": "same time, later in the list"},
        {"at": "5", "seconds": "0.5"}, {"at": None, "seconds": 9}, {"at": -1, "seconds": 8},
        {"at": 10 ** 14, "seconds": 7}, {"at": 15.9, "seconds": 6.5},
        {"seconds": 0}, {"seconds": -5}, {"seconds": None}, {"seconds": "x"}, {"seconds": "nan"},
        {"seconds": "inf", "at": 40}, {"seconds": 2e7, "at": 41}, {"seconds": True, "at": 42},
        {"seconds": [1], "at": 43}, "loose", None, 7, {}]}}]},
    {"presets": [{"id": "standard", "history": {"runs": [
        {"at": 1, "seconds": 10, "signature": SIG, "frames": 124},
        {"at": 2, "seconds": 20, "signature": OTHER_SIG, "frames": 124},
        {"at": 3, "seconds": 30, "signature": "", "frames": 243},
        {"at": 4, "seconds": 40, "frames": "243"}, {"at": 5, "seconds": 50, "signature": None},
        {"at": 6, "seconds": 60, "signature": 5, "frames": -3},
        {"at": 7, "seconds": 70, "frames": 10 ** 6, "summary": 12},
        {"at": 8, "seconds": 80, "frames": 124.9, "summary": None},
        {"at": 9, "seconds": 90, "frames": None, "extra": "dropped"}]}}]},
    {"settings": {"auto_reset_on_change": False},
     "presets": [{"id": "standard", "history": {"runs": [
         {"at": 1, "seconds": 10, "signature": SIG}, {"at": 2, "seconds": 20, "signature": OTHER_SIG},
         {"at": 3, "seconds": 30, "signature": "something else"}]}}]},
    {"presets": [{"id": "standard", "params": {"steps": 30}, "history": {
        "count": 99, "last_seconds": 5, "last_at": 5, "avg_seconds": 5, "signature": "stale",
        "runs": [{"at": 1, "seconds": 10, "signature": SIG},
                 {"at": 2, "seconds": 20, "signature": OTHER_SIG}]}}]},
    {"presets": [{"id": "a", "history": None}, {"id": "b", "history": []},
                 {"id": "c", "history": {"runs": None}}, {"id": "d", "history": {"runs": "abc"}},
                 {"id": "e", "history": {"runs": {"k": 1}}}, {"id": "f", "history": "x"},
                 {"id": "g", "params": None}, {"id": "h", "params": []}]},
    {"presets": [{"id": "draft", "name": "Draft", "takes": 4,
                  "params": {**P.DEFAULT_PARAMS, "megapixels": 0.25, "steps": 4, "model": "turbo",
                             "ref_video_edge": 384}},
                 {"id": "mine", "name": "Mine", "note": "tuned", "takes": 2,
                  "params": {"megapixels": 0.6, "steps": 28, "cfg": 2.5, "sampler_name": "euler",
                             "scheduler": "beta", "vram_staging": "auto"},
                  "history": {"runs": _runs(61.25, 59.5, signature="", frames=124)
                              + _runs(140.0, 150.0, 145.5, signature="", frames=243, start=2000)
                              + _runs(99.0, signature="", frames=0, start=3000)}}],
     "active": "mine", "settings": {"auto_reset_on_change": True, "theme": "dark"}},
]

STORES_THAT_RAISE = [
    {"settings": "x"}, {"settings": [1]}, {"settings": 5}, {"settings": True},
    {"presets": [{"id": "x", "params": "fast"}]}, {"presets": [{"id": "x", "params": 5}]},
    {"presets": [{"id": "x", "params": [1]}]}, {"presets": [{"id": "x", "params": True}]},
    {"presets": [{"id": "x", "history": {"runs": 5}}]},
    {"presets": [{"id": "x", "history": {"runs": True}}]},
]


def _preset_cases():
    case("presets", "empty")
    case("presets", "empty_history")
    for params in PARAMS:
        case("presets", "normalize_params", params, twice=True)
        case("presets", "params_signature", params)
        case("presets", "param_summary", params)
    for params in ("fast", 5, [1], True):
        case("presets", "normalize_params", params, raises=True)
        case("presets", "params_signature", params, raises=True)
        case("presets", "param_summary", params, raises=True)

    for store in STORES:
        out = case("presets", "normalize", store, twice=True)
        if not isinstance(store, dict) or not _small(store):
            continue
        if "active" in store or "presets" in store:
            case("presets", "active_preset", store)
            case("presets", "active_params", store)
        timed = [p for p in out["presets"] if p["history"]["runs"]]
        for preset in timed:
            mixed = len({r["frames"] for r in preset["history"]["runs"]}) > 1
            for frames in (0, 124, 243) if mixed else (124,):
                case("presets", "timing_for", preset, frames)
        if timed:
            case("presets", "clear_history", store, out["active"])
    mine = P.normalize(STORES[-1])
    for frames in (999, "124", None, 124.5, True):
        case("presets", "timing_for", mine["presets"][1], frames)
    case("presets", "timing_for", mine["presets"][1])
    case("presets", "timing_for", mine["presets"][0], 124)
    case("presets", "timing_for", mine["presets"][1], "x", raises=True)
    for store in ({}, STORES[-1]):
        case("presets", "active_preset", store)
        case("presets", "active_params", store)
        case("presets", "clear_history", store)
        case("presets", "clear_history", store, None)
        case("presets", "clear_history", store, "mine")
        case("presets", "clear_history", store, "no such preset")
    for store in STORES_THAT_RAISE:
        case("presets", "normalize", store, raises=True)
        case("presets", "active_preset", store, raises=True)
        case("presets", "clear_history", store, raises=True)
        case("presets", "record_run", store, "standard", 1.0, "", 1, 0, raises=True)

    # record_run: a store that grows one run at a time ...
    two = {"presets": [{"id": "standard"}, {"id": "draft", "params": {"steps": 4}}]}
    s = case("presets", "record_run", two, "standard", 100.0, "first", 10, 124)
    s = case("presets", "record_run", s, "standard", 300.0, "longer clip", 20, 243)
    s = case("presets", "record_run", s, "draft", 7.777, "another preset", 30, 124)
    s = case("presets", "record_run", s, "standard", 5.0, "out of order", 15, 124)
    case("presets", "record_run", s, "no such preset", 5.0, "", 99, 124)
    case("presets", "record_run", {}, "final", 61.25, "into the built-ins", 1, 124)
    # ... and what one run is turned into before it is stored
    for i, (seconds, summary, frames) in enumerate([
            (12.345, "", 124), (0.125, None, 124), (0.375, "tie", 0), (2.675, "below the half", None),
            ("45.5", "text", "124"), (1e9, "clamped", 124), (0.004, "rounds to nothing", 124),
            (0, "dropped", 124), (-5, "dropped", 124), (59.999, "", 124.7),
            (True, "one second", 124), (1.005, ["not", "text"], True), ("nan", "", 124),
            ("inf", "", 124), (0.005, "", 124), (0.015, "", 124), (0.025, "", 124)]):
        case("presets", "record_run", two, "standard", seconds, summary, 10 + i, frames)
    for bad in (None, "x", [1]):
        case("presets", "record_run", s, "standard", bad, "", 99, 124, raises=True)
    case("presets", "record_run", s, "standard", 5.0, "", "x", 124, raises=True)
    case("presets", "record_run", s, "standard", 5.0, "", 99, "x", raises=True)
    # a full log: the new run pushes the oldest out, or is itself the oldest and goes
    case("presets", "record_run", FIFTY_RUNS, "standard", 1.5, "one more", 5000, 124)
    case("presets", "record_run", FIFTY_RUNS, "standard", 1.5, "older than the rest", 1, 124)
    # a parameter change makes the earlier timings describe something else
    changed = copy.deepcopy(s)
    for preset in changed["presets"]:
        if preset["id"] == "standard":
            preset["params"]["steps"] = 30
    case("presets", "normalize", changed, twice=True)
    changed["settings"]["auto_reset_on_change"] = False
    case("presets", "normalize", changed, twice=True)
    case("presets", "record_run", changed, "standard", 8.0, "kept beside the old ones", 500, 124)
    case("presets", "clear_history", changed, "standard")
    case("presets", "clear_history", changed, None)
    case("presets", "active_preset", changed)


# ============================================================================ output settings
POSTS = [
    {}, None, [], "x", 5,
    {"global_refine": {"enabled": True}, "face_refine": {"enabled": True},
     "save": {"filename_prefix": "X", "crf": 3}, "version": 1, "mystery": 7},
    {"version": 99}, {"preview": None, "save": None}, {"preview": [], "save": "x"},
    {"preview": {"enabled": False, "preview_every": 5, "max_resolution": 512, "jpeg_quality": 60,
                 "stage_previews": True},
     "save": {"auto_save": False, "filename_prefix": "clip", "format": "webm", "codec": "vp9",
              "save_first_pass": True}},
    *[{"preview": {"enabled": v}, "save": {"auto_save": v}} for v in (
        None, 0, 1, "", "false", [], [0], {}, {"a": 1}, 0.0, 2.5)],
    *[{"preview": {"preview_every": v, "max_resolution": v, "jpeg_quality": v}} for v in (
        0, 1, 5, 100, 101, 127, 128, 4096, 4097, -1, 10, 9, "50", " 50 ", "5_0", "x", None, 50.9,
        "50.9", True, False, [50], "", 1e9)],
    *[{"save": {"filename_prefix": v}} for v in (
        "", None, 0, 5, 1.5, True, False, " spaced ", ["a"], {"a": 1}, "dir/name", "it's")],
    *[{"save": {"format": v, "codec": w}} for v, w in (
        ("auto", "auto"), ("mp4", "h264"), ("webm", "vp9"), ("mkv", "av1"), ("MKV", "H265"),
        (" webm ", " av1 "), ("avi", "prores"), (None, None), (5, True), (["mp4"], ["h264"]),
        ("", ""))],
    # face refine
    {"face": None}, {"face": []}, {"face": "x"}, {"face": {"mystery": 1, "enabled": True}},
    {"face": {"strength": 0.35, "padding": 2.5, "feather": 0.2, "min_score": 0.7, "subject": "s1",
              "text": "freckles", "file": "GachaDirector_take_3_00001_.mp4", "cuts": "61,122,183"}},
    *[{"face": {"strength": v, "padding": v, "feather": v, "min_score": v}} for v in (
        0, 0.05, 0.049, 0.95, 0.951, 1, 1.2, 4, 4.5, -1, 0.3335, 0.33349, 0.0205, "0.5", " 0.5 ",
        "x", None, True, False, [0.5], "", 1e9, "nan", "inf", 2)],
    *[{"face": {"subject": v, "text": v, "file": v}} for v in (
        "", None, 0, 5, 1.5, True, False, " spaced ", ["a"], {"a": 1}, "s1")],
    *[{"face": {"cuts": v, "shots": v}} for v in (
        "61,122", " 61 , 122 ", "61,,122,", "a,61,-5,1.5,+3,007", "", None, 61, [61, 122], "61;122",
        "\u0661\u0662,\u00b2,12", True,
        # "~" after a frame says the shot goes on from the one before: kept in cuts only
        "61,122~,183", "61~~,~,~5,5~x, 7 ~,8~", "~61", "61\n,62~\n,63")],
]


def _post_cases():
    case("post", "empty")
    for cfg in POSTS:
        case("post", "normalize", cfg, twice=True)


# ============================================================================ takes
def _take(tid, at, status="done", **more):
    return {"id": tid, "seed": at * 7, "prompt_id": "p-%s" % tid, "status": status, "at": at,
            "file": "%s.mp4" % tid if status == "done" else "", "preset": "standard",
            "summary": "0.4MP 20st", "note": "", **more}


THREE = {"takes": [_take("a", 1), _take("b", 2), _take("c", 3, status="running"),
                   _take("d", 4, status="failed"), _take("e", 5, file="")],
         "picks": {"0": "a", "1": "a", "2": "b"}}

TAKES = [
    {}, None, [], "store", 5,
    THREE,
    {"version": 1, "takes": [{"id": "x", "scope": 1}, {"id": "y", "scope": "whole"},
                             {"id": "z", "scope": None}, {"id": "w", "scope": 0},
                             {"id": "v", "scope": ""}, {"id": "u", "scope": "Whole"},
                             {"id": "t", "scope": False}, {"id": "s"}]},
    {"takes": [{"id": "s%d" % i, "status": status} for i, status in enumerate(
        ["queued", "running", "done", "failed", "missing", "Done", " done", "", None, 5, True,
         ["done"], "cancelled"])]},
    {"takes": [{}, {"id": None}, {"id": ""}, {"id": "  "}, {"id": 7}, {"id": 0}, "loose", None,
               {"id": "take0"}, {"id": " a "}, {"id": "a"}, {"id": "a", "note": "duplicate"},
               {"id": True}, {"id": ["x"]}, 3]},
    {"takes": [{"id": "s%d" % i, "seed": v} for i, v in enumerate(
        [-1, 0, 914000, 2 ** 53, "42", 4.9, None, "x", True, 10 ** 30, " 7 ", "1_000", [1], -0.5])]},
    {"takes": [{"id": "t3", "at": 30}, {"id": "t1", "at": 10}, {"id": "t2", "at": 20},
               {"id": "t1b", "at": 10}, {"id": "ts", "at": "15"}, {"id": "tn", "at": None},
               {"id": "tneg", "at": -5}, {"id": "tbig", "at": 10 ** 14}, {"id": "tf", "at": 15.9},
               {"id": "tx", "at": "x"}, {"id": "t0", "at": 0}]},
    {"takes": [{"id": "f", "prompt_id": 5, "file": None, "preset": True, "summary": ["a"],
                "note": {"k": "v"}, "extra": "dropped"},
               {"id": "g", "prompt_id": None, "file": 7, "preset": 0, "summary": 1.5,
                "note": "it's"}]},
    {"takes": [{"id": "t%03d" % i, "at": 1000 - i} for i in range(205)],
     "picks": {"0": "t000", "1": "t204", "2": "t004", "3": "t005"}},
    {"takes": "abc"}, {"takes": {"a": 1}}, {"takes": None},
    {**THREE, "picks": {"0": "a", "1": "zzz", "-1": "a", "x": "a", "1.0": "a", " 2 ": "b",
                        "+3": "c", "4_0": "a", "": "a", "5": None, "6": 5, "7": ["a"]}},
    {"takes": [_take("None", 1), _take("5", 2), _take("True", 3)],
     "picks": {"0": None, "1": 5, "2": True, "3": False, "4": 5.5}},
    {**THREE, "picks": []}, {**THREE, "picks": None}, {**THREE, "picks": {}},
    {**THREE, "picks": 0},
    {**THREE, "composite": {"prompt_id": "pc", "file": "final.mp4", "status": "done", "at": 99,
                            "seed": 12, "extra": "dropped"}},
    {**THREE, "composite": {"prompt_id": 5, "file": None, "status": "Done", "at": "x",
                            "seed": -1}},
    {**THREE, "composite": {"status": "running", "at": 10 ** 14, "seed": 2 ** 70}},
    {**THREE, "composite": {"status": 5}}, {**THREE, "composite": {"status": ["done"]}},
    {**THREE, "composite": "final.mp4"}, {**THREE, "composite": None}, {**THREE, "composite": []},
    {**THREE, "refine": {"prompt_id": "pr", "file": "refined.mp4", "status": "done", "at": 99,
                         "seed": 7, "key": "k", "of": "final.mp4", "mystery": 1}},
    {**THREE, "refine": {"prompt_id": 5, "file": None, "status": "Done", "at": "x", "seed": -1,
                         "key": None, "of": 5}},
    {**THREE, "refine": "refined.mp4"}, {**THREE, "refine": None}, {**THREE, "refine": []},
    {**THREE, "mystery": {"kept": True}, "version": 99, "toString": "kept"},
]

TAKES_THAT_RAISE = [
    {"takes": 5}, {"takes": True}, {"takes": 1.5},
    {"picks": "x"}, {"picks": [1]}, {"picks": 5}, {"picks": True},
]


def _take_cases():
    case("takes", "empty")
    shots = S.normalize({"prompt": {"shots": SHOTS3}})["prompt"]["shots"]
    for store in TAKES:
        case("takes", "normalize", store, twice=True)
        # the helpers read picks, statuses and the composite; a store that is only about
        # how one field is clamped tells them nothing new
        if not (isinstance(store, dict) and _small(store) and {"picks", "composite"} & set(store)):
            continue
        case("takes", "finished", store)
        case("takes", "all_picked", store, 3)
        case("takes", "summary", store, 3)
        case("takes", "segment_status", store, 0)
        case("takes", "segment_status", store, 3)
        case("takes", "splice_plan", store, shots)
    for n in (0, 1, 2, 4, -1):
        case("takes", "all_picked", THREE, n)
        case("takes", "summary", THREE, n)
    for seg in (1, 2, "1", 1.9, True, -1):
        case("takes", "segment_status", THREE, seg)
    for store in ({}, {"takes": [_take("c", 3, status="running")]}, {"takes": [_take("a", 1)]},
                  {"takes": [_take("e", 5, file="")]}):
        case("takes", "finished", store)
        case("takes", "segment_status", store, 0)
        case("takes", "all_picked", store, 0)
        case("takes", "all_picked", store, 1)
    case("takes", "splice_plan", THREE, shots[:2])
    case("takes", "splice_plan", THREE, [])
    case("takes", "splice_plan", {}, [])
    for store in TAKES_THAT_RAISE:
        case("takes", "normalize", store, raises=True)
        case("takes", "finished", store, raises=True)
        case("takes", "pick", store, 0, "a", raises=True)
        case("takes", "summary", store, 3, raises=True)
    case("takes", "segment_status", THREE, "x", raises=True)
    case("takes", "segment_status", THREE, None, raises=True)
    case("takes", "pick", THREE, "x", "a", raises=True)
    case("takes", "pick_all", THREE, "x", "a", raises=True)

    # the funnel, one step at a time
    t = case("takes", "add_take", T.empty(), {"seed": 1, "prompt_id": "p1", "id": "a", "at": 1})
    t = case("takes", "add_take", t, {"seed": 2, "prompt_id": "p2", "id": "b", "at": 2,
                                      "preset": "draft", "summary": "0.25MP 4st"})
    t = case("takes", "add_take", t, {"seed": 3.9, "prompt_id": "p3", "at": 1700000000000})
    t = case("takes", "add_take", t, {"seed": "4", "prompt_id": None, "at": 255, "id": None})
    case("takes", "add_take", t, {"seed": 5, "prompt_id": "dup", "id": "a", "at": 9})
    case("takes", "add_take", t, {"seed": 5, "prompt_id": "p5", "id": 77, "at": 3,
                                  "preset": None, "summary": 12})
    case("takes", "add_take", t, {"seed": "x", "prompt_id": "p", "id": "bad", "at": 3}, raises=True)
    case("takes", "add_take", t, {"seed": None, "prompt_id": "p", "id": "bad", "at": 3}, raises=True)
    case("takes", "splice_plan", t, shots)
    t = case("takes", "update_take", t, "a", {"status": "done", "file": "a.mp4"})
    t = case("takes", "update_take", t, "b", {"status": "done", "file": "b.mp4", "note": "keeper"})
    case("takes", "update_take", t, "nobody", {"status": "done"})
    case("takes", "update_take", t, "a", {"status": "exploded", "unknown": 1, "seed": "9",
                                          "at": 50, "file": None})
    case("takes", "update_take", t, "a", {"id": "renamed"})
    case("takes", "update_take", t, "a", {"id": "b"})
    case("takes", "update_take", t, "a", {})
    t = case("takes", "pick_all", t, 3, "a")
    plan = case("takes", "splice_plan", t, shots)["plan"]
    case("takes", "single_take", plan)
    case("takes", "cut_frames", plan)
    t = case("takes", "pick", t, 2, "b")
    plan = case("takes", "splice_plan", t, shots)["plan"]
    case("takes", "single_take", plan)
    case("takes", "cut_frames", plan)
    case("takes", "plan_key", plan)
    case("takes", "plan_key", [])
    # how the clip is divided, as a take remembers it
    case("takes", "layout_key", shots)
    # the picks of shots whose sound goes on across a cut, and the key that tells such a plan apart
    for doc in LONG_TAKES[-8:]:
        heard = S.normalize(doc)["prompt"]["shots"]
        case("takes", "layout_key", heard)
        every = T.pick(T.pick_all(t, len(heard), "a"), 1, "b")
        plan = case("takes", "splice_plan", every, heard)["plan"]
        if plan:
            case("takes", "plan_key", plan)
    case("takes", "layout_key", shots[:1])
    case("takes", "layout_key", [])
    for doc in LONG_TAKES:
        case("takes", "layout_key", S.normalize(doc)["prompt"]["shots"])
    u = case("takes", "add_take", t, {"seed": 8, "prompt_id": "p8", "id": "y", "at": 8,
                                      "layout": T.layout_key(shots)})
    case("takes", "update_take", u, "y", {"layout": "0,61~"})
    case("takes", "normalize", {"takes": [{"id": "l1", "layout": None}, {"id": "l2", "layout": 5},
                                          {"id": "l3", "layout": "0,61,122~"}]})
    # a take remembers the clip length it was rendered at; another length is not material
    total = sum(s["length"] for s in shots)
    for frames in (total, total + 17, 0):
        u = case("takes", "add_take", t, {"seed": 9, "prompt_id": "p9", "id": "z", "at": 9,
                                          "frames": frames})
        u = case("takes", "update_take", u, "z", {"status": "done", "file": "z.mp4"})
        u = case("takes", "pick", u, 1, "z")
        case("takes", "splice_plan", u, shots)
    case("takes", "normalize", {"takes": [{"id": "f", "frames": v} for v in (-1, "124", 2.9)],
                                "composite": {"key": 5, "status": "done"}}, twice=True)
    case("takes", "all_picked", t, 3)
    case("takes", "summary", t, 3)
    case("takes", "pick", t, 0, None)
    case("takes", "splice_plan", T.pick(t, 0, None), shots)
    case("takes", "pick", t, 1, "nobody")
    case("takes", "pick", t, -1, "a")
    case("takes", "pick", t, "1", "b")
    case("takes", "pick", t, 1.9, "b")
    case("takes", "pick", t, 7, "b")
    case("takes", "pick", t, 0, 5)
    case("takes", "pick_all", t, 0, "b")
    case("takes", "pick_all", t, 5, "b")
    case("takes", "pick_all", t, "2", "b")
    case("takes", "pick_all", t, 3, "nobody")
    case("takes", "pick_all", t, 3, None)
    case("takes", "pick_all", t, -2, "b")
    for tid in ("a", "b", "nobody", None):
        case("takes", "remove_take", t, tid)
    t = case("takes", "update_take", t, "b", {"status": "missing"})
    case("takes", "splice_plan", t, shots)
    case("takes", "segment_status", t, 2)

    for plan in ([], [{"take": "a", "start": 0}],
                 [{"take": "a", "start": 0}, {"take": "a", "start": 39}],
                 [{"take": "a", "start": 0}, {"take": "b", "start": 39}, {"take": "a", "start": 73}],
                 [{"take": "a", "start": 0}, {"take": "b", "start": "39"},
                  {"take": "b", "start": 73.9}, {"take": "c", "start": 90.2}],
                 # the same shot going on, and a cut: which join is which
                 [{"take": "a", "start": 0}, {"take": "b", "start": 39, "join": "continuous"},
                  {"take": "c", "start": 73, "join": "cut"}, {"take": "c", "start": 90, "join": "continuous"},
                  {"take": "a", "start": 107, "join": "nonsense"}, {"take": "b", "start": 110, "join": None}],
                 [{"take": "a", "start": 0, "join": "continuous"}, {"take": "a", "start": 39, "join": "continuous"}]):
        case("takes", "single_take", plan)
        case("takes", "cut_frames", plan)
        case("takes", "seam_frames", plan)
        case("takes", "hard_cuts", plan)
    case("takes", "plan_key", [{"file": "a.mp4", "start": 0, "length": 39},
                               {"file": "b.mp4", "start": 39, "length": 34, "join": "continuous"},
                               {"file": "b.mp4", "start": 73, "length": 51, "join": "cut"}])
    # a shot says how it follows the one before it; the plan carries that
    joined = [{"start": 0, "length": 39, "join": "continuous"}, {"start": 39, "length": 34, "join": "continuous"},
              {"start": 73, "length": 51, "join": "cut"}]
    both = T.pick(T.pick(T.pick(THREE, 0, "a"), 1, "b"), 2, "b")
    plan = case("takes", "splice_plan", both, joined)["plan"]
    case("takes", "seam_frames", plan)
    case("takes", "hard_cuts", plan)
    case("takes", "normalize", {"composite": {"status": "done", "file": "c.mp4", "frames": 240,
                                              "note": "cut at 61: a cuts at 63"}})
    case("takes", "normalize", {"composite": {"frames": "x", "note": 7}})
    case("takes", "normalize", {"composite": {"status": "done", "file": "c.mp4", "starts": "0,58,120"}})
    case("takes", "normalize", {"composite": {"starts": " 0, 58 ,x,-3,12.5,１２,120~,,9"}})
    case("takes", "normalize", {"composite": {"starts": [0, 58]}})
    case("takes", "normalize", {"composite": {"starts": None}})
    case("takes", "normalize", {"composite": {"frames": -3, "note": None}})


# ============================================================================ random input
#: Values a field should never hold. Chosen so that JSON carries each of them to the JS
#: side unchanged (see the module docstring).
JUNK = [None, True, False, 0, 1, -1, 7, 3.7, -0.5, "", " ", "abc", "12", " 12 ", "3.7", "nan",
        "inf", [], {}, [1], ["a"], {"a": 1}, "x.png", "a\\b.mp4", 1000000007, "1e2"]


def _fuzz(count, seed):
    r = random.Random(seed)

    def pick(*good, junk=0.12):
        v = r.choice(JUNK) if r.random() < junk else r.choice(good)
        return v() if callable(v) else v

    def some(make, most=4, junk=0.06):
        if r.random() < junk:
            return r.choice(JUNK)
        return [make() for _ in range(r.randint(0, most))]

    def bag(fields, keep=0.6):
        return {k: (v() if callable(v) else v) for k, v in fields.items() if r.random() < keep}

    name = lambda ext: lambda: "%s%d.%s" % (r.choice("abcxyz"), r.randint(0, 6), ext)  # noqa: E731
    frame = lambda: r.choice([-1, 0, 4, 5, 21, 22, 39, 60, 123, 124, 500, r.randint(-3, 400)])  # noqa: E731
    flag = lambda: r.choice([True, False])  # noqa: E731
    text = lambda: r.choice(["", "a kite", "it's", " padded ", "N/A"])  # noqa: E731
    length = lambda: r.choice([5, 22, 39, 107, 124, 243, 121, 60, r.randint(0, 400)])  # noqa: E731

    def cells():
        part = lambda: r.choice([  # noqa: E731
            str(r.randint(0, 9)), "%d-%d" % (r.randint(0, 8), r.randint(0, 9)),
            "%d..%d" % (r.randint(0, 8), r.randint(0, 9)), "f%d" % r.randint(0, 130),
            "f%d-%d" % (r.randint(0, 130), r.randint(0, 260)), "all", "none", "", " ", "x", "-1",
            "3-", "f", "f-2", "1.5"])
        return r.choice([",", " , ", ", "]).join(part() for _ in range(r.randint(0, 3)))

    def cuts():
        return ",".join(r.choice([str(r.randint(-5, 300)), " %d " % r.randint(0, 124), "", "x",
                                  "39.5"]) for _ in range(r.randint(0, 4)))

    def shot():
        return pick(lambda: bag({"id": pick("s0", "keep", 7, "a", "b"), "length": pick(length, 0, -3, "40"),
                                 "text": pick(text, "@{s1} and @{v1}", "@ref1 @{k2} @{zz}"),
                                 "collapsed": pick(flag),
                                 "join": pick("cut", "continuous", "continuous", "Cut", None, 2)}), junk=0.05)

    def owner():
        return {"id": pick("s1", "s2", "v1", "a1", "k1", "k2", "Bad", "", 3),
                "name": pick("hero", "the hero", "ref2", "voice", "", "a.b", 4),
                "shot": pick("s0", "keep", "a", "b", "", "nowhere", 7)}

    def anchor():
        return pick(lambda: bag({
            "kind": pick("image", "clip", "audio", "Clip ", "video"), "file": pick(name("png")),
            "frame": pick(frame), "pin": pick(flag), "cite": pick(flag),
            "role": pick("auto", "storyboard", "STORYBOARD"), "retention": pick(*S.RETENTIONS),
            "note": pick(text), "clip_start": pick(0, 12, -3), "with_audio": pick(flag),
            "clip_length": pick(0, 5, 22, 39, 40, 4, 1000),
            "at": pick("first", "last", "offset", "Last", ""), "offset": pick(0, 3, 40, -2, "7", 999),
            **bag(owner(), 0.5)}, keep=0.7), junk=0.05)

    def subject():
        return pick(name("png"), lambda: bag({
            "images": some(lambda: pick(name("png"), lambda: {"file": pick(name("png"))}), 5),
            "description": pick(text), "short_name": pick(text), "kind": pick(*S.SUBJECT_KINDS),
            "retention": pick(*S.RETENTIONS), "note": pick(text), **bag(owner(), 0.5)}), junk=0.05)

    def piece():
        return pick(lambda: bag({"file": pick(name("mp4")), "start": pick(frame),
                                 "length": pick(length), "take": pick("t1", "t2", 3)}, keep=0.8),
                    junk=0.05)

    def source():
        return bag({"video": pick(name("mp4"), ""), "start": pick(0, 24, -1), "as_latent": pick(flag),
                    "denoise": pick(0.85, 0.5, 0, 1, 1.5, "0.3"), "as_reference": pick(flag),
                    "role": pick(*S.SOURCE_ROLES, "EDIT"), "retention": pick(*S.RETENTIONS),
                    "desc": pick(text), "note": pick(text), "audio": pick(flag),
                    "cite_ends": pick(flag), "splice": some(piece, 3)}, keep=0.5)

    def media():
        return pick(lambda: bag({
            "images": some(lambda: pick(name("png"), lambda: bag({"file": pick(name("png")),
                                                                 "note": pick(text)}, 0.8)), 2),
            "videos": some(lambda: pick(name("mp4"), lambda: bag({
                "file": pick(name("mp4")), "note": pick(text),
                "retention": pick(*S.RETENTIONS)}, 0.8)), 2),
            "audio": some(lambda: pick(name("wav"), lambda: {"file": pick(name("wav"))}), 2)}),
            junk=0.05)

    def doc():
        d = bag({
            "family": pick("reference", "base", "Base "),
            "clip": lambda: pick(lambda: bag({"length": pick(length), "aspect": pick(
                "source", "16:9", "1:1", "", 1.5)})),
            "source": lambda: pick(source),
            "anchors": lambda: some(anchor, 5),
            "subjects": lambda: some(subject, 11),
            "videos": lambda: some(lambda: pick(name("mp4"), lambda: bag({
                "file": pick(name("mp4")), "desc": pick(text), "retention": pick(*S.RETENTIONS),
                "note": pick(text), "audio": pick(flag)})), 4),
            "audio": lambda: some(lambda: pick(name("wav"), lambda: bag({
                "file": pick(name("wav")), "subject": pick(0, 1, 2, 9, -1),
                "retention": pick(*S.AUDIO_RETENTIONS), "desc": pick(text)})), 4),
            "prompt": lambda: pick(lambda: bag({
                "mode": pick("structured", "raw", "RAW"), "global": pick(text),
                "shots": some(shot, 6), "summary": pick(text), "soundscape": pick(text),
                "music": pick(text), "negative": pick(text), "raw": pick(text)})),
            "mask": lambda: pick(lambda: bag({
                "mode": pick(*S.MASK_MODES, "FREE_CELLS"), "cells": pick(cells),
                "cut_frames": pick(cuts), "radius": pick(1, 2, 3, 4, 0, 9),
                "pinned_value": pick(0, 0.5, 1, 2)})),
            "view": lambda: pick(lambda: bag({"zoom": pick(1, 2.5, 99), "playhead": pick(frame),
                                              "selected_shot": pick(0, 1, 2, 9)})),
            "mystery": lambda: pick(7, {"kept": True}),
        }, keep=0.45)
        roll = r.random()
        if roll < 0.25:                                   # an old document
            d["schema_version"] = pick(1, 2, 3, 4, 5, "5", junk=0.03)
            old = bag({
                "plate": lambda: pick(lambda: bag({
                    "video": pick(name("mp4")), "length": pick(length, junk=0.04),
                    "retention": pick(*S.RETENTIONS), "splice": some(piece, 2, junk=0.03)}),
                    junk=0.04),
                "anchors": lambda: pick(lambda: bag({
                    "first": pick(name("png"), ""), "last": pick(name("png"), ""),
                    "card": pick(name("png"), ""), "card_note": pick(text),
                    "mids": some(lambda: pick(lambda: bag({
                        "file": pick(name("png")), "frame": pick(frame, junk=0.03)}, 0.9)), 3,
                        junk=0.03)})),
                "common": media, "run": lambda: pick({"steps": 4}, {}),
            })
            d.update(old)
            pr = d.get("prompt")
            if isinstance(pr, dict):
                pr.update(bag({"shot": pick(text), "plan_mode": pick("raw", "official_six_section")}))
                if isinstance(pr.get("shots"), list):
                    for s in pr["shots"]:
                        if isinstance(s, dict) and r.random() < 0.5:
                            s["media"] = media()
        elif roll < 0.9:
            d["schema_version"] = pick(6, 0, 7, None, junk=0.03)
        return d

    for _ in range(count):
        d = doc()
        case("doc", "normalize", d, twice=True, loose=True)
        if "derived" not in d:
            case("problems", "problems", d, loose=True)
        try:
            case("problems", "problems", S.normalize(d), loose=True)
        except RAISES:
            pass

    def number():
        return r.choice([r.random() * 5, round(r.random() * 5, 3), round(r.random() * 5, 4),
                         r.randint(0, 3000) / 2000, r.randint(0, 64) / 16, r.uniform(0, 110),
                         r.randint(0, 300), r.randint(0, 1600) / 16])

    def params():
        return pick(lambda: bag({
            "megapixels": pick(number), "steps": pick(lambda: r.randint(-2, 220)),
            "cfg": pick(number), "sampler_name": pick(*P.SAMPLERS, "EULER"),
            "scheduler": pick(*P.SCHEDULERS), "shift_video": pick(number),
            "shift_audio": pick(number), "model": pick(*P.MODELS),
            "ref_video_edge": pick(lambda: r.randint(-10, 800), *P.REF_VIDEO_EDGES),
            "ref_image_size": pick(*P.REF_IMAGE_SIZES), "vram_staging": pick(*P.STAGING),
            "width": pick(lambda: r.randint(0, 2000)), "height": pick(lambda: r.randint(0, 2000)),
        }, keep=0.5), junk=0.04)

    def run(sigs):
        return pick(lambda: bag({
            "at": pick(lambda: r.randint(0, 50)), "frames": pick(0, 124, 243),
            "seconds": pick(lambda: r.choice([r.uniform(0, 500), round(r.uniform(0, 500), 2),
                                              r.randint(0, 4000) / 8, r.randint(1, 50) / 10])),
            "signature": pick(*sigs, ""), "summary": pick(text)}, keep=0.85), junk=0.05)

    def store():
        made = []

        def preset():
            p = params()
            made.append(p)
            try:
                sigs = [P.params_signature(x) for x in made[-2:]]
            except RAISES:
                sigs = [SIG]
            return pick(lambda: bag({
                "id": pick("a", "b", "standard", "draft", 3), "name": pick(text),
                "note": pick(text), "takes": pick(1, 4, 0, 99), "params": p,
                "history": lambda: pick(lambda: bag({"runs": some(lambda: run(sigs), 60, junk=0.03)},
                                                    keep=0.9), junk=0.05)}, keep=0.7), junk=0.05)
        return bag({"active": pick("a", "b", "standard", "draft"),
                    "presets": lambda: some(preset, 4),
                    "settings": lambda: pick(lambda: bag({"auto_reset_on_change": pick(flag),
                                                          "theme": "dark"}), junk=0.04),
                    "mystery": 7}, keep=0.6)

    for _ in range(count):
        p = params()
        case("presets", "normalize_params", p, twice=True, loose=True)
        case("presets", "params_signature", p, loose=True)
        case("presets", "param_summary", p, loose=True)
        s = store()
        out = case("presets", "normalize", s, twice=True, loose=True)
        if out is not None:
            case("presets", "timing_for", r.choice(out["presets"]), r.choice([0, 124, 243]))
            case("presets", "record_run", s, r.choice(out["presets"])["id"], number() * 100,
                 pick(text), r.randint(0, 60), pick(0, 124, 243, junk=0.0), loose=True)
            case("presets", "clear_history", s, r.choice([None, out["active"]]))

    for _ in range(count):
        cfg = bag({
            "preview": lambda: pick(lambda: bag({
                "enabled": pick(flag), "preview_every": pick(lambda: r.randint(-5, 120)),
                "max_resolution": pick(lambda: r.randint(0, 5000)),
                "jpeg_quality": pick(lambda: r.randint(0, 120)), "extra": 1})),
            "save": lambda: pick(lambda: bag({
                "auto_save": pick(flag), "filename_prefix": pick("clip", "", "GD"),
                "format": pick(*O.SAVE_FORMATS, "MP4", "avi"),
                "codec": pick(*O.SAVE_CODECS, "H265", "prores"), "crf": 3})),
            "face": lambda: pick(lambda: bag({
                "strength": pick(lambda: round(r.uniform(-0.2, 1.2), 4)),
                "padding": pick(lambda: round(r.uniform(0.5, 5), 4)),
                "feather": pick(lambda: round(r.uniform(-0.1, 0.6), 4)),
                "min_score": pick(lambda: round(r.uniform(0, 1.1), 4)),
                "subject": pick("s1", ""), "text": pick("freckles", ""),
                "file": pick("take.mp4", ""), "cuts": pick("61,122", "61, x,122", ""),
                "shots": pick("1,2", "2, x", ""),
                "enabled": True})),
            "global_refine": {"enabled": True}, "version": pick(1, 2)})
        case("post", "normalize", cfg, twice=True)

    shots = S.normalize({"prompt": {"shots": SHOTS3}})["prompt"]["shots"]
    for _ in range(count):
        ids = ["a", "b", "c", "d", 5]
        s = bag({
            "takes": lambda: some(lambda: pick(lambda: bag({
                "id": pick(*ids), "seed": pick(lambda: r.randint(-5, 2 ** 40)),
                "prompt_id": pick("p1", ""), "file": pick("a.mp4", "b.mp4", ""),
                "status": pick(*T.STATUSES, "Done"), "at": pick(lambda: r.randint(0, 9)),
                "preset": pick("draft", ""), "summary": pick(text), "note": pick(text),
                "scope": pick(None, "whole", 1)}, keep=0.75), junk=0.05), 6, junk=0.04),
            "picks": lambda: pick(lambda: {k: pick(*ids, junk=0.08) for k in r.sample(
                ["0", "1", "2", "3", "x", "-1", "1.5", ""], r.randint(0, 5))}, junk=0.04),
            "composite": lambda: pick(lambda: bag({
                "prompt_id": pick("pc"), "file": pick("final.mp4", ""),
                "status": pick(*T.STATUSES, ""), "at": pick(lambda: r.randint(0, 9)),
                "seed": pick(lambda: r.randint(0, 99))})),
            "refine": lambda: pick(lambda: bag({
                "prompt_id": pick("pr"), "file": pick("refined.mp4", ""),
                "status": pick(*T.STATUSES, ""), "at": pick(lambda: r.randint(0, 9)),
                "seed": pick(lambda: r.randint(0, 99)), "of": pick("final.mp4", "")})),
            "mystery": 7}, keep=0.75)
        out = case("takes", "normalize", s, twice=True, loose=True)
        if out is None:
            continue
        seg, tid = r.randint(0, 3), r.choice(["a", "b", "c", "d", "5", None])
        case("takes", "splice_plan", s, shots)
        case("takes", "segment_status", s, seg)
        case("takes", "all_picked", s, r.randint(0, 3))
        case("takes", "summary", s, 3)
        case("takes", "pick", s, seg, tid)
        case("takes", "pick_all", s, r.randint(0, 3), tid)
        case("takes", "remove_take", s, tid)
        case("takes", "update_take", s, tid, bag({"status": pick(*T.STATUSES), "file": "new.mp4",
                                                  "note": pick(text), "at": r.randint(0, 9)}))
        case("takes", "add_take", s, {"seed": r.randint(0, 2 ** 40), "prompt_id": "pn",
                                      "at": r.randint(1, 20), **bag({"id": pick("a", "new"),
                                                                    "preset": "draft"})})
        plan = _splice_plan(s, shots)["plan"]
        if plan is not None:
            case("takes", "single_take", plan)
            case("takes", "cut_frames", plan)

    aspects = ["16:9", "9:16", "1:1", "4:3", "3:2", "21:9", "2.39:1", "896x512", "5:4", "3:4",
               "2:1", "1:2", "source", "1.85", "7:5"]
    for _ in range(count):
        aspect = pick(*aspects, lambda: "%d:%d" % (r.randint(1, 40), r.randint(1, 40)),
                      lambda: "%.3f" % r.uniform(0.2, 5), junk=0.05)
        mp = pick(lambda: r.randint(30, 4000) / 1000, lambda: r.uniform(0, 5),
                  lambda: r.randint(1, 4096) / 1024, lambda: r.randint(1, 64) ** 2 / 4096, junk=0.05)
        source = r.choice([None, [r.randint(1, 4000), r.randint(1, 4000)], [1920, 1080]])
        case("canvas", "canvas_size", aspect, mp, source, loose=True)
    for _ in range(count):
        n = r.choice([5, 22, 124, 243, r.randint(-5, 700)])
        case("grid", "make_grid", n)
        case("grid", "guide_clip_length", r.randint(-5, 700))
        case("grid", "parse_cells", cells(), n, loose=True)
        case("grid", "seam_cells", [r.randint(-5, 700) for _ in range(r.randint(0, 4))], n,
             r.randint(0, 4))


# ============================================================================ output
def write(path) -> None:
    head = {
        "note": "Generated by tests/make_parity_fixtures.py. Do not hand-edit.",
        "versions": {"schema": S.SCHEMA_VERSION, "presets": P.PRESETS_VERSION,
                     "post": O.POST_VERSION, "takes": T.TAKES_VERSION},
    }
    # one case per line: a changed answer shows up as one changed line in a diff
    line = lambda v: json.dumps(v, ensure_ascii=False, allow_nan=False, separators=(",", ":"))  # noqa: E731
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for k, v in head.items():
            f.write(" %s: %s,\n" % (json.dumps(k), line(v)))
        for i, name in enumerate(SECTIONS):
            f.write(" %s: [\n" % json.dumps(name))
            f.write(",\n".join("  " + line(c) for c in FIX[name]))
            f.write("\n ]%s\n" % ("," if i < len(SECTIONS) - 1 else ""))
        f.write("}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Write the JS/Python parity fixtures.")
    ap.add_argument("--fuzz", type=int, default=0, metavar="N")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=os.path.join(PKG, "tests", "_parity_fixtures.json"))
    args = ap.parse_args()

    _doc_cases()
    _grid_cases()
    _canvas_cases()
    _preset_cases()
    _post_cases()
    _take_cases()
    if args.fuzz:
        _fuzz(args.fuzz, args.seed)

    write(args.out)
    for name in SECTIONS:
        raised = sum(1 for c in FIX[name] if c.get("error"))
        moved = sum(1 for c in FIX[name] if "again" in c)
        print("%-9s%6d cases%s%s" % (name, len(FIX[name]),
                                     "   %d raise" % raised if raised else "",
                                     "   %d move on a second pass" % moved if moved else ""))
    shown = os.path.abspath(args.out)
    if shown.startswith(PKG + os.sep):
        shown = shown[len(PKG) + 1:].replace(os.sep, "/")
    print("wrote %d cases -> %s" % (sum(len(v) for v in FIX.values()), shown))


if __name__ == "__main__":
    main()
