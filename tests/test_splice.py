"""The two splice nodes on made-up takes: frames, sound, and what a cut costs.

    python custom_nodes/ComfyUI-GachaDirector/tests/test_splice.py     (from the ComfyUI root)

No model and no video file: the takes are tensors, handed to the nodes in place of what
they would read from output/. What is at stake: the picks are joined where the takes
really cut, the sound is cut where the picture is, and the face tracker is told where the
clip really cuts.
"""

import importlib.util
import json
import os
import sys

import torch

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for root in (os.getcwd(), os.path.dirname(os.path.dirname(PKG))):
    if os.path.isdir(os.path.join(root, "comfy_execution")) and root not in sys.path:
        sys.path.insert(0, root)
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_faces as FA, gd_frames as FR, gd_splice as SP  # noqa: E402

failed = []
RATE = 24000                     # a thousand samples a frame: sound is easy to count


def check(name, got, want):
    if got != want:
        failed.append(name)
        print("FAIL %s\n   got  %r\n   want %r" % (name, got, want))


def take(n, cuts, base):
    """A take of n frames. Every shot has a picture of its own, blocks of light and dark,
    around a grey of its own (shot k: base + k / 10), and the grey wobbles a little: a cut
    is the only change of what is in the picture. The first pixel carries the grey alone,
    so it says which shot a frame is of. The sound is the frame number, held for the frame."""
    dice = torch.Generator().manual_seed(int(base * 1000) + n)

    def picture():
        blocks = (torch.rand(4, 6, generator=dice) - 0.5) * 0.2
        p = blocks.repeat_interleave(4, 0).repeat_interleave(4, 1)
        p[0, 0] = 0.0
        return p.unsqueeze(-1)

    frames = torch.zeros(n, 16, 24, 3)
    level, shot = base, picture()
    for f in range(n):
        if f in cuts:
            level += 0.1
            shot = picture()
        frames[f] = level + 0.002 * ((f * 7) % 5) + shot
    wave = torch.arange(n).repeat_interleave(RATE // 24).float().unsqueeze(0).repeat(2, 1)
    return frames, wave


TAKES = {"a.mp4": take(243, [63, 118, 182], 0.1), "b.mp4": take(243, [64, 116, 177], 0.5)}
def _load(name, source, start, length, w, h, resize):
    """In place of the file reader: a stretch of a made-up take, and a note of what was
    asked for at full size. Like the reader, it reads to the end when no length is given,
    holds the last frame when the file ends early, and refuses a start past the end."""
    if resize != "decode":
        ASKED.append((name, start, length))
    whole = TAKES[name][0]
    got = whole[start:start + length] if length else whole[start:]
    if not len(got):
        raise ValueError("Gacha Director: %s gave no frames for start=%d length=%s (the file has %d)"
                         % (name, start, length or "all", len(whole)))
    if length and len(got) < length:
        got = torch.cat([got, got[-1:].repeat(length - len(got), 1, 1, 1)])
    return got


ASKED = []
SP.frames_mod.load_frames = _load
SP.read_audio = lambda name, source="output": (TAKES[name][1], RATE)

changes, small = SP.frame_changes(TAKES["a.mp4"][0])
check("a cut is the only large change", [f for f, c in enumerate(changes) if c > 0.05], [63, 118, 182])
# what is measured is the picture, not its brightness: the whole of a shot lit up for a moment
# (lightning) is no change at all, and half as bright again is none either
lit = TAKES["a.mp4"][0].clone()
lit[100:106] = lit[100:106] * 1.5 + 0.2
check("a shot lit up for six frames: no change to speak of, going in or coming out",
      [f for f, c in enumerate(SP.frame_changes(lit)[0]) if c > 0.05], [63, 118, 182])

# ---------------------------------------------------------------- cut together
pieces = [{"file": "a.mp4", "start": 0, "length": 61, "join": "cut"},
          {"file": "b.mp4", "start": 61, "length": 61, "join": "cut"},
          {"file": "a.mp4", "start": 122, "length": 61, "join": "cut"},
          {"file": "a.mp4", "start": 183, "length": 60, "join": "cut"}]
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(pieces), 243, 0, 0)
check("the clip is laid out at its full length", (int(frames.shape[0]), int(audio["waveform"].shape[-1])),
      (243, 243 * 1000))
check("at full size, only the stretches that go into the clip are read",
      ASKED, [("a.mp4", 0, 63), ("b.mp4", 63, 53), ("a.mp4", 116, 127)])
check("a.mp4 cuts at 63 and b.mp4 at 64: one frame of neither; b at 116 and a at 118: two",
      drops["drops"], [[63, 64], [116, 118]])
