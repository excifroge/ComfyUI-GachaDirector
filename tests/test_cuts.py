"""gd_cuts: where a take really cuts, and how picks from several takes are cut together.

    python tests/test_cuts.py          (from the package directory; plain Python is enough)
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("gd_cuts", os.path.join(HERE, "..", "gd_cuts.py"))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)

failed = []


def check(name, got, want):
    if got != want:
        failed.append(name)
        print("FAIL %s\n   got  %r\n   want %r" % (name, got, want))


def take(n, cuts, usual=2.0, big=30.0, **more):
    """Changes of a take of n frames that cuts at `cuts`; `more` sets single frames."""
    out = [usual] * n
    out[0] = 0.0
    for f in cuts:
        out[f] = big
    for f, v in more.items():
        out[int(f[1:])] = v
    return out


# ---------------------------------------------------------------- finding a cut
ch = take(243, [63, 118, 182])
check("the cut nearest the frame asked for", C.find_cut(ch, 61, 31, 91), 63)
check("a cut that came early", C.find_cut(ch, 122, 92, 152), 118)
check("nothing in the window is a cut", C.find_cut(take(243, []), 122, 92, 152), None)
check("a cut outside the window is not this one", C.find_cut(ch, 122, 120, 150), None)
check("a busy frame is not a cut", C.find_cut(take(243, [], f100=8.0), 100, 80, 120), None)
check("the larger change wins", C.find_cut(take(243, [118], f125=20.0), 122, 92, 152), 118)
check("among equals, the one nearest what was asked",
      C.find_cut(take(243, [110, 126]), 122, 92, 152), 126)
# a jump the model made inside a shot measures what a cut measures (0.83 beside 0.82 on a real
# take, the cut being the one at 118 of 122 asked)
check("two changes of about one size: the one nearer the frame asked for",
      C.find_cut(take(243, [], f105=30.0, f118=29.6), 122, 92, 152), 118)
check("...also when the nearer one is the larger", C.find_cut(take(243, [], f105=29.6, f118=30.0), 122, 92, 152), 118)
check("...but a change clearly larger is the cut, wherever it is",
      C.find_cut(take(243, [], f105=30.0, f118=24.0), 122, 92, 152), 105)
check("...and one that does not stay is not in it, however large",
      C.find_cut(take(243, [], f105=30.0, f118=29.6, f120=90.0), 122, 92, 152, stays=lambda f: f != 120), 118)
check("a flash is passed over for the cut behind it",
      C.find_cut(take(243, [118], f120=90.0), 122, 92, 152, stays=lambda f: f != 120), 118)
check("only a flash: no cut", C.find_cut(take(243, [], f120=90.0), 122, 92, 152,
                                          stays=lambda f: False), None)
# a take that moves hard from end to end: five times its usual change is more than its cut measures
busy = take(243, [118], usual=8.0)
check("in a busy take the cut is under the bar", C.find_cut(busy, 122, 92, 152), None)
check("...unless a change of that size is worth asking about anyway", C.find_cut(busy, 122, 92, 152, sure=20.0), 118)
check("...which does not make every frame of a quiet take a candidate",
      C.find_cut(take(243, []), 122, 92, 152, sure=20.0), None)
check("an empty window", C.find_cut(ch, 5, 9, 3), None)
check("the first frame is never a cut", C.find_cut(take(20, []), 0, 0, 5), None)

# ---------------------------------------------------------------- the window
P4 = [{"file": "a", "start": 0, "length": 61, "join": "cut"},
      {"file": "b", "start": 61, "length": 61, "join": "cut"},
      {"file": "c", "start": 122, "length": 61, "join": "cut"},
      {"file": "d", "start": 183, "length": 60, "join": "cut"}]
check("from the middle of one shot to the middle of the next", C.window(P4, 1), (31, 91))
check("the same window, asked by the frames cuts are asked at",
      (C.reach_of([61, 122, 183], 61, 243), C.reach_of([61, 122, 183], 183, 243), C.reach_of([122], 122, 243)),
      ((31, 91), (153, 213), (122 - C.CUT_REACH, 122 + C.CUT_REACH)))
long_ = [{"file": "a", "start": 0, "length": 200}, {"file": "b", "start": 200, "length": 162}]
check("and no further than the reach", C.window(long_, 1), (200 - C.CUT_REACH, 200 + C.CUT_REACH))

# ---------------------------------------------------------------- joining at cuts
REAL = {"a": {61: 63}, "b": {61: 64, 122: 116}, "c": {122: 118, 183: 180}, "d": {183: 177}}


def cut_of(file, asked, lo, hi):
    return REAL.get(file, {}).get(asked)


r = C.plan(P4, cut_of)
check("the clip at full length: every frame from one take",
      r["grid"], [{"file": "a", "start": 0, "end": 63}, {"file": "b", "start": 63, "end": 116},
                  {"file": "c", "start": 116, "end": 180}, {"file": "d", "start": 180, "end": 243}])
check("the frames that are neither shot, left out", r["drops"], [[63, 64], [116, 118]])
check("what is left", r["frames"], 240)
check("where the shots start in what is left", r["starts"], [0, 63, 115, 177])
check("a join reports both takes' cuts",
      [(j["kind"], j["a"], j["b"], j["dropped"]) for j in r["joins"]],
      [("cut", 63, 64, 1), ("cut", 116, 118, 2), ("cut", 180, 177, 0)])
# what the dropped frames leave is exactly each take's own shot
left = [f for part in r["grid"] for f in range(part["start"], part["end"])
        if not any(a <= f < b for a, b in r["drops"])]
check("the stretch of take b that is left is its shot 2", [f for f in left if 63 <= f < 118][:1] +
      [f for f in left if 63 <= f < 118][-1:], [64, 115])

# both takes are in the right shot over a stretch of frames: join inside it, nearest the frame asked
both = C.plan(P4[:2], lambda file, asked, lo, hi: {"a": 66, "b": 58}[file])
check("a join where both takes allow it keeps the length", (both["grid"], both["drops"], both["frames"]),
      ([{"file": "a", "start": 0, "end": 61}, {"file": "b", "start": 61, "end": 122}], [], 122))
late = C.plan(P4[:2], lambda file, asked, lo, hi: {"a": 70, "b": 65}[file])
check("...at the nearest frame both allow", late["grid"][0]["end"], 65)

none = C.plan(P4, lambda *a: None)
check("takes without a cut are joined at the frames asked for",
      ([p["end"] for p in none["grid"]], none["drops"], none["frames"]), ([61, 122, 183, 243], [], 243))

same = [dict(p, file="a") for p in P4]
check("one take everywhere: nothing to do",
      (C.plan(same, cut_of)["grid"], [j["kind"] for j in C.plan(same, cut_of)["joins"]]),
      ([{"file": "a", "start": 0, "end": 243}], ["same"] * 3))

mixed = [dict(P4[0]), dict(P4[1], join="continuous"), dict(P4[2]), dict(P4[3], file="c")]
m = C.plan(mixed, cut_of)
check("a continuous join is made at the frame asked for, a cut where the takes cut",
      (m["grid"], m["drops"], [j["kind"] for j in m["joins"]]),
      ([{"file": "a", "start": 0, "end": 61}, {"file": "b", "start": 61, "end": 116},
        {"file": "c", "start": 116, "end": 243}], [[116, 118]], ["continuous", "cut", "same"]))

# a "cut" found on the wrong side squeezes a shot to nothing: back to what was asked
bad = C.plan(P4[:3], lambda file, asked, lo, hi: {("b", 61): 125, ("b", 122): 100}.get((file, asked)))
check("a shot is never lost to its joins",
      ([(p["start"], p["end"]) for p in bad["grid"]], bad["drops"], bad["frames"]),
      ([(0, 61), (61, 122), (122, 183)], [], 183))

check("nothing picked", C.plan([], cut_of),
      {"grid": [], "drops": [], "frames": 0, "starts": [], "guards": [], "sound": [], "joins": []})

# ---------------------------------------------------------------- the sound across a cut
check("left to itself the sound is the picture's own take's, frame for frame",
      C.plan(P4, cut_of)["sound"], C.plan(P4, cut_of)["grid"])
on = [dict(P4[0]), dict(P4[1], sound="continuous"), dict(P4[2]), dict(P4[3], sound="continuous")]
heard = C.plan(on, cut_of)
check("the picture is cut as before", heard["grid"], C.plan(P4, cut_of)["grid"])
check("...and where the sound goes on it stays with the take it was with",
      heard["sound"], [{"file": "a", "start": 0, "end": 116}, {"file": "c", "start": 116, "end": 243}])
check("...which the record says", [j["voice"] for j in heard["joins"]], ["a", "", "c"])
check("...in words", C.describe(heard).split("\n")[0],
      "cut at 61: a cuts at 63, b cuts at 64; 1 frame(s) of neither shot left out; the sound stays with a")
chain = [dict(P4[0])] + [dict(p, sound="continuous") for p in P4[1:]]
check("going on across every cut: one take's sound for the whole clip",
      C.plan(chain, cut_of)["sound"], [{"file": "a", "start": 0, "end": 243}])
# one take for two shots whose own cut is known: when its sound takes over there, it does so at that cut
two = [{"file": "a", "start": 0, "length": 61, "join": "cut"},
       {"file": "c", "start": 61, "length": 61, "join": "cut", "sound": "continuous"},
       {"file": "c", "start": 122, "length": 121, "join": "cut"}]
check("the sound of a take takes over at that take's own cut",
      C.plan(two, lambda f, asked, lo, hi: {("c", 122): 118}.get((f, asked)))["sound"],
      [{"file": "a", "start": 0, "end": 118}, {"file": "c", "start": 118, "end": 243}])
inside = [dict(P4[0]), dict(P4[1], join="continuous", sound="continuous"), dict(P4[2], sound="continuous"), dict(P4[3])]
check("inside a long take the sound is each stretch's own (the render joins it); after it, it can go on",
      C.plan(inside, cut_of)["sound"],
      [{"file": "a", "start": 0, "end": 61}, {"file": "b", "start": 61, "end": 180}, {"file": "d", "start": 180, "end": 243}])

# ---------------------------------------------------------------- long takes and cuts
# a long take divided right after a cut: the cut is looked for as far as the next cut
# allows, not as far as the short stretch reaches
SHORT = [{"file": "a", "start": 0, "length": 61, "join": "cut"},
         {"file": "b", "start": 61, "length": 5, "join": "cut"},
         {"file": "b", "start": 66, "length": 177, "join": "continuous"}]
check("a stretch of a long take does not narrow the search", C.window(SHORT, 1), (31, 97))
far = {"a": 55, "b": 72}
s = C.plan(SHORT, lambda file, asked, lo, hi: far[file] if lo <= far[file] <= hi else None)
check("...so a cut that came late is found, and all of what is neither shot goes",
      (s["drops"], s["frames"]), ([[55, 72]], 243 - 17))
check("between two cuts the search stops half way to each",
      C.window(P4, 2), (122 - 30, 122 + 30))

# what a render must leave alone: the frames either side of every cut
check("the last frame of a shot, the first of the next, and what is left out between them",
      r["guards"], [62, 63, 64, 115, 116, 117, 118, 179, 180])
check("a take's own cut is guarded where the take cuts, or where it was asked to",
      C.plan(same, cut_of)["guards"], [62, 63, 121, 122, 182, 183])
inside = [dict(P4[0]), dict(P4[1], file="a", join="continuous"), dict(P4[2]), dict(P4[3], file="c")]
check("a boundary inside a long take is no cut: nothing to guard there",
      C.plan(inside, cut_of)["guards"], [121, 122, 179, 180])
check("a stretch that lies wholly in what a cut leaves out starts where the next one does",
      s["starts"], [0, 55, 55])
check("a report names what was done",
      C.describe(r).split("\n"),
      ["cut at 61: a cuts at 63, b cuts at 64; 1 frame(s) of neither shot left out",
       "cut at 122: b cuts at 116, c cuts at 118; 2 frame(s) of neither shot left out",
       "cut at 183: c cuts at 180, d cuts at 177", "frames 240"])

if failed:
    print("%d failed" % len(failed))
    sys.exit(1)
print("cut tests: all passed")
