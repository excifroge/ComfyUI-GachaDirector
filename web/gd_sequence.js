// Gacha Director — the picks played one after the other: the edit as it stands.
//
// A sequence is a list of parts, each a stretch of one file or a gap (a shot nothing is
// picked for). Every file has a video element of its own, loaded once. The part that is
// playing shows its element, and the element of the part after it is brought to that
// part's first frame beforehand, so going from one take to the next is a change of which
// element is shown. Nothing is rendered: where two takes meet inside a long take the
// sequence switches the way it does at a cut.
//
// Frames are those of the sequence, 0-based. Heard when the panel's sound switch is on (see
// gd_player.js): each part with the sound of its own take.

import { btn, el, tip } from "./gd_ui.js";
import { t } from "./gd_i18n.js";
import { FPS } from "./gd_doc.js";
import { sound, soundButton } from "./gd_player.js";

// A part is left this long before the file's next frame is due: that frame belongs to
// another shot, and a display refresh later it would be on screen.
const EARLY_S = 0.012;

function fmtSec(f) { return (f / FPS).toFixed(2); }

/**
 * @param opts.onFrame   (frame, {playing, source}) — source is "play" | "user" | "load"
 * @param opts.emptyText what the box says while there is nothing to play
 */
export function createSequencePlayer(opts = {}) {
  const { onFrame, emptyText = "" } = opts;

  const root = el("div", "gd-player gd-player-wide gd-seq");
  const box = el("div", "gd-player-box");
  const gap = el("div", "gd-seq-gap");
  gap.hidden = true;
  const overlay = el("div", "gd-player-overlay", "");
  const empty = el("div", "gd-player-empty", emptyText);
  box.append(gap, overlay, empty);
  root.appendChild(box);

  const controls = el("div", "gd-player-controls");
  const play = btn("▶", () => toggle(), "gd-btn");
  tip(play, t("player.playPause"));
  const loopBtn = btn("⟳", () => { st.loop = !st.loop; paintLoop(); }, "gd-btn gd-ghost");
  tip(loopBtn, t("player.loop"));
  const soundBtn = soundButton();
  const first = btn("⏮", () => seek(0), "gd-btn gd-ghost");
  tip(first, t("player.toStart"));
  const back = btn("‹", () => seek(st.cur - 1), "gd-btn gd-ghost");
  tip(back, t("player.prevFrame"));
  const fwd = btn("›", () => seek(st.cur + 1), "gd-btn gd-ghost");
  tip(fwd, t("player.nextFrame"));
  const last = btn("⏭", () => seek(st.total - 1), "gd-btn gd-ghost");
  tip(last, t("player.toEnd"));
  const frameWrap = el("span", "gd-player-framebox");
  frameWrap.appendChild(el("span", "gd-hint", t("player.frame")));
  const frameIn = el("input", "gd-player-frameinput");
  frameIn.type = "number"; frameIn.step = "1"; frameIn.min = "0";
  frameIn.addEventListener("change", () => seek(Number(frameIn.value)));
  frameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { seek(Number(frameIn.value)); frameIn.blur(); } });
  const frameTotal = el("span", "gd-hint", "/ -");
  frameWrap.append(frameIn, frameTotal);
  const timeOut = el("span", "gd-player-time", "0.00 / 0.00");
  const slider = el("input", "gd-player-range");
  slider.type = "range";
  slider.min = "0"; slider.max = "0"; slider.step = "1"; slider.value = "0";
  slider.addEventListener("input", () => seek(Number(slider.value)));
  controls.append(play, loopBtn, soundBtn.el, first, back, fwd, last, frameWrap, timeOut, slider);

  // parts: [{url, from, length, label, at}] — `at` is where the part starts in the sequence
  const st = { parts: [], total: 0, cur: 0, on: false, loop: true, raf: 0, clock: 0, key: "", destroyed: false };
  const videos = new Map();           // url -> video element
  paintLoop();
  const unwatchSound = sound.watch((on) => { for (const v of videos.values()) v.muted = !on; });

  function paintLoop() {
    loopBtn.classList.toggle("gd-active", st.loop);
    loopBtn.textContent = st.loop ? "⟳" : "→|";
  }
  const clampF = (f) => Math.max(0, Math.min(st.total - 1, Number.isFinite(f) ? Math.round(f) : 0));
  const partAt = (f) => {
    const i = st.parts.findIndex((p) => f < p.at + p.length);
    return i < 0 ? st.parts.length - 1 : i;
  };
  // the middle of a frame's display interval, never its boundary (see gd_player.js)
  const timeOf = (p, f) => (p.from + (f - p.at) + 0.5) / FPS;

  function videoOf(url) {
    let v = videos.get(url);
    if (!v) {
      v = el("video");
      v.muted = !sound.on(); v.playsInline = true; v.preload = "auto"; v.hidden = true;
      v.src = url;
      box.insertBefore(v, gap);
      videos.set(url, v);
    }
    return v;
  }

  /** Make `p` the part on screen: its element and no other, or the gap's words. */
  function present(p) {
    const mine = p && p.url ? videoOf(p.url) : null;
    for (const v of videos.values()) v.hidden = v !== mine;
    gap.hidden = !p || !!p.url;
    gap.textContent = p && !p.url ? p.label : "";
    overlay.textContent = p && p.url ? p.label : "";
  }

  function paint({ playing = st.on, source = "user", silent = false } = {}) {
    frameIn.value = String(st.cur);
    frameTotal.textContent = `/ ${Math.max(0, st.total - 1)}`;
    timeOut.textContent = `${fmtSec(st.cur)} / ${fmtSec(st.total)} s`;
    slider.value = String(st.cur);
    play.textContent = playing ? "❚❚" : "▶";
    if (!silent && onFrame && st.total) onFrame(st.cur, { playing, source });
  }

  function halt() {
    st.on = false;
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    for (const v of videos.values()) if (!v.paused) v.pause();
  }

  function seek(f, { source = "user", silent = false } = {}) {
    halt();
    if (!st.total) { present(null); paint({ playing: false, source, silent: true }); return; }
    st.cur = clampF(f);
    const p = st.parts[partAt(st.cur)];
    present(p);
    if (p.url) videoOf(p.url).currentTime = timeOf(p, st.cur);
    paint({ playing: false, source, silent });
  }

  /** The part after `i` (the first one again when the sequence loops): its element at its
   *  first frame, so that it is ready when its turn comes. */
  function cue(i) {
    const n = st.parts[i + 1] || (st.loop ? st.parts[0] : null);
    const now = st.parts[i];
    if (!n || !n.url || n.url === now.url) return;
    const v = videoOf(n.url);
    if (v.paused) v.currentTime = timeOf(n, n.at);
  }

  /** Play on from the frame the sequence is at. */
  function start() {
    const i = partAt(st.cur);
    const p = st.parts[i];
    st.on = true;
    present(p);
    if (p.url) {
      const v = videoOf(p.url);
      const want = timeOf(p, st.cur);
      if (Math.abs(v.currentTime - want) > 0.5 / FPS) v.currentTime = want;
      v.play().catch(() => {});
    } else {
      st.clock = performance.now() - ((st.cur - p.at) / FPS) * 1000;
    }
    cue(i);
    paint({ playing: true, source: "play" });
    if (!st.raf) st.raf = requestAnimationFrame(tick);
  }

  /** Part `i` is over: go on with the one after it. */
  function leave(i) {
    const p = st.parts[i];
    const n = st.parts[i + 1];
    // the same file going straight on (two shots of one take): nothing to change but the words
    if (n && n.url && n.url === p.url && n.from === p.from + p.length) {
      st.cur = n.at;
      present(n);
      cue(i + 1);
      paint({ playing: true, source: "play" });
      st.raf = requestAnimationFrame(tick);
      return;
    }
    if (p.url) videoOf(p.url).pause();
    if (!n && !st.loop) {
      st.on = false;
      st.cur = st.total - 1;
      paint({ playing: false, source: "play" });
      return;
    }
    st.cur = n ? n.at : 0;
    start();
  }

  function tick() {
    st.raf = 0;
    if (st.destroyed || !st.on) return;
    // a page that is no longer shown does not go on playing
    if (!root.isConnected || !root.getClientRects().length) { halt(); paint({ playing: false, source: "play", silent: true }); return; }
    const i = partAt(st.cur);
    const p = st.parts[i];
    let f;
    if (p.url) {
      const v = videoOf(p.url);
      if (v.ended || v.currentTime >= (p.from + p.length) / FPS - EARLY_S) { leave(i); return; }
      f = p.at + Math.max(0, Math.floor(v.currentTime * FPS + 1e-6) - p.from);
    } else {
      const gone = ((performance.now() - st.clock) / 1000) * FPS;
      if (gone >= p.length) { leave(i); return; }
      f = p.at + Math.floor(gone);
    }
    f = Math.min(f, p.at + p.length - 1);
    if (f !== st.cur) { st.cur = f; paint({ playing: true, source: "play" }); }
    st.raf = requestAnimationFrame(tick);
  }

  function toggle() {
    if (!st.total) return;
    if (st.on) { halt(); paint({ playing: false, source: "play" }); return; }
    if (st.cur >= st.total - 1) st.cur = 0;
    start();
  }

  return {
    el: root,
    controls,
    /**
     * What to play: `parts` in order, each `{url, from, length, label}` — `length` frames
     * of the file at `url` from its frame `from`, or, with no url, a gap that long. The
     * label is shown over the picture (in its place, for a gap). The same parts again
     * change nothing, so a page may call this every time it is drawn.
     */
    load(parts) {
      const kept = parts.filter((p) => p.length > 0);
      const key = JSON.stringify(kept.map((p) => [p.url || "", p.from | 0, p.length | 0, p.label || ""]));
      if (key === st.key) return;
      halt();
      st.key = key;
      let at = 0;
      st.parts = kept.map((p) => {
        const q = { url: p.url || "", from: Math.max(0, p.from | 0), length: p.length | 0, label: p.label || "", at };
        at += q.length;
        return q;
      });
      st.total = at;
      const used = new Set(st.parts.map((p) => p.url).filter(Boolean));
      for (const [url, v] of videos) {
        if (used.has(url)) continue;
        v.removeAttribute("src");
        v.load();
        v.remove();
        videos.delete(url);
      }
      for (const url of used) videoOf(url);
      empty.hidden = st.total > 0;
      slider.max = String(Math.max(0, st.total - 1));
      frameIn.max = slider.max;
      seek(st.cur, { source: "load", silent: true });
    },
    seek,
    toggle,
    frame() { return st.cur; },
    frames() { return st.total; },
    playing() { return st.on; },
    /** [{at, length}] of the parts as loaded, in order. */
    layout() { return st.parts.map((p) => ({ at: p.at, length: p.length })); },
    destroy() {
      st.destroyed = true;
      unwatchSound();
      soundBtn.stop();
      halt();
      for (const v of videos.values()) { v.removeAttribute("src"); v.remove(); }
      videos.clear();
      root.remove();
      controls.remove();
    },
  };
}
