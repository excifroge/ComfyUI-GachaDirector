"""Gacha Director — the one HTTP route the panel needs.

Read-only: what is in ``input/``, with the facts about each video the editor should not
ask the user for. No route writes anything; the panel's only writes go through the node's
own widgets, which is the whole point of keeping one source of truth.
"""

from __future__ import annotations

import logging
import math
import os

log = logging.getLogger("GachaDirector")

# stills only: an animated GIF loads as a batch of frames, which is a clip, not a picture
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v")
AUDIO_EXT = (".wav", ".mp3", ".flac", ".ogg", ".m4a")


def _input_dir() -> str:
    # after Thefrizzy1's ComfyUI-MiniMaxH3-Director (assets.py, Apache-2.0); see NOTICE
    try:
        import folder_paths
        return folder_paths.get_input_directory()
    except Exception:
        return ""


# Video facts the editor should not ask the user for: frame count, rate, size. Probed
# with PyAV (a ComfyUI core dependency) and cached by path+mtime, so a media listing costs
# one open per NEW file, not one per file per listing.
_PROBE_CACHE: dict = {}


def _probe_video(path: str, mtime: float) -> dict:
    key = (path, mtime)
    hit = _PROBE_CACHE.get(key)
    if hit is not None:
        return hit
    info: dict = {}
    try:
        import av  # type: ignore
        with av.open(path) as container:
            stream = container.streams.video[0] if container.streams.video else None
            if stream is not None:
                fps = float(stream.average_rate or stream.guessed_rate or 0.0)
                frames = int(stream.frames or 0)
                if frames <= 0 and stream.duration and stream.time_base:
                    # A stream without a frame count in its header still has a duration;
                    # counting frames by hand would mean decoding the whole file inside a
                    # media listing, so derive it instead.
                    frames = int(round(float(stream.duration * stream.time_base) * fps))
                w = int(stream.width or 0)
                h = int(stream.height or 0)
                if frames > 0:
                    # frames24: how many frames the clip yields once conformed to the
                    # model's 24 fps, which is what every frame number in a document counts
                    seconds = frames / fps if fps > 0 else 0.0
                    frames24 = frames if abs(fps - 24.0) / 24.0 <= 0.005 or fps <= 0 else (
                        int(seconds * 24.0 + 1e-6))
                    info = {"frames": frames, "fps": round(fps, 3), "width": w, "height": h,
                            "frames24": max(1, frames24),
                            "audio": bool(container.streams.audio)}
    except Exception:  # noqa: BLE001 - a file the decoder cannot open is simply unprobed
        info = {}
    _PROBE_CACHE[key] = info
    return info


#: How many generated files of a kind the library offers, newest first.
RENDERS_SHOWN = 400
GENERATED_SHOWN = {"images": 1000, "videos": RENDERS_SHOWN, "audio": 400}


def _list_generated() -> dict:
    """What is in output/, by kind, newest first, named the way ComfyUI names a file outside
    input/: with the ``[output]`` annotation, which every loader in the expansion resolves.

    Videos are probed (their length is what the panel needs to cut a piece from one); the
    answer is cached by path and modification time, so only new files cost anything.
    """
    out = {"images": [], "videos": [], "audio": []}
    try:
        import folder_paths
        root = folder_paths.get_output_directory()
    except Exception:  # noqa: BLE001
        return out
    found = {"images": [], "videos": [], "audio": []}
    for dirpath, _dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            low = name.lower()
            kind = ("images" if low.endswith(IMAGE_EXT) else "videos" if low.endswith(VIDEO_EXT)
                    else "audio" if low.endswith(AUDIO_EXT) else "")
            if not kind:
                continue
            full = os.path.join(dirpath, name)
            try:
                found[kind].append((os.path.getmtime(full), os.path.getsize(full), full,
                                    name if rel_dir == "." else
                                    os.path.join(rel_dir, name).replace("\\", "/")))
            except OSError:
                continue
    for kind, files in found.items():
        files.sort(reverse=True)
        for mtime, size, full, rel in files[:GENERATED_SHOWN[kind]]:
            item = {"name": "%s [output]" % rel, "size": size, "mtime": mtime}
            if kind == "videos":
                item.update(_probe_video(full, mtime))
            out[kind].append(item)
    return out


