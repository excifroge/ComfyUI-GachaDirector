"""Where a rendered clip really cuts, and how picks from several takes are cut together.

The model is asked for a cut at a time and puts it near that time: within a frame in a
short clip of two shots, up to a dozen frames off in a longer one of four (measured, see
AGENTS.md). Two takes cut together at the frame that was asked for therefore show, at the
join, a few frames of a shot neither of them was picked for. This module finds the frame
each take really cuts at and plans a join on those.

Pure: lists and numbers in, lists and numbers out. Reading frames is the caller's.
"""

from __future__ import annotations

#: A change is worth asking about when it is at least this many times the clip's usual
#: (median) change, or as large as the caller says is always worth it (``sure``). Measured
#: on 107 cuts of this model, by the measure of gd_splice.frame_changes: 4.4 to about 800
#: times; under 5 in a take that moves hard from end to end, which is what ``sure`` is
#: for. Changes that are no cut reach 100 times (lightning), so the number says only what
#: to look at: the cut is the largest change in its window that also stays
#: (gd_splice._stays).
CUT_RATIO = 5.0
#: How far from the frame asked for a cut is looked for, at most.
CUT_REACH = 36
#: Two changes within this share of one another are one size, as far as a cut goes. In a
#: shot that moves fast the model now and then jumps (a cut it was not asked for, inside
#: the shot), and such a jump measures what a cut measures: 0.86 beside a cut of 0.83, 0.83
#: beside one of 0.82. What tells them apart is where they are: the cut is where it was
#: asked for, give or take a few frames. Changes that are clearly smaller (the nearest
#: measured: a third less) do not come into it.
CUT_TIE = 0.15


def usual_change(changes: list[float]) -> float:
    """The median frame-to-frame change of a clip (the first entry, frame 0, has none)."""
    body = sorted(float(c) for c in changes[1:])
    if not body:
        return 0.0
    mid = len(body) // 2
    return body[mid] if len(body) % 2 else (body[mid - 1] + body[mid]) / 2.0


def find_cut(changes: list[float], asked: int, lo: int, hi: int, *,
             ratio: float = CUT_RATIO, stays=None, tie: float = CUT_TIE,
             sure: float | None = None) -> int | None:
    """The frame a new shot really starts at, near the frame it was asked to.

    ``changes[i]`` is how much frame ``i`` differs from frame ``i - 1``. The answer is the
    frame within ``lo..hi`` that differs most from the one before it, when that is a cut
    (``ratio`` times the usual change); among changes of one size (within ``tie`` of the
    largest), the one nearest ``asked``. None when nothing in the window is a cut: the
    take dissolved, panned, or did not change shot.

    ``stays(frame)`` is asked about every candidate: does the picture stay changed after
    it? A flash changes one frame as much as a cut does, and the next frame changes back.
    A change that does not stay is no candidate, however large.

    ``sure`` is a size of change that is worth asking about whatever the clip's usual
    change is, in the units of ``changes``. In a take that moves hard from end to end the
    usual change is large, and ``ratio`` times it comes close to what a cut measures.
    """
    n = len(changes)
    lo, hi = max(1, int(lo)), min(n - 1, int(hi))
    if lo > hi:
        return None
    floor = max(usual_change(changes), 1e-6) * ratio
    if sure is not None:
        floor = min(floor, float(sure))
    found = sorted(((float(changes[f]), -abs(f - asked), f) for f in range(lo, hi + 1)
                    if float(changes[f]) >= floor), reverse=True)
    top, pick = None, None             # the largest change that stays; the frame chosen
    for size, _, f in found:
        if top is not None and size < top * (1.0 - tie):
            break
        if stays is not None and not stays(f):
            continue
        if top is None:
            top, pick = size, f
        elif abs(f - asked) < abs(pick - asked):
            pick = f
    return pick


