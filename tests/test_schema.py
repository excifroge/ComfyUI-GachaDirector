r"""The pure modules: document, planner adapter, presets, takes, output settings.
No ComfyUI, no GPU.

Run:  python tests/test_schema.py
"""
import importlib.util
import json
import os
import sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_compile as C, gd_post as O, gd_presets as P  # noqa: E402
from gdpkg import gd_schema as S, gd_takes as T  # noqa: E402

F = []


def check(name, got, want):
    if got != want:
        F.append(f"{name}: got {got!r}, want {want!r}")


def ok(name, cond):
    if not cond:
        F.append(name)


# ---------------------------------------------------------------- document
e = S.normalize({})
check("empty schema version", e["schema_version"], S.SCHEMA_VERSION)
check("empty family", e["family"], "reference")
check("empty frame count", e["derived"]["frame_count"], 124)
check("empty starts from an empty latent", e["derived"]["latent_source"], "empty")
check("empty has one whole-clip shot",
      [(s["start"], s["length"]) for s in e["prompt"]["shots"]], [(0, 124)])
check("normalize is idempotent", S.normalize(e), e)
check("an empty document can run", S.problems(e), [])
check("round trip through JSON", S.normalize(json.loads(json.dumps(e))), e)

d = S.normalize({"family": "base", "mystery": 7, "clip": {"length": 121}})
check("unknown key kept", d["mystery"], 7)
check("length snaps to the grid", d["clip"]["length"], 124)

# shots tile the clip
d = S.normalize({"prompt": {"shots": [{"text": "a", "length": 40}, {"text": "b", "length": 40}]}})
check("last shot absorbs the remainder",
      [(s["start"], s["length"]) for s in d["prompt"]["shots"]], [(0, 40), (40, 84)])
d = S.normalize({"prompt": {"shots": [{"length": 200}, {"length": 3}]}})
check("shots are clamped and keep room for the next",
      [(s["start"], s["length"]) for s in d["prompt"]["shots"]], [(0, 119), (119, 5)])

# a clip shortened until shots no longer fit keeps their words in the last shot that does
d = S.normalize({"clip": {"length": 22}, "prompt": {"shots": [
    {"text": w, "length": 5} for w in ("one", "two", "three", "four", "five", "six")]}})
check("shots that no longer fit give their text to the last one, each on a line of its own",
      (len(d["prompt"]["shots"]), d["prompt"]["shots"][-1]["text"]), (4, "four\nfive\nsix"))
check("and that is stable", S.normalize(d)["prompt"]["shots"], d["prompt"]["shots"])
# which is what keeps two speakers two: run together, the second line would be read as more
# of what the first one says
d = S.normalize({"family": "reference", "clip": {"length": 22},
                 "subjects": [{"images": ["a.png"], "name": "ann"}, {"images": ["b.png"], "name": "bo"}],
                 "prompt": {"shots": [{"text": "A room.", "length": 5}, {"text": "", "length": 5},
                                      {"text": "", "length": 5}, {"text": "@{s1} says: Hello.", "length": 5},
                                      {"text": "@{s2} says: Goodbye.", "length": 5}]}})
# a sound reference longer than the model takes is given as its first 15 seconds; its length
# comes from the probe
long = {"family": "reference", "clip": {"length": 124},
        "subjects": [{"images": ["a.png"], "name": "ann"}],
        "audio": [{"file": "score.wav", "retention": "fully_copy"}],
        "prompt": {"shots": [{"text": "@{s1} reads by the window."}]}}


def sounds(doc, lengths):
    """(the warnings about sound lengths, what each sound reference is cut to)."""
    p = C.build_plan(doc, probe=lambda name: lengths.get(name, {}))
    return ([w for w in p.get("ref_warnings") or [] if "seconds" in w and "sound" in w],
            [x["first"] for x in C.ref_audio(p)])


check("a sound of 110 seconds: its first 15 are given, and the plan says so",
      sounds(long, {"score.wav": {"seconds": 110.2}}),
      (["score.wav is 110 seconds long: the model is given its first 15 (the longest sound reference it takes)"],
       [15.0]))
check("a sound of 15 seconds, or one whose length is not known, is given whole",
      (sounds(long, {"score.wav": {"seconds": 15.2}}), sounds(long, {})), (([], [0.0]), ([], [0.0])))
check("a video picked as a sound is measured by its frames",
      sounds(long, {"score.wav": {"frames": 3300, "fps": 30.0, "frames24": 2640}})[1], [15.0])
check("a sound shorter than the model asks for is said to be",
      sounds(long, {"score.wav": {"seconds": 1.2}}),
      (["score.wav is 1.2 seconds long: the model asks for sound references of at least 2 seconds"], [0.0]))
three = {**long, "audio": [{"file": "a.wav"}, {"file": "b.wav"}, {"file": "c.wav"}]}
check("what is added up is what is sent: a sound let pass at 15.4 seconds counts as 15.4",
      sounds({**long, "audio": [{"file": "a.wav"}, {"file": "b.wav"}]},
             {"a.wav": {"seconds": 15.4}, "b.wav": {"seconds": 2.2}})[0],
      ["the sound references add up to 18 seconds: the model takes 15 in all, and may not follow every "
       "one of them"])
check("sounds that add up to more than the model takes in all are said to",
      sounds(three, {n: {"seconds": 8.0} for n in ("a.wav", "b.wav", "c.wav")}),
      (["the sound references add up to 24 seconds: the model takes 15 in all, and may not follow every "
        "one of them"], [0.0, 0.0, 0.0]))
text = C.build_plan(long)["prompt"]
check("a copied sound is declared and marked as the planner does it (measured to be enough)",
      ("<Audio 1>: fully_copy - <Audio 1> is reused as the target video's complete final audio track." in text,
       "non_diegetic_music: N/A" in text), (True, True))

# a voice that is described is still its subject's voice
voiced = {"family": "reference", "clip": {"length": 124},
          "subjects": [{"images": ["a.png"], "name": "ann"}],
          "audio": [{"file": "voice.wav", "subject": "s1", "desc": "a deep measured voice"}],
          "prompt": {"shots": [{"text": "@{s1} looks up.\n@{s1} says: Hello."}]}}
text = C.build_plan(voiced)["prompt"]
check("a described voice keeps its speaker, and the description is in the prompt",
      ("<Audio 1> is the voice-timbre reference for <Subject 1> (S1)." in text,
       "<Audio 1> (voice of <Subject 1>): reference - the target follows <Audio 1> without copying "
       "the original signal. Voice characteristics: a deep measured voice." in text), (True, True))
# a shot with nothing written in front of one that says something is left out of the prompt
gap = {"family": "base", "clip": {"length": 124},
       "prompt": {"shots": [{"length": 60, "text": ""}, {"length": 64, "text": "She sits."}]}}
check("an empty shot before a written one is warned about, with the time that is lost",
      [w for w in C.build_plan(gap).get("ref_warnings") or [] if "nothing written" in w],
      ["shot 1 has nothing written: the model is not told of it, and what shot 2 says is not "
       "held back until 2.50 s"])
