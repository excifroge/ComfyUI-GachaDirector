"""Generate the example workflows that ship with the package.

    python templates/make_workflows.py [--out DIR] [--models KEY=FILE ...]

Writes two UI workflows into ``example_workflows/`` (or DIR):

    GachaDirector_Base.json        fl2va model:  text / image / first-last frame to video
    GachaDirector_Reference.json   ref2va model: reference to video, video editing

Both are the same graph — loaders, an optional turbo LoRA into ``model_turbo``, the
GachaDirector node and two text previews — with a different checkpoint and a starter clip.
They are generated rather than saved by hand so the widget order always matches the node
(``widgets_values`` is positional) and the documents inside are normalized by the code that
will read them.
"""

import argparse
import importlib.util
import json
import os
import sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec)
sys.modules["gdpkg"] = gdpkg
spec.loader.exec_module(gdpkg)
from gdpkg import gd_director as D, gd_post as O, gd_presets as P, gd_schema as S  # noqa: E402

#: The files the official ComfyUI templates use.
MODELS = {
    "base": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "reference": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "turbo_base": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "turbo_reference": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "vae": "minimax_h3_video_vae_int8_convrot.safetensors",
    "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
}

STARTER = {
    "base": {
        "family": "base", "clip": {"length": 124, "aspect": "16:9"},
        "prompt": {
            "global": "Live-action, cinematic macro photography on an overcast afternoon.",
            "shots": [
                {"length": 68, "text": "A close shot follows a folded paper boat as it slides "
                                       "along a rain-filled street gutter, rocking over small "
                                       "ripples. The camera trucks right at slow speed."},
                {"length": 56, "text": "The camera cuts to a low angle at a storm drain as "
                                       "the paper boat tips over the edge and disappears."}],
            "soundscape": "Steady rain on asphalt, water trickling along the gutter, a soft "
                          "splash at the drain.",
            "music": "N/A"},
    },
    "reference": {
        "family": "reference", "clip": {"length": 124, "aspect": "16:9"},
        "prompt": {
            "global": "The target video is a hand-painted watercolour animation with soft "
                      "paper texture.",
            "shots": [
                {"length": 124, "text": "A small red fox trots along a snowy forest path, "
                                        "stops, and looks back over its shoulder as snow "
                                        "falls. The camera tracks beside it."}],
            "soundscape": "Soft footfalls in snow, wind in the pines.",
            "music": "N/A"},
    },
}


def node(nid, kind, pos, size, inputs, outputs, widgets=None, **extra):
    n = {"id": nid, "type": kind, "pos": pos, "size": size, "flags": {}, "order": 0, "mode": 0,
         "inputs": inputs, "outputs": outputs,
         "properties": {"Node name for S&R": kind}}
    if widgets is not None:
        n["widgets_values"] = widgets
    n.update(extra)
    return n


def sock(name, kind, link=None, widget=False, optional=False):
    s = {"name": name, "type": kind, "link": link}
    if widget:
        s["widget"] = {"name": name}
    if optional:
        s["shape"] = 7
    return s


def out(name, kind, links=None):
    return {"name": name, "type": kind, "links": links}


