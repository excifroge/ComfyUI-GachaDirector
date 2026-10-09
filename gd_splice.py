"""Picks from several takes, put together: two internal nodes around gd_cuts.

``GachaDirectorCutSplice`` reads the picked takes, finds where each really cuts and lays the
picks out on the clip's own frames; ``GachaDirectorDropFrames`` then leaves out the few frames
that belong to neither of two shots that meet at a cut, and says what was done. Between the
two a render may run (when two takes of one long take have to be joined) or nothing at all
(when every join is a cut: the clip is then made without the model).
"""

from __future__ import annotations

import json
import logging

from . import gd_cuts as cuts
from . import gd_frames as frames_mod

log = logging.getLogger("GachaDirector")

#: Custom socket type carrying the frames to leave out, and the report, between the nodes.
DROPS = "GD_DROPS"
#: The size (width, height) at which a take is looked at for its cuts.
LOOK_SIZE = (168, 96)
#: Sound is faded over this long on either side of a join, so that it does not click.
FADE_SECONDS = 0.004
FPS = 24.0


#: A picture whose brightness spreads less than this (of 0..1) has no structure to speak of:
#: a black or a flat frame. It is left near zero rather than blown up to unit spread.
FLAT = 0.02


def _unlike(a, b):
    """How unlike two pictures of :func:`frame_changes` are: half their mean squared
    difference, which for two pictures of unit spread is one minus their correlation.
    About 0 for the same picture, about 1 for two that have nothing to do with each other."""
    return 0.5 * (a - b).pow(2).mean(dim=(-2, -1))


def frame_changes(frames):
    """How much every frame differs from the one before it (0 for the first), and the
    pictures that was measured on, for the questions asked of single frames.

    The pictures are made small and grey, and each is brought to zero mean and, as far as
    it has any structure, to unit spread (its spread is divided by sqrt(spread^2 + FLAT^2):
    a picture ten times ``FLAT`` in spread comes to 0.99, one as flat as ``FLAT`` to 0.71,
    a black frame stays at nothing). What is compared is where the light and the dark of a
    picture lie, not how bright it is; contrast is evened out, not removed. Lightning, a muzzle flash or an explosion lighting up a shot changes its
    brightness a great deal and its structure little; a cut replaces the structure.
    (Measured on four takes of a thunderstorm at night: by the plain difference of
    brightness the lightning came out larger than the cuts between two dark shots and was
    taken for them, and 5 of 12 cuts were found exactly. By this measure, with the check
    of :func:`_stays`, all 12.)
    """
    import torch.nn.functional as F  # noqa: PLC0415

    grey = frames.mean(dim=-1, keepdim=False).unsqueeze(1)           # [N, 1, H, W]
    small = F.interpolate(grey, size=(LOOK_SIZE[1], LOOK_SIZE[0]), mode="area").squeeze(1)
    z = small - small.mean(dim=(1, 2), keepdim=True)
    z = z / (z.pow(2).mean(dim=(1, 2), keepdim=True) + FLAT ** 2).sqrt()
    out = [0.0]
    if z.shape[0] > 1:
        out += _unlike(z[1:], z[:-1]).tolist()
    return out, z


#: A cut is judged by the frames on either side of it: this many next to it, and as many
#: again beyond those.
STAY_FRAMES = 8
#: A frame counts as unlike the other side of a cut when it differs from what that side
#: mostly looks like by this share of the change at the cut itself. (Against a flat white or
#: black frame a picture measures half of what it measures against another picture.)
STAY_SHARE = 0.4
#: No cut is smaller than this (cuts of this model measure 0.28 and more; two pictures this
#: close correlate above 0.95). In a clip that hardly moves, the usual change is next to
#: nothing and everything is many times it: a fade of one picture is no cut.
CUT_LEAST = 0.05
#: A change of this size is asked about whatever the take's usual change is. A take that
#: moves hard from end to end (a chase at the standard preset) has a usual change of 0.15
#: and more, and five times that is what its cuts measure, give or take: 0.72 to 1.07 in
#: two takes, two of the six under five times.
CUT_SURE = 0.5
#: The pictures on the two sides of a cut, this many each, are further apart than they
#: wobble among themselves, by at least this factor.
APART_FRAMES = 4
APART = 2.0


