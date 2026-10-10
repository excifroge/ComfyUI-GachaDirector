r"""What the node expands into, checked without a GPU.

1. The expansion names nothing outside ComfyUI core and this package.
2. Every way of driving the model lands on the right conditioning nodes, wired in the
   order the prompt numbers things in.
3. The bundled planner files still match the bytes recorded in vendor/UPSTREAM.json.

Run from the ComfyUI root:  python custom_nodes/ComfyUI-GachaDirector/tests/test_expand.py
(expanding a graph needs ComfyUI's own comfy_execution module on the path).
"""
import hashlib
import importlib.util
import json
import os
import sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for root in (os.getcwd(), os.path.dirname(os.path.dirname(PKG))):
    if os.path.isdir(os.path.join(root, "comfy_execution")) and root not in sys.path:
        sys.path.insert(0, root)
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_director as D, gd_presets as P, gd_schema as S  # noqa: E402

F = []


def bad(msg):
    F.append(msg)


def check(name, got, want):
    if got != want:
        bad(f"{name}: got {got!r}, want {want!r}")


# ---------------------------------------------------------------- 1. vendored bytes
manifest = json.load(open(os.path.join(PKG, "vendor", "UPSTREAM.json"), encoding="utf-8"))
for name, rec in manifest["files"].items():
    path = os.path.join(PKG, "vendor", name)
    if not os.path.isfile(path):
        bad(f"vendor/{name} is missing")
        continue
    data = open(path, "rb").read()
    if hashlib.sha256(data).hexdigest() != rec["sha256"]:
        bad(f"vendor/{name} no longer matches the sha256 in UPSTREAM.json")

# ---------------------------------------------------------------- 2. expansion
#: Everything the expansion is allowed to emit. Core nodes are listed by name rather than
#: probed, so this says something even when ComfyUI is not running.
CORE = {
    "BasicGuider", "BasicScheduler", "CFGGuider", "CLIPTextEncode", "CreateVideo",
    "AudioConcat", "ImageBatch", "ImageScale", "KSamplerSelect", "LoadAudio", "LoadImage",
    "LTXVConcatAVLatent", "LTXVSeparateAVLatent", "MiniMaxH3AddGuide",
    "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "MiniMaxH3SigmaShift",
    "RandomNoise", "SamplerCustomAdvanced", "SaveVideo", "SetLatentNoiseMask",
    "TrimAudioDuration", "VAEDecode", "VAEDecodeAudio", "VAEEncode", "VAEEncodeAudio",
}
OURS = set(gdpkg.NODE_CLASS_MAPPINGS) | {"GachaDirectorPreview"}

D.internal.total_vram_bytes = lambda: 48 * 1024 ** 3
D._known_nodes = lambda: None          # no ComfyUI is running here: nothing to ask
D._probe = lambda name: {"frames": 240, "frames24": 240, "fps": 24.0, "width": 1280,
                         "height": 720, "audio": True}


def expand(doc, params=None, **kw):
    store = P.empty()
    store["active"] = "standard"
    if params:
        for p in store["presets"]:
            if p["id"] == "standard":
                p["params"].update(params)
    args = {"model": "M", "clip": "C", "vae": "V", "audio_vae": "AV",
            "gd_timeline": json.dumps(doc), "gd_post": "{}",
            "gd_presets": json.dumps(store), "preset": "standard", "seed": 7}
    args.update(kw)
    problems = S.problems(S.normalize(doc))
    if problems:
        raise AssertionError("document does not validate: %s" % problems)
    return D.GachaDirector().run(**args)


def kinds(graph):
    out = {}
    for n in graph.values():
        out[n["class_type"]] = out.get(n["class_type"], 0) + 1
    return out


def only(graph, class_type):
    hits = [n for n in graph.values() if n["class_type"] == class_type]
    if len(hits) != 1:
        bad(f"expected exactly one {class_type}, found {len(hits)}")
        return {"inputs": {}}
    return hits[0]


SHOTS = [{"length": 60, "text": "A red kite climbs over a beach."},
         {"length": 64, "text": "It dives toward the water."}]

cases = {}

