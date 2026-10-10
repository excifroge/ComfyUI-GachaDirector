"""ComfyUI-GachaDirector — Gacha Director, a director console for MiniMax H3.

One node that expands into stock ComfyUI nodes, and a multi-page panel around it: the
clip, run presets with measured timings, takes and composite, results.
See README.md, NOTICE and LICENSE (GPL-3.0).
"""

import logging

__version__ = "2.1.2"

_log = logging.getLogger("GachaDirector")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

if __package__:
    from .gd_director import GachaDirector
    from .gd_frames import GachaDirectorLoadFrames
    from .gd_faces import GachaDirectorFaceTrack, GachaDirectorCropRegion, GachaDirectorPasteRegion
    from .gd_internal import GachaDirectorTimeMask, GachaDirectorFreeMemory
    from .gd_splice import GachaDirectorCutSplice, GachaDirectorDropFrames
    from . import gd_preview

    NODE_CLASS_MAPPINGS = {
        "GachaDirector": GachaDirector,
        "GachaDirectorTimeMask": GachaDirectorTimeMask,
        "GachaDirectorFreeMemory": GachaDirectorFreeMemory,
        "GachaDirectorLoadFrames": GachaDirectorLoadFrames,
        "GachaDirectorFaceTrack": GachaDirectorFaceTrack,
        "GachaDirectorCropRegion": GachaDirectorCropRegion,
        "GachaDirectorPasteRegion": GachaDirectorPasteRegion,
        "GachaDirectorCutSplice": GachaDirectorCutSplice,
        "GachaDirectorDropFrames": GachaDirectorDropFrames,
    }
    # The live preview reaches into ComfyUI's own runtime, so it is optional: a ComfyUI
    # that moved `latent_preview` or `protocol` costs the preview, not the package.
    if gd_preview.AVAILABLE:
        NODE_CLASS_MAPPINGS["GachaDirectorPreview"] = gd_preview.GachaDirectorPreview
    else:
        _log.warning("Gacha Director: live preview unavailable (%s)", gd_preview.UNAVAILABLE_REASON)
    NODE_DISPLAY_NAME_MAPPINGS = {
        "GachaDirector": "Gacha Director",
        "GachaDirectorTimeMask": "Gacha Director · time mask (internal)",
        "GachaDirectorFreeMemory": "Gacha Director · free memory (internal)",
        "GachaDirectorLoadFrames": "Gacha Director · load frames (internal)",
        "GachaDirectorFaceTrack": "Gacha Director · find the face (internal)",
        "GachaDirectorCropRegion": "Gacha Director · cut out a region (internal)",
        "GachaDirectorPasteRegion": "Gacha Director · put a region back (internal)",
        "GachaDirectorCutSplice": "Gacha Director · cut takes together (internal)",
        "GachaDirectorDropFrames": "Gacha Director · leave frames out (internal)",
        "GachaDirectorPreview": "Gacha Director · live preview (internal)",
    }
    if not gd_preview.AVAILABLE:
        NODE_DISPLAY_NAME_MAPPINGS.pop("GachaDirectorPreview", None)

    try:
        from . import gd_routes
        gd_routes.register()
    except Exception:                     # never let a panel convenience break the import
        _log.exception("Gacha Director: HTTP routes unavailable")

    _log.info("Gacha Director v%s: %d nodes registered", __version__, len(NODE_CLASS_MAPPINGS))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
