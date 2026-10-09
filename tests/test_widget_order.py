r"""Widget order is append-only, and the node imports without ComfyUI.

widgets_values is positional in a saved workflow. Inserting a widget in the middle shifts
every saved value after it one slot along; the workflow still opens, it just renders with
the wrong settings and nothing says so. A comment does not stop that, so the order is
pinned here.

(The explanation above follows Thefrizzy1's ComfyUI-MiniMaxH3-Director, Apache-2.0; see
NOTICE.)

Run:  python tests/test_widget_order.py
"""
import importlib.util, json, os, sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("gdpkg", os.path.join(PKG, "__init__.py"),
                                              submodule_search_locations=[PKG])
gdpkg = importlib.util.module_from_spec(spec); sys.modules["gdpkg"] = gdpkg; spec.loader.exec_module(gdpkg)
from gdpkg import gd_director as D  # noqa: E402

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "GDGROUP", "GDPRESET", "GDMETRICS"}
it = D.GachaDirector.INPUT_TYPES()
order = []
for grp in ("required", "optional"):
    for k, v in (it.get(grp) or {}).items():
        t = v[0] if isinstance(v, (list, tuple)) else v
        if isinstance(t, list) or t in WIDGET_TYPES:
            order.append(k)

# The order as released, written out here on purpose: comparing INPUT_TYPES with
# WIDGET_ORDER alone would pass a reorder that changed both. A new widget is appended
# to this list, to WIDGET_ORDER and to INPUT_TYPES; nothing already in it moves.
RELEASED = ["gd_timeline", "gd_post", "gd_presets", "gdg_run", "preset", "seed", "gd_metrics",
            "gd_takes"]
assert list(D.WIDGET_ORDER)[:len(RELEASED)] == RELEASED, (
    f"released widget order changed!\n  released : {RELEASED}\n  now      : {list(D.WIDGET_ORDER)}")
expected = list(D.WIDGET_ORDER)
assert order[:len(expected)] == expected, (
    f"widget order changed!\n  pinned : {expected}\n  actual : {order}\n"
    "New widgets go on the END of INPUT_TYPES and on the END of WIDGET_ORDER.")
assert "unique_id" in it.get("hidden", {}), "unique_id hidden input missing"

# IS_CHANGED must be a hash, never a bool
h1 = D.GachaDirector.IS_CHANGED(gd_timeline='{"a":1}')
h2 = D.GachaDirector.IS_CHANGED(gd_timeline='{"a":2}')
h3 = D.GachaDirector.IS_CHANGED(gd_timeline='{"a":1}', gd_post='{"b":1}')
assert isinstance(h1, str) and len(h1) == 64 and h1 != h2
assert h1 != h3, "the post config has to be part of the hash too"

# The files a document names are part of what the node is run on: one written again under
# its name must not be answered from the cache (the nodes inside, which look at their
# files, are not even built when this node's result is kept).
import tempfile  # noqa: E402
with tempfile.TemporaryDirectory() as folder:
    def where(name, source):
        return os.path.join(folder, source + "_" + name.replace(" [output]", ""))
    doc = json.dumps({
        "source": {"video": "src.mp4", "splice": [{"file": "take_a.mp4"}, {"file": "take_b.mp4"}, "loose"]},
        "subjects": [{"images": ["face.png", 5]}, "bare.png"], "videos": [{"file": "move.mp4"}],
        "audio": [{"file": ""}], "anchors": [{"file": "first.png"}]})
    post_cfg = json.dumps({"face": {"file": "final.mp4"}})
    names = ("input_src.mp4", "output_take_a.mp4", "output_take_b.mp4", "input_face.png",
             "input_bare.png", "input_move.mp4", "input_first.png", "output_final.mp4")
    for name in names[:-1]:
        with open(os.path.join(folder, name), "wb") as f:
            f.write(b"one")
    before = D.file_marks(doc, post_cfg, where)
    assert before.count("|") == len(names) - 1, before
    assert before.endswith("final.mp4:-"), "a file that is not there is marked as missing: " + before
    assert D.file_marks(doc, post_cfg, where) == before, "the same files are the same input"
    for name in names:
        was = D.file_marks(doc, post_cfg, where)
        with open(os.path.join(folder, name), "wb") as f:
            f.write(b"another one")
        assert D.file_marks(doc, post_cfg, where) != was, "%s written again went unnoticed" % name
assert D.file_marks("{not json", "[]") == "" and D.file_marks("", "") == ""
assert D.file_marks('{"videos": [{"file": "x.mp4"}]}') == "x.mp4:-", "without ComfyUI no file is found"

# The JSON widgets have to stay where they are: the panel finds them by name, but a
# workflow saved before a reorder maps by position.
assert order[:3] == ["gd_timeline", "gd_post", "gd_presets"], order[:3]

# Decoration widgets must be declared (widgets_values is positional) but never hold
# anything the run depends on.
assert it["required"]["gdg_run"][0] == "GDGROUP"
assert it["required"]["preset"][0] == "GDPRESET"
assert it["required"]["gd_metrics"][0] == "GDMETRICS"

# model_turbo is a socket, not a widget: adding it moved no saved value
assert it["optional"]["model_turbo"][0] == "MODEL"

# VALIDATE_INPUTS catches the cheap mistakes before the queue
assert D.GachaDirector.VALIDATE_INPUTS(gd_timeline="{not json") is not True
assert D.GachaDirector.VALIDATE_INPUTS(gd_timeline="{}") is True, "an empty clip is a valid text-to-video"
bad = D.GachaDirector.VALIDATE_INPUTS(
    gd_timeline='{"source":{"video":"x.mp4","as_latent":true},"mask":{"mode":"free_cells","cells":""}}')
assert "frees no cells" in str(bad), bad

print("widget order / IS_CHANGED / VALIDATE_INPUTS: all passed  (order = %s)" % order)