# --- base family
cases["t2v"] = {"family": "base", "prompt": {"global": "Live-action.", "shots": SHOTS}}
cases["i2v"] = {**cases["t2v"], "anchors": [
    {"kind": "image", "file": "a.png", "frame": 0, "pin": True, "cite": True}]}
cases["fl2v"] = {**cases["t2v"], "anchors": [
    {"kind": "image", "file": "a.png", "frame": 0, "pin": True, "cite": True},
    {"kind": "image", "file": "b.png", "frame": -1, "pin": True, "cite": True}]}
cases["keyframes"] = {**cases["t2v"], "prompt": {"mode": "raw", "raw": "trigger, a kite"},
                      "anchors": [
    {"kind": "image", "file": "a.png", "frame": 0},
    {"kind": "image", "file": "b.png", "frame": 52},
    {"kind": "image", "file": "c.png", "frame": -1}]}
cases["continuation"] = {**cases["t2v"], "anchors": [
    {"kind": "clip", "file": "prev.mp4", "frame": 0, "clip_start": 100, "clip_length": 22,
     "with_audio": True}]}
cases["v2v_base"] = {**cases["t2v"], "source": {"video": "src.mp4", "as_latent": True,
                                                "as_reference": False, "denoise": 0.6}}

# --- reference family
cases["r2v"] = {"family": "reference", "prompt": {"shots": SHOTS}, "subjects": [
    {"images": ["hero.png", "hero_back.png"], "description": "a boy in a red cape"},
    {"images": ["dragon.png"], "kind": "animal"}]}
cases["r2v_av"] = {**cases["r2v"],
                   "videos": [{"file": "move.mp4", "audio": True}],
                   "audio": [{"file": "voice.wav", "subject": "s1"}]}
cases["multiframe"] = {**cases["r2v"], "anchors": [
    {"kind": "image", "file": "k0.png", "frame": 0, "pin": True, "cite": True},
    {"kind": "image", "file": "k1.png", "frame": 36, "pin": True},
    {"kind": "image", "file": "k2.png", "frame": -1, "pin": True}]}
cases["edit"] = {"family": "reference", "prompt": {"shots": SHOTS},
                 "source": {"video": "src.mp4", "as_latent": False, "as_reference": True,
                            "role": "edit"}}
cases["edit_locked"] = {"family": "reference", "prompt": {"shots": SHOTS},
                        "source": {"video": "src.mp4", "as_latent": True, "denoise": 0.2,
                                   "as_reference": True, "role": "edit"},
                        "anchors": [
                            {"file": "first.png", "frame": 0, "pin": False, "cite": True},
                            {"file": "last.png", "frame": -1, "pin": False, "cite": True}]}
cases["composite"] = {**cases["edit_locked"],
                      "source": {**cases["edit_locked"]["source"], "splice": [
                          {"file": "a.mp4", "start": 0, "length": 60, "take": "t1"},
                          {"file": "b.mp4", "start": 60, "length": 64, "take": "t2"}]},
                      "mask": {"mode": "seam_repair", "cut_frames": "60", "radius": 1,
                               "seam_denoise": 0.3}}

# every join a cut: the takes are put one after the other and nothing is rendered
cases["composite_cuts"] = {"family": "reference", "prompt": {"shots": SHOTS},
                           "source": {"splice": [
                               {"file": "a.mp4", "start": 0, "length": 60, "take": "t1"},
                               {"file": "b.mp4", "start": 60, "length": 64, "take": "t2"}]},
                           "mask": {"mode": "seam_repair", "cut_frames": "", "radius": 1}}

results = {}
for label, doc in cases.items():
    try:
        results[label] = expand(doc)
    except Exception as exc:  # noqa: BLE001 - report every case, not just the first
        bad(f"{label}: {type(exc).__name__}: {exc}")
        continue
    graph = results[label]["expand"]
    names = set(kinds(graph))
    outside = sorted(names - CORE - OURS)
    if outside:
        bad(f"{label}: the graph names {outside}, which is outside ComfyUI core and this package")
    print(f"{label:13s} {len(graph):2d} nodes  " + ", ".join(
        f"{k}x{v}" if v > 1 else k for k, v in sorted(kinds(graph).items())
        if k.startswith(("MiniMaxH3", "GachaDirector", "LTXV", "SetLatent", "Load", "CFG", "Basic"))))