def _apart(small, f: int) -> float:
    """How far apart the pictures before frame ``f`` and the pictures from ``f`` on are, as
    two groups of ``APART_FRAMES``: the difference of what the groups look like on average,
    in times the wobble of their frames around those averages. Two shots that hold still
    are many times apart; flickering light and a movement that goes on are about once."""
    n = small.shape[0]
    left = small[max(0, f - APART_FRAMES):f]
    right = small[f:min(n, f + APART_FRAMES)]
    if not len(left) or not len(right):
        return 0.0
    between = float(_unlike(left.mean(dim=0), right.mean(dim=0)))
    within = float(_unlike(left, left.mean(dim=0)).mean() + _unlike(right, right.mean(dim=0)).mean())
    return between / (within + 1e-6)


def _stays(small, changes):
    """Does the picture change at ``f`` and stay changed? Across a cut the frames before
    ``f`` are unlike what follows, every one of them, and the frames from ``f`` on are
    unlike what came before. Into a flash, and out of it, that is so on one side only: the
    other side is part flash and part shot. Both sides are asked, and three frames in four
    have to say so: a flash of up to five frames is passed over.

    Lightning can hold a shot lit for a quarter of a second and more, and in a dark shot
    it shows what was not to be seen before: for those frames the picture is another one.
    So the eight frames beyond the eight next to the cut are asked as well, on either
    side. After a cut they are still the new shot; after a burst of light they are the old
    picture again. A burst of up to about half a second is passed over that way.
    ``check(f, lo, hi)`` takes the frames that question may reach, first and last: half the
    way to the cuts the document asks for on either side. A shot of a few frames that is
    cut to and cut back from is a shot, and beyond it nothing is asked.

    Last, the four frames before ``f`` and the four from ``f`` on are compared as two
    groups (:func:`_apart`): what the groups look like on average has to be ``APART`` times
    further apart than the frames of each wobble around their own average. (Measured: a
    flicker of lightning ten frames before a soft cut 1.0, that cut 2.7; a dragon's
    wingbeat in a long take 1.1.)
    """
    n = small.shape[0]

    def unlike(frames, others, need: float) -> bool:
        usual = others.median(dim=0).values
        far = _unlike(frames, usual) >= need
        return int(far.sum()) * 4 >= len(frames) * 3

    def check(f: int, lo: int = 0, hi: int | None = None) -> bool:
        before = small[max(0, f - STAY_FRAMES):f]
        after = small[f:min(n, f + STAY_FRAMES)]
        if not len(before) or not len(after) or float(changes[f]) < CUT_LEAST:
            return False
        need = STAY_SHARE * float(changes[f])
        if not (unlike(after, before, need) and unlike(before, after, need)):
            return False
        end = n if hi is None else min(n, int(hi) + 1)
        beyond = small[min(end, f + STAY_FRAMES):min(end, f + 2 * STAY_FRAMES)]
        behind = small[max(0, int(lo), f - 2 * STAY_FRAMES):max(0, int(lo), f - STAY_FRAMES)]
        if len(beyond) and not unlike(beyond, before, need):
            return False
        if len(behind) and not unlike(behind, after, need):
            return False
        return _apart(small, f) >= APART
    return check


def real_cut(changes, stays, hard: list, cut: int, total: int):
    """The frame a clip really cuts at near ``cut``, or None.

    ``changes`` and ``stays`` are the clip's, from :func:`frame_changes` and
    :func:`_stays`; ``hard`` are the frames at which the document asks for a cut (not the
    boundaries inside a long take), ``cut`` one of them, ``total`` the clip's length.
    Everything that asks where a clip cuts asks here: the splice, the route the panel
    calls and the face tracker.
    """
    lo, hi = cuts.reach_of(hard, cut, int(total))
    far = cuts.reach_of(hard, cut, int(total), reach=int(total))
    return cuts.find_cut(changes, int(cut), lo, hi, stays=lambda f: stays(f, *far), sure=CUT_SURE)


def _resize(frames, width: int, height: int):
    """Frames at another size, the way the frame loader resizes them."""
    from comfy.utils import common_upscale  # noqa: PLC0415 - ComfyUI runtime only

    return common_upscale(frames.movedim(-1, 1), width, height, "lanczos", "center").movedim(1, -1)


def read_audio(name: str, source: str = "output"):
    """A file's sound as ``(waveform [channels, samples], sample rate)``; ``(None, 0)``
    when it has none."""
    import av  # noqa: PLC0415 - a ComfyUI core dependency
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415

    path = frames_mod.resolve(name, source)
    with av.open(path) as container:
        if not container.streams.audio:
            return None, 0
        stream = container.streams.audio[0]
        rate = int(stream.rate)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        chunks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray())
    if not chunks:
        return None, 0
    return torch.from_numpy(np.concatenate(chunks, axis=1)).float(), rate


