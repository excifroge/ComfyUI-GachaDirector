r"""Grid math. No model, no GPU, no ComfyUI.

Run:  python tests/test_grid.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gd_grid as G  # noqa: E402

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(f"{name}: got {got!r}, want {want!r}")


# --- the same numbers as core's temporal_shape
check("temporal_shape(107)", G.temporal_shape(107), (107, 32, 178))
check("temporal_shape(124)", G.temporal_shape(124), (124, 37, 207))
check("temporal_shape(121) snaps up", G.temporal_shape(121)[0], 124)
check("temporal_shape(243)", G.temporal_shape(243), (243, 72, 405))

# --- cells: 17 frames each from frame 0, and the 5 that are left at the end.
# Where the VAE puts them was measured (tests/measure_vae_cells.py): frames 0-16 land in latent
# frames 0-4 and nowhere else, 17-33 in 5-9, and the last five frames in the last two.
check("cell_count(124)", G.cell_count(124), 8)
check("cell 0 covers 0-16", G.cell_bounds(124)[0], [0, 16])   # lists: derived goes into JSON
check("cell 7 is the short one", G.cell_bounds(124)[7], [119, 123])
check("a 5-frame clip is one cell", G.cell_bounds(5), [[0, 4]])
check("22 frames", G.cell_bounds(22), [[0, 16], [17, 21]])
check("latent frames of cell 0", G.cell_latent(0, 8), (0, 5))
check("latent frames of cell 6", G.cell_latent(6, 8), (30, 35))
check("latent frames of the short cell", G.cell_latent(7, 8), (35, 37))
check("cells cover every latent frame once",
      [t for c in range(15) for t in range(*G.cell_latent(c, 15))], list(range(72)))

g = G.make_grid(124)
check("parse_cells('3-4')", G.parse_cells("3-4", g), [3, 4])
check("frames_of_cells([3,4])", G.frames_of_cells([3, 4], 124), (51, 84))
check("parse_cells('f51-84')", G.parse_cells("f51-84", g), [3, 4])
check("cell_of_frame(51)", G.cell_of_frame(51, 124), 3)
check("cell_of_frame(84)", G.cell_of_frame(84, 124), 4)

check("parse_cells('all')", G.parse_cells("all", g), list(range(8)))
check("parse_cells('none')", G.parse_cells("none", g), [])
check("parse_cells('')", G.parse_cells("", g), [])
check("parse_cells('0,2..3,7')", G.parse_cells("0,2..3,7", g), [0, 2, 3, 7])
check("parse_cells('5-3' reversed)", G.parse_cells("5-3", g), [3, 4, 5])

# --- seam repair: one cell on each side of a cut
# a cut ON a boundary: 51 is the seam between cells 2|3, 102 between 5|6
check("seam_cells([51,102]) boundary cuts", G.seam_cells([51, 102], g, radius=1), [2, 3, 5, 6])
check("seam_cells([51] r=1) boundary", G.seam_cells([51], g, radius=1), [2, 3])
# a cut INSIDE a cell (60 sits in cell 3) frees the cell itself plus one each side
check("seam_cells([60] r=1) interior", G.seam_cells([60], g, radius=1), [2, 3, 4])
check("seam_cells([51] r=2) boundary", G.seam_cells([51], g, radius=2), [1, 2, 3, 4])
check("seam_cells clamps at 0", G.seam_cells([0], g, radius=1), [0, 1])
check("seam_cells clamps at end", G.seam_cells([123], g, radius=1), [6, 7])

# --- guide clips are 17k+5 frames long, or a single image
check("guide_clip_length", [G.guide_clip_length(n) for n in (1, 4, 5, 21, 22, 38, 39, 60, 124)],
      [1, 1, 5, 5, 22, 22, 39, 56, 124])

# --- canvas: the same arithmetic as core's ResolutionSelector
check("16:9 at 0.4 MP is the official preview canvas", G.canvas_size("16:9", 0.4), (864, 480))
check("1:1 at 0.4 MP", G.canvas_size("1:1", 0.4), (640, 640))
check("native canvas", G.canvas_size("16:9", G.NATIVE_MEGAPIXELS), (1344, 768))
check("portrait", G.canvas_size("9:16", 0.4), (480, 864))
check("follows the source", G.canvas_size("source", 0.25, (512, 512)), (512, 512))
check("source unknown -> 16:9", G.canvas_size("source", 0.4), (864, 480))
check("free ratio", G.canvas_size("896:512", 0.4375), (896, 512))
check("unreadable ratio -> 16:9", G.canvas_size("wide", 0.4), (864, 480))

# latent frames: a cell is its first frame alone and then four times four
lb = G.latent_bounds(124)
check("as many latent frames as the tensor has", len(lb), G.video_latent_t(124))
check("a cell in latent frames", lb[15:20], [[51, 51], [52, 55], [56, 59], [60, 63], [64, 67]])
check("the short cell at the end", lb[-2:], [[119, 119], [120, 123]])
check("every frame is in exactly one", [f for a, b in lb for f in range(a, b + 1)], list(range(124)))
check("latent frames of cells", G.cells_latents([4, 3, 3], 8), list(range(15, 25)))
check("the last cell has two", G.cells_latents([7], 8), [35, 36])
check("the cell of a latent frame", [G.cell_of_latent(t, 8) for t in (0, 4, 5, 34, 35, 36)], [0, 0, 1, 6, 7, 7])
# a seam on the first frame of a latent frame lies between two of them
check("a seam on a line: so many before, so many from it on", G.seam_latents(68, g, 2, 2), [18, 19, 20, 21])
check("  frames 60 to 72", (lb[18][0], lb[21][1]), (60, 72))
check("  nothing asked, nothing freed", G.seam_latents(68, g, 0, 0), [])
check("  one side only", (G.seam_latents(68, g, 0, 4), G.seam_latents(68, g, 4, 0)),
      ([20, 21, 22, 23], [16, 17, 18, 19]))
# one inside a latent frame has that latent frame as its own
check("a seam inside a latent frame frees it whatever is asked", G.seam_latents(62, g, 0, 0), [18])
check("  and what is asked on either side of it", G.seam_latents(62, g, 1, 2), [17, 18, 19, 20])
check("a range stops at the ends of the clip", (G.seam_latents(1, g, 3, 1), G.seam_latents(120, g, 1, 9)),
      ([0, 1], [35, 36]))

# a seam left to itself: the stretch ends where the next cell begins, and is long enough
frames_of = lambda ts: (lb[ts[0]][0], lb[ts[-1]][1]) if ts else None   # noqa: E731
check("on a cell's first frame: only what is before it", frames_of(G.seam_auto(68, g)), (56, 67))
check("inside a cell: to the end of that cell", frames_of(G.seam_auto(62, g)), (56, 67))
check("early in a cell: the whole rest of it, and a little before", frames_of(G.seam_auto(70, g)), (64, 84))
check("in the short cell at the end: to the end of the clip", frames_of(G.seam_auto(121, g)), (111, 123))
check("near the start there is less before it", frames_of(G.seam_auto(3, g)), (0, 16))
for f in range(1, 124):
    ts = G.seam_auto(f, g)
    lo, hi = frames_of(ts)
    if not (lo <= f - 1 and (hi + 1) % 17 == 0 or hi == 123 or hi + 1 == f and f % 17 == 0):
        FAILED.append("seam_auto(%d) frees %d-%d: it has to end where a cell begins" % (f, lo, hi))
    if ts != list(range(ts[0], ts[-1] + 1)):
        FAILED.append("seam_auto(%d): not one stretch" % f)
# latent frames named by hand
check("named one by one", G.parse_latents("18-21, 30", 37), [18, 19, 20, 21, 30])
check("nothing said is not the same as none", (G.parse_latents("", 37), G.parse_latents("none", 37)), (None, []))
for bad in ("21-18", "40", "5-99", "-1", "x"):
    try:
        G.parse_latents(bad, 37)
        FAILED.append("parse_latents(%r): should have raised" % bad)
    except ValueError:
        pass

for bad, fn in (
    ("cells out of range", lambda: G.parse_cells("8", g)),
    ("non-contiguous frames_of_cells", lambda: G.frames_of_cells([1, 3], 124)),
    ("frame out of range", lambda: G.cell_of_frame(124, 124)),
):
    try:
        fn()
        FAILED.append(f"{bad}: should have raised")
    except ValueError:
        pass

if FAILED:
    print(f"FAILED {len(FAILED)}:")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
print("grid tests: all passed")