def graph_of(label):
    return results.get(label, {}).get("expand", {})


# base: text only
g = graph_of("t2v")
i2v = only(g, "MiniMaxH3ImageToVideo")["inputs"]
check("t2v has no frames", [k for k in i2v if k.endswith("_frame")], [])
check("t2v prompt opens with the body", i2v.get("prompt", "").startswith(
    "integrated_multimodal_description:"), True)
check("t2v length", i2v.get("length"), 124)
check("t2v canvas (16:9 at 0.4 MP)", (i2v.get("width"), i2v.get("height")), (864, 480))
check("t2v samples from the empty latent at denoise 1",
      only(g, "BasicScheduler")["inputs"].get("denoise"), 1.0)
check("t2v uses BasicGuider", "CFGGuider" in kinds(g), False)

# base: first frame, cited -> the conditioning node's own input, with the official sentence
i2v = only(graph_of("i2v"), "MiniMaxH3ImageToVideo")["inputs"]
check("i2v first frame wired", "first_frame" in i2v and "last_frame" not in i2v, True)
check("i2v instruction line", i2v.get("prompt", "").split("\n")[0],
      "For the target video, at 0.00 seconds into the target video, <Picture 1> "
      "(from [Shot 1]) is fully referenced.")
check("i2v emits no guide", "MiniMaxH3AddGuide" in kinds(graph_of("i2v")), False)

i2v = only(graph_of("fl2v"), "MiniMaxH3ImageToVideo")["inputs"]
check("fl2v both frames wired", "first_frame" in i2v and "last_frame" in i2v, True)
check("fl2v instruction line", i2v.get("prompt", "").startswith(
    "How the reference pictures align with the target video — Picture 1 (from Shot 1)"), True)

# base: pinned-only keyframes -> Add Guide chain, raw prompt sent as written
g = graph_of("keyframes")
check("keyframes: three guides", kinds(g).get("MiniMaxH3AddGuide"), 3)
check("keyframes: raw prompt", only(g, "MiniMaxH3ImageToVideo")["inputs"].get("prompt"),
      "trigger, a kite")
check("keyframes: frames", sorted(n["inputs"]["frame_idx"] for n in g.values()
                                  if n["class_type"] == "MiniMaxH3AddGuide"), [0, 52, 123])

# base: continuation = a clip with its soundtrack pinned at frame 0
g = graph_of("continuation")
guide = only(g, "MiniMaxH3AddGuide")["inputs"]
check("continuation: clip and audio", "image" in guide and "audio" in guide, True)
loader = [n for n in g.values() if n["class_type"] == "GachaDirectorLoadFrames"][0]["inputs"]
check("continuation: clip range", (loader["start"], loader["length"]), (100, 22))
trim = only(g, "TrimAudioDuration")["inputs"]
check("continuation: audio range in seconds",
      (trim["start_index"], trim["duration"]), (round(100 / 24, 4), round(22 / 24, 4)))

# base: source clip in the latent
g = graph_of("v2v_base")
check("v2v_base: latent from the clip", kinds(g).get("VAEEncode"), 1)
check("v2v_base: denoise from the source", only(g, "BasicScheduler")["inputs"].get("denoise"), 0.6)
check("v2v_base: canvas follows the source aspect",
      (only(g, "MiniMaxH3ImageToVideo")["inputs"]["width"],
       only(g, "MiniMaxH3ImageToVideo")["inputs"]["height"]), (864, 480))

# reference: subjects in <Picture N> order
r2v = only(graph_of("r2v"), "MiniMaxH3ReferenceToVideo")["inputs"]
imgs = {k: graph_of("r2v")[v[0]]["inputs"].get("image") for k, v in r2v.items()
        if k.startswith("ref_images.")}
check("r2v: picture order", imgs, {"ref_images.ref_image_0": "hero.png",
                                    "ref_images.ref_image_1": "hero_back.png",
                                    "ref_images.ref_image_2": "dragon.png"})