check("an empty shot after the written ones is nothing to warn about",
      [w for w in C.build_plan({**gap, "prompt": {"shots": [{"length": 60, "text": "She sits."},
                                                            {"length": 64, "text": ""}]}}).get("ref_warnings") or []
       if "nothing written" in w], [])
check("an empty shot between two written ones is left out, and the later one keeps its time",
      ([w for w in C.build_plan({**gap, "prompt": {"shots": [
          {"length": 40, "text": "She sits."}, {"length": 40, "text": ""},
          {"length": 44, "text": "She stands."}]}}).get("ref_warnings") or [] if "nothing written" in w],
       "[Shot 2] At 00:03.333" in C.build_plan({**gap, "prompt": {"shots": [
           {"length": 40, "text": "She sits."}, {"length": 40, "text": ""},
           {"length": 44, "text": "She stands."}]}})["prompt"]),
      (["shot 2 has nothing written: the model is not told of it"], True))
check("nor is a stretch that goes on from one that is written",
      [w for w in C.build_plan({**gap, "prompt": {"shots": [
          {"length": 40, "text": "She sits."}, {"length": 40, "text": "", "join": "continuous"},
          {"length": 44, "text": "She stands."}]}}).get("ref_warnings") or [] if "nothing written" in w], [])
text = C.build_plan({**voiced, "audio": [{"file": "rain.wav", "desc": "steady rain on a tin roof"}]})["prompt"]
check("a sound that is nobody's voice is declared as it is described",
      "<Audio 1> is steady rain on a tin roof." in text, True)

said = C.build_plan(d)["prompt"]
check("two speakers whose shots were merged still speak one line each",
      (said.count("<d>"), "Goodbye" in said.split("Hello.")[1].split("</d>")[0]), (2, False))

# anchors
d = S.normalize({"family": "base", "anchors": [
    {"file": "z.png", "frame": -1, "cite": True},
    {"file": "a.png", "frame": 0, "cite": True},
    {"kind": "clip", "file": "c.mp4", "frame": 110, "clip_length": 30},
    {"kind": "audio", "file": "s.wav", "frame": 10, "cite": True},
    {"file": "a.png", "frame": 0, "pin": False},        # the same picture again
    {"file": ""},                                       # nothing
]})
# Nothing the user listed is dropped: a second entry for the same picture stays, and
# problems() is what says two pictures cannot sit on one frame.
check("anchors sorted by frame, blanks dropped",
      [(a["kind"], a["file"]) for a in d["anchors"]],
      [("image", "a.png"), ("image", "a.png"), ("audio", "s.wav"), ("clip", "c.mp4"),
       ("image", "z.png")])
check("the base model cannot cite without pinning",
      [a["pin"] for a in d["anchors"] if a["cite"]], [True, True])
check("two cited pictures on one frame are refused",
      any("cited at frame 5" in x for x in S.problems({"anchors": [
          {"file": "a.png", "frame": 5, "pin": False, "cite": True},
          {"file": "b.png", "frame": 5, "pin": False, "cite": True}]})), True)
clip = [a for a in d["anchors"] if a["kind"] == "clip"][0]
check("a clip is cut to a valid guide length that fits", clip["clip_length"], 5)
check("audio cannot be cited", [a["cite"] for a in d["anchors"] if a["kind"] == "audio"], [False])
check("resolved frames", d["derived"]["anchor_frames"], [0, 0, 10, 110, 123])
check("frame -1 was the last frame of the clip: now the last frame of the last shot",
      [(d["anchors"][-1]["at"], d["anchors"][-1]["shot"], d["anchors"][-1]["frame"])],
      [("last", d["prompt"]["shots"][-1]["id"], 123)])

# subjects and audio binding
d = S.normalize({"subjects": [{"images": ["a.png", "a.png", "b.png"]}, "c.png", {}],
                 "audio": [{"file": "v.wav", "subject": 9}]})
check("subject images deduped, bare names accepted",
      [s["images"] for s in d["subjects"]], [["a.png", "b.png"], ["c.png"]])
check("a voice of a subject that is not there belongs to nobody", d["audio"][0]["subject"], "")
d = S.normalize({"subjects": ["a.png", "c.png"], "audio": [{"file": "v.wav", "subject": "s2"}]})
check("a voice is tied to its subject by id", d["audio"][0]["subject"], "s2")

# what the sampler starts from
check("source in the latent",
      S.normalize({"source": {"video": "s.mp4", "as_latent": True}})["derived"]["latent_source"],
      "source")
# the default: with the edit prompt the reference alone carries layout, motion and camera,
# and a latent start at a high denoise was measured to add nothing
check("a source clip is a reference unless it is asked into the latent",
      S.normalize({"source": {"video": "s.mp4"}})["derived"]["latent_source"], "empty")
check("defaults: render the free part from scratch",
      (S.empty()["source"]["denoise"], S.empty()["mask"]["seam_denoise"]), (1.0, 1.0))
check("splice wins", S.normalize({"source": {"splice": [{"file": "t.mp4", "start": 0,
                                                         "length": 124}]}})["derived"]["latent_source"],
      "splice")

# problems: normalize keeps the switch, problems() names it
p = S.problems(S.normalize({"family": "base", "videos": [{"file": "m.mp4"}]}))
ok("base family with reference video is refused", any("reference videos" in x for x in p))
p = S.problems(S.normalize({"mask": {"mode": "seam_repair", "cut_frames": "60"}}))
ok("a mask needs a latent source", any("no source clip" in x for x in p))
p = S.problems(S.normalize({"source": {"video": "s.mp4", "as_latent": True},
                            "mask": {"mode": "free_cells"}}))
ok("a mask that frees nothing is refused", any("frees no cells" in x for x in p))
p = S.problems(S.normalize({"subjects": [{"images": ["%d.png" % i for i in range(6)]},
                                         {"images": ["x%d.png" % i for i in range(6)]}]}))
ok("too many reference images", any("at most 9" in x for x in p))
p = S.problems(S.normalize({"prompt": {"mode": "raw"}}))
ok("raw mode needs text", any("free-text" in x for x in p))

# ---------------------------------------------------------------- material belongs to a shot
d = S.normalize({"subjects": [{"images": ["in/ella front.png"]}, {"images": ["ella front.png"]},
                              {"description": "an old man, bent"}, {"images": ["x.png"], "name": "ref1"}],
                 "videos": ["run.mp4 [output]"], "audio": ["voice.wav"],
                 "anchors": [{"file": "a.png"}]})
check("every piece of material gets an id of its own",
      [x["id"] for k in ("subjects", "videos", "audio", "anchors") for x in d[k]],
      ["s1", "s2", "s3", "s4", "v1", "a1", "k1"])
check("and a name that can be typed after @: from the file, no spaces, none twice",
      [x["name"] for k in ("subjects", "videos", "audio", "anchors") for x in d[k]],
      ["ella_front", "ella_front_2", "an_old_man_bent", "ref1_", "run", "voice_", "a"])