out = SP.GachaDirectorDropFrames().drop(frames, audio, drops)
pics, sound = out["result"][:2]
check("what is left", (int(pics.shape[0]), out["ui"]["gd_frames"], out["ui"]["gd_starts"], out["result"][2]),
      (240, [240], ["0,63,115,179"], 240))
check("sound is as long as the picture", int(sound["waveform"].shape[-1]), 240 * 1000)
# every frame left is its take's own shot: take a is 0.1 / 0.2 / 0.3 / 0.4, take b 0.5 / 0.6 / ...
# (shots 3 and 4 are both take a: its own cut, at its frame 182, is frame 179 of what is left)
levels = [round(float(pics[f, 0, 0, 0]), 1) for f in (0, 62, 63, 114, 115, 178, 179, 239)]
check("shot 1 of a, shot 2 of b, shots 3 and 4 of a, and nothing else",
      levels, [0.1, 0.1, 0.6, 0.6, 0.3, 0.3, 0.4, 0.4])
mid = lambda f: int(sound["waveform"][0, 0, f * 1000 + 500])       # noqa: E731
check("the sound of a frame is that frame's (source frame numbers)",
      [mid(0), mid(62), mid(63), mid(114), mid(115), mid(239)], [0, 62, 64, 115, 118, 242])
check("a join does not click: the sound starts from nothing on the far side of a cut",
      float(sound["waveform"][0, 0, 63 * 1000]), 0.0)
check("the node says what it did",
      out["ui"]["gd_cuts"][0].split("\n")[0],
      "cut at 61: a.mp4 cuts at 63, b.mp4 cuts at 64; 1 frame(s) of neither shot left out")

# the sound going on across the first cut: the picture is take b's from the cut, the sound stays take a's
carried = [dict(pieces[0]), dict(pieces[1], sound="continuous"), dict(pieces[2]), dict(pieces[3])]
frames2, audio2, drops2 = SP.GachaDirectorCutSplice().splice(json.dumps(carried), 243, 0, 0)
check("the picture does not change with it", bool(torch.equal(frames2, frames)), True)
at = lambda a, f: int(a["waveform"][0, 0, f * 1000 + 500])       # noqa: E731
check("...the sound of shot 2 is take a's, at the same frames; from the next cut on it is that take's own",
      [at(audio2, 62), at(audio2, 64), at(audio2, 100), at(audio2, 115), at(audio2, 120)], [62, 64, 100, 115, 120])
check("...and no fade where the sound does not change take",
      float(audio2["waveform"][0, 0, 63 * 1000 + 1]) > 0.0, True)
out2 = SP.GachaDirectorDropFrames().drop(frames2, audio2, drops2)
check("...picture and sound are still one length", (int(out2["result"][0].shape[0]),
      int(out2["result"][1]["waveform"].shape[-1])), (240, 240 * 1000))

# nothing to leave out: the frames go through untouched
same = [dict(p, file="a.mp4") for p in pieces]
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(same), 243, 0, 0)
out = SP.GachaDirectorDropFrames().drop(frames, audio, drops)
check("one take everywhere comes back as it is",
      (bool(torch.equal(out["result"][0], TAKES["a.mp4"][0])), out["ui"]["gd_frames"]), (True, [243]))

# a take without sound is silence, as long as its picture
SP.read_audio = lambda name, source="output": (None, 0) if name == "b.mp4" else (TAKES[name][1], RATE)
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(pieces), 243, 0, 0)
check("a silent take is silence of the right length",
      (int(audio["waveform"].shape[-1]), float(audio["waveform"][0, 0, 90 * 1000])), (243 * 1000, 0.0))

# sound at another rate is brought to the clip's, not dropped
half = TAKES["b.mp4"][1][:, ::2]
SP.read_audio = lambda name, source="output": (half, RATE // 2) if name == "b.mp4" else (TAKES[name][1], RATE)
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(pieces), 243, 0, 0)
check("a take at half the sample rate still sounds, at the clip's rate",
      (int(audio["waveform"].shape[-1]), round(float(audio["waveform"][0, 0, 90 * 1000 + 500]))),
      (243 * 1000, 90))
SP.read_audio = lambda name, source="output": (TAKES[name][1], RATE)

# takes of two sizes come to the larger: frames of two sizes cannot follow one another
big = torch.nn.functional.interpolate(TAKES["b.mp4"][0].movedim(-1, 1), size=(32, 48)).movedim(1, -1)
TAKES["b.mp4"] = (big, TAKES["b.mp4"][1])
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(pieces), 243, 0, 0)
check("a small take and a large one: one clip, at the larger size",
      (tuple(frames.shape), drops["note"].split("\n")[-1]),
      ((243, 32, 48, 3), "takes of 24x16, 48x32: all brought to 48x32"))