check("r2v: prompt declares the subjects", "<Subject 1> is a boy in a red cape, shown in "
      "<Picture 1> and <Picture 2>." in r2v.get("prompt", ""), True)
check("r2v: flat socket spelling is not used",
      [k for k in r2v if k.startswith("ref_image_") and k != "ref_image_size"], [])

# reference: video with soundtrack + standalone audio, numbered the way core numbers them
r2v = only(graph_of("r2v_av"), "MiniMaxH3ReferenceToVideo")["inputs"]
check("r2v_av: sockets", sorted(k for k in r2v if k.startswith(("ref_videos", "ref_video_audios",
                                                               "ref_audios"))),
      ["ref_audios.ref_audio_0", "ref_video_audios.ref_video_audio_0", "ref_videos.ref_video_0"])
check("r2v_av: soundtrack is <Audio 1>",
      "<Audio 1> is the synchronized audio track of <Video 1>." in r2v.get("prompt", ""), True)
check("r2v_av: the voice is <Audio 2>", "<Audio 2> is the voice-timbre reference for "
      "<Subject 1>" in r2v.get("prompt", ""), True)

# reference: every pin is a guide, including the first frame
g = graph_of("multiframe")
check("multiframe: guides", sorted(n["inputs"]["frame_idx"] for n in g.values()
                                   if n["class_type"] == "MiniMaxH3AddGuide"), [0, 36, 123])
r2v = only(g, "MiniMaxH3ReferenceToVideo")["inputs"]
check("multiframe: only the cited keyframe takes a picture slot",
      len([k for k in r2v if k.startswith("ref_images.")]), 4)

# reference: edit without the latent = the official route
g = graph_of("edit")
r2v = only(g, "MiniMaxH3ReferenceToVideo")["inputs"]
check("edit: summary", "summary: [video editing] The target video is an edited version of "
      "<Video 1>." in r2v.get("prompt", ""), True)
check("edit: empty latent", "VAEEncode" in kinds(g), False)
check("edit: denoise 1", only(g, "BasicScheduler")["inputs"].get("denoise"), 1.0)

# reference: edit with the clip in the latent too
g = graph_of("edit_locked")
check("edit_locked: latent path", (kinds(g).get("VAEEncode"), kinds(g).get("LTXVSeparateAVLatent"),
                                   kinds(g).get("LTXVConcatAVLatent")), (1, 1, 1))
check("edit_locked: whole-clip mask is no mask", "SetLatentNoiseMask" in kinds(g), False)
check("edit_locked: denoise", only(g, "BasicScheduler")["inputs"].get("denoise"), 0.2)
check("edit_locked: end frames cited", len([k for k in only(g, "MiniMaxH3ReferenceToVideo")[
    "inputs"] if k.startswith("ref_images.")]), 2)

# composite: splice from output/, seam mask, reference video still the original clip
g = graph_of("composite")
# the seam has its own strength; the source clip's denoise is for the source clip
check("composite: seam denoise", only(g, "BasicScheduler")["inputs"].get("denoise"), 0.3)
loads = [n["inputs"] for n in g.values() if n["class_type"] == "GachaDirectorLoadFrames"]
splice = only(g, "GachaDirectorCutSplice")["inputs"]
check("composite: the picks go through the splice node, at the canvas size",
      ([(x["file"], x["start"], x["length"], x["join"]) for x in json.loads(splice["pieces"])],
       splice["length"], splice["width"] > 0),
      ([("a.mp4", 0, 60, "cut"), ("b.mp4", 60, 64, "cut")], 124, True))
check("composite: <Video 1> is still the source",
      [x["file"] for x in loads if x["source"] == "input"], ["src.mp4"])
# the picture and the sound of the picks are both pinned outside the seam
check("composite: video and audio each get a mask", kinds(g).get("SetLatentNoiseMask"), 2)
check("composite: the takes' own sound is encoded with the picture",
      (kinds(g).get("VAEEncodeAudio"), kinds(g).get("LoadAudio")), (1, None))
