// Gacha Director — the frame-accurate video player.
//
// One player, two homes: the edit page puts its picture box above the timeline and its
// transport below it (the Motion Director arrangement, see NOTICE), the takes page puts
// one whole player beside each shot's candidates. Frames are 0-based everywhere,
// matching the timeline, the anchors and the segment ranges; a frame is shown by seeking
// to the middle of its display interval, never to its boundary, where rounding would
// show the neighbour.
//
// During playback the frame is read from requestVideoFrameCallback when the browser has
// it (one callback per presented frame, with the media time it was presented at), and
// from timeupdate otherwise. Nothing here writes a document: the owner decides what a
// frame change means through onFrame.

import { btn, el, tip } from "./gd_ui.js";
import { t } from "./gd_i18n.js";
import { FPS } from "./gd_doc.js";

function fmtSec(f) { return (f / FPS).toFixed(2); }

// Whether playing is heard: one switch for every player of the panel, so a take is listened
// to wherever it is played. Off until the user turns it on (a page may not start sound by
// itself), and remembered in this browser.
const SOUND_KEY = "gachadirector.sound";
const soundWatchers = new Set();
let soundOn = false;
try { soundOn = window.localStorage.getItem(SOUND_KEY) === "1"; } catch (e) { /* a private window, or no window */ }
export const sound = {
  on: () => soundOn,
  set(v) {
    soundOn = !!v;
    try { window.localStorage.setItem(SOUND_KEY, soundOn ? "1" : "0"); } catch (e) { /* see above */ }
    for (const fn of soundWatchers) fn(soundOn);
  },
  /** Call `fn(on)` now and whenever the switch changes; returns how to stop that. */
  watch(fn) { soundWatchers.add(fn); fn(soundOn); return () => soundWatchers.delete(fn); },
};

/** The switch as a button for a transport: {el, stop}. */
export function soundButton() {
  const b = btn("♪", () => sound.set(!sound.on()), "gd-btn gd-ghost");
  tip(b, t("player.sound"));
  const stop = sound.watch((on) => b.classList.toggle("gd-active", on));
  return { el: b, stop };
}

/**
 * @param opts.onFrame   (frame, {playing, source}) — source is "play" | "user" | "load"
 * @param opts.onMeta    ({width, height, duration, frames}) once the file's metadata is in
 * @param opts.loop      initial loop state
 * @param opts.loopLabel text on the loop toggle
 * @param opts.wide      picture box is a fixed-height letterbox (edit page) instead of a square
 * @param opts.detachedControls  keep the transport out of `el` so the owner can place it
 * @param opts.emptyText what the box says when there is no file
 */
