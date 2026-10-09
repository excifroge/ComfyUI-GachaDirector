"""Gacha Director — from the clip document to a prompt and a list of what to load.

Pure module. Imports nothing from ComfyUI.

The prompt is assembled by the bundled planner (``vendor/minimax_plan.py``, see NOTICE),
which implements both official prompt formats: the three-field base format with its fixed
image-alignment sentences, and the six-section full-reference format. This module is the
adapter in front of it. It turns the document's *material with roles* into the flat
timeline the planner reads, and it settles the three things the planner cannot know:

* **the task type.** The planner never derives ``video editing`` or ``video
  continuation`` — those depend on what the source clip is *for*, which only the document
  says (``source.role``).
* **audio numbering.** Core labels a reference video's soundtrack ``<Audio j>`` right
  before its ``<Video k>``, and standalone audio after all of them. The planner numbers
  whatever it is handed in order, so soundtracks are handed over first, in video order.
* **what is cited and what is only pinned.** An anchor that is pinned but not cited never
  reaches the planner: it becomes an Add Guide node and the prompt does not mention it.
* **labels.** Prompt text names material by id (``@{s1}``); nobody types ``<Video 2>``.
  Here an id becomes the label the model reads, and material that belongs to a shot is
  mentioned in that shot even when its text does not: the guide declares a reference where
  it is used, and "this picture goes with shot 2" is something the panel knows.
* **which shot a picture is a frame of.** An anchor sits at the first frame of its shot,
  at the last, or somewhere in between; the planner reads "one segment, one picture, and
  it opens the shot". :func:`to_timeline` lays the pictures out so that the planner's own
  wording comes out right ("is the first frame of [Shot 2]", "is the last frame of
  [Shot 2]"), and falls back to its "composition anchor at 2.8 seconds" where it has no
  wording for the case.

Everything the emitter needs comes back in one plan: the prompt, the reference images in
``<Picture N>`` order, the videos in ``<Video N>`` order, the audio in ``<Audio N>`` order.
Feeding the sockets in any other order would leave the prompt talking about the wrong
file, silently.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from . import gd_grid as grid
from . import gd_schema as schema
from .vendor import minimax_plan as plan

FPS = 24.0

#: The guide's own sentences, verbatim where it gives them.
SOURCE_DESC = {
    "edit": "the source video for the target video edit",
    "continue": "the source video that the target video continues from",
    "motion": "",                    # the planner's generic reference-video declaration
}
SOURCE_SUMMARY = {
    "edit": "The target video is an edited version of %s.",
    "continue": "The target video continues from the end of %s.",
    "motion": "",
}
SOURCE_TASK = {
    "edit": plan.TASK_EDITING,
    "continue": plan.TASK_CONTINUATION,
    "motion": plan.TASK_REFERENCE,
}

#: What is written into a shot for material that belongs to it and that its text does not
#: mention. Only the copy that goes to the planner gets it; the user's text is not changed.
AUTO_SUBJECT = "%s is in this shot."
AUTO_VIDEO = "The motion in this shot follows %s."
AUTO_AUDIO = "The sound of %s is heard in this shot."

Probe = Callable[[str], Any]


def _frames_of(name: str, probe: Probe | None, fallback: int) -> int:
    """Length of a media file in 24 fps frames, or ``fallback`` when it cannot be read."""
    if probe is None:
        return fallback
    try:
        info = probe(name) or {}
    except Exception:  # noqa: BLE001 - an unreadable file is reported when it is loaded
        return fallback
    frames = int(info.get("frames24") or info.get("frames") or 0)
    return frames if frames > 0 else fallback


def labels(doc: dict) -> dict:
    """What every piece of material is called in the prompt: {id: text}.

    A subject is ``@refK`` (its place in the list): the planner turns that into
    ``<Subject N>``, or into the subject's description where there is no picture to label.
    Everything else is the label core gives it, counted the way core counts: pictures of
    subjects first, then cited anchors in time order; the source clip is ``<Video 1>`` when
    it is sent as a reference; soundtracks before standalone audio. A picture that is
    pinned but not cited has no label, and neither has anything in the base family.
    """
    d = schema.normalize(doc)
    reference = d["family"] == "reference"
    out = {x["id"]: "@ref%d" % (i + 1) for i, x in enumerate(d["subjects"])}
    if not reference:
        return out
    n = sum(len(x["images"]) for x in d["subjects"])
    for r in _records(d):
        if "anchor" in r:
            n += 1
            out[r["anchor"]["id"]] = "<Picture %d>" % n
    first = 2 if schema.reference_source(d) else 1
    for i, v in enumerate(d["videos"]):
        out[v["id"]] = "<Video %d>" % (first + i)
    tracks = (1 if schema.reference_source(d) and d["source"]["audio"] else 0) + sum(
        1 for v in d["videos"] if v["audio"])
    for i, x in enumerate(d["audio"]):
        out[x["id"]] = "<Audio %d>" % (tracks + i + 1)
    return out


def _long_takes(d: dict) -> list[list[dict]]:
    """The clip's shots as the model is to see them: each list is one shot of the prompt,
    made of a shot of the document and every shot that continues it."""
    out: list[list[dict]] = []
    for shot in d["prompt"]["shots"]:
        if out and shot["join"] == "continuous":
            out[-1].append(shot)
        else:
            out.append([shot])
    return out


def _written(d: dict) -> set:
    """Ids of the shots that will carry text: their own, or a sentence about their material."""
    out = set()
    for shot in d["prompt"]["shots"]:
        if shot["text"].strip() or _unsaid(d, shot):
            out.add(shot["id"])
    return out


def _unsaid(d: dict, shot: dict) -> list[tuple]:
    """A shot's own material that its text does not mention: [(sentence, id)]."""
    said = set(schema.MENTION_RE.findall(shot["text"]))
    out = [(AUTO_SUBJECT, x["id"]) for x in d["subjects"]
           if x["shot"] == shot["id"] and x["id"] not in said]
    if d["family"] == "reference":
        out += [(AUTO_VIDEO, x["id"]) for x in d["videos"]
                if x["shot"] == shot["id"] and x["id"] not in said]
        # a voice is declared with its subject; a sound of its own is said in the shot
        out += [(AUTO_AUDIO, x["id"]) for x in d["audio"]
                if x["shot"] == shot["id"] and x["id"] not in said and not x["subject"]]
    return out