check("composite: the mask is the document's own cells",
      (only(g, "GachaDirectorTimeMask")["inputs"]["mode"], only(g, "GachaDirectorTimeMask")["inputs"]["cells"]),
      ("free_cells", "2,3,4"))
check("composite: what the cuts cost is left out last, before saving",
      only(g, "CreateVideo")["inputs"]["images"][0],
      next(k for k, n in g.items() if n["class_type"] == "GachaDirectorDropFrames"))
check("composite: audio lands on the AV latent, so it is fitted to length",
      kinds(g).get("LTXVConcatAVLatent"), 2)

g = graph_of("composite_cuts")
check("cuts only: nothing is sampled, encoded or decoded",
      [kinds(g).get(k) for k in ("SamplerCustomAdvanced", "VAEEncode", "VAEDecode",
                                 "VAEDecodeAudio", "SetLatentNoiseMask")], [None] * 5)
check("cuts only: the takes keep their own size",
      (only(g, "GachaDirectorCutSplice")["inputs"]["width"], only(g, "GachaDirectorCutSplice")["inputs"]["height"]),
      (0, 0))
drop = next(k for k, n in g.items() if n["class_type"] == "GachaDirectorDropFrames")
cut = next(k for k, n in g.items() if n["class_type"] == "GachaDirectorCutSplice")
# a link in the result is run, wired on or not: a clip that is only cut together must hand
# on nothing that would make the text encoder or the model run
res = results["composite_cuts"]["result"]
check("cuts only: no latent, no conditioning, the model as it came in, a real frame count",
      (res[5], res[6], res[7], res[3] == [drop, 2]), (None, None, "M", True))
check("cuts only: splice -> drop -> save",
      (g[drop]["inputs"]["frames"][0], g[drop]["inputs"]["audio"][0],
       only(g, "CreateVideo")["inputs"]["images"][0], only(g, "CreateVideo")["inputs"]["audio"][0]),
      (cut, cut, drop, drop))

# --- cfg other than 1 brings the negative branch, from the document
doc = {**cases["t2v"], "prompt": {**cases["t2v"]["prompt"], "negative": "flicker"}}
g = expand(doc, {"cfg": 2.5})["expand"]
check("cfg 2.5: CFGGuider", kinds(g).get("CFGGuider"), 1)
check("cfg 2.5: negative text", only(g, "CLIPTextEncode")["inputs"].get("text"), "flicker")

# --- a sampler and a schedule wired into the node replace the preset's, and the report says so
r = expand(cases["t2v"], sampler="SMP", sigmas=[1.0, 0.7, 0.4, 0.1, 0.0])
g = r["expand"]
check("external: no scheduler or sampler of its own",
      ("BasicScheduler" in kinds(g), "KSamplerSelect" in kinds(g)), (False, False))
check("external: handed to the sampler as they came",
      (only(g, "SamplerCustomAdvanced")["inputs"].get("sampler"),
       only(g, "SamplerCustomAdvanced")["inputs"].get("sigmas")), ("SMP", [1.0, 0.7, 0.4, 0.1, 0.0]))
check("external: the report names what was used",
      ("external sigmas (4 steps)" in r["result"][9], "external sampler" in r["result"][9],
       "denoise" in r["result"][9].split("sigmas input wired")[0]), (True, True, False))
check("no external: the report is the preset's",
      "external" in expand(cases["t2v"])["result"][9], False)

# --- the node is an end point of the graph and keeps its own record of the run: the results
# page reads the report and the compiled prompt from history, under this node's id
check("an output node", D.GachaDirector.OUTPUT_NODE, True)
r = expand(cases["t2v"])
check("ui output keys", sorted(r["ui"]), ["gd_prompt", "gd_report"])
check("the report and the prompt are the node's own outputs",
      (r["ui"]["gd_report"][0], r["ui"]["gd_prompt"][0]), (r["result"][9], r["result"][8]))

# --- a turbo preset needs the turbo model wired in
try:
    expand(cases["t2v"], {"model": "turbo"})
    bad("a turbo preset ran without model_turbo")
except ValueError as exc:
    if "model_turbo" not in str(exc):
        bad(f"turbo error does not name the input: {exc}")