check("ids and names survive a round trip", S.normalize(d), d)
d2 = S.normalize({**d, "subjects": [d["subjects"][2], d["subjects"][0]]})
check("an id stays with its item when the list is reordered",
      [(x["id"], x["name"]) for x in d2["subjects"]], [("s3", "an_old_man_bent"), ("s1", "ella_front")])
d2 = S.normalize({"subjects": [{"images": ["a.png"], "id": "s1"}, {"images": ["b.png"], "id": "s1"},
                               {"images": ["c.png"], "id": "Bad Id"}]})
check("a repeated or malformed id is replaced, the first holder keeps it",
      [x["id"] for x in d2["subjects"]], ["s1", "s2", "s3"])

two = {"shots": [{"id": "a", "length": 68, "text": "one"}, {"id": "b", "length": 56, "text": "two"}]}
d = S.normalize({"prompt": two, "subjects": [{"images": ["s.png"], "shot": "b"},
                                             {"images": ["t.png"], "shot": "nowhere"}],
                 "anchors": [{"file": "f.png", "shot": "b", "at": "first"},
                             {"file": "l.png", "shot": "a", "at": "last"},
                             {"file": "m.png", "shot": "b", "at": "offset", "offset": 10},
                             {"file": "c.mp4", "kind": "clip", "shot": "b", "at": "last"}]})
check("material keeps its shot; a shot that does not exist means shared",
      [x["shot"] for x in d["subjects"]], ["b", ""])
check("an anchor's frame follows from its shot",
      [(a["file"], a["at"], a["frame"]) for a in d["anchors"]],
      [("l.png", "last", 67), ("f.png", "first", 68), ("c.mp4", "first", 68), ("m.png", "offset", 78)])
moved = S.normalize({**d, "prompt": {"shots": [{"id": "a", "length": 40, "text": "one"},
                                               {"id": "b", "length": 84, "text": "two"}]}})
check("and moves with the shot when the cut is dragged",
      [(a["file"], a["frame"]) for a in moved["anchors"]],
      [("l.png", 39), ("f.png", 40), ("c.mp4", 40), ("m.png", 50)])
check("an anchor on the first or last frame of its shot is at that end, however it was written",
      [(a["at"], a["offset"]) for a in S.normalize({"prompt": two, "anchors": [
          {"file": "x.png", "shot": "a", "at": "offset", "offset": 0},
          {"file": "y.png", "shot": "a", "at": "offset", "offset": 67},
          {"file": "z.png", "shot": "a", "at": "offset", "offset": 999}]})["anchors"]],
      [("first", 0), ("last", 67), ("last", 67)])
check("an anchor written with a frame goes to the shot that frame is in",
      [(a["shot"], a["at"], a["offset"]) for a in S.normalize({"prompt": two, "anchors": [
          {"file": "x.png", "frame": 68}, {"file": "y.png", "frame": 100},
          {"file": "z.png", "frame": -1}]})["anchors"]],
      [("b", "first", 0), ("b", "offset", 32), ("b", "last", 55)])
short = S.normalize({**d, "clip": {"length": 5}})
check("when a shot no longer fits, its material goes where its text went",
      ([x["id"] for x in short["prompt"]["shots"]], [x["shot"] for x in short["subjects"]],
       sorted({a["shot"] for a in short["anchors"]})),
      (["a"], ["a", ""], ["a"]))
check("two shots with one id get ids of their own",
      [x["id"] for x in S.normalize({"prompt": {"shots": [
          {"id": "a", "length": 40}, {"id": "a", "length": 40}, {"length": 44}]}})["prompt"]["shots"]],
      ["a", "shot0", "shot1"])

# schema 6 named a subject by its place in the list
v6 = {"schema_version": 6, "subjects": [{}, {"images": ["a.png"]}, {"description": "an old man"}],
      "audio": [{"file": "v.wav", "subject": 2}, {"file": "w.wav", "subject": 9}],
      "anchors": [{"file": "e.png", "frame": -1, "cite": True}],
      "prompt": {"global": "@ref1 and @ref2.", "summary": "@ref3 is nobody.",
                 "shots": [{"length": 60, "text": "@ref2 nods.\n@ref1 says: hello"},
                           {"length": 64, "text": "@char1 waits."}]}}
d = S.normalize(v6)
check("v6: version", d["schema_version"], S.SCHEMA_VERSION)
check("v6: @refN became the id of the subject it meant",
      (d["prompt"]["global"], d["prompt"]["summary"], [x["text"] for x in d["prompt"]["shots"]]),
      ("@{s1} and @{s2}.", "@ref3 is nobody.", ["@{s2} nods.\n@{s1} says: hello", "@char1 waits."]))
check("v6: a voice's subject number became an id", [x["subject"] for x in d["audio"]], ["s2", "s2"])
check("v6: material was not grouped, so all of it is shared", [x["shot"] for x in d["subjects"]], ["", ""])
check("v6: migration is idempotent", S.normalize(d), d)
check("v6: and the prompt is what it was",
      C.build_plan(v6)["prompt"], C.build_plan({**v6, "schema_version": 6})["prompt"])
ok("v6: @ref1 still speaks", "<Subject 1> (S1) says, <d>[English] hello</d>" in C.build_plan(v6)["prompt"])

ok("a reference to material that is gone is a problem, and says where",
   S.problems({"prompt": {"global": "@{s9}", "shots": [{"text": "@{v3} @{v3}"}]}})
   == ["the overall description refers to material that is no longer there (@{s9})",
       "the text of shot 1 refers to material that is no longer there (@{v3})"])

# ---------------------------------------------------------------- migration from v5
v5 = {"schema_version": 5,
      "plate": {"video": "plate.mp4", "length": 124, "retention": "fully_preserved"},
      "anchors": {"first": "", "mids": [{"file": "m.png", "frame": 35}], "last": "",
                  "card": "card.png", "card_note": "the character reference"},
      "prompt": {"global": "g", "plan_mode": "official_six_section", "soundscape": "N/A",
                 "shots": [{"length": 60, "text": "one", "media": {"images": [{"file": "s.png"}]}},
                           {"length": 64, "text": "two"}]},
      "common": {"images": [{"file": "c.png", "note": "a prop"}], "videos": [], "audio": []},
      "mask": {"mode": "free_cells", "cells": "3-4"}}
d = S.normalize(v5)
check("v5: version", d["schema_version"], S.SCHEMA_VERSION)
check("v5: a shot's own picture still belongs to that shot",
      [(a["file"], a["shot"], a["at"]) for a in d["anchors"]],
      [("s.png", "shot0", "first"), ("m.png", "shot0", "offset")])
check("v5: the plate became the source, in the latent and as a reference",
      (d["source"]["video"], d["source"]["as_latent"], d["source"]["as_reference"], d["source"]["role"]),
      ("plate.mp4", True, True, "edit"))
ok("v5: the automatic end frames are gone with the feature", "cite_ends" not in d["source"])
check("v5: card and common images became subjects",
      [(s["images"], s["description"]) for s in d["subjects"]],
      [(["card.png"], "the character reference"), (["c.png"], "a prop")])