def _records(d: dict) -> list[dict]:
    """The planner's segments, without their text, in the order it will read them.

    One record per long take, at its first frame (a shot that nothing continues is a long
    take of its own). The planner reads a record as a shot and a picture on it as what the
    shot opens with, or ends on when the record says so. A picture it has no such wording
    for gets a record of its own, with no text, which the planner declares as a composition
    anchor at that time: that is also what the first or last frame of a shot in the middle
    of a long take is. Pictures are numbered in the order of these records, so the labels
    are read off this list and nowhere else.
    """
    fc = d["derived"]["frame_count"]
    reference = d["family"] == "reference"
    takes = _long_takes(d)
    head = {s["id"]: t[0]["id"] for t in takes for s in t}
    tail = {s["id"]: t[-1]["id"] for t in takes for s in t}
    written = {head[i] for i in _written(d)}        # a long take says what any of its shots says
    recs = [{"start": int(t[0]["start"]), "shot": t[0]["id"]} for t in takes]
    own = {r["shot"]: r for r in recs}
    last_shot = d["prompt"]["shots"][-1]["id"]
    # The base model can be shown the first and the last frame of the clip and nothing
    # else: a picture anywhere else is held at its frame (see guides) and not declared.
    cited = sorted((x for x in d["anchors"] if x["kind"] == "image" and x["cite"]
                    and (reference or schema.resolved_frame(x, fc) in (0, fc - 1))),
                   key=lambda x: schema.resolved_frame(x, fc))
    for a in cited:
        frame = schema.resolved_frame(a, fc)
        r = own[head[a["shot"]]]
        free = "anchor" not in r
        opens = a["at"] == "first" and a["shot"] == head[a["shot"]]
        closes = a["at"] == "last" and a["shot"] == tail[a["shot"]]
        if not reference:
            # the base model is shown its first and last frame, nothing else
            if frame <= 0 and free:
                r["anchor"] = a
            else:
                recs.append({"start": frame, "anchor": a, "ends": frame >= fc - 1})
        elif opens and free:
            r["anchor"] = a                              # "is the first frame of [Shot k]"
        elif closes and free and head[a["shot"]] in written:
            r.update(anchor=a, ends=True)                # "is the last frame of [Shot k]"
        else:
            # the end of the last shot is the end of the video, and the planner says so
            recs.append({"start": frame, "anchor": a,
                         "ends": a["at"] == "last" and a["shot"] == last_shot})
    return sorted(recs, key=lambda r: r["start"])