# --- a ComfyUI that lacks one of the nodes is told which, and what to do
D._known_nodes = lambda: (CORE | OURS) - {"MiniMaxH3AddGuide"}
try:
    expand(cases["keyframes"])
    bad("a graph with a node this ComfyUI lacks was handed over")
except ValueError as exc:
    check("a missing core node is named, with what to do",
          ("MiniMaxH3AddGuide" in str(exc), "update ComfyUI" in str(exc)), (True, True))
check("a graph that needs none of the missing nodes still runs",
      "expand" in expand(cases["t2v"]), True)
D._known_nodes = lambda: CORE | OURS
check("and every graph does where nothing is missing", "expand" in expand(cases["keyframes"]), True)
D._known_nodes = lambda: None

# --- a sound reference longer than the model takes is cut to its first 15 seconds
was = D._probe
D._probe = lambda name: {"seconds": 110.2, "audio": True} if str(name).endswith(".wav") else was(name)
g = expand(cases["r2v_av"])["expand"]
cut = [n["inputs"] for n in g.values() if n["class_type"] == "TrimAudioDuration"
       and g[n["inputs"]["audio"][0]]["class_type"] == "LoadAudio"
       and str(g[n["inputs"]["audio"][0]]["inputs"]["audio"]).endswith(".wav")]
check("a long sound reference goes through a trim to 15 seconds",
      [(c["start_index"], c["duration"]) for c in cut], [(0.0, 15.0)])
wired = only(g, "MiniMaxH3ReferenceToVideo")["inputs"]["ref_audios.ref_audio_0"][0]
check("and what the model is handed is the trimmed sound, not the file",
      (g[wired]["class_type"], g[g[wired]["inputs"]["audio"][0]]["class_type"]),
      ("TrimAudioDuration", "LoadAudio"))
D._probe = was

# (a clip that is only cut together samples nothing: it must not ask for a model at all)
try:
    res = expand(cases["composite_cuts"], {"model": "turbo"})["result"]
    check("cuts only on a turbo preset, nothing wired to model_turbo: the model as it came in",
          res[7], "M")
except Exception as exc:  # noqa: BLE001
    bad(f"a clip that is only cut together asked for the turbo model: {exc}")
g = expand(cases["t2v"], {"model": "turbo"}, model_turbo="MT")["expand"]
check("turbo: the turbo model is the one patched",
      only(g, "MiniMaxH3SigmaShift")["inputs"].get("model"), "MT")

# --- reference videos shrink with the preset
g = expand(cases["edit"], {"ref_video_edge": 256})["expand"]
loader = [n["inputs"] for n in g.values() if n["class_type"] == "GachaDirectorLoadFrames"][0]
check("ref_video_edge 256", (loader["width"], loader["height"], loader["resize"]),
      (452, 254, "decode"))   # 16:9 is a touch wider than the 1344x768 area bound

# --- face refine: the region of a finished clip, generated again and put back
FACE_DOC = {"family": "reference", "clip": {"length": 124, "aspect": "1:1"},
            "prompt": {"shots": [{"length": 124, "text": "A close-up of the face of @{s1}."}]},
            "subjects": [{"id": "s1", "images": ["hero.png"], "description": "a boy in a red cape"}]}
_probe_all = D._probe
D._probe = lambda name: {"frames": 124, "frames24": 124, "fps": 24.0, "width": 672, "height": 384,
                         "audio": True}
g = expand(FACE_DOC, gd_post=json.dumps({"face": {
    "file": "GachaDirector_take_3_00001_.mp4", "cuts": "60", "shots": "2", "strength": 0.5,
    "padding": 2.5, "feather": 0.2}}))["expand"]
check("face refine: found, cut out, put back, once each",
      [kinds(g).get(k) for k in ("GachaDirectorFaceTrack", "GachaDirectorCropRegion", "GachaDirectorPasteRegion")],
      [1, 1, 1])
loader = [n["inputs"] for n in g.values() if n["class_type"] == "GachaDirectorLoadFrames"][0]
check("face refine: the finished clip is read from output/ at its own size",
      (loader["file"], loader["source"], loader["start"], loader["length"], loader["width"], loader["height"]),
      ("GachaDirector_take_3_00001_.mp4", "output", 0, 124, 0, 0))
