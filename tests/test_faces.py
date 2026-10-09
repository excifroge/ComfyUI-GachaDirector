"""Face refine without a detector or a model: the track, the cut-out, the way back.

    python tests/test_faces.py

What is at stake: the region must stay on one face (not hop between two), must never
follow a face across a cut, must leave alone a shot in which no face is really there, and
cutting out followed by putting back must give the frame back as it was.
"""

import importlib.util
import os
import sys

import torch

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gd_faces", os.path.join(PKG, "gd_faces.py"))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)

failed = []


def check(name, got, want):
    if got != want:
        failed.append("%s: got %r, want %r" % (name, got, want))


def ok(name, cond):
    if not cond:
        failed.append(name)


def face(cx, cy, side, score=0.9):
    return (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2, score)


W, H = 640, 360

# ---------------------------------------------------------------- one face, walking right
dets = [[face(100 + 4 * f, 180, 40)] for f in range(40)]
t = F.main_track(dets, [], W, H, pad=2.0)
def shots(track):
    return [(s["start"], s["end"], s["ok"]) for s in track["shots"]]


check("every frame of the shot is refined", (all(t["valid"]), t["seen"], shots(t)), (True, 40, [(0, 40, True)]))
ok("the cut-out is two face sizes a side", all(abs(b[2] - 80) < 1e-6 for b in t["boxes"]))
mid = t["boxes"][20]
ok("and is centred on the face", abs(mid[0] + 40 - 180) < 1.0 and abs(mid[1] + 40 - 180) < 1e-6)
steps = [t["boxes"][f + 1][0] - t["boxes"][f][0] for f in range(8, 30)]
ok("it moves with the face, smoothly", all(abs(s - 4) < 1e-6 for s in steps))
ok("boxes are not rounded to whole pixels",
   any(abs(b[0] - round(b[0])) > 1e-3 for b in F.main_track(
       [[face(100.3 + 0.37 * f, 180, 40)] for f in range(40)], [], W, H)["boxes"]))

# ---------------------------------------------------------------- held inside the frame
t = F.main_track([[face(10, 10, 40)] for _ in range(10)], [], W, H, pad=2.0)
check("a face in the corner: the cut-out stays inside the frame", t["boxes"][0], (0.0, 0.0, 80.0))
t = F.main_track([[face(300, 180, 12)] for _ in range(10)], [], W, H, pad=2.0, only={1})
check("a very small face: the cut-out is at least a fifth of the frame's short edge",
      t["boxes"][0], (264.0, 144.0, 72.0))

# ---------------------------------------------------------------- which faces are worth it
dets = ([[face(300, 180, 14)] for _ in range(20)] + [[face(300, 180, 40)] for _ in range(20)]
        + [[face(300, 180, 160)] for _ in range(20)] + [[] for _ in range(20)])
t = F.main_track(dets, [20, 40, 60], W, H)
check("left to itself, the tracker refines the faces that gain from it",
      [(s["ok"], s["why"], s["face"]) for s in t["shots"]],
      [(False, "small", 14), (True, "", 40), (False, "large", 160), (False, "none", 0)])
ok("and says what it left alone, and why",
   F.describe(t) == "face refine: a face in 60 of 80 frames; shot(s) 2 refined (20 frames), cut out at "
                    "80-80 px a side; shot 1 left alone: its face is 14 px, too small to gain from it; "
                    "shot 3 left alone: its face is 160 px, clear enough already; "
                    "shot 4 left alone: no face found in it")
t = F.main_track(dets, [20, 40, 60], W, H, only={1, 3, 4})
check("shots named by hand are refined whatever the size of the face, if there is one",
      [(s["ok"], s["why"]) for s in t["shots"]],
      [(True, ""), (False, "skipped"), (True, ""), (False, "none")])
check("when every face is of a size that gains nothing, that is what it says",
      F.describe(F.main_track([[face(300, 180, 200)] for _ in range(10)], [], W, H)),
      "face refine: nothing to refine; shot 1 left alone: its face is 200 px, clear enough already")
t = F.main_track([[face(320, 180, 300)] for _ in range(10)], [], W, H, pad=2.0, only={1})
check("a face filling the frame: the cut-out is no larger than the frame",
      t["boxes"][0], (140.0, 0.0, 360.0))