def at_rate(wave, have: int, want: int):
    """A sound at another sample rate, by linear interpolation: takes of one clip come at
    one rate, and when one does not, a slightly duller sound is better than none."""
    import torch  # noqa: PLC0415

    if wave is None or have == want or not have:
        return wave
    n = max(1, round(wave.shape[1] * want / have))
    return torch.nn.functional.interpolate(wave.unsqueeze(0), size=n, mode="linear",
                                           align_corners=False).squeeze(0)


def cut_audio(wave, rate: int, a: int, b: int):
    """The sound of frames ``a..b-1``, padded with silence where the file ends early."""
    import torch  # noqa: PLC0415

    s0, s1 = round(a / FPS * rate), round(b / FPS * rate)
    if wave is None:
        return torch.zeros((2, max(0, s1 - s0)))
    piece = wave[:, s0:s1]
    if piece.shape[1] < s1 - s0:
        piece = torch.nn.functional.pad(piece, (0, s1 - s0 - piece.shape[1]))
    return piece.clone()


def fade_ends(piece, rate: int, *, start: bool, end: bool):
    """A few milliseconds up from silence and down to it: no click where sounds meet."""
    import torch  # noqa: PLC0415

    n = int(rate * FADE_SECONDS)
    if n < 2 or piece.shape[1] < 2 * n:
        return piece
    ramp = torch.linspace(0.0, 1.0, n)
    if start:
        piece[:, :n] *= ramp
    if end:
        piece[:, -n:] *= ramp.flip(0)
    return piece