def _resolve(text: str, names: dict, d: dict) -> str:
    """Prompt text with every ``@{id}`` replaced by what the model reads."""
    mat = schema.material(d)

    def one(m):
        mid = m.group(1)
        if mid in names:
            return names[mid]
        if mid in mat:                       # pinned, not cited: there is no label to give
            return mat[mid][2]["name"]
        return m.group(0)                    # gone: schema.problems reports it
    return schema.MENTION_RE.sub(one, text or "")


def _final(text: str, names: dict, d: dict) -> str:
    """Text the planner passes on as it is written (a subject's description, the ambient
    sound, the music), with every ``@{id}`` replaced by what the model reads.

    The planner expands ``@refN`` in the overall description, the summary and the shots,
    and nowhere else, so here a subject is given its final name: ``<Subject N>`` when it
    has pictures and the model is the reference one (the planner numbers the subjects that
    have pictures, in order), else what it is called.
    """
    mat = schema.material(d)
    reference = d["family"] == "reference"
    pictured = [x["id"] for x in d["subjects"] if x["images"]]

    def one(m):
        mid = m.group(1)
        if mid not in mat:
            return m.group(0)                # gone: schema.problems reports it
        key, _, item = mat[mid]
        if key == "subjects":
            if reference and mid in pictured:
                return "<Subject %d>" % (pictured.index(mid) + 1)
            return item["short_name"] or item["description"] or item["name"]
        return names.get(mid, item["name"])
    return schema.MENTION_RE.sub(one, text or "")


# A reference audio that carries a spoken line is written `@audioN: the words` at the start
# of a line: that is the planner's dialogue rule, and `<Audio N>` there would be narration.
_AUDIO_SPEAKS = re.compile(r"^(\s*)<Audio (\d+)>(?=\s*(?:\[[^\]\n]+\])?[^:\n]*:\s*\S)")


def shot_texts(doc: dict) -> list[str]:
    """Each shot's text as the planner gets it: ids resolved, and a sentence added for
    every piece of the shot's own material that the text does not mention."""
    d = schema.normalize(doc)
    names = labels(d)
    out = []
    for shot in d["prompt"]["shots"]:
        extra = [sentence % names[mid] for sentence, mid in _unsaid(d, shot)]
        lines = [_AUDIO_SPEAKS.sub(r"\1@audio\2", line)
                 for line in _resolve(shot["text"], names, d).rstrip().split("\n")]
        if extra:
            # after the last line of narration: a spoken line is a line of its own, and the
            # description is meant to read as one paragraph
            told = [i for i, line in enumerate(lines)
                    if line.strip() and not plan.split_dialogue(line)[1]]
            if told:
                lines[told[-1]] = lines[told[-1]].rstrip() + " " + " ".join(extra)
            else:
                lines.insert(0, " ".join(extra))
        out.append("\n".join(lines).strip())
    return out


