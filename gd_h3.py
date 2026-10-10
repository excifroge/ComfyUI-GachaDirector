"""Gacha Director — the conditioning stage, built from ComfyUI's own MiniMax H3 nodes.

Everything this module emits is ComfyUI core, plus this package's frame loader:

    MiniMaxH3ImageToVideo      base family: prompt (+ first / last frame) -> conditioning
    MiniMaxH3ReferenceToVideo  reference family: prompt + <Picture/Video/Audio N>
    MiniMaxH3AddGuide          an image, a clip or audio pinned at any frame
    LoadImage / ImageScale / LoadAudio / TrimAudioDuration

The order references are wired in is the order the prompt numbers them in, and it comes
from the plan (gd_compile) and nowhere else: ``<Picture 1>`` is whatever sits first in the
plan's list, and the prompt text says so.

The reference sockets are named with a DOT: ``ref_images.ref_image_0``, not
``ref_image_0``. Core declares them through ``io.Autogrow`` and the executor folds the
dotted keys back into the dict the node's ``execute()`` takes. The flat spelling passes
validation and then fails at execution with "unexpected keyword argument", which is why
tests/test_expand.py pins the dotted form.
"""

from __future__ import annotations

import logging

from . import gd_compile as compile_

log = logging.getLogger("GachaDirector")

FPS = 24.0

#: A reference video is VAE-encoded whole and then rides through every sampling step, so
#: its size is the largest single lever on speed and memory. This is the model's own bound
#: (768 px short edge, 768 x 1344 area); a preset can lower the edge further.
REF_VIDEO_SHORT_EDGE = 768
REF_VIDEO_ASPECT = 1344 / 768.0


def ref_video_size(width: int, height: int, edge: int = 0):
    """Aspect-preserving decode size for a reference video.

    Adapted from seesee75's ComfyUI-MiniMaxH3-Director (minimax_media._decode_target_size,
    GPL-3.0); modified. See NOTICE.

    Short edge at most ``edge`` (0 = the model's 768), area at most edge * edge * 1.75.
    Returns (0, 0) when the clip already fits, which tells the loader to keep the file's
    own size — no resample, so a clip that is already small stays untouched.
    """
    import math
    w, h = int(width or 0), int(height or 0)
    if w <= 0 or h <= 0:
        return 0, 0
    cap = int(edge) if edge and int(edge) > 0 else REF_VIDEO_SHORT_EDGE
    cap = min(cap, REF_VIDEO_SHORT_EDGE)
    scale = min(1.0, cap / max(1, min(w, h)))
    max_pixels = cap * cap * REF_VIDEO_ASPECT
    if w * h * scale * scale > max_pixels:
        scale = math.sqrt(max_pixels / float(w * h))
    if scale >= 1.0:
        return 0, 0
    return max(16, int(round(w * scale)) // 2 * 2), max(16, int(round(h * scale)) // 2 * 2)


def _seconds(frames: int) -> float:
    return round(int(frames) / FPS, 4)


def _fit_to_canvas(g, image, width, height):
    """Centre cover-crop to the canvas, so a frame of another aspect is cropped, not bent."""
    return g.node("ImageScale", image=image, width=int(width), height=int(height),
                  upscale_method="lanczos", crop="center").out(0)


def track(g, file: str, start: int, length: int):
    """A file's soundtrack, trimmed to a frame range counted at 24 fps."""
    audio = g.node("LoadAudio", audio=file).out(0)
    if start > 0 or length > 0:
        audio = g.node("TrimAudioDuration", audio=audio, start_index=_seconds(start),
                       duration=_seconds(length) if length > 0 else 3600.0).out(0)
    return audio


def emit(g, doc, p, *, clip, vae, audio_vae, width, height, probe_size,
         ref_video_edge=0, ref_image_size="match"):
    """Emit the conditioning for one clip. Returns (positive, empty_av_latent).

    ``doc`` is the normalized document and ``p`` the plan from gd_compile.build_plan.
    ``probe_size(name)`` returns (w, h) for a file in input/, or None when it cannot say;
    it decides how far a reference video has to come down.
    """
    fc = int(doc["derived"]["frame_count"])

    if doc["family"] == "reference":
        refs = {}
        for i, item in enumerate(compile_.ref_images(p)):
            img = g.node("LoadImage", image=item["file"]).out(0)
            if item["keyframe"]:
                img = _fit_to_canvas(g, img, width, height)
            refs["ref_images.ref_image_%d" % i] = img
        for i, item in enumerate(compile_.ref_videos(p)):
            rw, rh = ref_video_size(*(probe_size(item["file"]) or (0, 0)), edge=ref_video_edge)
            refs["ref_videos.ref_video_%d" % i] = g.node(
                "GachaDirectorLoadFrames", file=item["file"], source="input",
                start=int(item["start"]), length=int(item["length"]),
                width=int(rw), height=int(rh), resize="decode").out(0)
            if item["audio"]:
                refs["ref_video_audios.ref_video_audio_%d" % i] = track(
                    g, item["file"], item["start"], item["length"])
        for i, item in enumerate(compile_.ref_audio(p)):
            sound = g.node("LoadAudio", audio=item["file"]).out(0)
            if item["first"] > 0:
                # longer than the model takes: its first seconds (gd_compile.build_plan says so)
                sound = g.node("TrimAudioDuration", audio=sound, start_index=0.0,
                               duration=float(item["first"])).out(0)
            refs["ref_audios.ref_audio_%d" % i] = sound
        cs = g.node("MiniMaxH3ReferenceToVideo", clip=clip, vae=vae, audio_vae=audio_vae,
                    prompt=p["prompt"], width=int(width), height=int(height),
                    length=fc, ref_image_size=ref_image_size, **refs)
    else:
        first, last = compile_.keyframe_files(p)
        frames = {}
        if first:
            # the node stretches the first frame to the canvas; cropping first keeps it
            # undistorted and is a no-op when the aspect already matches
            frames["first_frame"] = _fit_to_canvas(
                g, g.node("LoadImage", image=first).out(0), width, height)
        if last:
            frames["last_frame"] = _fit_to_canvas(
                g, g.node("LoadImage", image=last).out(0), width, height)
        cs = g.node("MiniMaxH3ImageToVideo", clip=clip, vae=vae, prompt=p["prompt"],
                    width=int(width), height=int(height), length=fc, **frames)

    positive, latent = cs.out(0), cs.out(1)

    # Add Guide only reads the latent for its size and length and only returns a new
    # positive, so every guide shares the conditioning node's own empty latent and the
    # positives chain in series.
    for gd in compile_.guides(doc):
        kw = {"positive": positive, "latent": latent, "frame_idx": int(gd["frame"])}
        if gd["kind"] == "image":
            kw["vae"] = vae
            kw["image"] = g.node("LoadImage", image=gd["file"]).out(0)
        elif gd["kind"] == "clip":
            kw["vae"] = vae
            kw["image"] = g.node(
                "GachaDirectorLoadFrames", file=gd["file"], source="input",
                start=int(gd["clip_start"]), length=int(gd["clip_length"]),
                width=int(width), height=int(height), resize="canvas").out(0)
            if gd["with_audio"]:
                kw["audio_vae"] = audio_vae
                kw["audio"] = track(g, gd["file"], gd["clip_start"], gd["clip_length"])
        else:
            kw["audio_vae"] = audio_vae
            kw["audio"] = g.node("LoadAudio", audio=gd["file"]).out(0)
        positive = g.node("MiniMaxH3AddGuide", **kw).out(0)

    return positive, latent
