"""Gacha Director — a director console for MiniMax H3. The one node.

Loaders in, video out, one node on the canvas. It works by **node expansion**: ``run()``
builds a subgraph with ``GraphBuilder`` and returns it, so stock ComfyUI nodes do the
actual work and every stage caches on its own. Nothing about sampling is reimplemented.
(The expansion approach, parts of the node declaration, the memory hand-off wiring and
several comments follow Thefrizzy1's ComfyUI-MiniMaxH3-Director, Apache-2.0; modified. See
NOTICE.)

    conditioning   MiniMaxH3ImageToVideo or MiniMaxH3ReferenceToVideo, + MiniMaxH3AddGuide
    model          MiniMaxH3SigmaShift, + the live preview
    start          the conditioning node's empty latent, or a clip encoded into it
                   (VAEEncode + LTXVConcatAVLatent) with a time mask (SetLatentNoiseMask)
    sampling       SamplerCustomAdvanced with BasicGuider (cfg 1) or CFGGuider
    output         VAEDecode, VAEDecodeAudio, CreateVideo, SaveVideo

What it adds is the part around that chain: one clip document that covers every official
way of driving the model (see gd_schema), run presets that remember what they cost, and a
takes page that renders candidates, lets each segment pick one and composites the picks.

Four widgets hold JSON: ``gd_timeline`` (the clip), ``gd_post`` (preview and save),
``gd_presets`` (run settings and their timings) and ``gd_takes`` (candidates and picks).
``seed`` stays a real widget because it is a per-run value and because that is where
control_after_generate lives.

Editing this file has no effect until ComfyUI is restarted — it imports Python once.
"""

from __future__ import annotations

import hashlib
import json
import logging

from . import gd_compile as compile_
from . import gd_grid as grid
from . import gd_h3 as h3
from . import gd_preview
from . import gd_internal as internal
from . import gd_post as post
from . import gd_presets as presets
from . import gd_schema as schema

log = logging.getLogger("GachaDirector")

# Widgets are positional in a saved workflow. NEW WIDGETS GO ON THE END, never in the
# middle — inserting one shifts every saved value after it by one slot and the workflow
# still opens, it just renders with the wrong settings. tests/test_widget_order.py pins
# this order.
WIDGET_ORDER = (
    "gd_timeline", "gd_post", "gd_presets",
    "gdg_run", "preset", "seed", "gd_metrics",
    "gd_takes",
)

#: Group headers. The ``GDGROUP`` type is drawn by web/gd_director.js; Python only names them.
GROUPS = {
    "gdg_run": "Run",
}

PREVIEW_DECODE_FAST = "latent2rgb (fast)"


def _parse_doc(doc_json: str) -> dict:
    try:
        d = json.loads(doc_json) if (doc_json or "").strip() else {}
    except Exception as exc:
        raise ValueError(f"gd_timeline is not valid JSON: {exc}")
    return schema.normalize(d)


def _parse_post(post_json: str) -> dict:
    try:
        c = json.loads(post_json) if (post_json or "").strip() else {}
    except Exception:
        c = {}                     # a broken output config must not block a render
    return post.normalize(c)


def _parse_presets(presets_json: str, active: str = "") -> dict:
    """The preset store, with the node's own selector winning over the stored ``active``."""
    try:
        raw = json.loads(presets_json) if (presets_json or "").strip() else {}
    except Exception:
        raw = {}
    store = presets.normalize(raw)
    sel = str(active or "").strip()
    if sel and any(p["id"] == sel for p in store["presets"]):
        store["active"] = sel
    return store


def _probe(name: str) -> dict:
    try:
        from . import gd_routes
        return gd_routes.probe(name)
    except Exception:  # noqa: BLE001 - an unknown file is simply unprobed
        return {}


def _size(name: str):
    info = _probe(name)
    if info.get("width") and info.get("height"):
        return int(info["width"]), int(info["height"])
    return None