def _one_paragraph(texts: list[str]) -> str:
    """What the shots of a long take say, as one shot's text: narration runs on as one
    paragraph, in order, and a spoken line stays a line of its own (which is how the
    planner knows it for one)."""
    lines: list[str] = []
    for text in texts:
        for k, line in enumerate(x for x in text.split("\n") if x.strip()):
            spoken = bool(plan.split_dialogue(line)[1])
            if k == 0 and lines and not spoken and not plan.split_dialogue(lines[-1])[1]:
                lines[-1] = lines[-1].rstrip() + " " + line.strip()
            else:
                lines.append(line)
    return "\n".join(lines)


def to_timeline(doc: dict, *, probe: Probe | None = None) -> dict:
    """The flat timeline the bundled planner reads."""
    d = schema.normalize(doc)
    fam, src, pr = d["family"], d["source"], d["prompt"]
    fc = d["derived"]["frame_count"]
    reference = fam == "reference"
    names = labels(d)
    said = dict(zip((x["id"] for x in pr["shots"]), shot_texts(d)))
    # a long take is one shot to the model
    text_of = {t[0]["id"]: _one_paragraph([said[s["id"]] for s in t]) for t in _long_takes(d)}

    segments = []
    for n, r in enumerate(_records(d)):
        seg = {"id": f"seg{n}", "start": r["start"], "length": 1,
               "prompt": text_of.get(r.get("shot"), ""), "type": "prompt"}
        a = r.get("anchor")
        if a:
            seg.update({"type": "image", "imageFile": a["file"], "fileName": a["file"],
                        "refRole": a["role"], "retention": a["retention"],
                        "refNote": a["note"]})
            if r.get("ends"):
                seg["isEndFrame"] = True
        segments.append(seg)

    subjects = [{
        "images": [{"file": f, "name": f} for f in s["images"]],
        "description": _final(s["description"], names, d), "shortName": s["short_name"],
        "kind": s["kind"], "retention": s["retention"], "retentionNote": s["note"],
    } for s in d["subjects"]]
    place = {x["id"]: i + 1 for i, x in enumerate(d["subjects"])}

    motion, audio = [], []
    summary = _resolve(pr["summary"], names, d).strip()
    if reference:
        if schema.reference_source(d):
            motion.append({
                "id": "source", "videoFile": src["video"], "fileName": src["video"],
                # like every reference video: no longer than the target, nor than 15 seconds
                "start": 0, "length": min(fc, int(15 * FPS)), "trimStart": src["start"],
                "retention": src["retention"],
                "refDesc": src["desc"].strip() or SOURCE_DESC[src["role"]],
                "refNote": src["note"],
                "_source": True, "_role": src["role"], "_audio": src["audio"],
            })
            lead = SOURCE_SUMMARY[src["role"]]
            if lead:
                summary = (lead % "<Video 1>" + " " + summary).strip()
        for i, v in enumerate(d["videos"]):
            motion.append({
                "id": f"video{i}", "videoFile": v["file"], "fileName": v["file"],
                # core reads no more of a reference video than the target is long, and
                # the model takes none longer than 15 seconds
                "start": 0, "length": min(_frames_of(v["file"], probe, fc), fc, int(15 * FPS)),
                "trimStart": 0, "retention": v["retention"],
                "refDesc": v["desc"], "refNote": v["note"],
                "_source": False, "_role": "motion", "_audio": v["audio"],
            })
        # soundtracks first, in video order: that is the order core labels them in
        for k, seg in enumerate(motion):
            if not seg["_audio"]:
                continue
            copied = seg["_role"] == "edit"
            audio.append({
                "id": f"track{k}", "audioFile": seg["videoFile"], "fileName": seg["videoFile"],
                "start": 0, "length": seg["length"],
                "retention": "fully_copy" if copied else "reference",
                "refDesc": "the synchronized audio track of <Video %d>%s"
                           % (k + 1, ", reused in the target video" if copied else ""),
                "_soundtrack_of": k, "_trim": seg["trimStart"],
            })
        for i, a in enumerate(d["audio"]):
            audio.append({
                "id": f"audio{i}", "audioFile": a["file"], "fileName": a["file"],
                "start": 0, "length": fc, "retention": a["retention"],
                "refDesc": a["desc"], "refNote": a["note"],
                "subject": place.get(a["subject"]), "_soundtrack_of": None,
            })

    return {
        "reference_mode": "ON" if reference else "OFF",
        "prompt_format": "minimax",
        "global_prompt": _resolve(pr["global"], names, d),
        "summary": summary,
        "overall_soundscape": _final(pr["soundscape"], names, d),
        "non_diegetic_music": _final(pr["music"], names, d),
        "subjects": subjects,
        "segments": segments,
        "motionSegments": motion,
        "audioSegments": audio,
        "retakeMode": False,
        "prompt_override_on": pr["mode"] == "raw",
        "prompt_override": pr["raw"],
    }


