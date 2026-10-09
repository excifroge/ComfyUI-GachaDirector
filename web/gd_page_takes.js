// Gacha Director — the takes page: candidates, one pick per shot, then the final clip.
//
//   candidates  ->  pick per shot  ->  final
//
// Layout: the edit page's timeline on top, read-only, as a navigator — click a shot to
// jump to its block, and each shot wears a badge (none / has candidates / picked). Under
// it, one block per shot: a frame-accurate player on the left, with what can be done with
// the take it shows (use it for every shot, delete it), and every take cut to this shot's
// range on the right. A clip of one shot has one such block. Beside the
// blocks runs a narrow navigator: one numbered cell per shot in the colour of its state,
// as tall as the shot is long, with the timeline's red marker across it. It is as tall as
// the visible part of the page and does nothing but jump to a shot.
//
// The cards of a pool wrap into rows and scroll down inside the pool. Their size is the
// viewer's to set, pool by pool, with a slider at the right end of the pool's heading; its
// smallest position is a list.
//
// A candidate is always a whole-clip render. The model renders the whole clip every time,
// so a new take costs the same as re-rendering one shot would, and it starts from noise
// rather than from generated frames. Another roll is another seed.
//
// The final clip is one of two things. If every shot picked the same take, that take is
// the final clip and nothing is rendered again. If the picks span takes, the composite
// button queues one more run: the picked ranges spliced into the starting latent, with the
// cells around each cut where the take changes left free. Whether takes cut together at
// all depends on the clip — takes that share a source clip or dense anchors move alike,
// unconstrained ones are different videos — so this page shows the seams it would repair
// and promises nothing.

import { t } from "./gd_i18n.js";
import { createTimeline, shotColor } from "./gd_timeline.js";
import { createPlayer } from "./gd_player.js";
import { createSequencePlayer } from "./gd_sequence.js";
import { btn, el, linkMark, row, section, tip } from "./gd_ui.js";
import { canvasSize, CELL, FPS } from "./gd_doc.js";
import { seconds } from "./gd_material.js";
import {
  allPicked, cutFrames, finishedTakes, layoutKey, segmentStatus, singleTake, splicePlan,
} from "./gd_takes_doc.js";

const NAV_MIN_H = 120;             // the navigator never shrinks below this
const NAV_MARGIN = 8;              // gap kept to the panel's top and bottom edges
// The width of a take's card, in pixels. The slider's lowest position is the list.
const CARD_MIN = 110, CARD_MAX = 420, CARD_STEP = 10, CARD_DEFAULT = 170;
const CARD_LIST = CARD_MIN - CARD_STEP;
const CARD_KEY = "gachadirector.cardSizes";

/** The sizes the viewer left the pools at: {"whole": px, "0": px, ...} by pool. */
function readCardSizes() {
  try {
    const all = JSON.parse(window.localStorage.getItem(CARD_KEY) || "{}");
    const out = {};
    for (const [k, v] of Object.entries(all && typeof all === "object" ? all : {})) {
      if (Number.isFinite(v) && v >= CARD_LIST && v <= CARD_MAX) out[k] = v;
    }
    return out;
  } catch { /* storage is a convenience: the page works without it */ }
  return {};
}