def _list_media() -> dict:
    root = _input_dir()
    generated = _list_generated()
    out = {"images": [], "videos": [], "audio": [], "renders": generated["videos"],
           "generated": generated, "root": root}
    if not root or not os.path.isdir(root):
        return out
    for dirpath, _dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name).replace("\\", "/")
            low = name.lower()
            full = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(full)
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            item = {"name": rel, "size": size, "mtime": mtime}
            if low.endswith(IMAGE_EXT):
                out["images"].append(item)
            elif low.endswith(VIDEO_EXT):
                item.update(_probe_video(full, mtime))
                out["videos"].append(item)
            elif low.endswith(AUDIO_EXT):
                out["audio"].append(item)
    for key in ("images", "videos", "audio"):
        out[key].sort(key=lambda x: -x["mtime"])
    return out


def probe(name: str) -> dict:
    """Facts about a media file: frames, fps, width, height, frames24, audio.

    The name is relative to input/, or carries ComfyUI's ``[output]`` annotation. An empty
    dict when the file is missing or unreadable.
    """
    if not _input_dir() or not name:
        return {}
    from . import gd_frames
    full = gd_frames.resolve(str(name).replace("\\", "/").lstrip("/"))
    if not os.path.isfile(full):
        return {}
    if full.lower().endswith(IMAGE_EXT):
        try:
            from PIL import Image
            with Image.open(full) as im:
                return {"frames": 1, "frames24": 1, "fps": 0.0,
                        "width": int(im.width), "height": int(im.height), "audio": False}
        except Exception:  # noqa: BLE001
            return {}
    return _probe_video(full, os.path.getmtime(full))


_CUTS: dict = {}                 # (path, mtime, size, cuts asked, total) -> [frame]


def real_cuts(name: str, asked: list, total: int, source: str = "output") -> list:
    """Where a rendered clip really cuts, near each frame a cut was asked for.

    ``asked`` are the frames at which the document has a cut (not the boundaries inside a
    long take); ``total`` is the clip's length. One answer per frame asked: the frame the
    clip cuts at, or the frame asked itself where no cut is found. The measuring of a
    file is kept: a take is asked about every time its shots are drawn.
    """
    from . import gd_frames
    from .gd_splice import _stays, frame_changes, real_cut

    from .gd_splice import LOOK_SIZE

    path = gd_frames.resolve(name, source)
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size, tuple(int(c) for c in asked), int(total))
    if key in _CUTS:
        return list(_CUTS[key])
    # small pictures straight from the decoder: this only compares frames
    changes, small = frame_changes(
        gd_frames.load_frames(name, source, 0, 0, LOOK_SIZE[0], LOOK_SIZE[1], "decode"))
    stays = _stays(small, changes)
    cuts = sorted({int(c) for c in asked if 0 < int(c) < int(total)})
    found = {}
    for cut in cuts:
        at = real_cut(changes, stays, cuts, cut, int(total))
        found[cut] = cut if at is None else at
    if len(_CUTS) > 512:
        _CUTS.clear()
    _CUTS[key] = [found.get(int(c), int(c)) for c in asked]
    return list(_CUTS[key])


_ALIKE: dict = {}
#: Frames on either side of the seam that the two takes are compared over.
ALIKE_SPAN = 8


def alike(name_a: str, name_b: str, frame: int, source: str = "output") -> float:
    """How alike two rendered clips are around a frame: the PSNR between them, in dB, over
    the frames from `ALIKE_SPAN` before it to `ALIKE_SPAN` after it, on small pictures.

    Measured on two pairs: two takes that came to about 33 dB here were
    joined by generating a dozen frames again; two that came to about 19 dB (one source
    video, two seeds, lit and coloured differently) were not joined by anything that was
    tried. Two points: a hint, not a rule. Small pictures read a little higher than the
    takes at full size. The measuring of a pair of files is kept.
    """
    import torch  # noqa: PLC0415

    from . import gd_frames
    from .gd_splice import LOOK_SIZE

    paths = [gd_frames.resolve(n, source) for n in (name_a, name_b)]
    stats = [os.stat(p) for p in paths]
    key = tuple((p, st.st_mtime_ns, st.st_size) for p, st in zip(paths, stats)) + (int(frame),)
    if key in _ALIKE:
        return _ALIKE[key]
    # the frames that are there: a seam near either end of the clip has fewer on that side,
    # and a clip read past its end comes back padded with its last frame
    total = min(int(_probe_video(p, st.st_mtime).get("frames24") or 0) for p, st in zip(paths, stats))
    start = max(0, int(frame) - ALIKE_SPAN)
    count = max(0, min(int(frame) + ALIKE_SPAN, total) - start)
    if not count:
        raise ValueError("no frames of both clips around frame %d" % int(frame))
    a, b = (gd_frames.load_frames(n, source, start, count, LOOK_SIZE[0], LOOK_SIZE[1], "decode")
            for n in (name_a, name_b))
    n = min(int(a.shape[0]), int(b.shape[0]), count)
    mse = float(torch.mean((a[:n].float() - b[:n].float()) ** 2)) if n else 1.0
    db = 99.0 if mse <= 0 else round(10.0 * math.log10(1.0 / mse), 1)
    if len(_ALIKE) > 2048:
        _ALIKE.clear()
    _ALIKE[key] = db
    return db


