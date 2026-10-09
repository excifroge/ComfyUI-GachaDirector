"""Gacha Director — the live preview node, registered under this package's own id.

The implementation is vendored upstream code (vendor/minimax_preview.py, see ../NOTICE):
it is the only preview that unpacks an H3 packed audio+video latent, which core's preview
does not do — core draws the first latent frame and calls it a day.

Only the identity changes here. The vendored file stays byte-identical so it can be diffed
against the next upstream release, and the subclass renames the node so that a machine
with both packages installed has two distinct nodes rather than a collision, and so the
graph this package emits never names anything belonging to another package.

The import is guarded because it is the one part of this package that reaches into
ComfyUI's own runtime (``comfy.patcher_extension``, ``latent_preview``, ``server``,
``protocol``). Outside ComfyUI — the offline tests, a plain ``python -c "import
gd_compile"`` — those do not exist, and a preview is not worth failing the whole package
for. When it cannot load, ``AVAILABLE`` is False, the node is not registered, and the
expansion simply does not emit one.
"""

from __future__ import annotations

import logging

log = logging.getLogger("GachaDirector")

NODE_ID = "GachaDirectorPreview"

try:
    from .vendor.minimax_preview import MiniMaxH3PreviewOverride as _Upstream
    AVAILABLE = True
    UNAVAILABLE_REASON = ""
except Exception as exc:                   # noqa: BLE001 - see the module docstring
    _Upstream = None
    AVAILABLE = False
    UNAVAILABLE_REASON = f"{type(exc).__name__}: {exc}"
    log.debug("Gacha Director: live preview unavailable (%s)", UNAVAILABLE_REASON)


if AVAILABLE:

    class GachaDirectorPreview(_Upstream):
        """Same behaviour as upstream's preview override, under an id we own."""

        @classmethod
        def define_schema(cls):
            schema = super().define_schema()
            schema.node_id = NODE_ID
            schema.display_name = "Gacha Director · live preview (internal)"
            schema.category = "GachaDirector/internal"
            return schema

else:
    GachaDirectorPreview = None