check("...and the cuts are found all the same", drops["drops"], [[63, 64], [116, 118]])
TAKES["b.mp4"] = take(243, [64, 116, 177], 0.5)

# ---------------------------------------------------------------- a flash is not a cut
flash = TAKES["a.mp4"][0].clone()
flash[100:103] = 1.0                       # three white frames in the first shot's... third shot
ch, sm = SP.frame_changes(flash)
stays = SP._stays(sm, ch)
check("going into a flash of three frames and coming out of it: neither stays",
      (stays(100), stays(103), stays(118)), (False, False, True))
# four dark frames just before the cut that is asked for, and the take's cut eleven frames on:
# half of the eight frames on one side are the flash, and "most of them" must not be it
dark = take(243, [72, 130, 190], 0.1)[0]
dark[58:62] = 0.0
ch, sm = SP.frame_changes(dark)
stays = SP._stays(sm, ch)
check("a flash of four dark frames is not a cut on either side",
      (stays(58), stays(62), stays(72)), (False, False, True))
check("...and the cut behind it is the one found",
      SP.cuts.find_cut(ch, 61, 31, 91, stays=stays), 72)
bright = TAKES["a.mp4"][0].clone()
bright[112:117] = bright[112:117] * 1.5 + 0.2            # five frames lit up, right up to the cut at 118
ch, sm = SP.frame_changes(bright)
stays = SP._stays(sm, ch)
check("a shot lit up for five frames right up to a cut: the cut is the one found",
      SP.cuts.find_cut(ch, 122, 92, 152, stays=stays), 118)
# a burst that shows another picture for ten frames (lightning in a dark shot shows what was
# not to be seen), then the shot again: on either side of it the picture goes back to what
# it was a little further on, which after a cut it does not
burst = take(243, [72, 130, 190], 0.1)[0]
other = take(243, [], 0.3)[0][:10]
burst[50:60] = other
ch, sm = SP.frame_changes(burst)
stays = SP._stays(sm, ch)
check("ten frames of another picture and back: neither end is a cut",
      (stays(50), stays(60), stays(72)), (False, False, True))
check("...and the cut after it is found", SP.cuts.find_cut(ch, 61, 31, 91, stays=stays), 72)

# ---------------------------------------------------------------- a take of another length
TAKES["short.mp4"] = take(200, [63, 118, 182], 0.1)
try:
    SP.GachaDirectorCutSplice().splice(json.dumps([dict(pieces[0]), dict(pieces[1], file="short.mp4"),
                                                dict(pieces[2]), dict(pieces[3])]), 243, 0, 0)
    failed.append("a take shorter than the clip should be refused")
except ValueError as exc:
    check("a take shorter than the clip is refused, and the message says why",
          ("short.mp4 is 200 frames long and the clip is 243" in str(exc)), True)
TAKES["long.mp4"] = take(260, [64, 116, 177], 0.5)
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(
    [dict(pieces[0]), dict(pieces[1], file="long.mp4"), dict(pieces[2]), dict(pieces[3])]), 243, 0, 0)
check("a take longer than the clip is used as far as the clip goes",
      (int(frames.shape[0]), drops["drops"]), (243, [[63, 64], [116, 118]]))

# ---------------------------------------------------------------- sound shorter than the picture
frames, audio, drops = SP.GachaDirectorCutSplice().splice(json.dumps(pieces), 243, 0, 0)
clipped = {"waveform": audio["waveform"][..., :100 * 1000], "sample_rate": RATE}
out = SP.GachaDirectorDropFrames().drop(frames, clipped, drops)
check("sound that ends early is filled with silence to the picture's length, and nothing breaks",
      (int(out["result"][0].shape[0]), int(out["result"][1]["waveform"].shape[-1]),
       float(out["result"][1]["waveform"][0, 0, 200 * 1000])), (240, 240 * 1000, 0.0))
few = {"waveform": audio["waveform"][..., :243 * 1000 - 266], "sample_rate": RATE}
out = SP.GachaDirectorDropFrames().drop(frames, few, drops)
check("sound a few milliseconds short of its picture comes out as long as the picture",
      int(out["result"][1]["waveform"].shape[-1]), 240 * 1000)

# ---------------------------------------------------------------- what a render may free
from gdpkg import gd_internal as IN  # noqa: E402
mask = IN.GachaDirectorTimeMask().build(243, "free_cells", "3,4,5", "", 1, keep={"guards": [68, 69]})
check("a cell that holds a real cut stays as it is",
      [line.split()[1] for line in mask[2].split("\n") if "FREE" in line], ["3", "5"])
mask = IN.GachaDirectorTimeMask().build(243, "free_cells", "3,4,5", "", 1)
check("without takes to ask, the cells are the document's",
      [line.split()[1] for line in mask[2].split("\n") if "FREE" in line], ["3", "4", "5"])