check("v5: anchors are cited, not pinned",
      [(a["file"], a["frame"], a["pin"], a["cite"]) for a in d["anchors"]],
      [("s.png", 0, False, True), ("m.png", 35, False, True)])
check("v5: mask kept", d["derived"]["free_cells"], [3, 4])
ok("v5: old keys gone", "plate" not in d and "common" not in d)
check("v5: migration is idempotent", S.normalize(d), d)
check("v1: prompt.shot becomes the only shot",
      [s["text"] for s in S.normalize({"schema_version": 1, "plate": {"video": "x.mp4"},
                                       "prompt": {"shot": "only"}})["prompt"]["shots"]], ["only"])

# ---------------------------------------------------------------- planner adapter
SHOTS = [{"length": 60, "text": "A kite climbs."}, {"length": 64, "text": "It dives."}]

p = C.build_plan({"family": "base", "prompt": {"global": "Live-action.", "shots": SHOTS,
                                               "soundscape": "Wind.", "music": "N/A"}})
check("t2va: three fields, no instruction line", p["prompt"].split("\n\n")[0][:35],
      "integrated_multimodal_description: ")
ok("t2va: second shot carries its cut time", "[Shot 2] At 00:02.500, " in p["prompt"])
ok("t2va: sound fields", "overall_soundscape: Wind." in p["prompt"]
   and "non_diegetic_music: N/A" in p["prompt"])
check("t2va: task", p["tasks"], ["t2va"])

p = C.build_plan({"family": "base", "prompt": {"shots": SHOTS}, "anchors": [
    {"file": "z.png", "frame": -1, "cite": True}]})
ok("l2va: the official last-frame sentence", p["prompt"].startswith(
    "How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) "
    "aligns with the 5.16-second mark of the target video."))
check("l2va: last frame only", C.keyframe_files(p), ("", "z.png"))

doc = {"family": "base", "prompt": {"shots": SHOTS}, "anchors": [
    {"file": "a.png", "frame": 0, "cite": True}, {"file": "m.png", "frame": 40},
    {"file": "z.png", "frame": -1}]}
check("base: a cited first frame is not a guide; pinned-only frames are",
      [(x["file"], x["frame"]) for x in C.guides(doc)], [("m.png", 40), ("z.png", 123)])

# "The first frame of shot 2" is an ordinary thing to ask of the base model. It can be shown
# the two ends of the clip and nothing else, so a picture anywhere else is held at its frame.
doc = {"family": "base", "prompt": {"shots": SHOTS}, "anchors": [
    {"file": "a.png", "frame": 0, "cite": True}, {"file": "m.png", "frame": 60, "cite": True}]}
check("base: a picture inside the clip that asks to be shown is held at its frame instead",
      (S.problems(doc), [(x["file"], x["frame"]) for x in C.guides(doc)],
       C.keyframe_files(C.build_plan(doc))), ([], [("m.png", 60)], ("a.png", "")))

p = C.build_plan({"family": "base", "prompt": {"mode": "raw", "raw": "trigger, sparks"}})
check("raw: sent as written", p["prompt"], "trigger, sparks")

ref = {"family": "reference", "prompt": {"shots": SHOTS},
       "subjects": [{"images": ["hero.png"], "description": "a boy in a red cape"}],
       "source": {"video": "src.mp4", "as_latent": False, "role": "edit", "audio": True},
       "videos": [{"file": "move.mp4"}],
       "audio": [{"file": "voice.wav", "subject": "s1"}]}
p = C.build_plan(ref)
check("reference: task types in the guide's order", p["tasks"],
      ["reference generation", "video editing", "audio reuse", "audio reference"])
ok("reference: summary opens the way the guide asks for an edit",
   "summary: [reference generation + video editing + audio reuse + audio reference] The "
   "target video is an edited version of <Video 1>." in p["prompt"])
ok("reference: the source is declared as the edit source",
   "<Video 1> is the source video for the target video edit." in p["prompt"])
ok("reference: the soundtrack is <Audio 1>, the voice <Audio 2>",
   "<Audio 1> is the synchronized audio track of <Video 1>, reused in the target video."
   in p["prompt"] and "<Audio 2> is the voice-timbre reference for <Subject 1>" in p["prompt"])
check("reference: videos in label order", [(v["file"], v["audio"]) for v in C.ref_videos(p)],
      [("src.mp4", True), ("move.mp4", False)])
check("reference: standalone audio only, given whole", C.ref_audio(p), [{"file": "voice.wav", "first": 0.0}])
check("reference: pictures", C.ref_images(p), [{"file": "hero.png", "keyframe": False}])

p = C.build_plan({**ref, "source": {**ref["source"], "role": "continue", "audio": False},
                  "videos": [], "audio": []})
ok("continuation: task and summary", "[reference generation + video continuation] The target "
   "video continues from the end of <Video 1>." in p["prompt"])

# a clip's own first and last frame, cited: two image anchors, like any other picture
p = C.build_plan({"family": "reference", "prompt": {"shots": SHOTS},
                  "source": {"video": "s.mp4"},
                  "anchors": [{"file": "f0.png", "frame": 0, "pin": False, "cite": True},
                              {"file": "f123.png", "frame": -1, "pin": False, "cite": True}]})
check("cited end frames become pictures",
      C.ref_images(p), [{"file": "f0.png", "keyframe": True}, {"file": "f123.png", "keyframe": True}])
ok("cited end frames are declared as frames", "<Picture 1> is the first frame of [Shot 1]." in p["prompt"]
   and "<Picture 2> is the last frame of [Shot 2]." in p["prompt"])

# material that belongs to a shot is named in that shot, written or not
owned = {"family": "reference", "prompt": {"global": "A valley.", "summary": "A scene.", "shots": [
             {"id": "a", "length": 68, "text": "@{s1} opens the door."},
             {"id": "b", "length": 56, "text": "Wide shot.\n@{s1} says quietly: wait"}]},
         "subjects": [{"images": ["ella.png"], "description": "a young woman"},
                      {"images": ["cabin.png"], "kind": "environment", "shot": "b"}],
         "videos": [{"file": "run.mp4", "shot": "b"}],
         "audio": [{"file": "wind.wav", "shot": "a"}, {"file": "voice.wav", "subject": "s1", "shot": "a"}],
         "anchors": [{"file": "open.png", "shot": "a", "at": "first", "cite": True},
                     {"file": "end1.png", "shot": "a", "at": "last", "cite": True},
                     {"file": "mid.png", "shot": "b", "at": "offset", "offset": 20, "cite": True},
                     {"file": "end2.png", "shot": "b", "at": "last", "cite": True},
                     {"file": "pin.png", "shot": "b", "at": "offset", "offset": 30}]}
# pictures are numbered in the order the planner reads them: the one a shot ends on sits on
# the shot's own record, ahead of a picture in the middle of that shot
check("labels are counted the way the plan sends them", C.labels(owned),
      {"s1": "@ref1", "s2": "@ref2", "k1": "<Picture 3>", "k2": "<Picture 4>", "k4": "<Picture 5>",
       "k3": "<Picture 6>", "v1": "<Video 1>", "a1": "<Audio 1>", "a2": "<Audio 2>"})