def file_marks(timeline: str, post_cfg: str = "", resolve=None) -> str:
    """Every file the document and the post settings name, each with when it was written
    and how big it is.

    What this node returned is kept for as long as its inputs are the same, and the nodes
    it expands into (which do look at their files) are then not even built. A file written
    again under its name is another input: without this, the same seed run again returns
    the clip made from the file as it was. ``resolve(name, folder)`` gives the path;
    a file that is not there is marked as missing.
    """
    import os  # noqa: PLC0415

    if resolve is None:
        from . import gd_frames  # noqa: PLC0415
        resolve = gd_frames.resolve

    def parsed(text):
        try:
            v = json.loads(text or "{}")
        except (TypeError, ValueError):
            return {}
        return v if isinstance(v, dict) else {}

    def listed(v):
        return v if isinstance(v, list) else []

    d, c = parsed(timeline), parsed(post_cfg)
    names = []
    src = d.get("source") if isinstance(d.get("source"), dict) else {}
    names.append((src.get("video"), "input"))
    names += [(p.get("file"), "output") for p in listed(src.get("splice")) if isinstance(p, dict)]
    for key in ("subjects", "videos", "audio", "anchors"):
        for it in listed(d.get(key)):
            if isinstance(it, dict):
                names.append((it.get("file"), "input"))
                # pictures: a list of names, one name, or entries with a "file" (gd_schema._norm_subject)
                images = it.get("images")
                for im in ([images] if isinstance(images, (str, dict)) else listed(images)):
                    names.append((im.get("file") if isinstance(im, dict) else im, "input"))
            else:
                names.append((it, "input"))            # the short form: just the file
    if isinstance(c.get("face"), dict):
        names.append((c["face"].get("file"), "output"))
    marks = []
    for name, folder in names:
        if not isinstance(name, str) or not name.strip():
            continue
        try:
            st = os.stat(resolve(name, folder))
            marks.append("%s:%d:%d" % (name, st.st_mtime_ns, st.st_size))
        except Exception:  # noqa: BLE001 - not there, or no ComfyUI to say where it would be
            marks.append("%s:-" % name)
    return "|".join(marks)