class GachaDirectorCutSplice:
    """The picked takes laid out on the clip's frames, joined where the takes really cut."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("IMAGE", "AUDIO", DROPS)
    RETURN_NAMES = ("frames", "audio", "drops")
    FUNCTION = "splice"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "pieces": ("STRING", {"default": "[]", "multiline": True}),
            "length": ("INT", {"default": 124, "min": 1, "max": 100000}),
            "width": ("INT", {"default": 0, "min": 0, "max": 8192}),
            "height": ("INT", {"default": 0, "min": 0, "max": 8192}),
        }, "optional": {"dissolve": ("STRING", {"default": ""})}}

    def splice(self, pieces, length, width, height, dissolve=""):
        import torch  # noqa: PLC0415

        items = json.loads(pieces) if isinstance(pieces, str) else list(pieces)
        if not items:
            raise ValueError("Gacha Director: nothing to cut together")
        # The cuts are looked for in small pictures, decoded small: a take at full size is
        # gigabytes, and of most takes only a stretch is used.
        takes = {}
        for item in items:
            name = item["file"]
            if name in takes:
                continue
            look = frames_mod.load_frames(name, "output", 0, 0, LOOK_SIZE[0], LOOK_SIZE[1], "decode")
            if int(look.shape[0]) < int(length):
                # (read to the clip's length it would come back padded with its last frame,
                # and the stretch read at full size further down would find nothing)
                raise ValueError(
                    "Gacha Director: the take %s is %d frames long and the clip is %d: it was "
                    "rendered at another clip length and cannot be cut into this clip"
                    % (name, int(look.shape[0]), int(length)))
            changes, small = frame_changes(look[: int(length)])
            del look
            wave, rate = read_audio(name)
            takes[name] = {"changes": changes, "stays": _stays(small, changes),
                           "wave": wave, "rate": rate}

        asked_cuts = [int(p["start"]) for p in items[1:] if p.get("join") != "continuous"]

        def cut_of(name, asked, lo, hi):
            # (lo and hi are the window gd_cuts.plan worked out from the same cuts)
            t = takes[name]
            return real_cut(t["changes"], t["stays"], asked_cuts, asked, int(length))

        result = cuts.plan(items, cut_of)
        rate = next((t["rate"] for t in takes.values() if t["rate"]), 44100)
        pics, sound = [], []
        parts = result["grid"]
        for part in parts:
            # at full size, only what goes into the clip
            pics.append(frames_mod.load_frames(
                part["file"], "output", int(part["start"]), int(part["end"]) - int(part["start"]),
                int(width), int(height), "canvas"))
        # the sound has a layout of its own: where the picture is cut and the sound goes on,
        # it stays with the take it was with
        voices = result["sound"]
        for k, part in enumerate(voices):
            t = takes[part["file"]]
            piece = cut_audio(at_rate(t["wave"], t["rate"], rate), rate, part["start"], part["end"])
            sound.append(fade_ends(piece, rate, start=k > 0, end=k < len(voices) - 1))
        note = cuts.describe(result)
        # Takes rendered at different sizes (a draft and a standard take of one clip) come
        # to the largest of them: frames of two sizes cannot follow one another.
        sizes = {(int(p.shape[2]), int(p.shape[1])) for p in pics}
        if len(sizes) > 1:
            w, h = max(sizes, key=lambda s: s[0] * s[1])
            pics = [p if (int(p.shape[2]), int(p.shape[1])) == (w, h) else _resize(p, w, h) for p in pics]
            note += "\ntakes of %s: all brought to %dx%d" % (
                ", ".join("%dx%d" % s for s in sorted(sizes)), w, h)
        frames = torch.cat(pics, dim=0)
        # An experiment: over the frames named, the picture goes from the take before a
        # join to the take after it by a dissolve instead of changing at one frame.
        for lo, hi in (json.loads(dissolve) if dissolve else []):
            lo, hi = int(lo), int(hi)
            for before, after in zip(parts, parts[1:]):
                at = int(after["start"])
                if before["file"] == after["file"] or not lo <= at <= hi + 1:
                    continue
                n = hi - lo + 1
                size = (int(frames.shape[2]), int(frames.shape[1]))
                a = frames_mod.load_frames(before["file"], "output", lo, n, size[0], size[1], "canvas")
                b = frames_mod.load_frames(after["file"], "output", lo, n, size[0], size[1], "canvas")
                w = ((torch.arange(n, dtype=torch.float32) + 1.0) / (n + 1.0)).view(n, 1, 1, 1)
                frames[lo:hi + 1] = a * (1.0 - w) + b * w
                note += "\ndissolve over frames %d-%d around the join at %d" % (lo, hi, at)
        audio = {"waveform": torch.cat(sound, dim=1).unsqueeze(0), "sample_rate": rate}
        log.info("Gacha Director: %s", note.replace("\n", " | "))
        return (frames, audio, {"drops": result["drops"], "note": note, "starts": result["starts"],
                                "guards": result["guards"]})

    @classmethod
    def IS_CHANGED(cls, pieces, length, width, height, dissolve="", **_):
        # the takes are files: one written again under its name is another take
        import os  # noqa: PLC0415
        seen = [str(dissolve)]
        try:
            for item in json.loads(pieces):
                path = frames_mod.resolve(item["file"], "output")
                st = os.stat(path)
                seen.append("%s:%d:%d" % (path, st.st_mtime_ns, st.st_size))
        except (OSError, ValueError, TypeError, KeyError):
            return float("nan")
        return "|".join(sorted(set(seen)))


class GachaDirectorDropFrames:
    """Leaves out the frames a cut between two takes costs, from picture and sound, and
    records what was done at every join and how long the clip came out."""

    CATEGORY = "GachaDirector/internal"
    RETURN_TYPES = ("IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("frames", "audio", "frame_count")
    FUNCTION = "drop"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE",),
            "audio": ("AUDIO",),
            "drops": (DROPS,),
        }}

    def drop(self, frames, audio, drops):
        import torch  # noqa: PLC0415

        ranges = sorted((int(a), int(b)) for a, b in drops["drops"] if b > a)
        n = int(frames.shape[0])
        keep, at = [], 0
        for a, b in ranges:
            a, b = max(at, min(a, n)), max(at, min(b, n))
            if a > at:
                keep.append((at, a))
            at = b
        if at < n:
            keep.append((at, n))
        if ranges:
            frames = torch.cat([frames[a:b] for a, b in keep], dim=0)
            wave, rate = audio["waveform"], int(audio["sample_rate"])
            # The sound as long as the picture it came with, to the sample: frames are
            # counted out of it, and the model's sound ends a few milliseconds before its
            # picture does (a sound much shorter would leave a stretch with nothing in it).
            want = round(n / FPS * rate)
            if wave.shape[-1] < want:
                wave = torch.nn.functional.pad(wave, (0, want - wave.shape[-1]))
            wave = wave[..., :want]
            parts = []
            for k, (a, b) in enumerate(keep):
                piece = wave[..., round(a / FPS * rate):round(b / FPS * rate)].clone()
                flat = piece.reshape(-1, piece.shape[-1])
                fade_ends(flat, rate, start=k > 0, end=k < len(keep) - 1)
                parts.append(flat.reshape(piece.shape))
            audio = {"waveform": torch.cat(parts, dim=-1), "sample_rate": rate}
        return {"ui": {"gd_cuts": [drops["note"]], "gd_frames": [int(frames.shape[0])],
                       "gd_starts": [",".join(str(int(x)) for x in drops["starts"])]},
                "result": (frames, audio, int(frames.shape[0]))}