track = only(g, "GachaDirectorFaceTrack")["inputs"]
check("face refine: the shots of the clip and the settings reach the tracker",
      (track["cuts"], track["shots"], track["padding"], track["min_score"]), ("60", "2", 2.5, 0.6))
crop = only(g, "GachaDirectorCropRegion")["inputs"]
check("face refine: the region is generated square at the preset's size",
      (crop["width"], crop["height"]), (640, 640))
check("face refine: the sampler starts from the cut-outs",
      g[only(g, "VAEEncode")["inputs"]["pixels"][0]]["class_type"], "GachaDirectorCropRegion")
check("face refine: half noise at shift 12 is a denoise of 0.077",
      round(only(g, "BasicScheduler")["inputs"]["denoise"], 4), 0.0769)
paste = only(g, "GachaDirectorPasteRegion")["inputs"]
check("face refine: what is generated goes back into the clip it was cut from",
      (g[paste["frames"][0]]["class_type"], g[paste["crops"][0]]["class_type"], paste["feather"]),
      ("GachaDirectorLoadFrames", "VAEDecode", 0.2))
check("face refine: the clip keeps its own sound",
      (kinds(g).get("VAEDecodeAudio"), only(g, "LoadAudio")["inputs"]["audio"]),
      (None, "GachaDirector_take_3_00001_.mp4 [output]"))
check("face refine: the subject's picture is the reference",
      "MiniMaxH3ReferenceToVideo" in kinds(g), True)
try:
    expand({**FACE_DOC, "source": {"video": "src.mp4", "as_latent": True}},
           gd_post=json.dumps({"face": {"file": "x.mp4"}}))
    bad("face refine: a document with a source clip should have been refused")
except ValueError as exc:
    check("face refine: a document with a source clip is refused", "face refine run" in str(exc), True)
D._probe = lambda name: {"frames": 124, "frames24": 124, "fps": 24.0, "width": 672, "height": 384,
                         "audio": False}
g = expand(FACE_DOC, gd_post=json.dumps({"face": {"file": "silent.mp4"}}))["expand"]
check("face refine: a clip without sound is not asked for its sound",
      (kinds(g).get("LoadAudio"), kinds(g).get("VAEDecodeAudio")), (None, 1))
D._probe = lambda name: {"frames": 243, "frames24": 243, "fps": 24.0, "width": 672, "height": 384,
                         "audio": True}
try:
    expand(FACE_DOC, gd_post=json.dumps({"face": {"file": "long.mp4"}}))
    bad("face refine: a clip of another length should have been refused")
except ValueError as exc:
    check("face refine: a clip of another length is refused", "has 243 frames" in str(exc), True)
D._probe = _probe_all

# --- validation: states that cannot run are refused before anything renders
for label, doc, needle in (
    ("mask without a latent source", {"family": "base", "mask": {"mode": "free_cells", "cells": "2"}},
     "no source clip"),
    ("base model with reference video", {"family": "base", "videos": [{"file": "m.mp4"}]},
     "takes no reference videos"),
    ("two pictures on one frame", {"family": "base", "anchors": [
        {"kind": "image", "file": "a.png", "frame": 10}, {"kind": "image", "file": "b.png", "frame": 10}]},
     "two pictures are pinned"),
):
    msg = D.GachaDirector.VALIDATE_INPUTS(gd_timeline=json.dumps(doc))
    if msg is True or needle not in str(msg):
        bad(f"validation [{label}] said {msg!r}")

# --- the time mask, through core's own resampling: free cells are 1, pinned cells are 0,
# and nothing in between. Core resamples a mask evenly onto the latent it is attached to,
# which is what makes a mask built per pixel frame leak into the next cell.
import torch  # noqa: E402
import comfy.utils  # noqa: E402
from comfy_extras.nodes_lt import LTXVConcatAVLatent  # noqa: E402
from gdpkg import gd_grid as G, gd_internal as I  # noqa: E402