def _task_types(p: dict) -> list[str]:
    """The official task types, from what the surviving references actually do.

    Restates the bundled planner's own rule (vendor/minimax_plan.py, GPL-3.0, see NOTICE)
    and extends it with the roles a source clip can have.
    """
    types = set()
    for s in p.get("ref_image_slots") or []:
        if s.get("source") == "timeline" and s.get("ref_role") == plan.REF_ROLE_AUTO:
            types.add(plan.TASK_KEYFRAME)
        else:
            types.add(plan.TASK_REFERENCE)
    for seg in p.get("ref_video_segs") or []:
        types.add(SOURCE_TASK.get(seg.get("_role") or "motion", plan.TASK_REFERENCE))
    for seg in p.get("ref_audio_segs") or []:
        copied = plan.sanitize_retention(seg.get("retention"), audio=True) in (
            "fully_copy", "partially_copy")
        types.add(plan.TASK_AUDIO_REUSE if copied else plan.TASK_AUDIO_REFERENCE)
    return [t for t in plan.TASK_ORDER if t in types]


def _run_planner(tl: dict, fc: int) -> dict:
    return plan.plan_timeline(
        tl, 0, fc, FPS,
        use_custom_motion=True,
        use_custom_audio=bool(tl["audioSegments"]),
        override_audio=False,
        extra_ref_image_count=0,
    )