p = C.build_plan(owned)
check("and the plan sends the pictures in that order", [x["file"] for x in C.ref_images(p)],
      ["ella.png", "cabin.png", "open.png", "end1.png", "end2.png", "mid.png"])
ok("a shot's own subject is named in it without being written",
   "<Subject 2> (appears in [Shot 2])" in p["prompt"] and "<Subject 2> is in this shot." in p["prompt"])
ok("so is its video, and a sound that is nobody's voice",
   "The motion in this shot follows <Video 1>." in p["prompt"]
   and "The sound of <Audio 1> is heard in this shot." in p["prompt"])
ok("a voice is declared with its subject, not in the shot",
   "<Audio 2> is the voice-timbre reference for <Subject 1>" in p["prompt"]
   and "The sound of <Audio 2>" not in p["prompt"])
ok("the sentences join the narration, and the spoken line stays a line of its own",
   "Wide shot. <Subject 2> is in this shot. The motion in this shot follows <Video 1>."
   in p["prompt"] and "<Subject 1> (S1) says quietly, <d>[English] wait</d>" in p["prompt"])
ok("the picture a shot opens with, and the one it ends on",
   "<Picture 3> is the first frame of [Shot 1]." in p["prompt"]
   and "<Picture 5> is the last frame of [Shot 2]." in p["prompt"]
   and "The shot ends on <Picture 5>." in p["prompt"])
ok("where the planner has no wording, a composition anchor at that time",
   "<Picture 4> is a composition anchor at 2.8s." in p["prompt"]
   and "<Picture 6> is a composition anchor at 3.7s." in p["prompt"])
check("nothing was written into the document",
      S.normalize(owned)["prompt"]["shots"][1]["text"], "Wide shot.\n@{s1} says quietly: wait")
ok("an anchor that is pinned and not cited has no label: its name stands in the text",
   "pin" in C.shot_texts({**owned, "prompt": {"shots": [{"id": "b", "text": "Like @{k5}."}]}})[0])
q = C.build_plan({"family": "reference", "prompt": {"shots": [{"id": "a", "length": 68, "text": ""},
                                                             {"id": "b", "length": 56, "text": "It dives."}]},
                  "subjects": [{"images": ["kite.png"], "shot": "a"}]})
ok("a shot with material and no text is still a shot of its own",
   "[Shot 1] <Subject 1> is in this shot. [Shot 2] At 00:02.833, It dives." in q["prompt"])
q = C.build_plan({"family": "reference", "prompt": {"shots": [{"id": "a", "text": "It climbs."}]},
                  "anchors": [{"file": "f.png", "shot": "a", "at": "first", "cite": True},
                              {"file": "l.png", "shot": "a", "at": "last", "cite": True}]})
ok("a shot that has both: the last one of the clip ends the video",
   "<Picture 1> is the first frame of [Shot 1]." in q["prompt"]
   and "<Picture 2> is the last frame of the target video." in q["prompt"])
q = C.build_plan({"family": "base", "prompt": {"shots": [{"id": "a", "text": "@{s1} waves."}]},
                  "subjects": [{"description": "a tall robot", "shot": "a"}]})
ok("base family: a subject is its description", "a tall robot waves." in q["prompt"])

check("canvas follows the source", C.canvas({"source": {"video": "s.mp4"}}, {"megapixels": 0.25},
                                           lambda n: {"width": 720, "height": 1280}), (384, 672))
check("canvas from an explicit ratio", C.canvas({"clip": {"aspect": "1:1"}}, {"megapixels": 0.4}),
      (640, 640))
ok("timeline_json hides the adapter's private keys", "_role" not in C.timeline_json(C.build_plan(ref)))

# ---------------------------------------------------------------- presets
s = P.normalize({})
check("built-in presets", [p_["id"] for p_ in s["presets"]], ["draft", "standard", "final"])
check("default preset", s["active"], "standard")
check("presets idempotent", P.normalize(s), s)
check("standard is the official template", {k: P.active_params(s)[k] for k in
                                            ("steps", "cfg", "sampler_name", "scheduler")},
      {"steps": 20, "cfg": 1.0, "sampler_name": "res_multistep", "scheduler": "simple"})
check("a v1 preset's width and height become a megapixel budget",
      P.normalize_params({"width": 960, "height": 960, "steps": 48})["megapixels"], 0.879)
check("ref_video_edge snaps to a known size", P.normalize_params({"ref_video_edge": 300})["ref_video_edge"], 256)

s = P.record_run(s, "standard", 100.0, frames=124, at_ms=1)
s = P.record_run(s, "standard", 300.0, frames=243, at_ms=2)
std = P.active_preset(s)
check("timing for this clip length only", P.timing_for(std, 124),
      {"count": 1, "last_seconds": 100.0, "avg_seconds": 100.0})
check("timing over everything", P.timing_for(std)["count"], 2)
for preset in s["presets"]:
    if preset["id"] == "standard":
        preset["params"]["steps"] = 30
check("changing a parameter drops timings that no longer describe it",
      P.active_preset(P.normalize(s))["history"]["count"], 0)

# ---------------------------------------------------------------- takes
t = T.empty()
t = T.add_take(t, seed=1, prompt_id="p1", take_id="a", at_ms=1)
t = T.add_take(t, seed=2, prompt_id="p2", take_id="b", at_ms=2)
t = T.update_take(t, "a", status="done", file="a.mp4")
t = T.update_take(t, "b", status="done", file="b.mp4")
shots = S.normalize({"prompt": {"shots": [{"length": 39}, {"length": 34}, {"length": 51}]}})["prompt"]["shots"]
t = T.pick_all(t, 3, "a")
plan = T.splice_plan(t, shots)
check("one take for every segment needs no composite", T.single_take(plan), "a")
check("... and has no cuts to repair", T.cut_frames(plan), [])
t = T.pick(t, 2, "b")
plan = T.splice_plan(t, shots)
check("mixed takes", T.single_take(plan), "")
check("only the cut where the take changes is repaired", T.cut_frames(plan), [73])
check("splice plan", [(x["file"], x["start"], x["length"]) for x in plan],
      [("a.mp4", 0, 39), ("a.mp4", 39, 34), ("b.mp4", 73, 51)])
check("segment-scoped takes from v1 are not candidates",
      T.normalize({"takes": [{"id": "x", "scope": 1}, {"id": "y", "scope": "whole"}]})["takes"][0]["id"], "y")
try:
    T.splice_plan(T.pick(t, 0, None), shots)
    F.append("a segment without a pick should stop the composite")
except ValueError:
    pass
check("takes idempotent", T.normalize(t), t)
check("the division into shots, as a take remembers it", T.layout_key(shots), "0,39,73")
long_take = S.normalize({"prompt": {"shots": [{"length": 39, "join": "continuous"}, {"length": 34},
                                              {"length": 51, "join": "continuous"}]}})["prompt"]["shots"]
