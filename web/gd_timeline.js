// Gacha Director — the canvas timeline.
//
// Parts are ported from AIMixer's ComfyUI_MiniMaxH3_Director, web/js/minimax_timeline.js
// (Apache-2.0, see NOTICE), and modified: the frame/pixel and mouse mapping, the DPR
// bitmap sizing, the adaptive ruler, the hit test ordered by priority, the cut marker and
// the edge-drag snapshot. The debounced single write path is its pattern. The shot track
// follows the Motion Director's timeline (also in NOTICE): a filmstrip of the source clip
// with the shots drawn as coloured frames over it, so a cut is placed against the
// picture, not against a paragraph of prompt text. Without a source clip the track is
// plain, and the shots are still there to cut and drag.
//
// What this timeline adds: the **latent cell strip sits on the same axis as the shots**.
// The model recomputes in cells (17 frames each, the last one 5), so "which frames get
// redone" and "which prompts still apply" are two different rulers over one clip, and
// drawing them together is how you see a shot boundary land inside a cell.
//
// Knows nothing about ComfyUI. Talks only to the host object it is handed.

import { filmstrip } from "./gd_filmstrip.js";
import { t } from "./gd_i18n.js";
import { showMentions } from "./gd_material.js";

// ---------------------------------------------------------------- layout
const RULER_H = 26;
const LABEL_H = 20;
const SHOT_H = 74;
const CELL_H = 46;
const GAP = 6;

const SHOT_Y = RULER_H + LABEL_H;
const CELL_Y = SHOT_Y + SHOT_H + GAP;
export const TIMELINE_H = CELL_Y + CELL_H + 4;
const TIMELINE_H_BARE = SHOT_Y + SHOT_H + 4;      // without the cell strip

/**
 * Does the cell strip say anything for this document? A cell is either redone or kept as
 * the footage the run starts from has it, so there is something to show only when the run
 * starts from footage, or when the document already keeps some cells. A clip made from
 * nothing redoes every cell: the strip would be a row of identical boxes whose clicks
 * lead into a document that cannot run.
 */
export function cellsMatter(d) {
  return d.derived.latent_source !== "empty" || d.mask.mode !== "whole_clip";
}

/** Band offsets, exported so a test can click a band instead of guessing a y. */
export const BANDS = {
  ruler: [0, RULER_H], label: [RULER_H, RULER_H + LABEL_H],
  shot: [SHOT_Y, SHOT_Y + SHOT_H], cell: [CELL_Y, CELL_Y + CELL_H],
};
/** Vertical centre of a band, for tests and for programmatic scrolling. */
export const bandMid = (name) => (BANDS[name][0] + BANDS[name][1]) / 2;

/** One colour per segment, shared with the segment navigator and the block headers. */
export const SHOT_COLORS = ["#f0a640", "#4fd08f", "#5aa5e6", "#c98af5", "#f07a7a", "#63d3d3", "#e0d060", "#f59ac6"];
export const shotColor = (i) => SHOT_COLORS[i % SHOT_COLORS.length];
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const HANDLE_PX = 14;          // edge grab zone, from AIMixer
// Shot edges magnet onto cell boundaries. Measured against the POINTER, not against the
// rounded frame: rounding first puts the candidate a whole frame away, and at a dozen
// pixels per frame that is already outside the radius, so snapping could never fire. The
// radius is also floored in frames, because a pixel radius narrower than one frame is not
// a magnet at all.
const SNAP_PX = 12;
const SNAP_MIN_FRAMES = 1.5;
const SNAP_MAX_FRAMES = 6;
const MIN_SHOT = 5;               // mirrors gd_schema.MIN_SHOT
const WRITE_DEBOUNCE_MS = 400;

// Adaptive ruler: pick the smallest step whose spacing clears the minimum pixels.
const RULER_MAJOR_SEC = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
// AIMixer uses 64 here, but its label is just "5s"; ours is "5s · 120f", measured at up
// to 61 px, so 64 let the last two labels overlap (seen at 124f / 1151 px wide).
const RULER_MIN_MAJOR_PX = 96;
const RULER_MIN_MINOR_PX = 7;
const FPS = 24;