def build_plan(doc: dict, *, probe: Probe | None = None) -> dict:
    """Plan a clip. Returns the planner's dict plus ``tasks`` and ``timeline``.

    Planned twice in the reference family: once to learn which references survive the
    official caps, and again with the task type those references add up to.
    """
    d = schema.normalize(doc)
    fc = d["derived"]["frame_count"]
    _require_soundtracks(d, probe)
    tl = to_timeline(d, probe=probe)
    p = _run_planner(tl, fc)
    tasks: list[str] = []
    # The planner trims references to the model's limits. A reference that is listed and
    # then not sent would also renumber every label after it, so anything short of
    # everything is an error here, counted rather than read off the planner's warnings.
    if d["family"] == "reference":
        wanted = {
            "images": sum(len(x["images"]) for x in d["subjects"]) + sum(
                1 for a in d["anchors"] if a["kind"] == "image" and a["cite"]),
            "videos": len(tl["motionSegments"]),
            "audio": len(tl["audioSegments"]),
        }
        sent = {"images": len(p.get("ref_image_slots") or []),
                "videos": len(p.get("ref_video_segs") or []),
                "audio": len(p.get("ref_audio_segs") or [])}
        short = ["%d of %d reference %s" % (sent[k], wanted[k], k)
                 for k in ("images", "videos", "audio") if sent[k] < wanted[k]]
        if short:
            why = " ".join(w for w in p.get("ref_warnings") or [] if "dropped" in w)
            raise ValueError("Gacha Director: more references than the model takes (only %s "
                             "would be sent). %sRemove or shorten references."
                             % (", ".join(short), why + " " if why else ""))
    if d["family"] == "reference":
        tasks = _task_types(p)
        if tasks:
            tl["task_type_override"] = " + ".join(tasks)
            p = _run_planner(tl, fc)
        # a soundtrack whose video was dropped by the caps would shift every <Audio N>
        kept = {id(s) for s in p["ref_video_segs"]}
        videos = tl["motionSegments"]
        for seg in p["ref_audio_segs"]:
            k = seg.get("_soundtrack_of")
            if k is not None and id(videos[k]) not in kept:
                raise ValueError(
                    "Gacha Director: the soundtrack of %s is cited but the video itself was "
                    "dropped by the reference limits; remove a reference video or turn "
                    "that soundtrack off" % videos[k]["videoFile"])
        cap = int(15 * FPS)
        if schema.reference_source(d) and fc > cap:
            p["ref_warnings"] = list(p.get("ref_warnings") or []) + [
                "the clip is %d frames; the source clip is shown to the model for its first %d "
                "(15 seconds), the longest reference video it takes" % (fc, cap)]
        for v in d["videos"]:
            if min(_frames_of(v["file"], probe, fc), fc) > cap:
                p["ref_warnings"] = list(p.get("ref_warnings") or []) + [
                    "%s is shown to the model for its first %d frames (15 seconds), the longest "
                    "reference video it takes" % (v["file"], cap)]
        cited = p.get("ref_image_slots") or p.get("ref_video_segs") or p.get("ref_audio_segs")
        # with nothing to refer to the planner writes the three plain fields, no summary
        if d["prompt"]["mode"] == "structured" and cited and not tl["summary"]:
            # The planner writes the task type; what the video shows is the user's to say.
            p["ref_warnings"] = list(p.get("ref_warnings") or []) + [
                "summary is empty: the reference guide expects a sentence or two after the "
                "task type, saying what the target video shows and what each reference is "
                "used for"]
    else:
        tasks = [p.get("mode") or "t2va"]
    if d["family"] == "reference":
        # the labels written into the text were counted here; the planner counts again
        promised = [r["anchor"]["file"] for r in _records(d) if "anchor" in r]
        got = [x["file"] for x in ref_images(p)][len(ref_images(p)) - len(promised):] \
            if promised else []
        if promised != got:
            raise ValueError("Gacha Director: the pictures were numbered %s but the plan sends "
                             "%s; this is a fault in the program, not in the clip"
                             % (promised, got))
    p["tasks"] = tasks
    p["timeline"] = tl
    return p


def _require_soundtracks(d: dict, probe: Probe | None) -> None:
    """A soundtrack switch on a file without sound fails deep inside the run; say it here."""
    if probe is None:
        return
    wanted = []
    if d["family"] == "reference":
        if schema.reference_source(d) and d["source"]["audio"]:
            wanted.append(d["source"]["video"])
        wanted += [v["file"] for v in d["videos"] if v["audio"]]
    wanted += [a["file"] for a in d["anchors"] if a["kind"] == "clip" and a["with_audio"]]
    for name in wanted:
        try:
            info = probe(name) or {}
        except Exception:  # noqa: BLE001 - an unprobed file is not known to be silent
            info = {}
        if info and not info.get("audio"):
            raise ValueError("Gacha Director: %s has no audio track, but its soundtrack is "
                             "switched on. Turn the soundtrack off for that file." % name)


# --------------------------------------------------------------------------- loading plan
def ref_images(p: dict) -> list[dict]:
    """[{"file", "keyframe"}] in ``<Picture N>`` order.

    ``keyframe`` marks a picture that stands for a frame of the target (first, last): those
    are fitted to the canvas. A subject image is left at its own size; the conditioning
    node scales it.
    """
    out = []
    for slot in p.get("ref_image_slots") or []:
        source = slot.get("source")
        if source == "char":
            img = slot.get("image") or {}
            name = img.get("file") or img.get("name") or ""
            keyframe = False
        elif source == "timeline":
            seg = (slot.get("event") or {}).get("seg") or {}
            name = seg.get("imageFile") or seg.get("fileName") or ""
            keyframe = bool(slot.get("keyframe"))
        else:
            raise ValueError("Gacha Director: the plan asked for a '%s' reference image, "
                             "which this package does not produce" % source)
        if not name:
            raise ValueError("Gacha Director: a reference image has no file name")
        out.append({"file": name, "keyframe": keyframe})
    return out