def reach_of(cuts: list[int], cut: int, total: int, reach: int = CUT_REACH) -> tuple[int, int]:
    """Where the cut asked for at frame ``cut`` is looked for: half the way to the cut
    before it and half the way to the cut after it (the ends of the clip where there is
    none), and no further than ``reach`` frames.

    ``cuts`` are the frames at which cuts are asked for. A boundary inside a long take is
    no cut and does not belong among them: it must not narrow the search, and no cut is
    looked for at it. Everything that asks where a clip really cuts asks through this.
    """
    cut = int(cut)
    before = max([int(c) for c in cuts if int(c) < cut], default=0)
    after = min([int(c) for c in cuts if int(c) > cut], default=int(total))
    return (max(cut - reach, cut - (cut - before) // 2),
            min(cut + reach, cut + (after - cut) // 2))


def window(pieces: list[dict], i: int, reach: int = CUT_REACH) -> tuple[int, int]:
    """Where the cut between piece ``i - 1`` and piece ``i`` is looked for
    (:func:`reach_of`). A boundary inside a long take is no cut and does not narrow the
    search: a take cuts where the model put the cut, wherever its long takes were divided."""
    total = int(pieces[-1]["start"]) + int(pieces[-1]["length"])
    cuts = [int(p["start"]) for p in pieces[1:] if p.get("join") != "continuous"]
    return reach_of(cuts, int(pieces[i]["start"]), total, reach)


def plan(pieces: list[dict], cut_of) -> dict:
    """How picks from several takes are put one after the other.

    ``pieces``
        one per shot, in order: ``{"file", "start", "length", "join", "sound"}``. ``start``
        and ``length`` are the shot's frames in the clip; ``join`` says how the shot
        follows the one before it, ``"cut"`` or ``"continuous"`` (ignored on the first);
        ``sound`` says the same of its sound, and only matters at a cut: ``"continuous"``
        there keeps the sound of the take the sound was with (the picture changes take,
        the sound does not).
    ``cut_of(file, asked, lo, hi)``
        the frame that take really cuts at near ``asked``, or None.

    At a cut between two takes, the left take ``A`` really cuts at ``a`` and the right one
    ``B`` at ``b``. When ``b <= a`` there are frames at which A is still in its shot and B
    already in the next: the join is made at the one nearest the frame asked for, and the
    clip keeps its length. When ``b > a`` the frames ``a..b-1`` are another shot in both
    takes: they are left out, and the clip is that much shorter. A take that has no cut
    there is joined at the frame asked for. Between shots of one take nothing is done, and
    a ``continuous`` join is made at the frame asked for (repairing it is a render's work).

    Returns::

        {"grid":   [{"file", "start", "end"}],   # the clip at its full length: which take
                                                 # every frame comes from (end exclusive)
         "drops":  [[a, b]],                     # frames of that clip to leave out
         "frames": int,                          # what is left
         "starts": [int],                        # where each shot starts in what is left
         "guards": [int],                        # frames of the full-length clip on either
                                                 # side of a cut: a render must not free them
         "sound":  [{"file", "start", "end"}],   # the same clip: which take every frame's
                                                 # sound comes from
         "joins":  [{"at", "kind", "left", "right", "a", "b", "dropped", "voice"}]}

    ``kind`` is ``"same"``, ``"continuous"`` or ``"cut"``. Left out, the dropped frames
    leave exactly the stretches of the takes that belong to the shots picked. ``voice``
    is the take whose sound goes on across a cut, where that is not the picture's own.
    """
    if not pieces:
        return {"grid": [], "drops": [], "frames": 0, "starts": [], "guards": [], "sound": [],
                "joins": []}
    total = int(pieces[-1]["start"]) + int(pieces[-1]["length"])
    # switch[i]: the frame of the clip at which piece i takes over from piece i - 1;
    # skip[i]: how many frames after it are still not piece i's shot
    switch = [int(p["start"]) for p in pieces]
    skip = [0] * len(pieces)
    switch[0] = 0
    joins = []
    for i in range(1, len(pieces)):
        left, right = pieces[i - 1], pieces[i]
        asked = int(right["start"])
        note = {"at": asked, "left": left["file"], "right": right["file"], "a": None, "b": None,
                "dropped": 0, "voice": ""}
        if left["file"] == right["file"]:
            note["kind"] = "same"
            if right.get("join") != "continuous":
                # the take's own cut: nothing to join, but a render has to leave it alone
                lo, hi = window(pieces, i)
                note["a"] = note["b"] = cut_of(left["file"], asked, lo, hi)
        elif right.get("join") == "continuous":
            note["kind"] = "continuous"
        else:
            note["kind"] = "cut"
            lo, hi = window(pieces, i)
            a = cut_of(left["file"], asked, lo, hi)
            b = cut_of(right["file"], asked, lo, hi)
            note["a"], note["b"] = a, b
            a = asked if a is None else int(a)
            b = asked if b is None else int(b)
            if b <= a:
                switch[i] = min(max(asked, b), a)
            else:
                switch[i], skip[i] = a, b - a
                note["dropped"] = b - a
        joins.append(note)
    # A stretch of one take squeezed to nothing between its two joins: something was taken
    # for a cut that is none. Its joins go back to the frames asked for rather than lose
    # the stretch. (Shots that follow one another in one take are one stretch: its first
    # shot may well lie wholly in what a cut leaves out.)
    def squeezed():
        ends = switch[1:] + [total]
        i = 0
        while i < len(pieces):
            j = i
            while j + 1 < len(pieces) and joins[j]["kind"] == "same":
                j += 1
            if ends[j] - (switch[i] + skip[i]) < 1:
                return i, j
            i = j + 1
        return None

    for _ in range(len(pieces)):
        hit = squeezed()
        if hit is None:
            break
        for k in (hit[0], hit[1] + 1):
            if 0 < k < len(pieces):
                switch[k], skip[k] = int(pieces[k]["start"]), 0
                joins[k - 1]["dropped"] = 0
                if joins[k - 1]["kind"] == "cut":
                    joins[k - 1]["a"] = joins[k - 1]["b"] = None
    ends = switch[1:] + [total]
    # The frames on either side of every cut, as the clip lies at its full length: the last
    # of the one shot and the first of the next, and what is left out in between.
    guards: set[int] = set()
    for i in range(1, len(pieces)):
        if pieces[i].get("join") == "continuous":
            continue
        j = joins[i - 1]
        at = j["a"] if j["kind"] == "same" and j["a"] is not None else switch[i]
        guards.update(range(at - 1, at + skip[i] + 1))
    grid, drops = [], []
    for i, p in enumerate(pieces):
        if grid and grid[-1]["file"] == p["file"] and not skip[i]:
            grid[-1]["end"] = ends[i]
        else:
            grid.append({"file": p["file"], "start": switch[i], "end": ends[i]})
        if skip[i]:
            drops.append([switch[i], switch[i] + skip[i]])
    gone = sum(b - a for a, b in drops)

    def left_at(frame: int) -> int:
        """Where a frame of the full-length clip lies in what is left of it."""
        out = 0
        for a, b in drops:
            if frame >= b:
                out += b - a
            elif frame > a:
                return a - out
        return frame - out

    def shot_at(i: int) -> int:
        """The frame of the full-length clip at which shot i starts."""
        j = joins[i - 1]
        if j["kind"] == "same" and j["a"] is not None:
            return int(j["a"])                       # the take's own cut, where it really is
        return switch[i] + skip[i]

    starts = [0]
    for i in range(1, len(pieces)):
        # never before the shot before it: a stretch that a late cut leaves nothing of
        # starts where the next one does
        starts.append(max(starts[-1], left_at(shot_at(i))))

    # Whose sound every frame has. It is the picture's own take's, except where the picture
    # is cut and the sound is said to go on: there it stays with the take it was with.
    sound, voice = [], pieces[0]["file"]
    for i, p in enumerate(pieces):
        if i:
            carried = p.get("join") != "continuous" and p.get("sound") == "continuous"
            if carried and voice != p["file"]:
                joins[i - 1]["voice"] = voice
            elif not carried:
                voice = p["file"]
        j = joins[i - 1] if i else None
        at = 0 if not i else (int(j["a"]) if j["kind"] == "same" and j["a"] is not None else switch[i])
        at = max(at, sound[-1]["start"] if sound else 0)
        if sound and sound[-1]["file"] == voice:
            continue
        if sound:
            sound[-1]["end"] = at
        sound.append({"file": voice, "start": at, "end": total})
    sound = [s for s in sound if s["end"] > s["start"]]
    return {"grid": grid, "drops": drops, "frames": total - gone, "starts": starts,
            "guards": sorted(f for f in guards if 0 <= f < total), "sound": sound, "joins": joins}


def describe(result: dict) -> str:
    """One line a join, and how long the clip came out, for a report."""
    lines = []
    say = lambda v: "no cut found" if v is None else "cuts at %d" % v      # noqa: E731
    for j in result["joins"]:
        if j["kind"] == "same":
            continue
        if j["kind"] == "continuous":
            lines.append("join at %d: continuous, %s -> %s" % (j["at"], j["left"], j["right"]))
            continue
        lines.append("cut at %d: %s %s, %s %s%s%s" % (
            j["at"], j["left"], say(j["a"]), j["right"], say(j["b"]),
            "; %d frame(s) of neither shot left out" % j["dropped"] if j["dropped"] else "",
            "; the sound stays with %s" % j["voice"] if j.get("voice") else ""))
    lines.append("frames %d" % result["frames"])
    return "\n".join(lines)