export function createPlayer(opts = {}) {
  const {
    onFrame, onMeta, loop = true, loopLabel = null, wide = false,
    detachedControls = false, emptyText = "",
  } = opts;

  const root = el("div", "gd-player" + (wide ? " gd-player-wide" : ""));
  const box = el("div", "gd-player-box");
  const video = el("video");
  const unwatchSound = sound.watch((on) => { video.muted = !on; });
  video.playsInline = true;
  video.preload = "auto";
  video.hidden = true;               // until a file is loaded, the box says there is none
  const overlay = el("div", "gd-player-overlay", "");
  const empty = el("div", "gd-player-empty", emptyText);
  box.append(video, overlay, empty);
  root.appendChild(box);

  const controls = el("div", "gd-player-controls");
  const play = btn("▶", () => toggle(), "gd-btn");
  tip(play, t("player.playPause"));
  const loopBtn = btn("⟳", () => { st.loop = !st.loop; paintLoop(); }, "gd-btn gd-ghost");
  tip(loopBtn, loopLabel || t("player.loop"));
  const soundBtn = soundButton();
  const first = btn("⏮", () => seek(range.lo, { source: "user" }), "gd-btn gd-ghost");
  tip(first, t("player.toStart"));
  const back = btn("‹", () => seek(frame() - 1, { source: "user" }), "gd-btn gd-ghost");
  tip(back, t("player.prevFrame"));
  const fwd = btn("›", () => seek(frame() + 1, { source: "user" }), "gd-btn gd-ghost");
  tip(fwd, t("player.nextFrame"));
  const last = btn("⏭", () => seek(range.hi, { source: "user" }), "gd-btn gd-ghost");
  tip(last, t("player.toEnd"));
  const frameWrap = el("span", "gd-player-framebox");
  frameWrap.appendChild(el("span", "gd-hint", t("player.frame")));
  const frameIn = el("input", "gd-player-frameinput");
  frameIn.type = "number"; frameIn.step = "1";
  frameIn.addEventListener("change", () => seek(Number(frameIn.value), { source: "user" }));
  frameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { seek(Number(frameIn.value), { source: "user" }); frameIn.blur(); } });
  const frameTotal = el("span", "gd-hint", "/ -");
  frameWrap.append(frameIn, frameTotal);
  const timeOut = el("span", "gd-player-time", "0.00 / 0.00");
  const slider = el("input", "gd-player-range");
  slider.type = "range";
  slider.min = "0"; slider.max = "0"; slider.step = "1"; slider.value = "0";
  slider.addEventListener("input", () => seek(Number(slider.value), { source: "user" }));
  controls.append(play, loopBtn, soundBtn.el, first, back, fwd, last, frameWrap, timeOut, slider);
  if (!detachedControls) root.appendChild(controls);

  // `offset` is where frame 0 of the transport sits in the file: a clip that starts 120
  // frames into its source plays the file from 5 s while the readouts count from 0.
  const st = { src: "", loop: !!loop, rvfc: 0, meta: null, destroyed: false, offset: 0 };
  const range = { lo: 0, hi: 0 };
  paintLoop();

  const timeOf = (f) => (f + st.offset + 0.5) / FPS;
  const frameAt = (sec) => Math.max(0, Math.floor(sec * FPS + 1e-6) - st.offset);
  function frame() { return frameAt(video.currentTime); }
  function playing() { return !!st.src && !video.paused && !video.ended; }
  function clampF(f) { return Math.max(range.lo, Math.min(range.hi, Number.isFinite(f) ? Math.round(f) : range.lo)); }

  function paintLoop() {
    loopBtn.classList.toggle("gd-active", st.loop);
    loopBtn.textContent = st.loop ? "⟳" : "→|";
  }

  /** Update every readout to frame f; emit onFrame unless silent. */
  function paint(f, { playing: isPlaying = playing(), source = "user", silent = false } = {}) {
    const cur = clampF(f == null ? frame() : f);
    const whole = range.lo === 0;
    frameIn.value = String(cur);
    frameTotal.textContent = whole ? `/ ${range.hi}` : `/ ${range.lo}–${range.hi}`;
    timeOut.textContent = `${fmtSec(cur)} / ${fmtSec(range.hi + 1)} s`;
    overlay.textContent = st.src ? t("player.frameOf", cur, range.hi) : "";
    slider.value = String(cur);
    play.textContent = isPlaying ? "❚❚" : "▶";
    if (!silent && onFrame) onFrame(cur, { playing: isPlaying, source });
  }

  function seek(f, { source = "user", silent = false } = {}) {
    if (!st.src) { paint(f, { playing: false, source, silent }); return; }
    const target = clampF(f);
    video.pause();
    video.currentTime = timeOf(target);
    paint(target, { playing: false, source, silent });
  }

  function toggle() {
    if (!st.src) return;
    if (video.paused || video.ended) {
      const f = frame();
      if (f >= range.hi || f < range.lo) video.currentTime = timeOf(range.lo);
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // ---- playback tracking
  function onPresented(f) {
    if (st.destroyed) return;
    if (f >= range.hi) {
      if (st.loop) { video.currentTime = timeOf(range.lo); paint(range.lo, { playing: true, source: "play" }); return; }
      video.pause();
      video.currentTime = timeOf(range.hi);
      paint(range.hi, { playing: false, source: "play" });
      return;
    }
    paint(f, { playing: true, source: "play" });
  }
  function trackWithRvfc() {
    if (!("requestVideoFrameCallback" in video)) return false;
    const cb = (_now, meta) => {
      if (st.destroyed || video.paused) { st.rvfc = 0; return; }
      onPresented(frameAt(meta.mediaTime));
      if (!video.paused) st.rvfc = video.requestVideoFrameCallback(cb);
    };
    st.rvfc = video.requestVideoFrameCallback(cb);
    return true;
  }
  video.addEventListener("play", () => {
    if (!trackWithRvfc()) st.useTimeupdate = true;
    paint(frame(), { playing: true, source: "play" });
  });
  video.addEventListener("timeupdate", () => {
    if (st.useTimeupdate && !video.paused) onPresented(frame());
  });
  video.addEventListener("pause", () => {
    if (st.rvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(st.rvfc);
    st.rvfc = 0;
    paint(frame(), { playing: false, source: "play" });
  });
  video.addEventListener("ended", () => paint(frame(), { playing: false, source: "play" }));
  video.addEventListener("loadedmetadata", () => {
    st.meta = {
      width: video.videoWidth, height: video.videoHeight,
      duration: video.duration, frames: Math.round(video.duration * FPS),
    };
    onMeta && onMeta(st.meta);
    seek(st.startFrame == null ? range.lo : st.startFrame, { source: "load", silent: !!st.silentLoad });
  });
  video.addEventListener("error", () => {
    overlay.textContent = t("player.loadFailed");
  });

  return {
    el: root,
    controls,
    video,
    /**
     * Load a file and confine the transport to [lo, hi] frames. `startFrame` is where the
     * playhead lands once metadata is in; `silent` suppresses the onFrame for that landing
     * (the owner already knows where it asked to land).
     */
    load(src, lo, hi, { startFrame = null, silent = false, offset = 0 } = {}) {
      st.offset = Math.max(0, offset | 0);
      range.lo = Math.max(0, lo | 0);
      range.hi = Math.max(range.lo, hi | 0);
      slider.min = String(range.lo);
      slider.max = String(range.hi);
      frameIn.min = String(range.lo);
      frameIn.max = String(range.hi);
      empty.hidden = !!src;
      video.hidden = !src;
      st.startFrame = startFrame;
      st.silentLoad = silent;
      if (src && src !== st.src) { st.src = src; st.meta = null; video.src = src; video.load(); }
      else if (src) seek(startFrame == null ? range.lo : startFrame, { source: "load", silent });
      else { st.src = ""; video.removeAttribute("src"); paint(range.lo, { playing: false, source: "load", silent: true }); }
    },
    setRange(lo, hi) {
      range.lo = Math.max(0, lo | 0); range.hi = Math.max(range.lo, hi | 0);
      slider.min = String(range.lo); slider.max = String(range.hi);
      frameIn.min = String(range.lo); frameIn.max = String(range.hi);
      paint(undefined, { silent: true });
    },
    seek, frame, playing, toggle,
    step(n, source = "user") { seek(frame() + n, { source }); },
    setLoop(v) { st.loop = !!v; paintLoop(); },
    meta() { return st.meta; },
    src() { return st.src; },
    offset() { return st.offset; },
    destroy() {
      st.destroyed = true;
      unwatchSound();
      soundBtn.stop();
      video.pause();
      video.removeAttribute("src");
      root.remove();
      controls.remove();
    },
  };
}