class GachaDirector:
    """A director console for MiniMax H3: one node, any way of driving the model."""

    CATEGORY = "GachaDirector"
    FUNCTION = "run"
    #: It saves a video and reports on the run, so it is an end point of the graph: loaders
    #: and this node are a complete workflow, with nothing wired to its outputs.
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "IMAGE",
                    "LATENT", "CONDITIONING", "MODEL", "STRING", "STRING")
    RETURN_NAMES = ("frames", "audio", "fps", "frame_count", "source_frames",
                    "latent", "positive", "model", "prompt", "run_report")
    DESCRIPTION = (
        "Director console for MiniMax H3. Open the panel for the clip (prompt, shots, "
        "anchors, references, source), the run presets, the takes and the results. "
        "Emits the whole chain as a subgraph of stock nodes. Loaders stay outside and "
        "wire in; this node loads no model itself.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "MiniMax H3 diffusion model: ref2va for the "
                                               "reference family, fl2va for the base family."}),
                "clip": ("CLIP", {"tooltip": "CLIPLoader with type 'minimax'."}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 audio VAE."}),

                "gd_timeline": ("STRING", {
                    "multiline": True, "default": "{}",
                    "tooltip": "Managed by the panel: the clip document."}),
                "gd_post": ("STRING", {
                    "multiline": True, "default": "{}",
                    "tooltip": "Managed by the panel: live preview and save settings."}),
                "gd_presets": ("STRING", {
                    "multiline": True, "default": "{}",
                    "tooltip": "Managed by the panel: run presets and their measured "
                               "timings."}),

                "gdg_run": ("GDGROUP", {"default": GROUPS["gdg_run"]}),
                "preset": ("GDPRESET", {
                    "default": "",
                    "tooltip": "Which preset this run uses. The numbers live on the "
                               "panel's run page; this only selects one."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                                 "control_after_generate": True,
                                 "tooltip": "Per-run value, deliberately not part of a "
                                            "preset."}),
                "gd_metrics": ("GDMETRICS", {
                    "default": "",
                    "tooltip": "Read-only: canvas, frames, steps, and what this preset "
                               "has cost before."}),
                "gd_takes": ("STRING", {
                    "multiline": True, "default": "{}",
                    "tooltip": "Managed by the panel's takes page: which renders exist "
                               "and which one each segment picked. The run itself never "
                               "reads this."}),
            },
            "optional": {
                "model_turbo": ("MODEL", {
                    "tooltip": "A distilled / turbo-LoRA version of the same model. Used "
                               "by presets whose model is set to 'turbo'."}),
                "sampler": ("SAMPLER", {"tooltip": "Overrides the preset's sampler when "
                                                   "connected."}),
                "sigmas": ("SIGMAS", {"tooltip": "Overrides the preset's scheduler and "
                                                 "steps when connected."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, gd_timeline="{}", gd_post="{}", gd_presets="{}", preset="", **kwargs):
        # A hash, never a bool: True == True reads as "unchanged".
        #
        # Only the ACTIVE preset's parameters go in, not the whole store: the timing
        # history lives in gd_presets and grows after every run, so hashing the store
        # would invalidate the cache on every recorded timing.
        h = hashlib.sha256()
        h.update((gd_timeline or "").encode("utf-8"))
        h.update(b"\x00")
        h.update((gd_post or "").encode("utf-8"))
        h.update(b"\x00")
        try:
            p = presets.active_preset(_parse_presets(gd_presets, preset))
            h.update(json.dumps(p["params"], sort_keys=True).encode("utf-8"))
        except Exception:
            h.update((gd_presets or "").encode("utf-8"))
        h.update(b"\x00")
        h.update(file_marks(gd_timeline, gd_post).encode("utf-8"))
        return h.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, gd_timeline="{}", **kw):
        # Only widget constants are visible here; cheap checks that save a long render.
        try:
            d = _parse_doc(gd_timeline)
        except ValueError as exc:
            return str(exc)
        found = schema.problems(d)
        if found:
            return "Gacha Director: " + "; ".join(found)
        return True

    # ------------------------------------------------------------------ run
    def run(self, model, clip, vae, audio_vae, gd_timeline="{}", gd_post="{}",
            gd_presets="{}", gdg_run=None, preset="", seed=0, gd_metrics="",
            gd_takes="{}", model_turbo=None, sampler=None, sigmas=None, unique_id=None):
        from comfy_execution.graph_utils import GraphBuilder  # ComfyUI only

        d = _parse_doc(gd_timeline)
        cfgp = _parse_post(gd_post)
        store = _parse_presets(gd_presets, preset)
        params = presets.active_params(store)
        src, mask, dv = d["source"], d["mask"], d["derived"]
        length = dv["frame_count"]
        latent_source = dv["latent_source"]
        pv, sv, face = cfgp["preview"], cfgp["save"], cfgp["face"]
        # Face refine is a run of its own: the document describes the face, and the latent
        # it starts from is the region of a finished clip the face is in.
        refining = bool(face["file"])
        short = 0          # a clip to refine that is shorter than this run: its real length
        if refining:
            if latent_source != "empty" or d["anchors"]:
                raise ValueError("Gacha Director: a face refine run takes a document with no "
                                 "source clip and nothing held on a frame")
            latent_source = "face"
            # the clip as it is on disk: its length has to be this run's, and it may be silent
            clip_info = _probe("%s [output]" % face["file"])
            have = int(clip_info.get("frames24") or clip_info.get("frames") or 0)
            # A clip cut together from several takes can be a few frames short of the
            # document's length (what its cuts cost). It is refined with its last frame
            # held to the end and comes out as long as it went in.
            if have and (have > length or length - have > grid.CELL):
                raise ValueError(
                    "Gacha Director: the clip to refine (%s) has %d frames, but this run is "
                    "for %d" % (face["file"], have, length))
            short = have if have and have < length else 0

        if params["model"] == "turbo":
            if model_turbo is None:
                raise ValueError(
                    "Gacha Director: the preset \"%s\" runs on the turbo model, but nothing "
                    "is connected to model_turbo. Wire the model through its turbo LoRA "
                    "into model_turbo, or set the preset's model to 'main'."
                    % presets.active_preset(store)["name"])
            base_model = model_turbo
        else:
            base_model = model

        width, height = compile_.canvas(d, params, _probe)
        steps, cfg = int(params["steps"]), float(params["cfg"])
        # A clip in the latent is re-noised as far as the user set; the seam cells of a
        # composite have their own strength; an empty latent is all noise.
        denoise = {"source": float(src["denoise"]), "splice": float(mask["seam_denoise"]),
                   "empty": 1.0,
                   "face": post.denoise_for(face["strength"], params["shift_video"]),
                   }[latent_source]

        plan = compile_.build_plan(d, probe=_probe)

        g = GraphBuilder()

        # --- conditioning -----------------------------------------------------------
        positive, empty_latent = h3.emit(
            g, d, plan, clip=clip, vae=vae, audio_vae=audio_vae,
            width=width, height=height, probe_size=_size,
            ref_video_edge=int(params["ref_video_edge"]),
            ref_image_size=params["ref_image_size"])

        # --- model ------------------------------------------------------------------
        sampling_model = g.node(
            "MiniMaxH3SigmaShift", model=base_model,
            shift_video=float(params["shift_video"]),
            shift_audio=float(params["shift_audio"])).out(0)
        shifted_model = sampling_model
        if pv["enabled"] and gd_preview.AVAILABLE:
            sampling_model = g.node(
                "GachaDirectorPreview", model=sampling_model, vae=vae,
                decode=PREVIEW_DECODE_FAST, preview_target="node",
                max_resolution=int(pv["max_resolution"]), preview_frames=24,
                preview_fps=24.0, webp_quality=int(pv["jpeg_quality"]),
                every_n_steps=int(pv["preview_every"]), max_preview_overhead=25,
                suppress_default_preview=True, playback="true speed").out(0)

        # --- where the sampler starts -----------------------------------------------
        source_frames = None
        source_audio = None
        latent = empty_latent
        whole = region = drops = None
        # A composite whose joins are all cuts is made without the model: nothing of it is
        # rendered again, so nothing is sampled.
        # (an experiment may name the latent frames itself: the document key x_free_latents)
        free_latents = str(d.get("x_free_latents") or "") or ",".join(str(t) for t in dv["free_latents"])
        cut_only = latent_source == "splice" and not free_latents
        if refining:
            # The finished clip at its own size, the face found in it, and the cut-outs of
            # that region at the size this run works at.
            whole = g.node("GachaDirectorLoadFrames", file=face["file"], source="output",
                           start=0, length=int(length), width=0, height=0,
                           resize="canvas").out(0)
            region = g.node("GachaDirectorFaceTrack", frames=whole, cuts=face["cuts"],
                            shots=face["shots"], padding=float(face["padding"]),
                            min_score=float(face["min_score"]))
            source_frames = g.node("GachaDirectorCropRegion", frames=whole, region=region.out(0),
                                   width=int(width), height=int(height)).out(0)
        elif latent_source == "splice":
            # Composite: the picks laid out on the clip's frames, read from output/ —
            # picture and sound alike, so what was picked is what is kept. Two takes that
            # meet at a cut are joined where they really cut; what that costs in frames is
            # left out at the very end. Without a render the takes keep their own size.
            spliced = g.node(
                "GachaDirectorCutSplice", pieces=json.dumps(src["splice"]), length=int(length),
                width=0 if cut_only else int(width), height=0 if cut_only else int(height),
                **({"dissolve": json.dumps(d["x_seam_dissolve"])} if d.get("x_seam_dissolve") else {}))
            source_frames, source_audio, drops = spliced.out(0), spliced.out(1), spliced.out(2)
        elif latent_source == "source":
            source_frames = g.node(
                "GachaDirectorLoadFrames", file=src["video"], source="input",
                start=int(src["start"]), length=int(length),
                width=int(width), height=int(height), resize="canvas").out(0)
            # The clip's own sound only matters when part of the clip is kept as it is.
            if mask["mode"] != "whole_clip" and _probe(src["video"]).get("audio"):
                source_audio = h3.track(g, src["video"], src["start"], length)
        if source_frames is not None and not cut_only:
            # The clip's own latent in the video stream, the conditioning node's empty
            # audio in the audio stream: core's Separate/Concat keep the layout the model
            # expects, whatever it is.
            video_latent = g.node("VAEEncode", pixels=source_frames, vae=vae).out(0)
            empty_audio = g.node("LTXVSeparateAVLatent", av_latent=empty_latent).out(1)
            masked = mask["mode"] != "whole_clip"
            audio_latent = None
            if masked and source_audio is not None:
                audio_latent = g.node("VAEEncodeAudio", audio=source_audio, vae=audio_vae).out(0)
            if masked:
                # the cells are the document's own (a seam inside a long take frees fewer
                # than its radius says: see gd_schema), so they are handed over as they are
                tmask = g.node(
                    "GachaDirectorTimeMask", length=length, mode="free_cells",
                    cells=",".join(str(c) for c in dv["free_cells"]), cut_frames="",
                    radius=int(mask["radius"]),
                    latents=free_latents,
                    **({"keep": drops} if drops is not None else {}),
                    **({"audio_latent": audio_latent} if audio_latent is not None else {}))
                video_latent = g.node("SetLatentNoiseMask", samples=video_latent,
                                      mask=tmask.out(0)).out(0)
            latent = g.node("LTXVConcatAVLatent", video_latent=video_latent,
                            audio_latent=empty_audio).out(0)
            if audio_latent is not None:
                # Pinned cells keep their sound too. Concatenating onto the AV latent
                # (rather than onto the bare video latent) is what trims or pads the
                # encoded track to the exact length the model expects.
                audio_latent = g.node("SetLatentNoiseMask", samples=audio_latent,
                                      mask=tmask.out(1)).out(0)
                latent = g.node("LTXVConcatAVLatent", video_latent=latent,
                                audio_latent=audio_latent).out(0)

        # --- VRAM hand-off before the DiT loads --------------------------------------
        stage = internal.should_stage(params["vram_staging"], internal.total_vram_bytes())
        cond = positive
        if stage:
            gate = g.node("GachaDirectorFreeMemory", latent=latent, conditioning=positive,
                          stage="sampling")
            latent, cond = gate.out(0), gate.out(1)

        # --- sampling ---------------------------------------------------------------
        # The official templates sample with BasicGuider: one conditioning, no negative
        # branch. Any other cfg needs a second conditioning to push away from.
        noise = g.node("RandomNoise", noise_seed=int(seed)).out(0)
        if cfg == 1.0:
            guider = g.node("BasicGuider", model=sampling_model, conditioning=cond).out(0)
        else:
            negative = g.node("CLIPTextEncode", clip=clip,
                              text=d["prompt"]["negative"]).out(0)
            guider = g.node("CFGGuider", model=sampling_model, positive=cond,
                            negative=negative, cfg=cfg).out(0)
        sig = sigmas if sigmas is not None else g.node(
            "BasicScheduler", model=sampling_model, scheduler=params["scheduler"],
            steps=steps, denoise=denoise).out(0)
        smp = sampler if sampler is not None else g.node(
            "KSamplerSelect", sampler_name=params["sampler_name"]).out(0)
        final_latent = latent if cut_only else g.node(
            "SamplerCustomAdvanced", noise=noise, guider=guider,
            sampler=smp, sigmas=sig, latent_image=latent).out(0)

        # --- decode -----------------------------------------------------------------
        decode_latent = final_latent
        if stage and not cut_only:
            decode_latent = g.node("GachaDirectorFreeMemory", latent=final_latent,
                                   stage="VAE decode").out(0)
        if cut_only:
            frames, audio = source_frames, source_audio
        else:
            frames = g.node("VAEDecode", samples=decode_latent, vae=vae).out(0)
        if refining:
            # Only the region comes from this run: it goes back into the clip it was cut
            # from, and the clip keeps the sound it had.
            frames = g.node("GachaDirectorPasteRegion", frames=whole, crops=frames,
                            region=region.out(0), feather=float(face["feather"])).out(0)
            if short:
                frames = g.node("ImageFromBatch", image=frames, batch_index=0,
                                length=int(short)).out(0)
        if cut_only:
            pass
        elif refining and (clip_info.get("audio") or not clip_info):
            audio = h3.track(g, "%s [output]" % face["file"], 0, short or length)
        else:
            # (also a clip without a soundtrack: what this run generated stands in for it)
            audio = g.node("VAEDecodeAudio", samples=decode_latent, vae=audio_vae).out(0)
            if refining and short:
                audio = g.node("TrimAudioDuration", audio=audio, start_index=0.0,
                               duration=short / 24.0).out(0)
        frame_count = short or length
        if drops is not None:
            # what the cuts between takes cost, left out of picture and sound alike; the
            # node also records what was done at every join
            done = g.node("GachaDirectorDropFrames", frames=frames, audio=audio, drops=drops)
            frames, audio, frame_count = done.out(0), done.out(1), done.out(2)

        # --- save -------------------------------------------------------------------
        if sv["auto_save"]:
            video = g.node("CreateVideo", images=frames, audio=audio, fps=24.0).out(0)
            g.node("SaveVideo", video=video, filename_prefix=sv["filename_prefix"],
                   format=sv["format"], codec=sv["codec"])

        # What was really sampled with. A wired schedule replaces the preset's steps and
        # scheduler and the denoise; a wired sampler replaces the preset's sampler.
        sampler_name = "external sampler" if sampler is not None else params["sampler_name"]
        if sigmas is not None:
            try:
                sampling = "external sigmas (%d steps)" % max(len(sigmas) - 1, 0)
            except TypeError:
                sampling = "external sigmas"
            sampling += "  cfg %s  %s" % (cfg, sampler_name)
        elif cut_only:
            sampling = "nothing sampled (every join is a cut)"
        else:
            sampling = "%d steps  cfg %s  denoise %s  %s/%s" % (
                steps, cfg, denoise, sampler_name, params["scheduler"])
        run_report = compile_.report(d, plan, extra=[
            "canvas %dx%d  %s  seed %d" % (width, height, sampling, int(seed)),
            ("sigmas input wired: the preset's steps and scheduler and the denoise settings "
             "were not used." if sigmas is not None else ""),
            "preset: " + presets.summary(store, length),
            ("face refine: %s, the face cut out at %.1f face sizes, generated again at "
             "%dx%d from %s, edges blended over %d%%"
             % (face["file"], face["padding"], width, height,
                "the wired sigmas (the strength setting is not used)" if sigmas is not None
                else "%d%% noise" % round(face["strength"] * 100),
                round(face["feather"] * 100))
             if refining else ""),
            "composite: " + " | ".join(
                "%s%d+%d <- %s" % ("~" if p_["join"] == "continuous" else
                                   "^" if p_["sound"] == "continuous" else "", p_["start"],
                                   p_["length"], p_["file"])
                for p_ in src["splice"]) if src["splice"] else "",
            ("composite: a shot marked ~ continues the one before it; where two takes meet "
             "inside such a long take the cells around the join are rendered again, and "
             "where they meet at a cut they are put one after the other as they are. A shot "
             "marked ^ is cut to with the sound going on: the sound stays with the take it "
             "was with"
             if src["splice"] else ""),
            "output: " + post.summary(cfgp),
            ("VRAM staging: on (free-memory hand-offs before sampler and VAE)."
             if stage else ""),
        ])

        if refining:
            run_report = run_report.replace(
                "start: empty latent", "start: the region of %s its main face is in" % face["file"])

        return {
            # The node's own record of the run. It lands in ComfyUI's history under this
            # node's id, which is where the results page reads it.
            "ui": {"gd_report": [run_report], "gd_prompt": [plan["prompt"]]},
            # A link here is run, wired on or not. A composite of cuts renders nothing, so
            # it hands on no latent and no conditioning (computing them would load the text
            # encoder for a clip that is only cut together), and the model as it came in.
            "result": (frames, audio, 24.0, frame_count,
                       source_frames if source_frames is not None else frames,
                       None if cut_only else final_latent,
                       None if cut_only else positive,
                       base_model if cut_only else shifted_model,
                       plan["prompt"], run_report),
            "expand": g.finalize(),
        }