def register() -> bool:
    """Attach the route. Returns False when ComfyUI's server is not available."""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:                       # pragma: no cover - no server in tests
        log.debug("Gacha Director: routes not registered (%s)", exc)
        return False

    server = getattr(PromptServer, "instance", None)
    if server is None:                             # imported outside a running server
        return False
    routes = server.routes

    @routes.get("/gachadirector/media")
    async def _media(_request):
        """Everything in input/, for the material library."""
        try:
            return web.json_response({"ok": True, **_list_media()})
        except Exception as exc:
            log.exception("Gacha Director: media listing failed")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/gachadirector/plan")
    async def _plan(request):
        """Compile a document: the prompt the model would read, without running anything.

        The panel shows this so a prompt is checked before a render is spent on it. It is
        the same code path the node takes, so what is shown is what is sent.
        """
        try:
            from . import gd_compile, gd_schema
            body = await request.json()
            d = gd_schema.normalize(body.get("doc") or {})
            p = gd_compile.build_plan(d, probe=probe)
            w, h = gd_compile.canvas(d, body.get("params") or {}, probe)
            return web.json_response({
                "ok": True, "prompt": p["prompt"], "tasks": p.get("tasks") or [],
                "warnings": p.get("ref_warnings") or [], "problems": gd_schema.problems(d),
                "canvas": [w, h],
            })
        except Exception as exc:
            log.exception("Gacha Director: plan failed")
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.post("/gachadirector/cuts")
    async def _cuts(request):
        """Where rendered clips really cut: {files: [name], cuts: [frame], total} ->
        {ok, real: {name: [frame]}}. A file that cannot be read is left out."""
        try:
            import asyncio
            body = await request.json()
            asked = [int(x) for x in body.get("cuts") or []]
            total = int(body.get("total") or 0)
            loop = asyncio.get_running_loop()
            real = {}
            for name in list(body.get("files") or [])[:64]:
                try:
                    # decoding is not the event loop's work
                    real[name] = await loop.run_in_executor(None, real_cuts, str(name), asked, total)
                except Exception as exc:  # noqa: BLE001 - a missing take is not an error here
                    log.debug("Gacha Director: cuts of %s not measured (%s)", name, exc)
            return web.json_response({"ok": True, "real": real})
        except Exception as exc:
            log.exception("Gacha Director: measuring cuts failed")
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.post("/gachadirector/alike")
    async def _alike(request):
        """How alike pairs of rendered clips are around a frame: {pairs: [[a, b, frame]]} ->
        {ok, db: [number or null]}, one answer a pair. A pair that cannot be read is null."""
        try:
            import asyncio
            body = await request.json()
            loop = asyncio.get_running_loop()
            out = []
            for pair in list(body.get("pairs") or [])[:32]:
                try:
                    a, b, frame = str(pair[0]), str(pair[1]), int(pair[2])
                    out.append(await loop.run_in_executor(None, alike, a, b, frame))
                except Exception as exc:  # noqa: BLE001 - a missing take is not an error here
                    log.debug("Gacha Director: likeness of %s not measured (%s)", pair, exc)
                    out.append(None)
            return web.json_response({"ok": True, "db": out})
        except Exception as exc:
            log.exception("Gacha Director: measuring likeness failed")
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    log.info("Gacha Director: HTTP routes registered")
    return True