const C = {
  ruler: "#252525", rulerTick: "#5a5a5a", rulerMajor: "#aaa", labelBand: "#1a1a1a",
  track: "#111", filmEmpty: "#182028", filmEdge: "#22303f",
  cellFree: "#e6edf3", cellPinned: "#0e141c", cellBorder: "#2c3f55",
  cellFreeText: "#111", cellPinnedText: "#6f8399",
  playhead: "#ff5555", snapGuide: "rgba(120,200,255,.9)", dim: "#7f93a8",
  cut: "#ffd23f", cutLine: "rgba(255,210,63,.5)",
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function pickMajorSec(pxPerSec) {
  for (const s of RULER_MAJOR_SEC) if (s * pxPerSec >= RULER_MIN_MAJOR_PX) return s;
  return RULER_MAJOR_SEC[RULER_MAJOR_SEC.length - 1];
}
function pickMinorSec(majorSec, pxPerSec) {
  for (const div of [10, 5, 4, 2]) {
    const s = majorSec / div;
    if (s * pxPerSec >= RULER_MIN_MINOR_PX) return s;
  }
  return majorSec;
}
function fmtTime(sec) {
  if (sec < 60) return (Math.round(sec * 100) / 100).toString().replace(/\.0+$/, "") + "s";
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, "0")}`;
}
function ellipsize(ctx, text, maxPx) {
  if (ctx.measureText(text).width <= maxPx) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxPx) t = t.slice(0, -1);
  return t + "…";
}

/**
 * @param host {{ doc():object, normalize(doc):object, commit(doc):void,
 *                commitView?(doc):void, plateSrc?():string, onScrub?(frame):void,
 *                onSelectShot?(i):void, readOnly?:boolean,
 *                segmentStatus?(i):"none"|"takes"|"picked" }}
 *
 * `commitView` receives writes that only touch `view` (playhead, zoom); the owner can
 * keep those out of the undo history. Without it they go through `commit`.
 *
 * `plateSrc` is the URL of the source clip; when given, the shot track is a filmstrip
 * of it. `onScrub` fires while the user drags the playhead so a player can follow.
 *
 * A click on a segment body selects it AND scrubs there; a click on a boundary selects
 * the segment to its right, which makes that boundary the selected cut — the edit page's
 * bar edits and deletes exactly that one, so cut selection needs no state of its own.
 * Splitting is not a timeline gesture at all: it lives on that bar, so there is exactly
 * one way to make a cut and it cannot collide with selecting.
 *
 * `readOnly` turns the timeline into a navigator: the ruler still scrubs and a shot still
 * selects, but nothing moves. `segmentStatus` paints a badge per shot so the takes page
 * shows at a glance which segments have candidates and which have a pick.
 *
 * `normalize` is required, not optional: while a drag is in flight the timeline draws an
 * un-committed document, and every derived field it draws (free cells, which shots and
 * anchors are live) has to be recomputed from that document rather than left over from
 * the last commit. Without it a cell sweep computes its second cell from stale state.
 */
export function createTimeline(host) {
  const root = document.createElement("div");
  root.className = "gd-tl";
  const viewport = document.createElement("div");
  viewport.className = "gd-tl-viewport";
  const canvas = document.createElement("canvas");
  canvas.className = "gd-tl-canvas";
  viewport.appendChild(canvas);
  // A strip under the picture, as wide as it and scrolling with it: its owner fills it
  // (the Generate page shows the seams there) and places things by share of its width.
  const below = document.createElement("div");
  below.className = "gd-tl-below";
  viewport.appendChild(below);
  root.appendChild(viewport);
  const ctx = canvas.getContext("2d");

  const st = {
    drag: null,          // {kind, ...}
    hover: null,
    snapX: null,         // guide line while an edge is snapping
    writeTimer: null,
    pendingDoc: null,
    pendingView: false,
    raf: 0,
    destroyed: false,
    playhead: null,      // transient playhead from a playing player; null = use the document
    strip: null,
    unsubStrip: null,
  };

  // ------------------------------------------------------------ geometry
  function doc() { return host.doc(); }
  function totalFrames() { return doc().derived.frame_count; }
  function zoom() { return doc().view.zoom || 1; }
  function drawWidth() {
    // clientWidth, never getBoundingClientRect: AIMixer's comment is that a transformed
    // ancestor inflates the rect and squashes the bitmap. The overlay is untransformed
    // today, but the panel may end up inside one.
    const vw = viewport.clientWidth || root.clientWidth || 900;
    return Math.max(240, Math.round(vw * zoom()));
  }
  function heightNow() { return cellsMatter(liveDoc()) ? TIMELINE_H : TIMELINE_H_BARE; }
  function frameToX(f, w) { return (f / Math.max(1, totalFrames())) * w; }
  function xToFrame(x, w) { return clamp(Math.round((x / w) * totalFrames()), 0, totalFrames() - 1); }

  function mousePos(e) {
    const rect = canvas.getBoundingClientRect();
    const w = st.lastW || drawWidth();
    const sx = rect.width > 0 ? w / rect.width : 1;
    const sy = rect.height > 0 ? heightNow() / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  // ------------------------------------------------------------ writes
  function commitTo(d, view) {
    if (view && host.commitView) host.commitView(d);
    else host.commit(d);
  }
  function write(next, { flush = false, view = false } = {}) {
    st.pendingDoc = host.normalize(next);
    st.pendingView = view;
    if (st.writeTimer) { clearTimeout(st.writeTimer); st.writeTimer = null; }
    if (flush) {
      const d = st.pendingDoc; st.pendingDoc = null;
      commitTo(d, view);
    } else {
      // Writing on every mousemove would serialize the document dozens of times a
      // second; AIMixer debounces the same way and flushes on mouseup.
      st.writeTimer = setTimeout(() => {
        st.writeTimer = null;
        const d = st.pendingDoc; st.pendingDoc = null;
        if (d && !st.destroyed) commitTo(d, st.pendingView);
      }, WRITE_DEBOUNCE_MS);
    }
    render();
  }
  function flushWrites() {
    if (st.writeTimer) { clearTimeout(st.writeTimer); st.writeTimer = null; }
    if (st.pendingDoc) { const d = st.pendingDoc; st.pendingDoc = null; commitTo(d, st.pendingView); }
  }
  /** The doc being drawn: the un-committed drag state if there is one. */
  function liveDoc() { return st.pendingDoc || doc(); }

  function scrubTo(frame) {
    st.playhead = null;                          // the document is authoritative again
    const d = JSON.parse(JSON.stringify(liveDoc()));
    d.view.playhead = frame;
    write(d, { view: true });
    host.onScrub && host.onScrub(frame);
  }

  // ------------------------------------------------------------ hit test
  // Ordered by priority, specific before generic, edges before bodies, topmost first —
  // the ordering discipline is AIMixer's.
  function hitTest(x, y) {
    const d = liveDoc();
    const w = st.lastW || drawWidth();
    const phx = frameToX(currentPlayhead(d), w);

    if (y <= RULER_H) {
      if (Math.abs(x - phx) <= HANDLE_PX) return { type: "playhead" };
      return { type: "ruler" };
    }
    if (cellsMatter(d) && y >= CELL_Y && y <= CELL_Y + CELL_H) {
      for (let i = 0; i < d.derived.cells.length; i++) {
        const [a, b] = d.derived.cells[i];
        const x0 = frameToX(a, w), x1 = frameToX(b + 1, w);
        if (x >= x0 && x < x1) return { type: "cell", index: i };
      }
      return { type: "cell-band" };
    }
    // label band and filmstrip band are one hit zone: edges first, then bodies
    if (y >= RULER_H && y <= SHOT_Y + SHOT_H) {
      const shots = d.prompt.shots;
      // interior boundaries only: shot 0's left edge and the last shot's right edge are
      // the clip itself and cannot move
      for (let i = 1; i < shots.length; i++) {
        const bx = frameToX(shots[i].start, w);
        if (Math.abs(x - bx) <= HANDLE_PX) return { type: "shot-edge", index: i };
      }
      for (let i = shots.length - 1; i >= 0; i--) {
        const s = shots[i];
        const x0 = frameToX(s.start, w), x1 = frameToX(s.start + s.length, w);
        const last = i === shots.length - 1;
        if (x >= x0 && (last ? x <= x1 : x < x1)) return { type: "shot", index: i };
      }
    }
    if (Math.abs(x - phx) <= HANDLE_PX) return { type: "playhead" };
    return null;
  }

  // ------------------------------------------------------------ edits
  function cellBoundaryFrames(d) {
    const out = [];
    for (const [a] of d.derived.cells) out.push(a);
    out.push(d.derived.frame_count);
    return out;
  }

  /** Move the boundary before shot `index`, taking length from one neighbour. */
  function moveShotBoundary(index, frame, { snap = true } = {}) {
    const d = JSON.parse(JSON.stringify(st.drag.snapshot));
    const shots = d.prompt.shots;
    const w = st.lastW || drawWidth();
    const prev = shots[index - 1], cur = shots[index];
    const lo = prev.start + MIN_SHOT;
    const hi = cur.start + cur.length - MIN_SHOT;
    let f = clamp(Math.round(frame), lo, hi);

    st.snapX = null;
    if (snap && cellsMatter(d)) {
      // Snapping to a cell boundary is the point: a shot edge inside a cell means that
      // cell re-reads two prompts.
      const pxPerFrame = w / Math.max(1, totalFrames());
      const radius = clamp(SNAP_PX / pxPerFrame, SNAP_MIN_FRAMES, SNAP_MAX_FRAMES);
      let best = null, bestDist = radius + 1e-9;
      for (const cb of cellBoundaryFrames(d)) {
        if (cb < lo || cb > hi) continue;
        const dist = Math.abs(cb - frame);          // frame = raw pointer position
        if (dist <= radius && dist < bestDist) { bestDist = dist; best = cb; }
      }
      if (best !== null) { f = best; st.snapX = frameToX(best, w); }
    }
    const delta = f - cur.start;
    prev.length += delta;
    cur.length -= delta;
    cur.start = f;
    return d;
  }

  function setFreeCells(set) {
    const d = JSON.parse(JSON.stringify(liveDoc()));
    const list = [...set].sort((a, b) => a - b);
    if (list.length === d.derived.cell_count) { d.mask.mode = "whole_clip"; d.mask.cells = ""; }
    else { d.mask.mode = "free_cells"; d.mask.cells = list.join(","); }
    return d;
  }

  function selectShot(index) {
    const d = JSON.parse(JSON.stringify(liveDoc()));
    d.view.selected_shot = index;
    write(d, { flush: true, view: true });
    host.onSelectShot && host.onSelectShot(index);
  }

  // ------------------------------------------------------------ events
  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = mousePos(e);
    const hit = hitTest(x, y);
    const w = st.lastW || drawWidth();
    if (!hit) return;
    if (st.strip && st.strip.failed && y >= SHOT_Y && y <= SHOT_Y + SHOT_H) {
      st.strip.retry();                          // the failure text says "click to retry"
      return;
    }

    if (hit.type === "ruler" || hit.type === "playhead") {
      st.drag = { kind: "playhead" };
      scrubTo(xToFrame(x, w));
    } else if (host.readOnly) {
      // navigator: a shot click selects, everything else is inert
      if (hit.type === "shot" || hit.type === "shot-edge") {
        selectShot(hit.type === "shot" ? hit.index : Math.max(0, hit.index - 1));
      }
      st.drag = null;
    } else if (hit.type === "shot-edge") {
      // pressing a boundary selects the segment to its right, which is what makes that
      // boundary "the selected cut" for the bar above
      selectShot(hit.index);
      st.drag = { kind: "shot-edge", index: hit.index, snapshot: JSON.parse(JSON.stringify(liveDoc())) };
    } else if (hit.type === "shot") {
      selectShot(hit.index);
      st.drag = { kind: "playhead" };               // the picture is also the scrub surface
      scrubTo(xToFrame(x, w));
    } else if (hit.type === "cell") {
      const cur = new Set(liveDoc().derived.free_cells);
      const turnOn = !cur.has(hit.index);
      turnOn ? cur.add(hit.index) : cur.delete(hit.index);
      st.drag = { kind: "cell-paint", turnOn, lastCell: hit.index };
      write(setFreeCells(cur));
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  /**
   * Hover feedback. On the CANVAS, permanently: it used to live inside the window-level
   * drag handler, which is attached on mousedown and removed on mouseup, so the cursor
   * was only ever recomputed during a press — click something un-draggable and whatever
   * shape it left behind stuck to the timeline for good.
   */
  function onHover(e) {
    if (st.drag) return;                            // the drag handler owns the cursor
    const { x, y } = mousePos(e);
    const hit = hitTest(x, y);
    const cursor = !hit ? "default"
      : host.readOnly ? (hit.type === "shot" || hit.type === "ruler" || hit.type === "playhead" ? "pointer" : "default")
      : hit.type === "shot-edge" ? "col-resize"
      : hit.type === "shot" ? "pointer"
      : hit.type === "playhead" || hit.type === "ruler" ? "ew-resize"
      : hit.type === "cell" ? "pointer"
      : "default";
    canvas.style.cursor = cursor;
    const key = hit ? hit.type + (hit.index ?? "") : "";
    if (key !== st.hover) { st.hover = key; render(); }
  }

  function onMouseMove(e) {
    const { x, y } = mousePos(e);
    const w = st.lastW || drawWidth();
    if (!st.drag) return;
    if (st.drag.kind === "playhead") {
      scrubTo(xToFrame(x, w));
    } else if (st.drag.kind === "shot-edge") {
      // Recompute from the snapshot each move, never from the last result: incremental
      // application accumulates rounding drift (AIMixer keeps _edgeSnapshot for this).
      const next = moveShotBoundary(st.drag.index, (x / w) * totalFrames(), { snap: !e.altKey });
      if (next) write(next);
    } else if (st.drag.kind === "cell-paint") {
      // Paint every cell BETWEEN the last one and this one. Mouse moves are sampled, so
      // a quick sweep skips cells if each event only paints where it landed (the
      // interaction test caught this: two moves across three cells left the middle one).
      const cells = liveDoc().derived.cells;
      const w2 = st.lastW || drawWidth();
      const frame = clamp(Math.round((x / w2) * totalFrames()), 0, totalFrames() - 1);
      let idx = -1;
      for (let i = 0; i < cells.length; i++) if (frame >= cells[i][0] && frame <= cells[i][1]) { idx = i; break; }
      if (idx >= 0 && idx !== st.drag.lastCell) {
        const cur = new Set(liveDoc().derived.free_cells);
        const from = Math.min(st.drag.lastCell, idx), to = Math.max(st.drag.lastCell, idx);
        for (let i = from; i <= to; i++) st.drag.turnOn ? cur.add(i) : cur.delete(i);
        st.drag.lastCell = idx;
        write(setFreeCells(cur));
      }
    }
  }

  function onMouseUp() {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    st.drag = null;
    st.snapX = null;
    flushWrites();
    render();
  }

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;         // plain wheel scrolls the viewport
    e.preventDefault();
    const d = JSON.parse(JSON.stringify(liveDoc()));
    d.view.zoom = clamp((d.view.zoom || 1) * (e.deltaY < 0 ? 1.25 : 0.8), 1, 16);
    write(d, { flush: true, view: true });
  }

  // ------------------------------------------------------------ draw
  function currentPlayhead(d) {
    return st.playhead != null ? clamp(st.playhead, 0, d.derived.frame_count - 1) : d.view.playhead;
  }

  function render() {
    if (st.destroyed) return;
    // requestAnimationFrame never fires while the document is hidden (a backgrounded
    // browser tab), so a commit that arrives then would leave the canvas stale until
    // something else happened to resize it. Draw straight through in that case.
    if (typeof document !== "undefined" && document.hidden) { draw(); return; }
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => { st.raf = 0; draw(); });
  }

  /** The filmstrip store for the current source clip, re-subscribed when it changes. */
  function currentStrip() {
    const src = host.plateSrc ? host.plateSrc() : "";
    const strip = src ? filmstrip(src) : null;
    if (strip !== st.strip) {
      if (st.unsubStrip) { st.unsubStrip(); st.unsubStrip = null; }
      st.strip = strip;
      if (strip) st.unsubStrip = strip.subscribe(() => render());
    }
    return strip;
  }

  function draw() {
    const d = liveDoc();
    const w = drawWidth();
    st.lastW = w;
    const dpr = window.devicePixelRatio || 1;
    const withCells = cellsMatter(d);
    const H = withCells ? TIMELINE_H : TIMELINE_H_BARE;
    const bw = Math.round(w * dpr), bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${H}px`;
    below.style.width = `${w}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);

    const fc = d.derived.frame_count;
    const durationSec = fc / FPS;
    const shots = d.prompt.shots;
    const free = new Set(d.derived.free_cells);
    const liveShots = new Set(d.derived.live_shot_indices);
    const playhead = currentPlayhead(d);
    // The selected cut IS the selected segment's start: one selection, no second state.
    const selCut = d.view.selected_shot > 0 && shots[d.view.selected_shot]
      ? shots[d.view.selected_shot].start : null;

    // ---- ruler
    ctx.fillStyle = C.ruler; ctx.fillRect(0, 0, w, RULER_H);
    const pxPerSec = w / Math.max(durationSec, 0.001);
    const majorSec = pickMajorSec(pxPerSec);
    const minorSec = pickMinorSec(majorSec, pxPerSec);
    const secToX = (s) => (s / Math.max(durationSec, 0.001)) * w;
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (minorSec < majorSec) {
      ctx.fillStyle = C.rulerTick;
      for (let i = 0, n = Math.floor(durationSec / minorSec + 1e-9); i <= n; i++) {
        const s = i * minorSec;
        if (Math.abs(s % majorSec) < 1e-9) continue;
        ctx.fillRect(secToX(s), RULER_H - 4, 1, 4);
      }
    }
    ctx.fillStyle = C.rulerMajor;
    let lastLabelX1 = -1e9;
    for (let i = 0, n = Math.floor(durationSec / majorSec + 1e-9); i <= n; i++) {
      const s = i * majorSec, x = secToX(s);
      ctx.fillRect(x, RULER_H - 8, 1, 8);
      const label = `${fmtTime(s)} · ${Math.round(s * FPS)}f`;
      const tw = ctx.measureText(label).width;
      let lx = x + 3;
      if (x + 3 + tw > w - 2 && s > 0) {
        if (x - tw - 2 < 2) continue;             // no room either side: tick only
        lx = x - tw - 2;
      }
      if (lx < lastLabelX1 + 4) continue;         // would touch the previous label
      ctx.fillText(label, lx, 12);
      lastLabelX1 = lx + tw;
    }

    // ---- shot label band: "Shot 1 · 1.63s" in the shot colour, then a prompt excerpt
    ctx.fillStyle = C.labelBand; ctx.fillRect(0, RULER_H, w, LABEL_H);
    ctx.textBaseline = "middle";
    shots.forEach((s, i) => {
      const x0 = frameToX(s.start, w), x1 = frameToX(s.start + s.length, w);
      const pxW = x1 - x0;
      if (pxW < 10) return;
      const sel = i === d.view.selected_shot;
      ctx.font = `${sel ? "600 " : ""}11px system-ui, sans-serif`;
      ctx.fillStyle = liveShots.has(i) ? shotColor(i) : C.dim;
      const head = t("tl.segLabel", i + 1, (s.length / FPS).toFixed(2));
      const headW = ctx.measureText(head).width;
      const textX = x0 + (i > 0 ? 12 : 5);          // clear of the cut diamond
      ctx.fillText(ellipsize(ctx, head, pxW - 8), textX, RULER_H + LABEL_H / 2);
      const room = pxW - headW - 16 - (textX - x0);
      if (room > 40) {
        const excerpt = showMentions(s.text || "", d).replace(/\s+/g, " ").trim();
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillStyle = excerpt ? C.dim : "#4a5a6b";
        ctx.fillText(ellipsize(ctx, excerpt || t("tl.emptySeg"), room), textX + headW + 8, RULER_H + LABEL_H / 2);
      }
    });

    // ---- filmstrip: the source clip, frame by frame
    ctx.fillStyle = C.track; ctx.fillRect(0, SHOT_Y, w, SHOT_H);
    const strip = currentStrip();
    if (strip) {
      const aspect = strip.aspect || 1;
      const slotW = Math.max(24, Math.round((SHOT_H - 4) * aspect));
      const n = Math.ceil(w / slotW);
      const wanted = [];
      // the strip shows the file from where the clip starts in it
      const offset = host.plateOffset ? Math.max(0, host.plateOffset() | 0) : 0;
      for (let i = 0; i < n; i++) {
        const x = i * slotW;
        const frame = offset + clamp(Math.floor(((x + slotW / 2) / w) * fc), 0, fc - 1);
        wanted.push(frame);
        const thumb = strip.thumb(frame);
        const drawW = Math.min(slotW, w - x);
        if (thumb) {
          ctx.drawImage(thumb, 0, 0, thumb.width * (drawW / slotW), thumb.height, x, SHOT_Y + 2, drawW, SHOT_H - 4);
        } else {
          ctx.fillStyle = strip.failed ? "#2a1f22" : C.filmEmpty;
          ctx.fillRect(x, SHOT_Y + 2, drawW, SHOT_H - 4);
        }
        ctx.fillStyle = C.filmEdge;
        ctx.fillRect(x, SHOT_Y + 2, 1, SHOT_H - 4);
      }
      if (!strip.failed) strip.ensure(wanted);
      if (strip.failed || !strip.ready) {
        ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
        const msg = strip.failed
          ? t("tl.stripFailed", strip.reason || t("film.unknown"))
          : t("tl.stripLoading");
        const tw = ctx.measureText(msg).width;
        ctx.fillStyle = "rgba(0,0,0,.6)";
        ctx.fillRect(6, SHOT_Y + SHOT_H / 2 - 10, tw + 12, 20);
        ctx.fillStyle = strip.failed ? "#ff9a9a" : C.dim;
        ctx.fillText(msg, 12, SHOT_Y + SHOT_H / 2);
      }
    } else {
      ctx.fillStyle = C.dim;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(t("tl.noPlate"), 8, SHOT_Y + SHOT_H / 2);
    }

    // ---- segments as coloured frames over the filmstrip
    shots.forEach((s, i) => {
      const x0 = frameToX(s.start, w), x1 = frameToX(s.start + s.length, w);
      const pxW = Math.max(1, x1 - x0);
      const dead = !liveShots.has(i);
      const sel = i === d.view.selected_shot;
      const col = dead ? "#4a5a6b" : shotColor(i);
      if (dead) { ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(x0, SHOT_Y + 2, pxW, SHOT_H - 4); }
      if (sel && !dead) { ctx.fillStyle = rgba(col, 0.14); ctx.fillRect(x0, SHOT_Y + 2, pxW, SHOT_H - 4); }
      ctx.strokeStyle = col; ctx.lineWidth = sel ? 3 : 2;
      const inset = sel ? 1.5 : 1;
      ctx.strokeRect(x0 + inset, SHOT_Y + 2 + inset, Math.max(0, pxW - inset * 2), SHOT_H - 4 - inset * 2);
      if (dead && pxW > 44) {
        ctx.fillStyle = "#9fb0c4"; ctx.font = "10px system-ui, sans-serif";
        ctx.textBaseline = "top"; ctx.textAlign = "left";
        ctx.fillText(t("tl.pinned"), x0 + 6, SHOT_Y + 7);
      }
      if (i > 0) {                                  // boundary handle
        const on = s.start === selCut;
        ctx.fillStyle = on ? C.cut : "rgba(255,255,255,.85)";
        ctx.fillRect(x0 - (on ? 2.5 : 1.5), SHOT_Y + 2, on ? 5 : 3, SHOT_H - 4);
        ctx.fillStyle = "#111";
        ctx.fillRect(x0 - 0.5, SHOT_Y + SHOT_H / 2 - 6, 1, 12);
      }
      if (host.segmentStatus) {
        // takes page: grey = nothing yet, blue = candidates exist, green = picked
        const status = host.segmentStatus(i);
        const scol = status === "picked" ? "#4fd08f" : status === "takes" ? "#5aa5e6" : "#3a4657";
        const label = status === "picked" ? t("tl.segPicked") : status === "takes" ? t("tl.segHasTakes") : t("tl.segNoTakes");
        ctx.fillStyle = "rgba(0,0,0,.6)";
        const bw2 = pxW > 70 ? 58 : 16;
        ctx.fillRect(x1 - bw2 - 4, SHOT_Y + 4, bw2, 14);
        ctx.fillStyle = scol;
        ctx.beginPath();
        ctx.arc(x1 - 11, SHOT_Y + 11, 4, 0, Math.PI * 2);
        ctx.fill();
        if (pxW > 70) {
          ctx.font = "10px system-ui, sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(label, x1 - 18, SHOT_Y + 11);
          ctx.textAlign = "left";
        }
      }
    });

    // ---- what is held on a frame: a picture, a clip, a sound. Shown, not edited: it is set
    // in its shot's card and moves with the shot.
    const rows = new Map();
    for (const a of d.anchors || []) {
      if (!a.pin && !a.cite) continue;
      const col = a.kind === "image" ? "#ffe08a" : a.kind === "clip" ? "#7ee2a8" : "#d6b3ff";
      const atEnd = a.at === "last";
      const x = frameToX(a.frame + (atEnd ? 1 : 0), w);       // a last frame sits against the shot's end
      const lane = rows.get(a.frame) || 0;                    // two things on one frame: stacked
      rows.set(a.frame, lane + 1);
      const y = SHOT_Y + SHOT_H - 17 - lane * 14;
      if (a.kind === "clip") {
        ctx.fillStyle = rgba(col, 0.3);
        ctx.fillRect(x, SHOT_Y + 2, Math.max(3, frameToX(a.clip_length, w)), SHOT_H - 4);
      }
      ctx.fillStyle = col;
      ctx.fillRect(clamp(x - (atEnd ? 2 : 0), 0, w - 2), SHOT_Y + 2, 2, SHOT_H - 4);
      ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      const label = `${a.kind === "image" ? "▣" : a.kind === "clip" ? "▶" : "♪"} ${a.name}`;
      const tw = ctx.measureText(label).width + 8;
      const lx = clamp(atEnd ? x - tw - 2 : x + 2, 0, Math.max(0, w - tw));
      ctx.fillStyle = "rgba(0,0,0,.72)"; ctx.fillRect(lx, y, tw, 13);
      ctx.fillStyle = col; ctx.fillText(label, lx + 4, y + 7);
    }

    // ---- cut markers: a diamond over every interior boundary, the selected one lit,
    // with a guide line down through the cells so it is obvious which cell it lands in
    const cy = RULER_H + LABEL_H / 2;
    shots.forEach((s, i) => {
      if (i === 0) return;
      const x0 = frameToX(s.start, w);
      const on = s.start === selCut;
      const r = on ? 7 : 4;
      ctx.beginPath();
      ctx.moveTo(x0, cy - r); ctx.lineTo(x0 + r, cy); ctx.lineTo(x0, cy + r); ctx.lineTo(x0 - r, cy);
      ctx.closePath();
      if (s.join === "continuous") {
        // the same shot going on: an open diamond with a line running through it
        ctx.strokeStyle = on ? C.cut : "#8fa3b8"; ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0 - r - 5, cy); ctx.lineTo(x0 + r + 5, cy); ctx.stroke();
      } else {
        ctx.fillStyle = on ? C.cut : "#8fa3b8";
        ctx.fill();
      }
      if (on && withCells) {
        ctx.strokeStyle = C.cutLine; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0 + 0.5, SHOT_Y + SHOT_H); ctx.lineTo(x0 + 0.5, CELL_Y + CELL_H); ctx.stroke();
      }
    });

    // ---- cell strip, on the same axis
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = "10px ui-monospace, Consolas, monospace";
    (withCells ? d.derived.cells : []).forEach(([a, b], i) => {
      const x0 = frameToX(a, w), x1 = frameToX(b + 1, w);
      const pxW = Math.max(1, x1 - x0 - 2);
      const isFree = free.has(i);
      ctx.fillStyle = isFree ? C.cellFree : C.cellPinned;
      ctx.fillRect(x0 + 1, CELL_Y, pxW, CELL_H);
      ctx.strokeStyle = C.cellBorder; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 1.5, CELL_Y + 0.5, pxW - 1, CELL_H - 1);
      if (pxW > 26) {
        ctx.fillStyle = isFree ? C.cellFreeText : C.cellPinnedText;
        ctx.textBaseline = "top";
        ctx.fillText(ellipsize(ctx, t("tl.cell", i), pxW - 6), x0 + 4, CELL_Y + 5);
        ctx.fillText(ellipsize(ctx, `${a}-${b}`, pxW - 6), x0 + 4, CELL_Y + 19);
        if (pxW > 52) {
          ctx.fillStyle = isFree ? "#2b6cb0" : "#4a5a6b";
          ctx.fillText(isFree ? t("tl.free") : t("tl.pinned"), x0 + 4, CELL_Y + 32);
        }
      }
    });

    // ---- playhead
    const phx = frameToX(playhead, w);
    ctx.strokeStyle = C.playhead; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(phx + 0.5, 0); ctx.lineTo(phx + 0.5, H); ctx.stroke();
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(phx - 5, 0); ctx.lineTo(phx + 5, 0); ctx.lineTo(phx, 8); ctx.closePath(); ctx.fill();
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "top";
    const phLabel = `${playhead}f`;
    const lw = ctx.measureText(phLabel).width;
    ctx.fillText(phLabel, Math.min(w - lw - 2, phx + 4), 14);

    // ---- snap guide
    if (st.snapX !== null) {
      ctx.strokeStyle = C.snapGuide; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(st.snapX + 0.5, SHOT_Y); ctx.lineTo(st.snapX + 0.5, H - 4);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------ lifecycle
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onHover);
  canvas.addEventListener("mouseleave", () => { canvas.style.cursor = "default"; });
  canvas.addEventListener("wheel", onWheel, { passive: false });
  // Coming back to a foregrounded tab does not necessarily change any element's size,
  // so the ResizeObserver alone is not enough to refresh what was drawn while hidden.
  const onVisible = () => { if (!document.hidden) render(); };
  document.addEventListener("visibilitychange", onVisible);
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => render()) : null;
  ro && ro.observe(viewport);

  return {
    el: root,
    below,
    render,
    /**
     * Show a playhead that is not (yet) in the document — a playing player reports its
     * frame here every presented frame; writing the document that often would be absurd.
     * `null` hands the playhead back to the document.
     */
    setPlayhead(frame) {
      st.playhead = frame == null ? null : frame;
      render();
    },
    destroy() {
      st.destroyed = true;
      flushWrites();
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.unsubStrip) st.unsubStrip();
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onHover);
      canvas.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      ro && ro.disconnect();
      root.remove();
    },
  };
}