# ---------------------------------------------------------------- where a clip really cuts
check("the face tracker is told the real cuts, not the ones asked for",
      FA.real_cuts(TAKES["a.mp4"][0], [61, 122, 183]), [63, 118, 182])
check("a cut that is not there stays where it was asked", FA.real_cuts(TAKES["a.mp4"][0], [20]), [20])
check("no cuts asked, none found", FA.real_cuts(TAKES["a.mp4"][0], []), [])
# (a joined clip can have a shot of which nothing is left: two boundaries on one frame)
check("boundaries given twice stay two, so the shots after them keep their numbers",
      FA.real_cuts(TAKES["a.mp4"][0], [61, 61, 122, 183]), [63, 63, 118, 182])
check("...also where one of the two is inside a long take",
      FA.real_cuts(TAKES["a.mp4"][0], [61, 183], [61, 122]), [63, 63, 122, 182])
# boundaries inside a long take: no cut is looked for there, and they do not narrow the search
check("a boundary inside a long take stays where it is",
      FA.real_cuts(TAKES["a.mp4"][0], [61, 183], [122]), [63, 122, 182])
check("...even with a real cut next to it (that one belongs to the cut asked for)",
      FA.real_cuts(TAKES["a.mp4"][0], [122], [116]), [116, 118])
late = take(243, [72], 0.1)[0]
check("a cut that comes after the boundary behind it: the boundary moves up to it, never before",
      FA.real_cuts(late, [61], [66]), [72, 72])
from gdpkg import gd_faces  # noqa: E402
track = gd_faces.main_track([[] for _ in range(243)], [72, 72], 24, 16)
check("a shot with no frames left is still a shot: the ones after it keep their numbers",
      [(s["start"], s["end"]) for s in track["shots"]], [(0, 72), (72, 72), (72, 243)])

# ---------------------------------------------------------------- what is a cut and what is not
def still(seed, n, level=0.4):
    """n frames of one picture."""
    dice = torch.Generator().manual_seed(seed)
    blocks = (torch.rand(4, 6, generator=dice) - 0.5) * 0.2
    p = blocks.repeat_interleave(4, 0).repeat_interleave(4, 1)
    return (level + p).unsqueeze(-1).repeat(n, 1, 1, 3)


# a shot of ten frames that is cut to and cut back from, with the same picture on either side
aba = torch.cat([still(1, 40), still(2, 10), still(1, 193)])
check("a ten-frame shot the document asks for is a shot: both its cuts are found",
      FA.real_cuts(aba, [40, 50]), [40, 50])
check("...the same ten frames with no cut asked there are passed over, like a burst of light",
      FA.real_cuts(aba, [45]), [45])
# one picture fading in: every change is many times the usual one, and none of them is a cut
fade = still(3, 243) * torch.linspace(0.0, 1.0, 243).view(-1, 1, 1, 1)
check("a picture fading in has no cut", FA.real_cuts(fade, [61, 122, 183]), [61, 122, 183])
# light flickering between two pictures frame by frame, the shot again, then a cut
flick = torch.cat([still(4, 100), torch.cat([still(4 if i % 2 else 5, 1) for i in range(12)]),
                   still(4, 8), still(6, 123)])
ch, sm = SP.frame_changes(flick)
stays = SP._stays(sm, ch)
check("flicker: no frame of it is a cut", [f for f in range(100, 113) if stays(f)], [])
check("...and the cut after it is found", FA.real_cuts(flick, [122]), [120])
# The case a real take showed: lightning in a dark shot shows something else in every frame of
# it (frames 109-111 and 113-118), the shot is itself again for four frames, and then it is cut
# from. The lightning is no cut and the cut is found; what told them apart on the real take is
# that the two sides of a cut are each one picture, further apart from each other than the
# frames of either wobble among themselves.
lit = iter(range(200, 300))
storm = torch.cat([still(9, 109)] + [still(next(lit), 1) for _ in range(3)] + [still(9, 1)]
                  + [still(next(lit), 1) for _ in range(6)] + [still(9, 4), still(10, 120)])
ch, sm = SP.frame_changes(storm)
stays = SP._stays(sm, ch)
check("lightning that ends four frames before a cut is no cut, and the cut is one",
      (stays(113), stays(123)), (False, True))
check("...the two sides of the lightning wobble more than they differ; the cut's do not",
      (SP._apart(sm, 113) < 1.0, SP._apart(sm, 123) > 10 * SP.APART), (True, True))
check("...so the cut is the one found", FA.real_cuts(storm, [122]), [123])

if failed:
    print("%d failed" % len(failed))
    sys.exit(1)
print("splice tests: all passed")
