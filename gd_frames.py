"""Gacha Director — the frame loader the expansion uses.

Core ComfyUI's ``LoadVideo`` cannot do three things this package needs: read a frame range
out of a file in ``output/`` (a finished take), conform a 30 or 60 fps source to the 24 fps
the model works at, and scale while decoding so a 4K source never sits in memory at full
size. So the loader is ours: a plain STRING path, a frame range, an optional resize.

Decoded with **PyAV**, which ComfyUI itself requires and uses for its own video I/O.
The nearest-in-time frame pick is adapted from seesee75's ComfyUI-MiniMaxH3-Director
(minimax_media.load_video_tensor, GPL-3.0); modified. See NOTICE.

Frame rate
----------
MiniMax H3 is a 24 fps model. A source at any other rate is conformed by picking, for every
24 fps output frame, the source frame nearest in time — no blending, so nothing is smeared.
``start`` and ``length`` always count 24 fps frames. A source already at 24 fps is walked
frame by frame and comes through untouched.

Two resize modes
----------------
* ``resize="canvas"``: decode at the file's own size, then lanczos + centre crop to the
  target. Used for the source clip and for spliced takes, which must fill the canvas.
* ``resize="decode"``: the decoder scales to exactly ``width`` x ``height`` (the caller
  passes an aspect-preserving size). Used for reference videos.

A source that ends early holds its last frame rather than returning a short batch — a
short batch would change the length the sampler works on.

Decode contract: RGB, float32, 0..1, shaped (N, H, W, 3).
"""

from __future__ import annotations

import logging
import os


log = logging.getLogger("GachaDirector")

#: Where a name may live. "output" is what a composite's takes need.
SOURCES = ["input", "output", "temp"]

#: How a resize is done. See the module docstring.
RESIZE = ["canvas", "decode"]


def _folder(source: str) -> str:
    import folder_paths
    if source == "output":
        return folder_paths.get_output_directory()
    if source == "temp":
        return folder_paths.get_temp_directory()
    return folder_paths.get_input_directory()


def resolve(name: str, source: str = "input") -> str:
    """Absolute path for a media name, honouring a trailing "[output]" annotation.

    The annotation is how ComfyUI itself writes "this file is in the output folder", and
    the panel hands names around in that form, so accepting it here means a caller never
    has to strip it first.
    """
    raw = str(name or "").strip().replace("\\", "/")
    for tag in SOURCES:
        suffix = " [%s]" % tag
        if raw.endswith(suffix):
            raw, source = raw[: -len(suffix)].strip(), tag
            break
    folder = os.path.abspath(_folder(source))
    path = os.path.abspath(os.path.join(folder, raw))
    # A name is a file of that folder (or of a folder inside it), never a way out of it: a
    # workflow from somewhere else, or a request to one of the routes, must not be able to
    # point this at any file of the machine.
    try:
        inside = os.path.normcase(os.path.commonpath([folder, path])) == os.path.normcase(folder)
    except ValueError:                      # on another drive
        inside = False
    if not inside:
        raise ValueError("%r is not inside the %s folder" % (name, source))
    return path


#: The model's frame rate. Sources at another rate are conformed to it.
MODEL_FPS = 24.0


def _stream_fps(stream) -> float:
    try:
        return float(stream.average_rate or stream.guessed_rate or 0.0)
    except Exception:  # noqa: BLE001 - a stream with no rate is treated as already conformed
        return 0.0


