"""Gacha Director — small runtime nodes the expansion emits.

These exist because ``run()`` only *builds* the graph; it does not execute it. Anything
that must happen *between* two stages (build a mask tensor, hand memory back) has to be a
real node in the emitted subgraph so it is a data dependency and happens at the right
moment.

They are registered so the emitted graph can name them, and they live under
``GachaDirector/internal`` so nobody mistakes them for the operating surface.

The free-memory node, ``should_stage`` and ``total_vram_bytes`` are adapted from
Thefrizzy1's ComfyUI-MiniMaxH3-Director (freemem.py, Apache-2.0); modified. See NOTICE.
"""

from __future__ import annotations

import logging

from . import gd_grid as grid

log = logging.getLogger("GachaDirector")


class GachaDirectorTimeMask:
    """Time mask on the H3 latent grid, for the video stream and for the audio stream.

    WHITE (1) = free to denoise, BLACK (0) = pinned to the source latent. Core ComfyUI
    resamples a mask onto the latent it is attached to, evenly, and the latent's time axis
    is not even (a cell is one latent frame for its first pixel frame and four more for
    the other sixteen). So both masks are built at the size of the latent they go on —
    one image per latent frame, one column per audio-latent frame — and core has nothing
    left to resample in time. A mask built per pixel frame leaks into the neighbouring
    cell: its nearest latent frame comes out half free.

    ``audio_latent`` is the encoded track the audio mask will be attached to. Its length
    is the track's own, which need not be the clip's, and the mask has to match it.

    A mask attached to the packed AV latent only reaches the video stream — the sampler
    leaves a stream without a mask fully free. To pin sound as well, each stream gets its
    own mask before the two are concatenated.
    """

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("MASK", "MASK", "STRING")
    RETURN_NAMES = ("mask", "audio_mask", "report")
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17}),
            "mode": (list(("whole_clip", "free_cells", "seam_repair")), {"default": "whole_clip"}),
            "cells": ("STRING", {"default": ""}),
            "cut_frames": ("STRING", {"default": ""}),
            "radius": ("INT", {"default": 1, "min": 1, "max": 4}),
        }, "optional": {"audio_latent": ("LATENT",), "keep": ("GD_DROPS",),
                        "latents": ("STRING", {"default": ""})}}

    def build(self, length, mode, cells, cut_frames, radius, audio_latent=None, keep=None,
              latents=""):
        g = grid.make_grid(length)
        if mode == "whole_clip":
            free = list(range(g["cell_count"]))
        elif mode == "seam_repair":
            cuts = [int(x) for x in str(cut_frames).replace(" ", "").split(",") if x]
            if not cuts:
                raise ValueError("seam_repair needs at least one cut frame")
            free = grid.seam_cells(cuts, g, radius=int(radius))
        else:
            free = grid.parse_cells(cells, g)
        # The mask is made of latent frames. They are the cells' own, or, when the caller
        # names them ("18-21,30"), exactly those: a seam with a range of its own frees less
        # than whole cells.
        n = g["cell_count"]
        named = grid.parse_latents(latents, g["latent_t"])
        free_latents = named if named is not None else grid.cells_latents(free, n)
        if keep:
            # A cell that holds a real cut stays as it is, whatever was asked: a cut that
            # is rendered again lands somewhere else. Where the takes really cut is known
            # only once they have been read, which is why this arrives as an input. It goes
            # for latent frames named one by one as well: none of such a cell is freed.
            guards = [int(f) for f in keep.get("guards") or []]
            held = {c for c in range(n) if any(g["cells"][c][0] <= f <= g["cells"][c][1] for f in guards)}
            free = [c for c in free if c not in held]
            free_latents = [t for t in free_latents if grid.cell_of_latent(t, n) not in held]
        import torch  # noqa: PLC0415 - only where a tensor is made
        # spatially the mask is one value, so its size there does not matter
        m = torch.zeros((g["latent_t"], 8, 8), dtype=torch.float32)
        audio_t = g["audio_t"]
        if audio_latent is not None:
            audio_t = int(audio_latent["samples"].shape[-1])
        per_frame = grid.AUDIO_LATENT_FPS / grid.FPS
        am = torch.zeros((1, 2, audio_t), dtype=torch.float32)
        bounds = grid.latent_bounds(g["frame_count"])
        for t in free_latents:
            a, b = bounds[t]
            m[t:t + 1] = 1.0
            # the sound of the same frames (40 latent frames a second against 24 pictures)
            am[..., min(audio_t, int(round(a * per_frame))):
               min(audio_t, int(round((b + 1) * per_frame)))] = 1.0
        if named is None:
            return (m, am, grid.describe(g, free))
        return (m, am, "latent frames %s free (frames %s)" % (
            free_latents, ", ".join("%d-%d" % tuple(bounds[t]) for t in free_latents)))


class GachaDirectorFreeMemory:
    """Pass-through that hands resident models back between stages.

    H3 loads a large text encoder and then a large DiT; they are never needed at once.
    On a small card the second load on top of the first is what fails. Placed as a real
    node between conditioning and the sampler (and between the sampler and VAEDecode) it
    caps peak residency at the larger single model. It changes nothing about the render —
    only when memory is returned.
    """

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("LATENT", "CONDITIONING")
    RETURN_NAMES = ("latent", "conditioning")
    FUNCTION = "free"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"latent": ("LATENT",)},
            "optional": {"conditioning": ("CONDITIONING",),
                         "stage": ("STRING", {"default": ""})},
        }

    def free(self, latent, conditioning=None, stage=""):
        try:
            import comfy.model_management as mm
            mm.unload_all_models()
            mm.soft_empty_cache()
            log.info("GachaDirector: freed resident models before %s", stage or "next stage")
        except Exception as exc:  # never let a memory hint kill a render
            log.warning("GachaDirector: free-memory hand-off skipped: %s", exc)
        return (latent, conditioning)


def should_stage(strategy: str, total_vram_bytes) -> bool:
    """auto = stage at or under 16 GB. Unknown VRAM resolves to yes (cheap failure)."""
    s = (strategy or "auto").strip().lower()
    if s == "on":
        return True
    if s == "off":
        return False
    if not total_vram_bytes or int(total_vram_bytes) <= 0:
        return True
    return int(total_vram_bytes) <= 16 * 1024 ** 3


def total_vram_bytes():
    try:
        import comfy.model_management as mm
        return int(mm.get_total_memory(mm.get_torch_device()))
    except Exception:
        return None