export function createTakesPage(host) {
  const root = host.container;
  let timeline = null;
  let monitor = null;                 // the picks played one after the other, above the navigator
  let monitorParts = [];              // what it plays: [{shot, at, length, ...}], shot -1 for the final clip
  let body = null;
  let navPh = null;                   // the red marker across the navigator
  let navScroller = null;             // the element whose scrolling the navigator follows
  let navRo = null;
  const cardSizes = readCardSizes();  // pool ("whole", or a shot's index) -> card width
  const players = new Map();          // shot index (or a key) -> player
  const viewing = new Map();          // shot index -> take id being previewed
  let noteText = "";                  // one-line feedback after queueing
  let liveBox = null;                 // {el, img, text}: the render in progress

  function buildShell() {
    root.replaceChildren();
    const tlSec = section(null);
    tlSec.classList.add("gd-sec-tl");
    const head = el("div", "gd-tl-head");
    head.appendChild(tip(el("h3", null, t("takes.monitor")), t("takes.monitorHint")));
    tlSec.appendChild(head);
    monitor = createSequencePlayer({ emptyText: t("takes.monitorEmpty"), onFrame: onMonitorFrame });
    tlSec.appendChild(monitor.el);
    timeline = createTimeline({
      doc: () => host.doc(),
      normalize: host.normalizeDoc,
      commit: (d) => host.commitDoc(d, t("h.nav")),
      readOnly: true,
      plateSrc: () => { const d = host.doc(); return d.source.video ? host.viewUrl(d.source.video) : ""; },
      plateOffset: () => host.doc().source.start,
      segmentStatus: (i) => segmentStatus(host.takes(), i),
      onSelectShot: (i) => { renderBody(); scrollToSeg(i); },
      onScrub: (f) => { paintNavPlayhead(f); if (monitor) monitor.seek(monitorFrameOf(f), { silent: true }); },
    });
    tlSec.appendChild(timeline.el);
    tlSec.appendChild(monitor.controls);
    root.appendChild(tlSec);
    body = el("div", "gd-edit-body");
    root.appendChild(body);
    renderBody();
    timeline.render();
  }

  // ---------------------------------------------------------------- the monitor
  /**
   * What the edit comes to as picked now. The final clip itself when there is one (one
   * take picked for every shot, or the composite of the picks as they are); otherwise,
   * shot by shot, the frames of the picked take that are that shot, and a gap for a shot
   * nothing is picked for. Where two takes meet inside a long take this simply switches:
   * the frames around such a join are generated when the picks are joined, not before.
   */
  function paintMonitor() {
    if (!monitor) return;
    const d = host.doc();
    const tk = host.takes();
    const shots = d.prompt.shots;
    const parts = [];
    // (one take picked for every shot is played shot by shot like any other picks: it is
    // the final clip once it was put out as one)
    const fin = host.madeFile ? host.madeFile() : "";
    if (fin) {
      const frames = host.finalFrames ? host.finalFrames() : d.derived.frame_count;
      parts.push({ shot: -1, url: host.viewUrlOutput(fin), from: 0, length: frames, label: t("takes.final") });
    } else if (finishedTakes(tk).length) {
      shots.forEach((s, i) => {
        const take = tk.takes.find((x) => x.id === tk.picks[String(i)]);
        if (!take || take.status !== "done" || !take.file || !fits(take)) {
          parts.push({ shot: i, url: "", from: 0, length: s.length, label: t("takes.monitorGap", i + 1) });
          return;
        }
        const [a, b] = host.realRange ? host.realRange(take.file, i) : [s.start, s.start + s.length - 1];
        parts.push({ shot: i, url: host.viewUrlOutput(take.file), from: a, length: b - a + 1,
                     label: t("takes.monitorPart", i + 1, take.seed) });
      });
    }
    monitor.load(parts);
    const laid = monitor.layout();
    monitorParts = parts.filter((p) => p.length > 0).map((p, i) => ({ ...p, at: laid[i].at }));
  }
  /** The frame of the clip a frame of the monitor stands for. */
  function clipFrameOf(f) {
    const d = host.doc();
    const p = monitorParts.find((x) => f < x.at + x.length) || monitorParts[monitorParts.length - 1];
    if (!p || p.shot < 0) return Math.min(f, d.derived.frame_count - 1);
    const s = d.prompt.shots[p.shot];
    return s.start + Math.min(f - p.at, s.length - 1);
  }
  /** And the other way: where in the monitor a frame of the clip is. */
  function monitorFrameOf(f) {
    const shots = host.doc().prompt.shots;
    const i = shots.findIndex((s) => f < s.start + s.length);
    const p = monitorParts.find((x) => x.shot === (i < 0 ? shots.length - 1 : i));
    if (!p) return f;
    return p.at + Math.min(Math.max(0, f - shots[p.shot].start), p.length - 1);
  }
  function onMonitorFrame(f) {
    const at = clipFrameOf(f);
    if (timeline) timeline.setPlayhead(at);
    paintNavPlayhead(at);
  }

  // ---------------------------------------------------------------- the seams
  // A stretch shorter than this has not closed a seam well in the measurements
  // (12 frames ending where a cell begins came to 1.3 times the takes' own
  // motion, 8 and 4 frames to 1.5 and 1.6; a plain cut was 3.0).
  const SEAM_SHORT = 12;
  // Two takes this far apart where they meet (dB between them) have not been joined by
  // generating again, whatever the range: about 30 dB closed with a dozen frames, 18 dB did
  // not close with thirty-four. Between the two nothing was measured.
  const SEAM_UNLIKE = 22;
  let seamDrag = false;               // an end of a range is being dragged: the strip is left alone
  let seamFront = -1;                 // the seam whose bar lies on top (ranges may cover one another)
  /**
   * Under the timeline: what joining generates again around each seam (where two takes of
   * one long take meet), as a bar with two ends to drag. An end stands where a latent frame
   * begins: the mask is made of latent frames, and those are not evenly spaced (a cell is
   * one frame and then four times four). Nothing is written while an end is dragged; the
   * range goes into the document once, when it is let go somewhere else than it was.
   */
  function paintSeams() {
    if (!timeline || !timeline.below || seamDrag) return;
    const strip = timeline.below;
    strip.replaceChildren();
    const j = host.joinPlan ? host.joinPlan() : null;
    const ranges = j ? j.ranges : [];
    strip.classList.toggle("gd-seams", ranges.length > 0);
    // what a composite of these picks and ranges is known by (for checks made in a browser)
    strip.dataset.key = j ? host.compositeKey(host.doc(), j.plan) : "";
    if (!ranges.length) return;
    const fc = host.doc().derived.frame_count;
    const pct = (f) => `${(f / fc) * 100}%`;
    // where a cell begins the line is longer: a range that ends there leaves the frames
    // after it to the take they are from (inside a cell every latent frame leans on those
    // before it, and a kept one behind a replaced one no longer fits)
    const onCell = (f) => f % CELL === 0 || f >= fc;
    const drawn = new Set();
    for (const r of ranges) {
      for (const f of r.lines) {
        if (drawn.has(f)) continue;
        drawn.add(f);
        const line = el("i", "gd-seam-line" + (onCell(f) ? " cell" : ""));
        line.style.left = pct(f);
        strip.appendChild(line);
      }
    }
    for (const r of ranges) {
      // the seam itself: a line where it is, with a head to press. Two ranges can cover one
      // another entirely; the seams they belong to are never in one place, so the head is
      // what brings a bar that lies under another to the front.
      const at = el("i", "gd-seam-at" + (seamFront === r.frame ? " front" : ""));
      at.style.left = pct(r.frame);
      at.addEventListener("click", () => { seamFront = r.frame; paintSeams(); });
      strip.appendChild(at);
      const bar = el("div", "gd-seam" + (seamFront === r.frame ? " front" : ""));
      const label = el("span", "gd-seam-label" + (seamFront === r.frame ? " front" : ""));
      const place = (lo, end) => {
        bar.style.left = pct(lo);
        bar.style.width = pct(Math.max(0, end - lo));
        bar.classList.toggle("short", end > lo && (end - lo < SEAM_SHORT || !onCell(end)));
        bar.classList.toggle("none", end <= lo);
        const range = end <= lo ? t("takes.seamNone")
          : t("takes.seamRange", Math.max(0, r.frame - lo), Math.max(0, end - r.frame), seconds(end - lo));
        const alike = r.alike == null ? "" : ` · ${t("takes.seamAlike", r.alike.toFixed(0))}`;
        label.textContent = (r.kind === "auto" && lo === r.lo && end === r.end ? `${t("takes.seamAuto")} · ${range}` : range) + alike;
        label.classList.toggle("unlike", r.alike != null && r.alike < SEAM_UNLIKE);
        // The readout stands after the bar; before it where it would run off the strip;
        // and over the bar, ending where the bar ends, when there is room on neither side.
        // (A strip that is not laid out yet has no width: then by shares of it.)
        const tail = Math.max(end, lo), head = Math.min(lo, tail);
        const w = strip.clientWidth, need = label.offsetWidth + 20;
        const after = w ? w * (1 - tail / fc) >= need : tail / fc <= 0.6;
        const before = !after && (w ? w * (head / fc) >= need : head / fc >= 0.4);
        label.classList.toggle("before", before);
        label.classList.toggle("in", !after && !before);
        label.style.left = after ? pct(tail) : "auto";
        label.style.right = after ? "auto" : `${(1 - (before ? head : tail) / fc) * 100}%`;
      };
      const handle = (side) => {
        const h = el("b", `gd-seam-handle ${side}`);
        h.addEventListener("pointerdown", (e) => {
          const allowed = side === "l" ? r.leftLines : r.rightLines;
          if (e.button !== 0 || !allowed.length) return;
          e.preventDefault();
          e.stopPropagation();
          try { h.setPointerCapture(e.pointerId); } catch (err) { /* an event made by a script */ }
          let lo = r.lo, end = r.end;
          if (end <= lo) { lo = r.mineLo; end = r.mineEnd; }
          let moved = false;
          seamDrag = true;
          const move = (m) => {
            // the strip as it lies now: the timeline may have been scrolled meanwhile
            const box = strip.getBoundingClientRect();
            const f = ((m.clientX - box.left) / Math.max(1, box.width)) * fc;
            const near = allowed.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), allowed[0]);
            if (side === "l") lo = near; else end = near;
            moved = true;
            place(lo, end);
          };
          const over = (commit) => {
            h.removeEventListener("pointermove", move);
            h.removeEventListener("pointerup", up);
            h.removeEventListener("pointercancel", off);
            seamDrag = false;
            // the shot may be another one by now (the clip was edited from elsewhere)
            const still = (host.doc().prompt.shots[r.shot] || {}).id === r.id;
            if (commit && still && moved && (lo !== r.lo || end !== r.end)) host.setSeamRange(r.shot, lo, end);
            else paintSeams();
          };
          const up = () => over(true);
          const off = () => over(false);
          h.addEventListener("pointermove", move);
          h.addEventListener("pointerup", up);
          h.addEventListener("pointercancel", off);
        });
        return h;
      };
      bar.append(handle("l"), handle("r"));
      bar.dataset.seam = String(r.frame);
      bar.dataset.kind = r.kind;
      // a double click leaves the seam to itself again
      bar.addEventListener("dblclick", () => host.setSeamAuto(r.shot));
      tip(bar, [t("takes.seamRangeHint"), r.limited ? t("takes.seamRangeLimited") : "",
                r.alike != null && r.alike < SEAM_UNLIKE ? t("takes.seamUnlike") : ""].filter(Boolean).join("\n"));
      strip.append(bar, label);
      place(r.lo, r.end);
    }
  }

  function scrollToSeg(i) {
    const target = body && body.querySelector(`.gd-takeseg[data-seg="${i}"]`);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // ---------------------------------------------------------------- the navigator
  function paintNavPlayhead(f) {
    if (!navPh) return;
    const fc = Math.max(1, host.doc().derived.frame_count);
    navPh.style.top = `${(Math.max(0, Math.min(fc - 1, f)) / fc) * 100}%`;
  }
  /** The nearest scrolling element, the page container itself included. */
  function scrollParent() {
    for (let e = root; e && e !== document.body; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if (o === "auto" || o === "scroll") return e;
    }
    return root.parentElement;
  }
  /** As tall as the visible part of the shots: from where it sits (or the panel's top once
   *  it sticks) to the panel's bottom, never past the blocks it leads to. */
  function fitNav() {
    const nav = body && body.querySelector(".gd-takenav");
    const panel = scrollParent();
    if (!nav || !panel) return;
    const wrap = nav.parentElement;
    const col = wrap.querySelector(".gd-segcol");
    const pr = panel.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cr = col ? col.getBoundingClientRect() : wr;
    const top = Math.max(wr.top, pr.top + NAV_MARGIN);
    const bottom = Math.min(pr.bottom - NAV_MARGIN, Math.max(cr.bottom, top + NAV_MIN_H));
    const h = Math.max(NAV_MIN_H, Math.round(bottom - top));
    if (Math.abs(h - (parseFloat(nav.style.height) || 0)) >= 1) nav.style.height = `${h}px`;
    const total = Math.max(1, host.doc().derived.frame_count);
    for (const item of nav.querySelectorAll(".gd-takenav-item")) {
      item.classList.toggle("micro", (Number(item.dataset.len) / total) * h < 16);
    }
  }
  function watchNavFit() {
    const panel = scrollParent();
    if (!panel || panel === navScroller) return;
    if (navScroller) navScroller.removeEventListener("scroll", fitNav);
    navScroller = panel;
    panel.addEventListener("scroll", fitNav, { passive: true });
    if (navRo) navRo.disconnect();
    navRo = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => fitNav()) : null;
    if (navRo) { navRo.observe(panel); navRo.observe(body); }
  }

  // ---------------------------------------------------------------- the size of the cards
  /**
   * The slider of one pool: how large its cards are, the lowest position being a list.
   * `key` names the pool ("whole", or a shot's index) and `scope` is the element the pool
   * lies in: the size is set on it and on nothing else, so every pool is sized on its own.
   */
  function cardSizer(key, scope) {
    const sizeNow = () => (key in cardSizes ? cardSizes[key] : CARD_DEFAULT);
    const box = el("label", "gd-cardsize");
    box.appendChild(el("span", "gd-hint", t("takes.cardSize")));
    const range = el("input");
    range.type = "range";
    range.min = String(CARD_LIST); range.max = String(CARD_MAX); range.step = String(CARD_STEP);
    range.value = String(sizeNow());
    const say = el("span", "gd-hint gd-cardsize-now");
    const paint = () => {
      const v = sizeNow();
      scope.style.setProperty("--gd-card", `${Math.max(CARD_MIN, v)}px`);
      scope.classList.toggle("gd-cards-list", v <= CARD_LIST);
      say.textContent = v <= CARD_LIST ? t("takes.cardList") : `${v} px`;
    };
    range.addEventListener("input", () => {
      cardSizes[key] = Number(range.value);
      paint();
      try { window.localStorage.setItem(CARD_KEY, JSON.stringify(cardSizes)); } catch { /* see readCardSizes */ }
    });
    // a click on the slider is not a click on what it sits in
    box.addEventListener("click", (e) => e.stopPropagation());
    tip(range, t("takes.cardSizeHint"));
    paint();
    box.append(range, say);
    return box;
  }

  function statusBadge(status) {
    if (status === "done") return null;
    const map = { queued: ["gd-badge-blue", t("takes.queued")], running: ["gd-badge-blue", t("takes.running")],
                  failed: ["gd-badge-bad", t("takes.failed")], missing: ["gd-badge-bad", t("takes.missing")] };
    const [cls, txt] = map[status] || ["gd-badge-bad", status];
    return el("span", cls, txt);
  }

  /** The render in progress: the newest sampling preview, its step, and a way to stop it. */
  function buildLive() {
    const box = el("section", "gd-live");
    const img = el("img", "gd-live-img");
    const side = el("div", "gd-live-side");
    const text = tip(el("strong", null, t("takes.liveWaiting")), t("takes.liveHint"));
    side.appendChild(text);
    side.appendChild(row(btn(t("takes.interrupt"), () => host.interrupt(), "gd-btn gd-ghost gd-danger")));
    box.append(img, side);
    liveBox = { el: box, img, text };
    paintLive(host.live ? host.live() : null);
    return box;
  }
  function paintLive(data) {
    if (!liveBox) return;
    const on = !!data || (host.rendering && host.rendering());
    liveBox.el.hidden = !on;
    if (data && data.webp) {
      liveBox.img.src = `data:image/webp;base64,${data.webp}`;
      liveBox.text.textContent = t("takes.liveStep", data.step, data.total);
    } else {
      liveBox.img.removeAttribute("src");
      liveBox.text.textContent = t("takes.liveWaiting");
    }
  }

  function playerFor(key) {
    let p = players.get(key);
    if (!p) {
      p = createPlayer({ loopLabel: t("takes.loopSeg"), emptyText: t("takes.previewHere") });
      players.set(key, p);
    }
    return p;
  }

  /** A take as a card: its video over [start, start + length), hover to play, with actions
   *  under it. */
  function takeCard(take, start, length, { picked, viewingIt, actions, onClick }) {
    const card = el("div", "gd-cand" + (picked ? " picked" : "") + (viewingIt ? " viewing" : ""));
    if (take.status === "done" && take.file) {
      const v = el("video");
      const t0 = (start + 0.5) / FPS;
      // At rest the card shows the middle of the range, not its first frame: the model
      // puts a cut a few frames off the frame it was asked for, and the first frame of a
      // shot is then still the shot before it.
      const still = (start + Math.floor(length / 2) + 0.5) / FPS;
      v.muted = true; v.preload = "metadata";
      v.src = host.viewUrlOutput(take.file) + `#t=${still.toFixed(3)}`;
      v.addEventListener("mouseenter", () => { v.currentTime = t0; v.play().catch(() => {}); });
      v.addEventListener("mouseleave", () => { v.pause(); v.currentTime = still; });
      v.addEventListener("timeupdate", () => {
        if (v.currentTime * FPS >= start + length) v.currentTime = t0;
      });
      card.appendChild(v);
    } else {
      const ph = el("div", "gd-cand-ph");
      ph.appendChild(statusBadge(take.status) || el("span", null, take.status));
      card.appendChild(ph);
    }
    const meta = el("div", "gd-cand-meta");
    meta.textContent = `seed ${take.seed}` + (take.preset ? ` · ${take.preset}` : "")
      + (take.at ? `\n${new Date(take.at).toLocaleTimeString()}` : "")
      + (fits(take) ? "" : `\n${t("takes.otherLength", take.frames)}`)
      + (sameLayout(take) ? "" : `\n${t("takes.otherLayout")}`);
    meta.style.whiteSpace = "pre-line";
    card.appendChild(meta);
    const acts = el("div", "gd-cand-actions");
    for (const a of actions) if (a) acts.appendChild(a);
    card.appendChild(acts);
    if (onClick) card.onclick = onClick;
    return card;
  }

  /** A take is material for this clip only if it was rendered at this clip's length. */
  function fits(take) {
    return !take.frames || take.frames === host.doc().derived.frame_count;
  }

  /** A take's cuts lie where the shots were when it was rendered. One from before the
   *  shots were divided as they are now (other cut frames, or another choice of montage
   *  and long take) is said to be so; a take that did not record it is not judged. */
  function sameLayout(take) {
    return !take.layout || take.layout === layoutKey(host.doc().prompt.shots);
  }

  function renderBody() {
    if (!body) return;
    const d = host.doc();
    const takes = host.takes();
    const shots = d.prompt.shots;
    const fc = d.derived.frame_count;
    const busy = !!(host.queuing && host.queuing());
    // players and take cards take the shape of the clip
    const [cw, ch] = canvasSize(d.clip.aspect, host.run().megapixels, host.sourceSize ? host.sourceSize() : null);
    root.style.setProperty("--gd-aspect", `${cw} / ${ch}`);
    const preset = host.activePreset();
    const n = preset.takes || 1;
    const done = finishedTakes(takes);
    body.replaceChildren();
    paintMonitor();
    paintSeams();

    if (host.takesStorageMissing && host.takesStorageMissing()) {
      const warn = section(null);
      warn.classList.add("gd-sec-bad");
      warn.appendChild(el("strong", null, t("takes.noStorage")));
      body.appendChild(warn);
    }
    if (noteText) body.appendChild(el("div", "gd-note", noteText));
    body.appendChild(buildLive());

    // ------------------------------------------------------------ toolbar
    const bar = section(null);
    bar.classList.add("gd-takes-bar");
    let picked = 0;
    for (let i = 0; i < shots.length; i++) if (String(i) in takes.picks) picked++;
    bar.appendChild(tip(el("strong", null, t("takes.status", picked, shots.length)),
      shots.length > 1 ? t("takes.mixHint") : ""));
    // how many a press makes: the preset's own number, the one the Project page shows
    const count = el("label", "gd-takecount");
    count.appendChild(el("span", "gd-hint", t("takes.count")));
    const countIn = el("input");
    countIn.type = "number"; countIn.min = "1"; countIn.max = "12"; countIn.step = "1";
    countIn.value = String(n);
    countIn.addEventListener("change", () => {
      const v = Math.max(1, Math.min(12, Math.round(Number(countIn.value) || n)));
      if (v !== n) host.patchPreset(preset.id, { takes: v }); else countIn.value = String(n);
    });
    count.appendChild(countIn);
    bar.appendChild(tip(count, t("takes.countHint")));
    const genBtn = tip(btn(t("takes.generate", n), () => host.queueTakes(n)), t("takes.generateHint", n));
    genBtn.disabled = busy;
    bar.appendChild(genBtn);
    bar.appendChild(btn(t("takes.refresh"), () => { host.forgetCuts(); host.refreshTakes(); },
                        "gd-btn gd-ghost"));
    if (takes.takes.length) {
      bar.appendChild(btn(t("takes.clearAll"), () => {
        if (window.confirm(t("takes.clearConfirm"))) host.clearTakes();
      }, "gd-btn gd-ghost"));
    }
    const older = done.filter((x) => fits(x) && !sameLayout(x)).length;
    if (older) bar.appendChild(el("div", "gd-note", t("takes.layoutChanged", older)));
    body.appendChild(bar);

    // ------------------------------------------------------------ the final clip
    const { plan, why } = splicePlan(takes, shots);
    const fin = el("section", "gd-composite");
    const fh = el("div", "gd-seg-title");
    fh.appendChild(el("strong", null, t("takes.final")));
    fin.appendChild(fh);
    const whole = plan ? singleTake(plan) : "";
    if (!allPicked(takes, shots.length) || !plan) {
      fin.appendChild(el("div", "gd-hint", why
        ? t(why.key, ...(why.args || []))
        : t("takes.finalNeedsPicks")));
    } else {
      // Every shot has its pick: the button makes the final clip of them. Two takes meet
      // either at a cut, where they are put one after the other as they are, or inside a
      // long take, where the frames around the join are rendered again; one take picked
      // for every shot is put out as it is.
      const j = host.joinPlan ? host.joinPlan() : null;
      const cuts = j ? j.cuts : cutFrames(plan);
      const seams = j ? j.seams : [];
      const renders = j ? j.renders : true;
      const at = (list) => list.map((f) => t("post.seamAt", f, (f / FPS).toFixed(2))).join(t("post.listSep"));
      // what joining the picks comes to, in a line; what each means is its tooltip
      const sum = el("div", "gd-joinsum");
      if (whole) {
        const take = takes.takes.find((x) => x.id === whole);
        sum.appendChild(tip(el("span", "gd-badge-blue", t("takes.finalOne", take ? take.seed : "")), t("takes.outputHint")));
      }
      if (cuts.length) sum.appendChild(tip(el("span", "gd-badge-blue", t("post.joinCuts", cuts.length, at(cuts))), t("takes.finalCuts")));
      if (seams.length) sum.appendChild(tip(el("span", "gd-badge-blue", t("post.joinSeams", seams.length, at(seams))), t("takes.finalSeams")));
      if (j && j.carried.length) sum.appendChild(tip(el("span", "gd-badge-blue", t("post.joinCarried", j.carried.length, at(j.carried))), t("takes.finalCarried")));
      if (sum.childElementCount) fin.appendChild(sum);
      if (j && j.dead.length) fin.appendChild(el("div", "gd-note gd-note-bad", t("takes.finalDead", at(j.dead))));
      const c = takes.composite;
      const compBtn = btn(t("takes.composite"), () => host.queueComposite());
      tip(compBtn, renders ? t("takes.compositeHint") : whole ? t("takes.outputHint") : t("takes.assembleHint"));
      compBtn.disabled = busy;
      if (renders) {
        // how wide and how strong the pass around a seam is, is set on the post page
        // how much is generated again is set on the timeline above, how strongly on the post page
        const seam = el("span", "gd-hint", t("takes.seamNow", d.mask.seam_denoise));
        const tune = btn(t("takes.seamTune"), () => host.goPage && host.goPage("post"), "gd-btn gd-ghost gd-btn-sm");
        fin.appendChild(row(compBtn, seam, tune));
      } else {
        fin.appendChild(row(compBtn));
      }
      // a composite belongs to the picks it was rendered from
      if (c.status && c.key && c.key !== host.compositeKey(d, plan)) {
        fin.appendChild(el("div", "gd-hint", t("takes.compositeStale")));
      } else if (c.status) {
        fh.appendChild(el("span", "gd-hint", `seed ${c.seed} · ${c.at ? new Date(c.at).toLocaleString() : ""}`));
        const badge = statusBadge(c.status);
        if (badge) fh.appendChild(badge);
        if (c.status === "done" && c.file) {
          // it plays in the monitor above
          const info = el("div");
          const line = row(el("span", "gd-hint", c.file));
          // cuts between takes can cost a few frames: the clip says how long it came out
          const frames = c.frames || fc;
          if (frames !== fc) {
            line.appendChild(tip(el("span", "gd-hint", t("takes.finalFrames", frames, (frames / FPS).toFixed(2), fc - frames)),
              t("takes.finalFramesHint")));
          }
          if (c.note) {
            const log = el("details", "gd-fold");
            log.appendChild(el("summary", null, t("takes.joinLog")));
            log.appendChild(el("pre", "gd-joinlog", c.note));
            info.appendChild(log);
          }
          line.appendChild(btn(t("takes.toResults"), () => host.goPage && host.goPage("results"), "gd-btn gd-btn-sm"));
          line.appendChild(btn(t("res.open"), () => window.open(host.viewUrlOutput(c.file), "_blank"), "gd-btn gd-ghost gd-btn-sm"));
          info.insertBefore(line, info.firstChild);
          fin.appendChild(info);
        }
      }
    }
    body.appendChild(fin);

    // ------------------------------------------------------------ one block per shot
    navPh = null;
    const many = shots.length > 1;     // one shot needs no navigator
    const wrap = el("div", "gd-takewrap" + (many ? "" : " gd-takewrap-one"));
    const nav = el("div", "gd-takenav");
    const col = el("div", "gd-segcol");
    if (many) wrap.append(nav, col); else wrap.append(col);
    body.appendChild(wrap);
    const kept = host.keptOfShots ? host.keptOfShots() : null;
    shots.forEach((shot, si) => {
      const pickId = takes.picks[String(si)] || "";
      const status = segmentStatus(takes, si);
      const selected = si === d.view.selected_shot;
      const block = el("section", "gd-takeseg" + (selected ? " selected" : "") + (pickId ? " picked" : ""));
      block.dataset.seg = String(si);

      const head = el("div", "gd-seg-title");
      const tag = el("button", "gd-seg-tag", `${si + 1}`);
      tag.type = "button";
      tag.onclick = () => host.patchDoc((x) => { x.view.selected_shot = si; }, t("h.pickSeg"));
      head.appendChild(tag);
      head.appendChild(el("strong", null, t("edit.segment", si + 1)));
      head.appendChild(el("span", "gd-hint", t("edit.segRange", seconds(shot.start),
        seconds(shot.start + shot.length), seconds(shot.length), shot.start, shot.start + shot.length - 1)));
      if (si) {
        // how this shot follows the one above it, as set on the Edit page: the two links,
        // shown and not pressed here
        const longTake = shot.join === "continuous";
        const heard = longTake || shot.sound === "continuous";
        const links = el("span", "gd-links");
        links.append(
          linkMark("picture", longTake, t(longTake ? "join.pictureOn" : "join.pictureOff")),
          linkMark("sound", heard, t(longTake ? "join.soundLocked" : heard ? "join.soundOn" : "join.soundOff")));
        head.appendChild(links);
      }
      const stateText = status === "picked" ? t("takes.picked")
        : status === "takes" ? `${done.length} ${t("takes.candidates")}` : t("takes.none");
      head.appendChild(el("span", status === "picked" ? "gd-badge-ok" : status === "takes" ? "gd-badge-blue" : "gd-badge-bad",
        stateText));
      // joined as picked now, nothing of this shot's pick would be left
      if (kept && kept[si] && !kept[si].kept) {
        const gone = el("span", "gd-badge-bad", t("takes.keptNone"));
        tip(gone, t("post.joinKeptWarn", si + 1));
        head.appendChild(gone);
      }
      head.appendChild(cardSizer(String(si), block));
      block.appendChild(head);

      // the strip beside the blocks: a way to get to this shot, and nothing else
      const cell = el("button", `gd-takenav-item ${status}` + (selected ? " selected" : "")
        + (shot.join === "continuous" ? " goes-on" : ""), String(si + 1));
      cell.type = "button";
      cell.dataset.len = String(shot.length);
      cell.style.flex = `${shot.length} 0 0`;    // flex-basis 0: heights are exactly ∝ length
      cell.style.setProperty("--seg", shotColor(si));
      tip(cell, `${t("edit.segment", si + 1)} · ${seconds(shot.start)}–${seconds(shot.start + shot.length)}s · ${stateText}`);
      cell.onclick = () => scrollToSeg(si);
      nav.appendChild(cell);

      const bodyRow = el("div", "gd-takeseg-body");
      const player = playerFor(si);
      const view = el("div", "gd-takeview");
      view.appendChild(player.el);
      bodyRow.appendChild(view);
      const viewId = viewing.get(si) || pickId || (done[0] || {}).id || "";
      const viewTake = takes.takes.find((x) => x.id === viewId);
      // What can be done with the take the player shows, as a whole: a take is a render of
      // the whole clip, so using it everywhere and deleting it are not this shot's alone.
      if (viewTake) {
        const line = el("div", "gd-inline gd-takeview-line");
        const usable = viewTake.status === "done" && viewTake.file && fits(viewTake);
        line.appendChild(el("span", "gd-hint", t("takes.viewing",
          `seed ${viewTake.seed}` + (viewTake.preset ? ` · ${viewTake.preset}` : ""))));
        if (many && usable && whole !== viewTake.id) {
          line.appendChild(btn(t("takes.pickAll"), () => host.pickAll(viewTake.id), "gd-btn gd-ghost gd-btn-sm"));
        }
        const del = btn(t("takes.deleteThis"), () => {
          viewing.delete(si);
          host.removeTake(viewTake.id);
        }, "gd-btn gd-ghost gd-btn-sm");
        tip(del, t("takes.deleteThisHint"));
        line.appendChild(del);
        view.appendChild(line);
      }
      // It opens on the middle of the shot, like the cards (the first frames of a shot may
      // still be the shot before it), and stays where it is when the page is drawn again.
      const url = viewTake && viewTake.file ? host.viewUrlOutput(viewTake.file) : "";
      // the frames of that take which are this shot (a take cuts a few frames off the
      // frame it was asked to: see realRange in gd_editor.js)
      const [first, last] = viewTake && viewTake.file && host.realRange
        ? host.realRange(viewTake.file, si) : [shot.start, shot.start + shot.length - 1];
      const at = player.src() === url && player.frame() >= first && player.frame() <= last
        ? player.frame() : first + Math.floor((last - first + 1) / 2);
      player.load(url, first, last, { startFrame: at });

      const right = el("div", "gd-pool");
      const strip = el("div", "gd-cands");
      if (!takes.takes.length) strip.appendChild(el("div", "gd-hint", t("takes.noCandidates")));
      for (const take of takes.takes) {
        // the take's own shot: from where it really cuts in to where it really cuts out
        const [from, to] = host.realRange && take.file ? host.realRange(take.file, si)
          : [shot.start, shot.start + shot.length - 1];
        strip.appendChild(takeCard(take, from, to - from + 1, {
          picked: take.id === pickId,
          viewingIt: take.id === viewId,
          actions: [
            take.id === pickId
              ? btn(t("takes.unpick"), (e) => { e.stopPropagation(); host.pick(si, null); }, "gd-btn gd-ghost")
              : (take.status === "done" && take.file && fits(take)
                ? btn(t("takes.pick"), (e) => { e.stopPropagation(); host.pick(si, take.id); })
                : null),
          ],
          onClick: () => {
            viewing.set(si, take.id);
            host.patchDoc((x) => { x.view.selected_shot = si; }, t("h.viewTake"));
          },
        }));
      }
      right.appendChild(strip);
      bodyRow.appendChild(right);
      block.appendChild(bodyRow);
      col.appendChild(block);
    });
    if (!many) return;
    navPh = el("div", "gd-segnav-ph");
    nav.appendChild(navPh);
    paintNavPlayhead(d.view.playhead);
    watchNavFit();
    fitNav();
  }

  return {
    render() {
      if (!timeline) buildShell();
      else { renderBody(); timeline.render(); }
    },
    note(text) { noteText = String(text || ""); renderBody(); },
    live(data) { paintLive(data); },
    destroy() {
      for (const p of players.values()) p.destroy();
      players.clear();
      if (monitor) { monitor.destroy(); monitor = null; }
      if (navScroller) navScroller.removeEventListener("scroll", fitNav);
      if (navRo) navRo.disconnect();
      navScroller = navRo = navPh = null;
      if (timeline) { timeline.destroy(); timeline = null; }
    },
  };
}