check("... says which shots go on from the one before (never the first)",
      T.layout_key(long_take), "0,39,73~")
check("... one shot", T.layout_key(shots[:1]), "0")
u = T.add_take(t, seed=3, prompt_id="p3", take_id="c", at_ms=3, layout=T.layout_key(long_take))
check("a take keeps the division it was rendered with",
      [x["layout"] for x in u["takes"]], ["", "", "0,39,73~"])

# ---------------------------------------------------------------- names outside the shots
# A subject's description, the ambient sound and the music may name material too. The
# planner passes them on as written, so they reach it with the final labels in place.
doc = {"family": "reference", "prompt": {
           "soundscape": "The sound of @{a1}.", "music": "In the style of @{a1}.",
           "shots": [{"id": "a", "length": 124, "text": "@{s2} dances on a roof."}]},
       "subjects": [{"id": "s1", "description": "an old man"},
                    {"id": "s2", "images": ["d.png"],
                     "description": "a dancer, taught by @{s1}, whose motion comes from @{v1}"},
                    {"id": "s3", "images": ["e.png"], "description": "a rival of @{s2}"}],
       "videos": [{"id": "v1", "file": "run.mp4"}], "audio": [{"id": "a1", "file": "song.wav"}]}
check("nothing in it is a problem", S.problems(doc), [])
tl = C.to_timeline(doc)
check("a description names a video by its label, a pictured subject by its label, another by what it is",
      [x["description"] for x in tl["subjects"]],
      ["an old man", "a dancer, taught by an old man, whose motion comes from <Video 1>",
       "a rival of <Subject 1>"])
check("the ambient sound and the music name an audio by its label",
      (tl["overall_soundscape"], tl["non_diegetic_music"]),
      ("The sound of <Audio 1>.", "In the style of <Audio 1>."))
ok("and no id is left in the prompt", "@{" not in C.build_plan(doc)["prompt"])
check("a name of something gone, there, is refused",
      S.problems_coded({"prompt": {"music": "like @{a9}"}, "subjects": [{"description": "as @{v9}"}]}),
      [["mention_gone_other", ["@{a9}"]], ["mention_gone_other", ["@{v9}"]]])
# an audio that carries a spoken line: the planner's own tag at the start of the line
doc = {"family": "reference", "prompt": {"shots": [{"id": "a", "length": 124, "text":
       "A stage in the dark.\n@{a1}: Hello there.\n@{a1} is heard far away."}]},
       "audio": [{"id": "a1", "file": "song.wav"}]}
check("a line an audio speaks is written the planner's way, and prose about it is not",
      C.shot_texts(doc)[0].split("\n")[1:], ["@audio1: Hello there.", "<Audio 1> is heard far away."])
ok("so the planner makes it a spoken line", "<Audio 1> carries <d>[English] Hello there.</d>"
   in C.build_plan(doc)["prompt"])

# ---------------------------------------------------------------- output settings
c = O.normalize({"global_refine": {"enabled": True}, "face_refine": {"enabled": True},
                 "save": {"filename_prefix": "X", "crf": 3}})
check("stages of older versions are dropped", sorted(c), ["face", "preview", "save", "version"])
check("save prefix kept, unknown save keys dropped", c["save"],
      {"auto_save": True, "filename_prefix": "X", "format": "mp4", "codec": "h264"})
check("output settings idempotent", O.normalize(c), c)
c = O.normalize({"face": {"strength": 2, "padding": 0, "feather": "x", "cuts": " 61, a,122 ,",
                          "file": None, "enabled": True}})
check("face refine settings are clamped, and its job fields cleaned", c["face"],
      {"strength": 0.95, "padding": 1.2, "feather": 0.15, "min_score": 0.6, "subject": "",
       "text": "", "shots": "", "file": "", "cuts": "61,122"})
# the strength of a face refine is the noise the run starts from; the denoise that gives it
# depends on the schedule shift
for noise, shift in ((0.5, 12.0), (0.3, 12.0), (0.8, 5.0), (0.5, 1.0)):
    dn = O.denoise_for(noise, shift)
    ok("denoise for %d%% noise at shift %s comes back as that noise" % (noise * 100, shift),
       abs(shift * dn / (1 + (shift - 1) * dn) - noise) < 1e-9)
check("half noise at the default shift", round(O.denoise_for(0.5, 12.0), 4), 0.0769)
check("a codec core cannot write falls back", O.normalize({"save": {"codec": "h265"}})["save"]["codec"],
      "h264")

# ---------------------------------------------------------------- reference limits
# Nothing the user listed is dropped without saying so: a reference that is listed and
# then not sent would also renumber every <Video N> / <Audio N> after it.
many = {"family": "reference", "subjects": [{"images": ["%d.png" % i for i in range(9)]}],
        "videos": [{"file": "a.mp4", "audio": True}, {"file": "b.mp4", "audio": True}],
        "audio": [{"file": "x.wav"}]}
found = S.problems(many)
check("soundtracks count as audio references, and everything counts toward 12 files",
      [any(n in x for x in found) for n in ("reference files in all", "reference audio")],
      [True, False])
check("four audio references with soundtracks", any(
    "4 reference audio clips (2 of them soundtracks)" in x
    for x in S.problems({**many, "audio": [{"file": "x.wav"}, {"file": "y.wav"}]})), True)


def refuses(name, doc, needle, probe):
    try:
        C.build_plan(doc, probe=probe)
    except ValueError as exc:
        if needle not in str(exc):
            F.append(f"{name}: wrong reason: {exc}")
        return
    F.append(f"{name}: should have been refused")


# every subject listed is kept; the model's limit is on images, and problems() counts those
d = S.normalize({"subjects": [{"images": ["%d.png" % i]} for i in range(10)]})
check("ten subjects stay ten", len(d["subjects"]), 10)
check("ten subjects and ten images are refused, by count", S.problems(d),
      ["10 subjects, but the limit is 9 (subjects without a picture count too)",
       "10 reference images, but the model takes at most 9"])
# a subject without a picture takes no image slot, but it is numbered all the same
check("ten subjects in words only",
      S.problems(S.normalize({"subjects": [{"description": "thing %d" % i} for i in range(10)]})),
      ["10 subjects, but the limit is 9 (subjects without a picture count too)"])
check("nine subjects in words are fine",
      S.problems(S.normalize({"subjects": [{"description": "thing %d" % i} for i in range(9)]})), [])
check("a derived block that came with the document is not trusted",
      S.problems({**S.normalize({"source": {"video": "s.mp4", "as_latent": True},
                                 "mask": {"mode": "free_cells"}}),
                  "derived": {"free_cells": [0], "latent_source": "source"}}),
      ["the mask frees no cells, so the run would only reproduce its source"])

ten_seconds = lambda name: {"frames": 240, "frames24": 240, "audio": False}   # noqa: E731
refuses("fewer references sent than listed",
        {"family": "reference", "subjects": [{"images": ["%d.png" % i]} for i in range(10)],
         "prompt": {"shots": SHOTS}}, "9 of 10 reference images", ten_seconds)
