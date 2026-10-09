"""Which latent frames does a stretch of pixel frames land in?

    python custom_nodes/ComfyUI-GachaDirector/tests/measure_vae_cells.py [VAE_FILE]

Run with ComfyUI's own Python from the ComfyUI folder. Not a test: a measurement, kept
because gd_grid.py rests on its result. VAE_FILE is a name in models/vae (default: the
first file there whose name contains "minimax_h3_video_vae").

It encodes a base clip with the MiniMax H3 video VAE, then the same clip with one stretch
of frames replaced, and prints which latent frames changed. That settles where the model's
time cells are: a stretch that is one cell changes exactly that cell's latent frames and
nothing else. It runs on the CPU at a tiny size, so it does not disturb a render in
progress.

Measured with ComfyUI 0.39.0 (56 frames -> 17 latent frames):

    frames 0-16   -> latent frames 0-4
    frames 17-33  -> latent frames 5-9
    frames 34-50  -> latent frames 10-14
    frames 51-55  -> latent frames 15-16      (the short cell is the last one)
    frames 0-4    -> latent frames 0-4        (not a cell of its own)
    frames 5-21   -> latent frames 2-9        (straddles two cells)
"""

import os
import sys

WANTED = sys.argv[1] if len(sys.argv) > 1 else ""
sys.argv = [sys.argv[0], "--cpu"]        # ComfyUI reads its own flags from argv
sys.path.insert(0, os.getcwd())

import torch  # noqa: E402

import comfy.sd  # noqa: E402
import comfy.utils  # noqa: E402
import folder_paths  # noqa: E402

LENGTH = 56          # 17 * 3 + 5
SIZE = 64


def find(name):
    names = folder_paths.get_filename_list("vae")
    if not name:
        name = next((n for n in names if "minimax_h3_video_vae" in n.lower()), "")
    path = folder_paths.get_full_path("vae", name) if name else None
    if not path:
        raise FileNotFoundError("no MiniMax H3 video VAE in models/vae (have: %s)"
                                % ", ".join(names))
    return path


def main():
    vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(find(WANTED)))
    g = torch.Generator().manual_seed(1)
    base = torch.rand((LENGTH, SIZE, SIZE, 3), generator=g)
    other = torch.rand((LENGTH, SIZE, SIZE, 3), generator=g)
    z0 = vae.encode(base)
    print("frames %d -> latent %s" % (LENGTH, tuple(z0.shape)))

    def changed(a, b):
        x = base.clone()
        x[a:b + 1] = other[a:b + 1]
        z = vae.encode(x)
        diff = (z - z0).abs().amax(dim=(0, 1, 3, 4))
        return [i for i, v in enumerate(diff.tolist()) if v > 1e-6]

    for a, b, label in [
        (0, 16, "frames 0-16   (first 17)"),
        (17, 33, "frames 17-33  (second 17)"),
        (34, 50, "frames 34-50  (third 17)"),
        (51, 55, "frames 51-55  (the last 5)"),
        (0, 4, "frames 0-4"),
        (5, 21, "frames 5-21"),
        (17, 17, "frame 17 alone"),
        (18, 21, "frames 18-21"),
    ]:
        print("%-28s -> latent frames %s" % (label, changed(a, b)))


if __name__ == "__main__":
    with torch.no_grad():
        main()