def ref_videos(p: dict) -> list[dict]:
    """[{"file", "start", "length", "audio"}] in ``<Video N>`` order."""
    return [{"file": seg.get("videoFile") or "", "start": int(seg.get("trimStart") or 0),
             "length": int(seg.get("length") or 0), "audio": bool(seg.get("_audio"))}
            for seg in p.get("ref_video_segs") or []]


def ref_audio(p: dict) -> list[dict]:
    """Standalone reference audio, [{"file"}], in the order core will label it."""
    return [{"file": seg.get("audioFile") or ""}
            for seg in p.get("ref_audio_segs") or [] if seg.get("_soundtrack_of") is None]


def keyframe_files(p: dict) -> tuple[str, str]:
    """Base family: the cited first and last frame, ("", "") where there is none."""
    first = last = ""
    for ev in p.get("events") or []:
        name = (ev.get("seg") or {}).get("imageFile") or ""
        if ev.get("role") == plan.ROLE_FIRST and not first:
            first = name
        elif ev.get("role") == plan.ROLE_LAST and not last:
            last = name
    return first, last


def guides(doc: dict) -> list[dict]:
    """Anchors that become Add Guide nodes, in frame order.

    In the base family a cited first or last image goes through the conditioning node's
    own first/last inputs instead (which also shows it to the text encoder), so it is not
    a guide. Everything else that is pinned is.
    """
    d = schema.normalize(doc)
    fc = d["derived"]["frame_count"]
    out = []
    for a in d["anchors"]:
        if not a["pin"]:
            continue
        f = schema.resolved_frame(a, fc)
        if d["family"] == "base" and a["kind"] == "image" and a["cite"] and f in (0, fc - 1):
            continue
        out.append({"kind": a["kind"], "file": a["file"], "frame": f,
                    "clip_start": a["clip_start"], "clip_length": a["clip_length"],
                    "with_audio": a["with_audio"]})
    return out


def canvas(doc: dict, params: dict, probe: Probe | None = None) -> tuple[int, int]:
    """(width, height) for this clip under a preset's megapixel budget."""
    d = schema.normalize(doc)
    size = None
    if d["source"]["video"] and probe is not None:
        try:
            info = probe(d["source"]["video"]) or {}
            if info.get("width") and info.get("height"):
                size = (int(info["width"]), int(info["height"]))
        except Exception:  # noqa: BLE001 - an unreadable source just means 16:9
            size = None
    return grid.canvas_size(d["clip"]["aspect"], float(params.get("megapixels") or 0.4), size)


def report(doc: dict, p: dict | None = None, extra: list[str] | None = None) -> str:
    d = schema.normalize(doc)
    lines = ["Gacha Director — run", schema.summary(d)]
    if p is not None:
        if p.get("tasks"):
            lines.append("task: " + " + ".join(p["tasks"]))
        refs = ["<Picture %d> %s" % (i + 1, x["file"]) for i, x in enumerate(ref_images(p))
                ] if d["family"] == "reference" else []
        refs += ["<Video %d> %s" % (i + 1, x["file"]) for i, x in enumerate(ref_videos(p))]
        if refs:
            lines.append("labels: " + ", ".join(refs))
        for w in p.get("ref_warnings") or []:
            lines.append("note: " + w)
    if extra:
        lines += [""] + [x for x in extra if x]
    return "\n".join(lines)


def timeline_json(p: dict) -> str:
    """The compiled timeline, with the adapter's private keys left out."""
    def clean(obj):
        if isinstance(obj, dict):
            return {k: clean(v) for k, v in obj.items() if not str(k).startswith("_")}
        if isinstance(obj, list):
            return [clean(x) for x in obj]
        return obj
    return json.dumps(clean(p.get("timeline") or {}), ensure_ascii=False)