# ---------------------------------------------------------------- two people
dets = []
for f in range(30):
    a = face(150, 180, 60, 0.9)
    b = face(450, 180, 60 + (6 if f % 2 else -6), 0.9)      # now larger, now smaller
    dets.append([a, b])
for f in range(0, 30, 3):
    dets[f] = dets[f][:1]                                    # the second is not always seen
t = F.main_track(dets, [], W, H)
ok("one of two faces is followed (the one seen longest), not whichever is larger in a frame",
   all(abs(b[0] + b[2] / 2 - 150) < 2 for b in t["boxes"]))

# ---------------------------------------------------------------- a small face and a false alarm
dets = [[face(400 + f, 165, 14, 0.9)] for f in range(60)]
for f in (20, 21, 22):
    dets[f] = dets[f] + [face(560, 130, 120, 0.95)]          # a rock, for three frames
t = F.main_track(dets, [], W, H, pad=2.0, smooth=0, only={1})
ok("a small face seen throughout is the main one, not a large thing seen for a moment",
   all(t["valid"]) and all(abs(b[0] + b[2] / 2 - (400 + f)) < 1e-6 for f, b in enumerate(t["boxes"])))
dets = [[face(300, 100, 200, 0.9)] if f % 4 == 0 else [] for f in range(60)]
check("something seen in a quarter of a shot's frames is not taken for a face",
      (shots(F.main_track(dets, [], W, H)), F.MIN_SHARE), ([(0, 60, False)], 0.4))

# ---------------------------------------------------------------- sightings missing
dets = [[face(200 + 2 * f, 180, 50)] if f % 2 == 0 else [] for f in range(41)]
t = F.main_track(dets, [], W, H, smooth=0)
check("a face seen in every other frame is followed", (all(t["valid"]), t["seen"]), (True, 21))
ok("between two sightings the cut-out moves in a straight line",
   abs(t["boxes"][11][0] + t["boxes"][11][2] / 2 - 222) < 1e-6)
dets = [[face(100, 100, 40)] for _ in range(20)] + [[face(500, 250, 60)] for _ in range(20)]
t = F.main_track(dets, [20], W, H, only={2})
check("only the shots asked for are refined", shots(t), [(0, 20, False), (20, 40, True)])

# ---------------------------------------------------------------- a face that goes away
dets = [[face(300, 180, 50)] if f < 50 else [] for f in range(100)]
t = F.main_track(dets, [], W, H)
check("where the face is, the region is put back whole", (t["weight"][0], t["weight"][49]), (1.0, 1.0))
ok("it fades over a few frames after the last sighting",
   1.0 > t["weight"][50] > t["weight"][53] > 0.0 and t["weight"][49 + F.EDGE + 1] == 0.0)
check("and where the face is not, nothing is put back", (t["weight"][70], t["valid"][70], t["valid"][10]),
      (0.0, False, True))
dets = [[face(300, 180, 50)] if f < 30 or f >= 70 else [] for f in range(100)]
t = F.main_track(dets, [], W, H)
ok("a face that looks away and comes back is not painted on while it is away",
   t["weight"][50] == 0.0 and t["weight"][29] == 1.0 and t["weight"][70] == 1.0)
check("and it is one face before and after", (t["seen"], shots(t)), (60, [(0, 100, True)]))
dets = [[face(100, 180, 50)] if f < 30 else [face(520, 180, 50)] if f >= 70 else [] for f in range(100)]
t = F.main_track(dets, [], W, H)
check("somebody else, seen later somewhere else, is not that face", (t["seen"], shots(t)), (30, [(0, 100, False)]))
dets = [[face(300, 180, 50)] if f % 10 == 0 else [] for f in range(0, 100)]
dets[0] = [face(300, 180, 50)]
t = F.main_track([d if i % 2 == 0 or d else d for i, d in enumerate(
    [[face(300, 180, 50)] if f % 2 == 0 else [] for f in range(100)])], [], W, H)
ok("a face missed in a frame here and there is there all along", min(t["weight"][:99]) == 1.0)

# ---------------------------------------------------------------- shots
dets = [[face(100, 100, 40)] for _ in range(20)] + [[face(500, 250, 60)] for _ in range(20)]
t = F.main_track(dets, [20], W, H, pad=2.0)
check("a cut: each shot has its own cut-out, with nothing blended across",
      (t["boxes"][19], t["boxes"][20]), ((60.0, 60.0, 80.0), (440.0, 190.0, 120.0)))