for length in (124, 243, 22):
    grid = G.make_grid(length)
    n, lt = grid["cell_count"], grid["latent_t"]
    for free in ([1], [n - 1], [0, n - 1], list(range(n))):
        if max(free) >= n:
            continue
        spec = ",".join(str(c) for c in free)
        mask, amask, _ = I.GachaDirectorTimeMask().build(length, "free_cells", spec, "", 1)
        on_latent = comfy.utils.reshape_mask(
            mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])), (1, 24, lt, 30, 54))
        per_frame = on_latent[0, 0].amax(dim=(1, 2)).tolist()
        low = on_latent[0, 0].amin(dim=(1, 2)).tolist()
        want = [0.0] * lt
        for c in free:
            for t in range(*G.cell_latent(c, n)):
                want[t] = 1.0
        check(f"video mask {length}f cells {spec}", per_frame, want)
        check(f"video mask {length}f cells {spec} is flat", low, want)
        check(f"audio mask {length}f length", amask.shape[-1], grid["audio_t"])

# latent frames named one by one (a seam with a range of its own) take the place of the cells
mask, amask, said = I.GachaDirectorTimeMask().build(124, "free_cells", "3,4", "", 1, latents="18,19,20,21")
check("a mask of latent frames", [t for t in range(37) if float(mask[t].max()) > 0], [18, 19, 20, 21])
check("  its sound is that of the same frames (60 to 72)",
      [i for i in range(amask.shape[-1]) if float(amask[0, 0, i]) > 0][::20][:2] and
      (int(amask[0, 0].nonzero()[0]), int(amask[0, 0].nonzero()[-1])), (100, 121))
check("  and it says which", "latent frames [18, 19, 20, 21]" in said, True)
# a cell that holds a real cut is not touched, however the frames were named
mask, _, _ = I.GachaDirectorTimeMask().build(124, "free_cells", "3,4", "", 1, latents="18,19,20,21",
                                         keep={"guards": [68]})
check("a guarded cell keeps its latent frames, named or not",
      [t for t in range(37) if float(mask[t].max()) > 0], [18, 19])
mask, _, _ = I.GachaDirectorTimeMask().build(124, "free_cells", "3,4", "", 1, keep={"guards": [68]})
check("  as it keeps them when cells are named", [t for t in range(37) if float(mask[t].max()) > 0],
      list(range(15, 20)))

mask, _, _ = I.GachaDirectorTimeMask().build(124, "free_cells", "3,4", "", 1, latents="none")
check("\"none\" frees nothing, whatever the cells say", float(mask.max()), 0.0)
for spec in ("21-18", "99"):
    try:
        I.GachaDirectorTimeMask().build(124, "free_cells", "3,4", "", 1, latents=spec)
        bad("a mask of latent frames %r: should have been refused" % spec)
    except ValueError:
        pass

# a track shorter than the clip: the mask is built at the track's own length, so fitting it
# to the clip only pads (free) and never moves what was pinned
grid = G.make_grid(124)
short = {"samples": torch.zeros((1, 32, 2, 100))}
_, amask, _ = I.GachaDirectorTimeMask().build(124, "free_cells", "2", "", 1, audio_latent=short)
check("audio mask follows the track", amask.shape[-1], 100)
_, fitted = LTXVConcatAVLatent.fit_audio(
    torch.zeros((1, 32, 2, grid["audio_t"])), short["samples"],
    amask.reshape((-1, 1, amask.shape[-2], amask.shape[-1])))
a, b = grid["cells"][2]
lo, hi = round(a * 40 / 24), round((b + 1) * 40 / 24)
row = fitted[0, 0, 0].tolist()
check("audio mask: pinned before the cell", set(row[:lo]), {0.0})
check("audio mask: free inside the cell", set(row[lo:hi]), {1.0})
check("audio mask: pinned after the cell, to the end of the track", set(row[hi:100]), {0.0})
check("audio mask: what the track does not cover is generated", set(row[100:]), {1.0})

if F:
    print("\nFAILED:")
    for f in F:
        print(" -", f)
    sys.exit(1)
print("\nexpand tests: all passed")