# one reference video longer than 15 s is cut to 15 s, and the plan says so
_long = lambda name: {"frames": 600, "frames24": 600, "audio": False}   # noqa: E731
_plan = C.build_plan(S.normalize({"family": "reference", "clip": {"length": 379},
                                  "videos": [{"file": "a.mp4"}], "prompt": {"summary": "x", "shots": SHOTS}}),
                     probe=_long)
check("a long reference video: cut to 360 frames", [v["length"] for v in _plan["ref_video_segs"]], [360])
check("a long reference video: the plan says so",
      [w for w in _plan["ref_warnings"] if "a.mp4" in w and "360 frames" in w] != [], True)
_plan = C.build_plan(S.normalize({"family": "reference", "clip": {"length": 124},
                                  "videos": [{"file": "a.mp4"}], "prompt": {"summary": "x", "shots": SHOTS}}),
                     probe=_long)
check("a long file in a short clip: read to the clip's length, nothing to warn about",
      ([v["length"] for v in _plan["ref_video_segs"]],
       [w for w in _plan["ref_warnings"] if "15 seconds" in w]), ([124], []))
refuses("reference videos over the 15 s total",
        {"family": "reference", "clip": {"length": 243},
         "videos": [{"file": "a.mp4"}, {"file": "b.mp4"}], "prompt": {"shots": SHOTS}},
        "dropped", ten_seconds)
refuses("a soundtrack switched on for a silent file",
        {"family": "reference", "videos": [{"file": "a.mp4", "audio": True}],
         "prompt": {"shots": SHOTS}}, "no audio track", ten_seconds)
refuses("a pinned clip with sound from a silent file",
        {"family": "base", "anchors": [{"kind": "clip", "file": "a.mp4", "with_audio": True}],
         "prompt": {"shots": SHOTS}}, "no audio track", ten_seconds)
p = C.build_plan({"family": "reference", "clip": {"length": 124},
                  "videos": [{"file": "a.mp4"}], "prompt": {"shots": SHOTS}}, probe=ten_seconds)
check("a reference video is as long as core will read it: the target's length",
      [v["length"] for v in C.ref_videos(p)], [124])
long_ref = lambda name: {"frames": 600, "frames24": 600, "audio": False}   # noqa: E731
p = C.build_plan({"family": "reference", "clip": {"length": 481},
                  "videos": [{"file": "a.mp4"}], "prompt": {"shots": SHOTS}}, probe=long_ref)
check("and never longer than the 15 seconds the model takes",
      [v["length"] for v in C.ref_videos(p)], [360])

# ---------------------------------------------------------------- cuts and long takes
SH = [{"id": "a", "length": 61, "text": "She walks."}, {"id": "b", "length": 61, "text": "She stops."},
      {"id": "c", "length": 61, "text": "A dragon appears."}, {"id": "d", "length": 60, "text": "It lands."}]
joins = lambda doc: [s["join"] for s in S.normalize(doc)["prompt"]["shots"]]      # noqa: E731
check("a shot follows the one before it with a cut unless it says it goes on",
      joins({"clip": {"length": 243}, "prompt": {"shots": [
          dict(SH[0], join="continuous"), dict(SH[1], join="continuous"), dict(SH[2]),
          dict(SH[3], join="nonsense")]}}), ["cut", "continuous", "cut", "cut"])
# a document from before shots said so: over a source clip its takes were joined by rendering
# the seam again, and that is kept; from nothing, a boundary was a cut and stays one
old = {"schema_version": 7, "clip": {"length": 243}, "prompt": {"shots": [dict(x) for x in SH]}}
check("v7, made from nothing: cuts", joins(old), ["cut", "cut", "cut", "cut"])
check("v7, over a source clip: the shots go on from one another",
      joins(dict(old, source={"video": "src.mp4"})), ["cut", "continuous", "continuous", "continuous"])
check("v7: a shot that already says is left as it says",
      joins(dict(old, source={"video": "src.mp4"}, prompt={"shots": [
          dict(SH[0]), dict(SH[1], join="cut"), dict(SH[2]), dict(SH[3])]})),
      ["cut", "cut", "continuous", "continuous"])
sounds = lambda doc: [s["sound"] for s in S.normalize(doc)["prompt"]["shots"]]      # noqa: E731
check("the sound may go on across a cut; nothing goes on before the first shot",
      sounds({"clip": {"length": 243}, "prompt": {"shots": [
          dict(SH[0], sound="continuous"), dict(SH[1], join="continuous"), dict(SH[2], sound="continuous"),
          dict(SH[3], sound="nonsense")]}}), ["cut", "cut", "continuous", "cut"])
check("inside a long take the sound's own setting is kept for when the picture is cut again",
      sounds({"clip": {"length": 243}, "prompt": {"shots": [
          dict(SH[0]), dict(SH[1], join="continuous", sound="continuous"), dict(SH[2]), dict(SH[3])]}}),
      ["cut", "continuous", "cut", "cut"])
# --- a seam's own range
def seam_doc(seam="none", cut=68, joins=("continuous",), radius=1):
    second = {"id": "b", "length": 124 - cut, "join": joins[0]}
    if seam != "none":
        second["seam"] = seam
    return {"clip": {"length": 124}, "prompt": {"shots": [{"id": "a", "length": cut}, second]},
            "source": {"splice": [{"file": "a.mp4", "start": 0, "length": cut, "take": "A"},
                                  {"file": "b.mp4", "start": cut, "length": 124 - cut, "take": "B",
                                   "join": joins[0]}]},
            "mask": {"mode": "seam_repair", "cut_frames": str(cut), "radius": radius}}


free = lambda doc: (S.normalize(doc)["derived"]["free_latents"], S.normalize(doc)["derived"]["free_cells"])   # noqa: E731
check("a seam without a range of its own frees the cells it always did",
      free(seam_doc()), (list(range(15, 25)), [3, 4]))
check("  and nothing is written into a document that has none",
      [s["seam"] for s in S.normalize(seam_doc())["prompt"]["shots"]], [None, None])
check("with one, exactly its latent frames; the cells are those that hold any",
      free(seam_doc([2, 2])), ([18, 19, 20, 21], [3, 4]))
check("a seam inside a latent frame frees that one too", free(seam_doc([1, 1], cut=62)), ([17, 18, 19], [3]))
check("a range is two numbers, each within bounds",
      [S.normalize(seam_doc(v))["prompt"]["shots"][1]["seam"] for v in ([2, 2], [99, -3], [2], "2,2", None, [1.9, "3"])],
      [[2, 2], [40, 0], None, None, None, [1, 3]])
check("the first shot follows nothing and has none",
      S.normalize({"clip": {"length": 124}, "prompt": {"shots": [{"length": 68, "seam": [2, 2]}, {"length": 56}]}})
      ["prompt"]["shots"][0]["seam"], None)