def build(family, models):
    doc = S.normalize(STARTER[family])
    doc.pop("derived", None)
    presets = P.empty()
    presets["active"] = "standard"
    turbo_steps = 8 if family == "base" else 4
    for p in presets["presets"]:
        if p["id"] == "draft":
            p["params"]["steps"] = turbo_steps
            p["note"] = ("Turbo model (model_turbo), %d steps, small canvas, small reference "
                         "videos. For judging the prompt and the material, not for picking "
                         "a take." % turbo_steps)
    presets = P.normalize(presets)

    spec = D.GachaDirector.INPUT_TYPES()
    widget_types = {"INT", "FLOAT", "STRING", "BOOLEAN", "GDGROUP", "GDPRESET", "GDMETRICS"}
    values = {"gd_timeline": json.dumps(doc, ensure_ascii=False),
              "gd_post": json.dumps(O.empty()), "gd_presets": json.dumps(presets),
              "gdg_run": D.GROUPS["gdg_run"], "preset": presets["active"], "seed": 0,
              "gd_metrics": "", "gd_takes": "{}"}
    director_inputs, widgets = [], []
    links = {"model": 1, "clip": 3, "vae": 4, "audio_vae": 5, "model_turbo": 6}
    for group in ("required", "optional"):
        for name, cfg in spec[group].items():
            kind = cfg[0]
            if kind in widget_types:
                director_inputs.append(sock(name, kind, widget=True))
            else:
                director_inputs.append(sock(name, kind, links.get(name), optional=group == "optional"))
    for name in D.WIDGET_ORDER:
        widgets.append(values[name])
        if name == "seed":
            widgets.append("randomize")          # control_after_generate sits right after it
    outputs = [out(n, t) for n, t in zip(D.GachaDirector.RETURN_NAMES, D.GachaDirector.RETURN_TYPES)]
    outputs[8]["links"] = [7]
    outputs[9]["links"] = [8]

    nodes = [
        node(1, "UNETLoader", [30, 60], [330, 82],
             [sock("unet_name", "COMBO", widget=True), sock("weight_dtype", "COMBO", widget=True)],
             [out("MODEL", "MODEL", [1, 2])], [models[family], "default"]),
        node(5, "LoraLoaderModelOnly", [30, 190], [330, 82],
             [sock("model", "MODEL", 2), sock("lora_name", "COMBO", widget=True),
              sock("strength_model", "FLOAT", widget=True)],
             [out("MODEL", "MODEL", [6])], [models["turbo_" + family], 1.0],
             title="Turbo LoRA (for the Draft preset)"),
        node(2, "CLIPLoader", [30, 320], [330, 106],
             [sock("clip_name", "COMBO", widget=True), sock("type", "COMBO", widget=True),
              sock("device", "COMBO", widget=True)],
             [out("CLIP", "CLIP", [3])], [models["clip"], "minimax", "default"]),
        node(3, "VAELoader", [30, 470], [330, 58], [sock("vae_name", "COMBO", widget=True)],
             [out("VAE", "VAE", [4])], [models["vae"]], title="Video VAE"),
        node(4, "VAELoader", [30, 570], [330, 58], [sock("vae_name", "COMBO", widget=True)],
             [out("VAE", "VAE", [5])], [models["audio_vae"]], title="Audio VAE"),
        node(10, "GachaDirector", [410, 60], [400, 300], director_inputs, outputs, widgets,
             color="#1d2a3a", bgcolor="#243447"),
        node(30, "PreviewAny", [860, 60], [460, 320], [sock("source", "*", 7)],
             [out("STRING", "STRING")], [], title="Compiled prompt"),
        node(31, "PreviewAny", [860, 420], [460, 260], [sock("source", "*", 8)],
             [out("STRING", "STRING")], [], title="Run report"),
    ]
    for order, n in enumerate(nodes):
        n["order"] = order
    return {
        "id": "gachadirector-example-%s" % family, "revision": 0,
        "last_node_id": 31, "last_link_id": 8,
        "nodes": nodes,
        "links": [[1, 1, 0, 10, 0, "MODEL"], [2, 1, 0, 5, 0, "MODEL"], [3, 2, 0, 10, 1, "CLIP"],
                  [4, 3, 0, 10, 2, "VAE"], [5, 4, 0, 10, 3, "VAE"],
                  [6, 5, 0, 10, [i["name"] for i in director_inputs].index("model_turbo"), "MODEL"],
                  [7, 10, 8, 30, 0, "STRING"], [8, 10, 9, 31, 0, "STRING"]],
        "groups": [], "config": {}, "extra": {}, "version": 0.4,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(PKG, "example_workflows"))
    ap.add_argument("--models", nargs="*", default=[], metavar="KEY=FILE",
                    help="override model file names, e.g. base=my_fl2va.safetensors")
    a = ap.parse_args()
    models = dict(MODELS)
    for item in a.models:
        k, _, v = item.partition("=")
        if k not in models:
            raise SystemExit("unknown model key %r (have %s)" % (k, ", ".join(sorted(models))))
        models[k] = v
    os.makedirs(a.out, exist_ok=True)
    for family, name in (("base", "GachaDirector_Base"), ("reference", "GachaDirector_Reference")):
        path = os.path.join(a.out, name + ".json")
        json.dump(build(family, models), open(path, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print("wrote", path)


if __name__ == "__main__":
    main()