def load_frames(name: str, source: str = "input", start: int = 0, length: int = 0,
                width: int = 0, height: int = 0, resize: str = "canvas",
                fps: float = MODEL_FPS) -> torch.Tensor:
    """Decode [start, start+length) of a video as an IMAGE tensor. length 0 = to the end.

    ``start`` and ``length`` count frames at ``fps``. ``fps=0`` turns conforming off and
    counts the file's own frames.
    """
    import av  # noqa: PLC0415 - a ComfyUI core dependency, imported where it is used
    import numpy as np

    path = resolve(name, source)
    if not os.path.isfile(path):
        raise FileNotFoundError(
            "Gacha Director: no such video: %s (resolved from %r in %s/)" % (path, name, source))

    want_end = None if length <= 0 else start + length
    in_decoder = resize == "decode" and width > 0 and height > 0

    def to_array(frame):
        if in_decoder:
            return frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
        return frame.reformat(format="rgb24").to_ndarray()

    frames = []
    seen = 0
    with av.open(path) as container:
        if not container.streams.video:
            raise ValueError("Gacha Director: %s has no video stream" % path)
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        src_fps = _stream_fps(stream)
        conform = fps > 0 and src_fps > 0 and abs(src_fps - fps) / fps > 0.005
        if not conform:
            # Walk from the start rather than seeking: a keyframe seek lands on a frame
            # the caller did not ask for, and clips this short make the walk free.
            for frame in container.decode(stream):
                if seen >= start and (want_end is None or seen < want_end):
                    frames.append(to_array(frame))
                seen += 1
                if want_end is not None and seen >= want_end:
                    break
        else:
            # Nearest-in-time pick. Output frame k sits at k / fps; decoded frames arrive
            # in order, so one look-behind is enough to know which neighbour is nearer.
            tb = stream.time_base
            t0 = None
            k = start
            prev = None                      # (time, frame)
            for frame in container.decode(stream):
                t = float(frame.pts * tb) if frame.pts is not None and tb else seen / src_fps
                if t0 is None:
                    t0 = t
                t -= t0
                seen += 1
                while want_end is None or k < want_end:
                    target = k / fps
                    if t < target:
                        break                 # need a later frame for this slot
                    pick = frame
                    if prev is not None and abs(prev[0] - target) < abs(t - target):
                        pick = prev[1]
                    frames.append(to_array(pick))
                    k += 1
                prev = (t, frame)
                if want_end is not None and k >= want_end:
                    break

    if not frames:
        raise ValueError(
            "Gacha Director: %s gave no frames for start=%d length=%s (the file has %d)"
            % (name, start, length or "all", seen))
    if length > 0 and len(frames) < length:
        log.warning("Gacha Director: %s only had %d of the %d frames asked for from %d — "
                    "holding its last frame", name, len(frames), length, start)
        frames.extend([frames[-1]] * (length - len(frames)))
    arr = np.asarray(frames, dtype=np.float32) / 255.0
    import torch  # noqa: PLC0415 - only where a tensor is made
    out = torch.from_numpy(arr)

    have = (int(out.shape[2]), int(out.shape[1]))
    if not in_decoder and width > 0 and height > 0 and have != (width, height):
        from comfy.utils import common_upscale  # noqa: PLC0415 - ComfyUI runtime only
        out = common_upscale(out.movedim(-1, 1), width, height, "lanczos", "center").movedim(1, -1)
    return out


class GachaDirectorLoadFrames:
    """Video frames as IMAGE: a range of one file, optionally resized to the canvas."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "file": ("STRING", {"default": "", "tooltip":
                                "File name inside the chosen folder. A trailing '[output]' "
                                "annotation also selects the folder."}),
            "source": (SOURCES, {"default": "input"}),
            "start": ("INT", {"default": 0, "min": 0, "max": 100000}),
            "length": ("INT", {"default": 0, "min": 0, "max": 100000,
                               "tooltip": "0 = to the end of the file."}),
            "width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8,
                              "tooltip": "0 = keep the file's own size."}),
            "height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
            "resize": (RESIZE, {"default": "canvas", "tooltip":
                                "canvas: lanczos + centre crop after decoding, for the "
                                "source clip. decode: scaled by the decoder, for "
                                "reference videos."}),
        }}

    def load(self, file, source, start, length, width, height, resize="canvas"):
        return (load_frames(file, source, int(start), int(length),
                            int(width), int(height), str(resize)),)

    @classmethod
    def IS_CHANGED(cls, file, source, start, length, width, height, resize="canvas", **_):
        try:
            path = resolve(file, source)
            return "%s:%s:%d:%d:%d:%d:%s" % (os.path.getmtime(path), path, start, length,
                                             width, height, resize)
        except Exception:  # noqa: BLE001 - a missing file is reported by load(), not here
            return float("nan")