check("a range is kept while the shot is cut to, and frees nothing then",
      (S.normalize(seam_doc([2, 2], joins=("cut",)))["prompt"]["shots"][1]["seam"],
       free(seam_doc([2, 2], joins=("cut",)))[0] == list(range(15, 25))), ([2, 2], True))
check("a range ends where the long take does: a latent frame is freed whole or not at all",
      free(seam_doc([40, 40]))[0], list(range(0, 37)))
check("a seam left to itself ends where the next cell begins",
      [free(seam_doc("auto", cut=c))[0] for c in (68, 62, 70)],
      [[17, 18, 19], [17, 18, 19], list(range(19, 25))])
check("  the word is kept as it is, and anything else that is no pair is nothing",
      [S.normalize(seam_doc(v))["prompt"]["shots"][1]["seam"] for v in ("auto", "AUTO", "cell", True)],
      ["auto", None, None, None])
# a frame named by hand that lies inside a long take stays inside it
hand = lambda cuts: S.normalize({"clip": {"length": 124}, "prompt": {"shots": [   # noqa: E731
    {"id": "a", "length": 51}, {"id": "b", "length": 17}, {"id": "c", "length": 17, "join": "continuous"},
    {"id": "d", "length": 39}]}, "source": {"video": "src.mp4", "as_latent": True},
    "mask": {"mode": "seam_repair", "cut_frames": cuts, "radius": 1}})["derived"]["free_cells"]
check("a frame inside a long take does not free across the cut before it", hand("60"), [3, 4])
check("  a frame on a cut is the cut: both sides of it", hand("51"), [2, 3])
check("  and one where a shot goes on stays inside its long take, as before", hand("68"), [3, 4])

check("the report says when less than whole cells are free",
      "only the latent frames [18, 19, 20, 21] (frames 60-63, 64-67, 68-68, 69-72)"
      in S.summary(S.normalize(seam_doc([2, 2]))), True)
check("  and nothing more when whole cells are", "only the latent frames" in S.summary(S.normalize(seam_doc())), False)

check("a current document over a source clip is not touched",
      joins(dict(old, schema_version=S.SCHEMA_VERSION, source={"video": "src.mp4"})), ["cut"] * 4)
# a composite of that time, as a history or an API caller still has it: wherever it changed
# take the frames around were rendered again, over a source clip or not
pieces = [{"file": "a.mp4", "start": 0, "length": 122, "take": "A"},
          {"file": "b.mp4", "start": 122, "length": 121, "take": "B"}]
for name, source in (("from nothing", {}), ("over a source clip", {"video": "src.mp4"})):
    comp = S.normalize(dict(old, source=dict(source, splice=[dict(p) for p in pieces]),
                            mask={"mode": "seam_repair", "cut_frames": "122"}))
    check("v7 composite, %s: its pieces go on from one another" % name,
          [p["join"] for p in comp["source"]["splice"]], ["cut", "continuous"])
    check("v7 composite, %s: the cells around the join are still rendered" % name,
          comp["derived"]["free_cells"], [6, 7, 8])
    check("v7 composite, %s: runs" % name, S.problems(comp), [])
check("a current composite's pieces are cuts unless they say",
      [p["join"] for p in S.normalize(dict(old, schema_version=S.SCHEMA_VERSION, source={"splice": [
          dict(p) for p in pieces]}))["source"]["splice"]], ["cut", "cut"])

long_doc = {"family": "reference", "clip": {"length": 243}, "prompt": {"global": "Snow.", "shots": [
    dict(SH[0]), dict(SH[1], join="continuous", text="She stops.\n@voice(a low voice) says: Here."),
    dict(SH[2]), dict(SH[3], join="continuous")]}}
check("the long takes of a clip", S.long_takes(S.normalize(long_doc)["prompt"]["shots"]), [(0, 122), (122, 243)])
prompt = C.build_plan(long_doc)["prompt"]
check("shots that go on from one another are one [Shot]; a cut is the next one, with its time",
      (prompt.count("[Shot 1]"), prompt.count("[Shot 2] At 00:05.083"), prompt.count("[Shot 3]")), (1, 1, 0))
check("their narration runs on in order, and a spoken line is still one",
      ("She walks. She stops." in prompt, "<d>[English] Here.</d>" in prompt,
       "A dragon appears. It lands." in prompt), (True, True, True))
# a picture on the first frame of a shot in the middle of a long take is a frame of that
# take, not the opening of a [Shot]
mid = dict(long_doc, anchors=[{"id": "k1", "kind": "image", "file": "p.png", "shot": "b", "at": "first",
                               "pin": True, "cite": True}])
check("the first frame of a shot inside a long take is declared at its time",
      ("composition anchor at 2.5s" in C.build_plan(mid)["prompt"],
       "first frame of [Shot" in C.build_plan(mid)["prompt"]), (True, False))

# a seam inside a long take is repaired inside it
seam = lambda cuts, shots: S.normalize({"clip": {"length": 243}, "prompt": {"shots": shots},      # noqa: E731
                                        "source": {"splice": [{"file": "a.mp4", "start": 0, "length": 243}]},
                                        "mask": {"mode": "seam_repair", "cut_frames": cuts}})["derived"]["free_cells"]
check("a seam at a cut frees the cells either side of it (a document that asks for that)",
      seam("61", [dict(x) for x in SH]), [2, 3, 4])
check("a seam inside a long take frees the cells around it, where the long take has room",
      seam("122", [dict(SH[0]), dict(SH[1]), dict(SH[2], join="continuous"), dict(SH[3])]), [6, 7, 8])
# the long take is frames 61..182; cell 10 is 170..186 and reaches into the shot after the cut
check("...and does not reach past the long take's end, where a cut is",
      seam("170", [{"id": "a", "length": 61}, {"id": "b", "length": 109},
                   {"id": "c", "length": 13, "join": "continuous"}, {"id": "d", "length": 60}]), [9])
check("a long take too short to hold a whole cell: nothing can be rendered again",
      seam("68", [{"id": "a", "length": 61}, {"id": "b", "length": 7}, {"id": "c", "length": 8, "join": "continuous"},
                  {"id": "d", "length": 167}]), [])
check("a composite of cuts frees nothing, and that is no problem",
      S.problems({"clip": {"length": 124}, "prompt": {"shots": [{"length": 60}, {"length": 64}]},
                  "source": {"splice": [{"file": "a.mp4", "start": 0, "length": 60},
                                        {"file": "b.mp4", "start": 60, "length": 64}]},
                  "mask": {"mode": "seam_repair", "cut_frames": ""}}), [])
check("pieces that add up to the clip and overlap are refused",
      [p.split(":")[0][:28] for p in S.problems({"clip": {"length": 124}, "source": {"splice": [
          {"file": "a.mp4", "start": 0, "length": 62}, {"file": "b.mp4", "start": 0, "length": 62}]},
          "mask": {"mode": "seam_repair", "cut_frames": ""}})],
      ["the composite splice covers "])

if F:
    print("FAILED:")
    for f in F:
        print(" -", f)
    sys.exit(1)
print("schema / compile / presets / takes tests: all passed")