dets = [[face(100, 100, 40)] for _ in range(20)] + [[] for _ in range(20)]
dets[25] = [face(300, 200, 30)]                              # a false alarm in one frame
t = F.main_track(dets, [20], W, H)
check("a shot without a face is left alone",
      (shots(t), t["valid"][19], t["valid"][20], t["valid"][25]),
      ([(0, 20, True), (20, 40, False)], True, False, False))
check("faces below the score asked for do not count",
      any(F.main_track([[face(100, 100, 40, 0.4)] for _ in range(10)], [], W, H)["valid"]), False)
ok("the report says what was done, and names the shot without a face",
   F.describe(t) == "face refine: a face in 21 of 40 frames; shot(s) 1 refined (20 frames), cut out at "
                    "80-80 px a side; shot 2 left alone: no face found in it")
check("and when there is nothing", F.describe(F.main_track([[]] * 5, [], W, H)),
      "face refine: nothing to refine; shot 1 left alone: no face found in it")

# ---------------------------------------------------------------- cut out, put back
torch.manual_seed(1)
ys, xs = torch.meshgrid(torch.arange(H), torch.arange(W), indexing="ij")
frame = torch.stack([(xs / W), (ys / H), 0.5 + 0.5 * torch.sin((xs + ys) / 9.0)], dim=-1)   # ramps and a wave
frames = frame[None].repeat(4, 1, 1, 1).float()
t = F.main_track([[face(300.4 + f, 170.7, 60)] for f in range(4)], [], W, H, pad=2.0, smooth=0)
crops = F.crop_regions(frames, t, 256, 256)
check("the cut-outs are the size asked for", tuple(crops.shape), (4, 256, 256, 3))
x0, y0, s = t["boxes"][0]
u = (10 + 0.5) / 256 * s + x0                                  # where output pixel 10 looks
ok("a cut-out shows the box it was cut from",
   abs(float(crops[0, 128, 10, 0]) - (u - 0.5) / W) < 2e-3)
back = F.paste_regions(frames, crops, t, feather=0.15)
worst = float((back - frames).abs().max())
ok("cutting out and putting back gives the frame back (worst pixel off by %.4f)" % worst, worst < 0.02)
ok("exactly so outside the box", float((back[0, :, :200] - frames[0, :, :200]).abs().max()) == 0.0)
red = torch.zeros_like(crops)
red[..., 0] = 1.0
out = F.paste_regions(frames, red, t, feather=0.15)
cx, cy = round(x0 + s / 2), round(y0 + s / 2)
ok("what was generated is what is seen in the middle of the box",
   float((out[0, cy, cx] - torch.tensor([1.0, 0.0, 0.0])).abs().max()) < 1e-4)
edge = out[0, cy, round(x0) + 1]
ok("and the frame is what is seen at its edge", float((edge - frames[0, cy, round(x0) + 1]).abs().max()) < 0.02)
t2 = dict(t, valid=[True, False, True, True], weight=[1.0, 0.0, 0.5, 1.0])
out = F.paste_regions(frames, red, t2)
ok("a frame that is not to be refined comes through untouched", bool((out[1] == frames[1]).all()))
half = out[2, cy, cx + 2]
ok("a frame in which the face is fading is half the frame, half what was generated",
   abs(float(half[0]) - (0.5 + 0.5 * float(frames[2, cy, cx + 2, 0]))) < 0.02)
# no dark rim: a white frame, cut out and put back, is white everywhere, however thin the edge
white = torch.ones(1, 64, 96, 3)
for box, feather in (((0.3, 0.3, 31.3), 0.02), ((0.0, 0.0, 64.0), 0.15), ((40.6, 10.2, 50.0), 0.05)):
    tw = {"boxes": [box], "valid": [True], "weight": [1.0], "size": (96, 64)}
    again = F.paste_regions(white, F.crop_regions(white, tw, 128, 128), tw, feather=feather)
    ok("a white frame stays white round the region %s at feather %s (darkest %.4f)"
       % (box, feather, float(again.min())), float(again.min()) > 0.999)

if failed:
    print("\n".join(failed))
    print("faces: %d failed" % len(failed))
    sys.exit(1)
print("face tests: all passed")
