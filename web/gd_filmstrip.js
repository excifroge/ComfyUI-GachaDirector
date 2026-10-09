// Gacha Director — filmstrip thumbnails for the timeline.
//
// The shot track shows the source clip itself, frame by frame, the way the Motion
// Director's timeline does (see NOTICE). Thumbnails are pulled client-side from the same
// file the player shows: a detached <video> is seeked to each wanted frame and drawn into
// a small canvas. No server route, no cache directory, nothing to go stale on disk — a
// clip that changes on the server is a different URL the moment its name changes.
//
// One store per URL, kept for the life of the page. Frames are requested in the order the
// timeline needs them, so the seek loop walks forward and the strip fills left to right.
//
// Loading can fail for reasons that have nothing to do with the file: ComfyUI serves
// files from the same single-threaded loop that runs the graph, and while a sampler is
// grinding a media fetch can time out. So a failure is retried with a growing delay, and
// the reason is kept (HTTP status or decoder error) so the timeline can say which it was
// instead of a bare "failed".

import { FPS } from "./gd_doc.js";
import { t } from "./gd_i18n.js";

const THUMB_H = 96;             // thumbnail height in pixels; width follows the aspect
const SEEK_TIMEOUT_MS = 2500;   // a seek that never fires `seeked` is skipped, not fatal
const NOTIFY_MS = 40;           // batch redraw notifications while thumbnails stream in
const RETRY_MS = [1500, 4000, 9000];   // automatic retries after a load error

const MEDIA_ERR = { 1: "film.aborted", 2: "film.network", 3: "film.decode", 4: "film.unsupported" };

const stores = new Map();

function createStore(src) {
  const s = {
    src, ready: false, failed: false, reason: "", attempts: 0, aspect: 1, frames: 0,
    thumbs: new Map(), queue: [], queued: new Set(), busy: false,
    listeners: new Set(), notifyTimer: 0, retryTimer: 0, video: null,
    thumb(f) { return this.thumbs.get(f) || null; },
    /** Ask for these frames; already-present or already-queued ones are ignored. */
    ensure(frames) {
      let added = false;
      for (const f of frames) {
        if (this.thumbs.has(f) || this.queued.has(f)) continue;
        this.queued.add(f); this.queue.push(f); added = true;
      }
      if (added) pump();
    },
    /** Start over after a failure (a click on the strip, or the automatic retry). */
    retry() {
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = 0; }
      this.failed = false; this.reason = ""; this.ready = false;
      attach();
      notify();
    },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  };

  function notify() {
    if (s.notifyTimer) return;
    s.notifyTimer = setTimeout(() => {
      s.notifyTimer = 0;
      for (const fn of s.listeners) { try { fn(s); } catch (e) { /* a listener must not stop the strip */ } }
    }, NOTIFY_MS);
  }

  function seekTo(sec) {
    const video = s.video;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", onSeeked);
        clearTimeout(timer);
        resolve(ok);
      };
      const onSeeked = () => finish(true);
      const timer = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
      video.addEventListener("seeked", onSeeked);
      if (Math.abs(video.currentTime - sec) < 1e-4 && video.readyState >= 2) { finish(true); return; }
      video.currentTime = sec;
    });
  }

  async function pump() {
    if (s.busy || !s.ready || s.failed) return;
    s.busy = true;
    try {
      while (s.queue.length && !s.failed) {
        const f = s.queue.shift();
        s.queued.delete(f);
        if (s.thumbs.has(f)) continue;
        const ok = await seekTo((f + 0.5) / FPS);
        if (!ok || s.video.readyState < 2) continue;
        const c = document.createElement("canvas");
        c.width = Math.max(8, Math.round(THUMB_H * s.aspect));
        c.height = THUMB_H;
        try { c.getContext("2d").drawImage(s.video, 0, 0, c.width, c.height); }
        catch (e) { continue; }
        s.thumbs.set(f, c);
        notify();
      }
    } finally {
      s.busy = false;
    }
  }

  /** Find out whether the URL even answers, so the failure text can say 404 vs decode. */
  async function explain(video) {
    const code = video.error && video.error.code;
    let reason = t(MEDIA_ERR[code] || "film.unknown");
    try {
      const res = await fetch(src, { method: "HEAD", cache: "no-store" });
      if (!res.ok) reason = t("film.http", res.status);
      else if (code === 4) reason = t("film.codec");
    } catch (e) {
      reason = t("film.noServer");
    }
    return reason;
  }

  function attach() {
    if (s.video) { s.video.removeAttribute("src"); s.video.load(); }
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    s.video = video;
    s.attempts += 1;
    video.addEventListener("loadedmetadata", () => {
      if (s.video !== video) return;
      s.ready = true;
      s.aspect = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 1;
      s.frames = Math.round(video.duration * FPS);
      // frames requested while we were down are still queued; drain them
      for (const f of s.queue) s.queued.add(f);
      notify();
      pump();
    });
    video.addEventListener("error", async () => {
      if (s.video !== video) return;
      s.failed = true;
      s.reason = await explain(video);
      notify();
      const delay = RETRY_MS[s.attempts - 1];
      if (delay != null) s.retryTimer = setTimeout(() => { s.retryTimer = 0; s.retry(); }, delay);
    });
    video.src = src;
    video.load();
  }

  attach();
  return s;
}

/** The thumbnail store for a video URL (shared across timelines showing the same clip). */
export function filmstrip(src) {
  if (!src) return null;
  let s = stores.get(src);
  if (!s) { s = createStore(src); stores.set(src, s); }
  return s;
}
