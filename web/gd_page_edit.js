// Gacha Director — the edit page: preview and timeline on top, the material every shot shares
// under it, then one card per shot stacked down the page with a navigator beside them.
//
// A frame is one thing in three places — the picture, the red playhead, the frame box —
// and the player owns it: the timeline draws whatever the player reports while it plays,
// and the document only learns the frame when playback stops or the user scrubs, so
// hitting play does not write the widget twenty-four times a second.
//
// Between the picture and the timeline sits the shot bar: insert a cut at the playhead,
// the selected shot's start and end frames between two arrows, and delete-cut. The start
// frame IS the selected cut, so deleting it merges this shot into the previous one — a
// cut is what you actually picked wrong, not a shot. Splitting has exactly one entry
// point, the insert button, so it can never fight with selecting.
//
// A shot's card holds what that shot is made of: its text on the left, its pictures,
// videos and sounds on the right. Each piece of material has a name and a use picked from
// a short list ("the first frame", "who is in it", "carry on from it"). The document
// stores the same thing the way the model takes it (subjects, references, anchors; see
// gd_material.js, which translates), and the compiler numbers the material and declares it
// to the model, so nobody types a label.
//
// There is no task mode to pick. Text to video, first/last frame, reference to video,
// editing, continuation are what the material adds up to: the tag on a card says which,
// and the recipe buttons are shortcuts that put the right material in place.

import { t } from "./gd_i18n.js";
import { cellsMatter, createTimeline, shotColor } from "./gd_timeline.js";
import { createPlayer } from "./gd_player.js";
import {
  btn, checkbox, datalist, dropZone, el, fileKind, input, labeled, linkMark, number, row, section, select,
  textarea, tip, warnList,
} from "./gd_ui.js";
import {
  AUDIO_RETENTIONS, CELL, DEFAULT_SEAM, FAMILIES, SHORT_CELL, FPS, MASK_MODES, MIN_SHOT,
  PROMPT_MODES, RETENTIONS, SOURCE_ROLES, SUBJECT_KINDS, canvasSize, problemsCoded,
} from "./gd_doc.js";
import {
  AUDIO_USES, IMAGE_USES, VIDEO_USES, addAudio, addImage, addVideo, budget, clipMode, freeId,
  loosenAnchors, mentionable, readMentions, rehome, removeMaterial, seconds, setUse, shotMode,
  showMentions, useOf,
} from "./gd_material.js";

const NAV_MIN_H = 160;             // the navigator never shrinks below this
const NAV_MARGIN = 8;              // gap kept to the panel's top and bottom edges
const ASPECTS = ["source", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const MAX_TRAINED = 362;           // about 15 s, the top of the range the model was trained on

/** The largest 17k+5 frame count that fits in `frames` frames. */
export function gridLength(frames) {
  const n = Number(frames) || 0;
  if (n < SHORT_CELL) return 0;
  return SHORT_CELL + Math.floor((n - SHORT_CELL) / CELL) * CELL;
}

export function createEditPage(host) {
  const root = host.container;
  let timeline = null;
  let player = null;
  let tlHint = null;
  let fileLine = null;
  let body = null;
  let navPh = null;                // the playhead marker inside the navigator
  let tlTitle = null;              // the timeline's title: how the timeline is worked rests on it
  /** How the timeline is worked, and what the cell strip is while the strip is shown. */
  function paintTimelineTip() {
    if (!tlTitle) return;
    tip(tlTitle, cellsMatter(host.doc()) ? `${t("tl.help")}\n${t("tl.helpCells")}` : t("tl.help"));
  }
  let onKey = null;
  let segBar = null;               // {insert, prev, next, start, end, del}
  let navScroller = null;          // the panel element whose scroll drives the navigator fit
  let navRo = null;
  let compiled = null;             // the last compiled prompt the server returned
  let bodyKey = "";                // what the cards were last built from
  let builds = 0;                  // how many times the cards have been built
  let compiledHost = null;         // where the compiled prompt is shown

  /** What the server knows about a file in input/: {frames, frames24, fps, width, height, audio}. */
  function mediaInfo(name, kind = "videos") {
    const m = host.media() || {};
    // a rendered clip ("name [output]") is a video like any other once it is picked
    const pool = kind === "videos" ? [...(m.videos || []), ...(m.renders || [])] : (m[kind] || []);
    return pool.find((x) => x.name === name) || null;
  }
  function sourceInfo(d) {
    const hit = d.source.video ? mediaInfo(d.source.video) : null;
    return hit && hit.frames ? hit : null;
  }
  function canvasOf(d) {
    const info = sourceInfo(d);
    return canvasSize(d.clip.aspect, host.run().megapixels,
      info && info.width && info.height ? [info.width, info.height] : null);
  }

  // ---------------------------------------------------------------- playhead plumbing
  function frameCount() { return host.doc().derived.frame_count; }
  function currentFrame() { return player && player.src() ? player.frame() : host.doc().view.playhead; }
  function paintNavPlayhead(f) {
    if (!navPh) return;
    const fc = Math.max(1, frameCount());
    navPh.style.top = `${(Math.max(0, Math.min(fc - 1, f)) / fc) * 100}%`;
  }
  /** The player moved: mirror it on the timeline and the navigator; persist when stopped. */
  function onPlayerFrame(f, { playing, source }) {
    if (timeline) timeline.setPlayhead(f);
    paintNavPlayhead(f);
    paintSegBar(f);
    if (!playing && source !== "load" && host.setPlayhead) host.setPlayhead(f);
  }
  /** The user scrubbed on the timeline: the player follows without echoing back. */
  function onScrub(f) {
    if (player) player.seek(f, { silent: true });
    paintNavPlayhead(f);
    paintSegBar(f);
  }
  /** After any render: the document's playhead wins unless the player is mid-playback. */
  function syncPlayerToDoc() {
    if (!player) return;
    const d = host.doc();
    const fc = d.derived.frame_count;
    const src = d.source.video ? host.viewUrl(d.source.video) : "";
    const offset = src ? d.source.start : 0;
    // the preview is the stretch of the file the run reads: `start` frames in
    if (src !== player.src() || offset !== player.offset()) {
      player.load(src, 0, fc - 1, { startFrame: d.view.playhead, silent: true, offset });
      if (timeline) timeline.setPlayhead(null);
      paintNavPlayhead(d.view.playhead);
      return;
    }
    player.setRange(0, fc - 1);
    if (player.playing()) return;
    if (player.frame() !== d.view.playhead) player.seek(d.view.playhead, { silent: true });
    if (timeline) timeline.setPlayhead(null);
    paintNavPlayhead(d.view.playhead);
  }
  function paintFileLine() {
    if (!fileLine) return;
    const d = host.doc();
    const [cw, ch] = canvasOf(d);
    const info = sourceInfo(d);
    fileLine.className = "gd-fileline";
    const parts = [];
    if (d.source.video) {
      // what goes in and what comes out: the file as it is, then what the run makes of it
      parts.push(t("edit.srcName", d.source.video));
      if (info) {
        parts.push(t("edit.srcInfo", info.width || "?", info.height || "?", info.frames,
          Number(info.fps).toFixed(3).replace(/\.?0+$/, "")));
      }
      parts.push(t("edit.srcToOut", d.derived.frame_count, cw, ch));
    } else {
      parts.push(t("edit.noSource"));
    }
    fileLine.textContent = parts.join(" · ");
    if (info && Math.abs(info.fps - FPS) > 0.12) {
      fileLine.appendChild(el("span", "gd-badge-blue", t("edit.fpsConform", Number(info.fps).toFixed(2))));
    }
    const have = info ? (info.frames24 || info.frames) - d.source.start : 0;
    if (info && have < d.derived.frame_count) {
      fileLine.appendChild(el("span", "gd-badge-bad", t("edit.shortWarn", have, d.derived.frame_count)));
    } else if (info && have > d.derived.frame_count) {
      fileLine.appendChild(el("span", "gd-badge-blue", t("edit.tailUnused", have - d.derived.frame_count)));
    }
  }

  // Keyboard transport while this page is showing and focus is not in a field.
  function pageVisible() { return !!root.offsetParent; }
  function isEditable(node) {
    for (let e = node; e && e !== document; e = e.parentElement) {
      const tag = String(e.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable) return true;
    }
    return false;
  }
  function installKeys() {
    onKey = (e) => {
      if (!player || !pageVisible() || isEditable(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 17 : 1;
      if (e.key === "ArrowLeft" || e.key === ",") player.step(-step);
      else if (e.key === "ArrowRight" || e.key === ".") player.step(step);
      else if (e.key === " " || e.key === "k") player.toggle();
      else if (e.key === "Home") player.seek(0);
      else if (e.key === "End") player.seek(frameCount() - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
  }

  // ---------------------------------------------------------------- selection & shots
  /** Select shot i. View state only: no undo entry, but every view of it repaints. */
  function selectSeg(i, { seek = false } = {}) {
    const d = host.doc();
    if (i < 0 || i >= d.prompt.shots.length) return;
    d.view.selected_shot = i;
    if (host.commitView) host.commitView(d); else host.commitDoc(d, t("h.pickSeg"));
    renderBody();
    paintSegBar();
    if (timeline) timeline.render();
    if (seek && player) player.seek(d.prompt.shots[i].start);
  }
  /** Select shot i without rebuilding the page, so a click inside a card still reaches
   *  what was clicked. */
  function markSelected(i) {
    const d = host.doc();
    if (!host.commitView || i < 0 || i >= d.prompt.shots.length) return;
    d.view.selected_shot = i;
    host.commitView(d);
    bodyKey = cardsKey();              // the cards show this selection already (below)
    for (const b of body.querySelectorAll(".gd-seg")) b.classList.toggle("selected", Number(b.dataset.shot) === i);
    paintSegBar();
    if (timeline) timeline.render();
  }
  /** Can a cut go at frame f: strictly inside a shot, MIN_SHOT away from both ends. */
  function insertableAt(d, f) {
    const s = d.prompt.shots.find((x) => f > x.start && f < x.start + x.length);
    return !!s && f - s.start >= MIN_SHOT && s.start + s.length - f >= MIN_SHOT;
  }
  function insertCut() {
    const f = currentFrame();
    const shots = host.doc().prompt.shots;
    const at = shots.findIndex((s) => f > s.start && f < s.start + s.length);
    if (at < 0 || f - shots[at].start < MIN_SHOT || shots[at].start + shots[at].length - f < MIN_SHOT) return;
    // Picks are stored by shot number: both halves keep the take the whole shot had. They
    // move before the document does, so the undo step that follows holds both.
    if (host.shiftPicks) host.shiftPicks("split", at);
    host.patchDoc((x) => {
      const idx = x.prompt.shots.findIndex((s) => f > s.start && f < s.start + s.length);
      if (idx < 0) return;
      const s = x.prompt.shots[idx];
      const leftLen = f - s.start;
      if (leftLen < MIN_SHOT || s.length - leftLen < MIN_SHOT) return;
      // what is held on a frame stays on that frame, in whichever half it falls
      loosenAnchors(x);
      x.prompt.shots.splice(idx + 1, 0, {
        id: `shot${Date.now().toString(36)}`, start: f, length: s.length - leftLen,
        text: "", collapsed: false,
        // A boundary put into footage that is already there divides one shot; in a clip
        // made from nothing it is where the next shot begins. Either can be changed on
        // the bar between the two cards.
        join: x.source.video ? "continuous" : "cut",
        // (a shot that is cut to keeps it for when it goes on from the one before)
        seam: DEFAULT_SEAM,
      });
      s.length = leftLen;
      x.view.selected_shot = idx + 1;
    }, t("h.insertCut"));
  }
  /** Move the boundary before shot i to frame f, clamped so both sides keep MIN_SHOT. */
  function moveBoundary(i, f) {
    const d = host.doc();
    const prev = d.prompt.shots[i - 1], cur = d.prompt.shots[i];
    if (!prev || !cur || !Number.isFinite(f)) { paintSegBar(); return; }
    const lo = prev.start + MIN_SHOT, hi = cur.start + cur.length - MIN_SHOT;
    const nf = Math.max(lo, Math.min(hi, Math.round(f)));
    if (nf === cur.start) { paintSegBar(); return; }
    host.patchDoc((x) => {
      const p = x.prompt.shots[i - 1], c = x.prompt.shots[i];
      const delta = nf - c.start;
      p.length += delta; c.length -= delta; c.start = nf;
    }, t("h.moveCut"));
  }
  /** Delete the cut at the selected shot's start: the two shots become one. */
  function deleteCut() {
    const d = host.doc();
    const i = d.view.selected_shot;
    if (i < 1 || i >= d.prompt.shots.length) return;
    if (host.shiftPicks) host.shiftPicks("merge", i);      // before the document: see insertCut
    host.patchDoc((x) => {
      const prev = x.prompt.shots[i - 1], cur = x.prompt.shots[i];
      // the merged shot keeps the material of both, and what was held on a frame stays there
      loosenAnchors(x);
      rehome(x, cur.id, prev.id);
      prev.length += cur.length;
      // Both prompts survive the merge; losing one silently is how a paragraph disappears.
      // A spoken line ("@name says: ...") is a line of its own to the planner, so where one
      // meets the other text the two stay on separate lines.
      const parts = [prev.text, cur.text].map((v) => (v || "").trim()).filter(Boolean);
      const spoken = (line) => /^\s*@[^\s:]+[^:\n]*:\s*\S/.test(line || "");
      const meets = parts.length === 2
        && (spoken(parts[0].split("\n").pop()) || spoken(parts[1].split("\n")[0]));
      prev.text = parts.join(meets ? "\n" : " ");
      x.prompt.shots.splice(i, 1);
      x.view.selected_shot = i - 1;
    }, t("h.deleteCut"));
  }

  /**
   * Spread one long prompt over the shots: sentences in order, each shot taking a share of
   * the text proportional to its length in frames. The whole-clip description written
   * before the cuts existed is the normal case — this is how it gets split without
   * retyping it. Every shot's text is joined first, so running it twice is stable.
   */
  function spreadPrompts() {
    host.patchDoc((x) => {
      const shots = x.prompt.shots;
      if (shots.length < 2) return;
      const text = shots.map((s) => s.text || "").join(" ").replace(/\s+/g, " ").trim();
      if (!text) return;
      const units = (text.match(/[^.!?。！？]+[.!?。！？]+["'”’)\]]*|[^.!?。！？]+$/g) || [text])
        .map((u) => u.trim()).filter(Boolean);
      const chars = units.reduce((a, u) => a + u.length, 0) || 1;
      const total = shots.reduce((a, s) => a + s.length, 0) || 1;
      // char-space boundaries proportional to frames, then each sentence goes where its
      // middle falls: order is preserved by construction
      const bounds = [];
      let acc = 0;
      for (const s of shots) { acc += s.length; bounds.push((chars * acc) / total); }
      const buckets = shots.map(() => []);
      let pos = 0;
      for (const u of units) {
        const mid = pos + u.length / 2;
        let i = bounds.findIndex((b) => mid < b);
        if (i < 0) i = shots.length - 1;
        buckets[i].push(u);
        pos += u.length + 1;
      }
      // A shot left empty while a neighbour holds several reads as a bug, so pull one
      // across — from the left neighbour's tail or the right one's head, order intact.
      for (let pass = 0; pass < shots.length; pass++) {
        for (let i = 0; i < buckets.length; i++) {
          if (buckets[i].length) continue;
          if (i > 0 && buckets[i - 1].length > 1) buckets[i].push(buckets[i - 1].pop());
          else if (i < buckets.length - 1 && buckets[i + 1].length > 1) buckets[i].push(buckets[i + 1].shift());
        }
      }
      shots.forEach((s, i) => { s.text = buckets[i].join(" "); });
    }, t("h.spread"));
  }

  function buildSegBar() {
    const bar = el("div", "gd-cutbar");
    const insert = btn(t("edit.cutInsert"), insertCut, "gd-btn");
    const sep = el("span", "gd-cutbar-sep");
    const prev = btn("◁", () => selectSeg(host.doc().view.selected_shot - 1, { seek: true }), "gd-btn gd-ghost gd-btn-icon");
    tip(prev, t("edit.cutPrevSeg"));
    const start = el("input", "gd-cutbar-input");
    start.type = "number"; start.step = "1"; tip(start, t("edit.cutStartTitle"));
    const dash = el("span", "gd-hint", "–");
    const end = el("input", "gd-cutbar-input");
    end.type = "number"; end.step = "1"; tip(end, t("edit.cutEndTitle"));
    const commitStart = () => moveBoundary(host.doc().view.selected_shot, Number(start.value));
    const commitEnd = () => moveBoundary(host.doc().view.selected_shot + 1, Number(end.value) + 1);
    start.addEventListener("change", commitStart);
    end.addEventListener("change", commitEnd);
    start.addEventListener("gd-key", (e) => { if (e.detail.key === "Enter") start.blur(); });
    end.addEventListener("gd-key", (e) => { if (e.detail.key === "Enter") end.blur(); });
    const next = btn("▷", () => selectSeg(host.doc().view.selected_shot + 1, { seek: true }), "gd-btn gd-ghost gd-btn-icon");
    tip(next, t("edit.cutNextSeg"));
    const del = btn(t("edit.cutDelete"), deleteCut, "gd-btn gd-ghost gd-danger");
    bar.append(insert, sep, prev, start, dash, end, next, del);
    segBar = { el: bar, insert, prev, next, start, end, del };
    return bar;
  }
  function paintSegBar(frame) {
    if (!segBar) return;
    const d = host.doc();
    const f = frame == null ? currentFrame() : frame;
    const shots = d.prompt.shots;
    const i = Math.max(0, Math.min(shots.length - 1, d.view.selected_shot));
    const s = shots[i];
    const ok = insertableAt(d, f);
    segBar.insert.disabled = !ok;
    tip(segBar.insert, ok ? t("edit.cutInsertOk", f)
      : t("edit.cutInsertNo", f, MIN_SHOT));
    segBar.prev.disabled = i <= 0;
    segBar.next.disabled = i >= shots.length - 1;
    const prev = shots[i - 1], nxt = shots[i + 1];
    // The selected cut is this shot's start; deleting it merges the two shots.
    segBar.del.disabled = !prev;
    tip(segBar.del, prev
      ? t("edit.cutDeleteOk", i, i + 1, s.start)
      : t("edit.cutDeleteNo"));
    segBar.start.value = String(s.start);
    segBar.start.disabled = !prev;                    // shot 1 starts at the clip
    segBar.start.classList.toggle("gd-cut-active", !!prev);
    if (prev) {
      segBar.start.min = String(prev.start + MIN_SHOT);
      segBar.start.max = String(s.start + s.length - MIN_SHOT);
      tip(segBar.start, t("edit.cutStartRange", i + 1, segBar.start.min, segBar.start.max, i));
    } else tip(segBar.start, t("edit.cutStartFirst"));
    segBar.end.value = String(s.start + s.length - 1);
    segBar.end.disabled = !nxt;                       // the last shot ends at the clip
    if (nxt) {
      segBar.end.min = String(s.start + MIN_SHOT - 1);
      segBar.end.max = String(nxt.start + nxt.length - MIN_SHOT - 1);
      tip(segBar.end, t("edit.cutEndRange", i + 1, segBar.end.min, segBar.end.max, i + 2));
    } else tip(segBar.end, t("edit.cutEndLast", d.derived.frame_count - 1));
  }

  // ---------------------------------------------------------------- navigator fit
  /** The nearest scrolling element, the page container itself included. */
  function scrollParent() {
    for (let e = root; e && e !== document.body; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if (o === "auto" || o === "scroll") return e;
    }
    return root.parentElement;
  }
  /**
   * Size the navigator to the visible part of the shot area: from where it sits (or the
   * panel's top edge once it is sticking) down to the panel's bottom edge, but never past
   * the blocks column it navigates. Re-run on every scroll and resize.
   */
  function fitNav() {
    const nav = body && body.querySelector(".gd-segnav");
    if (!nav) return;
    const panel = scrollParent();
    if (!panel) return;
    const wrap = nav.parentElement;
    const col = wrap.querySelector(".gd-segcol");
    const pr = panel.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cr = col ? col.getBoundingClientRect() : wr;
    const top = Math.max(wr.top, pr.top + NAV_MARGIN);
    const bottom = Math.min(pr.bottom - NAV_MARGIN, Math.max(cr.bottom, top + NAV_MIN_H));
    const h = Math.max(NAV_MIN_H, Math.round(bottom - top));
    if (Math.abs(h - (parseFloat(nav.style.height) || 0)) >= 1) nav.style.height = `${h}px`;
    const total = Math.max(1, frameCount());
    for (const item of nav.querySelectorAll(".gd-segnav-item")) {
      const px = (Number(item.dataset.len) / total) * h;
      item.classList.toggle("tiny", px < 34);
      item.classList.toggle("micro", px < 15);
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

  // ---------------------------------------------------------------- shell
  function buildShell() {
    root.replaceChildren();

    const tlSec = section(null);
    tlSec.classList.add("gd-sec-tl");
    const head = el("div", "gd-tl-head");
    tlTitle = el("h3", null, t("edit.timeline"));
    head.appendChild(tlTitle);
    tlHint = el("span", "gd-hint");
    head.appendChild(tlHint);
    tlSec.appendChild(head);

    fileLine = el("div", "gd-fileline");
    tlSec.appendChild(fileLine);

    player = createPlayer({
      wide: true, detachedControls: true, loop: true,
      emptyText: t("edit.sourceEmpty"),
      onFrame: onPlayerFrame,
      onMeta: () => { paintFileLine(); },
    });
    tlSec.appendChild(player.el);
    tlSec.appendChild(buildSegBar());

    timeline = createTimeline({
      doc: () => host.doc(),
      normalize: host.normalizeDoc,
      commit: (d) => host.commitDoc(d, t("h.timeline")),
      commitView: (d) => host.commitView ? host.commitView(d) : host.commitDoc(d, t("h.timeline")),
      plateSrc: () => { const d = host.doc(); return d.source.video ? host.viewUrl(d.source.video) : ""; },
      plateOffset: () => host.doc().source.start,
      onScrub,
      onSelectShot: () => { renderBody(); paintSegBar(); },
    });
    tlSec.appendChild(timeline.el);
    tlSec.appendChild(player.controls);
    paintTimelineTip();
    root.appendChild(tlSec);

    body = el("div", "gd-edit-body");
    root.appendChild(body);
    installKeys();
    renderBody();
    timeline.render();
    syncPlayerToDoc();
    paintFileLine();
    paintSegBar();
  }

  /** Jump to shot i's block and flash its navigator entry as the click's feedback. */
  function jumpToShot(i) {
    const target = body && body.querySelector(`[data-shot="${i}"]`);
    const panel = scrollParent();
    if (target && panel) {
      const to = panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - NAV_MARGIN;
      panel.scrollTop = Math.max(0, Math.round(to));
      fitNav();
    }
    const item = body && body.querySelector(`.gd-segnav-item[data-seg="${i}"]`);
    if (item) {
      item.classList.add("flash");
      setTimeout(() => item.classList.remove("flash"), 80);
    }
  }

  // ---------------------------------------------------------------- small builders
  function pick(kind, onPick, current = "") {
    const one = kind === "images" ? "image" : kind === "audio" ? "audio" : "video";
    host.library().open({ pick: { kinds: [one], label: t(`lib.kind.${one}`), current,
                                  onPick: (name) => onPick(name) } });
  }
  /** A file becomes material of a shot (`sid` "" for shared material), in the use it most
   *  likely has there; the use can be changed on its row. */
  function addPicked(x, sid, kind, name) {
    const reference = x.family === "reference";
    if (kind === "image") {
      // A shot's first picture is most often what it opens on in the base model, and
      // somebody who is in it in the reference model.
      const opens = sid && !reference && !x.anchors.some((a) => a.kind === "image" && a.shot === sid && a.at === "first");
      addImage(x, sid, name, opens ? "first" : "subject");
    } else if (kind === "video") {
      addVideo(x, sid, name, reference || !sid ? "motion" : "continue", mediaInfo(name));
    } else {
      addAudio(x, sid, name, reference || !sid ? "sound" : "play");
    }
  }
  /** Files dropped where a shot's material is (or the shared material): copied into
   *  ComfyUI's input folder, then added, each as what it is. The base model takes shared
   *  pictures only. */
  /** Items of the material library dropped there: added, each as what it is. */
  function takeItems(sid, items) {
    host.patchDoc((x) => {
      for (const { name, kind } of items) {
        if (!sid && x.family !== "reference" && kind !== "image") continue;
        addPicked(x, sid, kind, name);
      }
    }, t("h.addMaterial"));
  }
  async function dropInto(sid, files) {
    let got = [];
    try { got = await host.importFiles(files); } catch (e) {
      window.alert(t("lib.importFailed", String((e && e.message) || e)));
      return;
    }
    if (!got.length) return;
    host.patchDoc((x) => {
      for (const { name, kind } of got) {
        if (!sid && x.family !== "reference" && kind !== "image") continue;
        addPicked(x, sid, kind, name);
      }
    }, t("h.addMaterial"));
  }
  /** A text field with a material-library button beside it. */
  function mediaField(kind, value, onpick, listId) {
    const wrap = el("div", "gd-media-field");
    wrap.appendChild(input("text", value, onpick, { list: listId }));
    wrap.appendChild(btn("…", () => pick(kind, onpick, value), "gd-btn gd-ghost gd-btn-icon"));
    return wrap;
  }
  function removeBtn(onclick) {
    return btn("×", onclick, "gd-btn gd-ghost gd-btn-icon");
  }
  function tr(prefix, values) {
    return values.map((v) => [v, t(`${prefix}.${v}`)]);
  }
  function field(label, control, hint) {
    // A <label> clicks its first control when its text is clicked: right for one input,
    // wrong for a row of buttons, where the click would press the first of them.
    const single = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
    const w = el(single ? "label" : "div", "gd-fld");
    w.appendChild(el("span", "gd-fld-lbl", label));
    w.appendChild(control);
    return tip(w, hint);
  }

  /** The navigator: entries as tall as the shots are long, in the timeline's colours. */
  function buildNav(d) {
    const nav = el("div", "gd-segnav");
    d.prompt.shots.forEach((s, i) => {
      const live = d.derived.live_shot_indices.includes(i);
      const item = el("button", "gd-segnav-item" + (live ? "" : " dead")
        + (s.join === "continuous" ? " goes-on" : ""));
      item.type = "button";
      item.dataset.seg = String(i);
      item.dataset.len = String(s.length);
      item.style.flex = `${s.length} 0 0`;      // flex-basis 0: heights are exactly ∝ length
      item.style.setProperty("--seg", shotColor(i));
      tip(item, t("edit.segNavTitle", i + 1, s.start, s.start + s.length - 1, s.length));
      item.appendChild(el("span", "gd-segnav-name", t("edit.segShort", i + 1)));
      item.appendChild(el("span", "gd-segnav-range", `${seconds(s.start)}–${seconds(s.start + s.length)}s`));
      item.appendChild(el("span", "gd-segnav-len", `${s.length}f · ${seconds(s.length)}s`));
      item.onclick = () => { selectSeg(i); jumpToShot(i); };
      nav.appendChild(item);
    });
    navPh = el("div", "gd-segnav-ph");
    nav.appendChild(navPh);
    paintNavPlayhead(d.view.playhead);
    return nav;
  }

  /** Set the source clip; the clip length follows the file when the server has probed it. */
  function setSource(name) {
    const info = mediaInfo(name);
    const frames = info ? (info.frames24 || info.frames || 0) : 0;
    const auto = Math.min(gridLength(frames), MAX_TRAINED);
    host.patchDoc((x) => {
      x.source.video = name;
      x.source.start = 0;
      if (name && auto >= SHORT_CELL) x.clip.length = auto;
      // the base model has no reference channel: a source clip can only be its start
      if (name && x.family === "base") x.source.as_latent = true;
    }, t("h.source"));
  }

  // ---------------------------------------------------------------- recipes
  // A recipe starts the clip over as one kind of job: the material is replaced, the prompt
  // and the clip's length and aspect stay. Adding to what is there is what the shot cards
  // are for; a recipe that only added could not promise what its label says (a reference
  // video left behind makes "text to video" refuse to run). One undo step brings the old
  // material back.
  function startOver(x, family) {
    if (family) x.family = family;
    for (const key of ["subjects", "videos", "audio", "anchors"]) {
      for (const it of [...x[key]]) removeMaterial(x, it.id);
    }
    Object.assign(x.source, { video: "", start: 0, splice: [], audio: false });
    x.mask = { ...x.mask, mode: "whole_clip", cells: "", cut_frames: "" };
  }
  function framesOf(name) {
    const info = mediaInfo(name);
    return info ? (info.frames24 || info.frames || 0) : 0;
  }
  function recipes() {
    const bar = el("div", "gd-recipes");
    bar.appendChild(el("span", "gd-hint", t("edit.recipes")));
    const add = (key, fn) => {
      const b = btn(t(`recipe.${key}`), fn, "gd-btn gd-ghost gd-btn-sm");
      tip(b, t(`recipe.${key}Hint`));
      bar.appendChild(b);
    };
    const apply = (mutate) => host.patchDoc(mutate, t("h.recipe"));
    const firstShot = (x) => x.prompt.shots[0].id;
    const lastShot = (x) => x.prompt.shots[x.prompt.shots.length - 1].id;
    add("t2v", () => apply((x) => startOver(x, "base")));
    add("i2v", () => pick("images", (name) => apply((x) => {
      startOver(x, "base");
      addImage(x, firstShot(x), name, "first");
    })));
    add("fl2v", () => pick("images", (first) => pick("images", (last) => apply((x) => {
      startOver(x, "base");
      addImage(x, firstShot(x), first, "first");
      addImage(x, lastShot(x), last, "last");
    }))));
    add("r2v", () => pick("images", (name) => apply((x) => {
      startOver(x, "reference");
      addImage(x, "", name);
    })));
    // A subject that takes its look from a picture and its movement from a video. The
    // wording is the reference guide's own ("... whose walking motion comes from
    // <Video 1>"); written any looser, the model tends to reproduce the video instead.
    add("motion", () => pick("images", (image) => pick("videos", (video) => apply((x) => {
      startOver(x, "reference");
      const vid = addVideo(x, "", video);
      Object.assign(x.videos.find((it) => it.id === vid), {
        retention: "attribute_transfer",
        desc: "the motion reference: only the body movement and its timing are used, "
          + "not the appearance or the setting",
      });
      const sid = addImage(x, "", image);
      x.subjects.find((it) => it.id === sid).description = `the character, whose motion comes from @{${vid}}`;
    }))));
    add("edit", () => pick("videos", (name) => apply((x) => {
      startOver(x, "reference");
      const auto = Math.min(gridLength(framesOf(name)), MAX_TRAINED);
      if (auto >= SHORT_CELL) x.clip.length = auto;
      x.clip.aspect = "source";          // an edit keeps the whole frame of what it edits
      Object.assign(x.source, { video: name, as_reference: true, as_latent: false, role: "edit" });
    })));
    add("continue", () => pick("clips", (name) => apply((x) => {
      const info = mediaInfo(name);
      startOver(x, "");                  // either model continues a clip
      const id = addVideo(x, firstShot(x), name, "continue", info);
      x.anchors.find((it) => it.id === id).clip_start = Math.max(0, framesOf(name) - 22);
    })));
    return tip(bar, t("edit.recipesNote"));
  }

  /** What the compiled prompt depends on: the document without its view state. */
  function contentKey() {
    const d = host.doc();
    return JSON.stringify({ ...d, view: null, derived: null }) + JSON.stringify(host.run());
  }
  /** Everything the cards are built from: that, the selection, what is known of the source. */
  function cardsKey() {
    const d = host.doc();
    return contentKey() + d.view.selected_shot + JSON.stringify(sourceInfo(d))
      + (host.modelName ? host.modelName() : "");
  }
  async function compilePrompt() {
    if (!host.planPrompt) return;
    const key = contentKey();
    compiled = { loading: true, key, was: compiled && compiled.prompt ? compiled : null };
    paintCompiled();
    let got;
    try { got = await host.planPrompt(); } catch (e) { got = { error: String(e) }; }
    if (!compiled) return;             // closed while the server was working
    compiled = { ...got, key };
    paintCompiled();
  }
  /** The compiled prompt, in its own corner of the page: the answer arrives while the user
   *  may be typing somewhere else, and must not rebuild what they are typing into. */
  function paintCompiled() {
    if (!compiledHost) return;
    compiledHost.replaceChildren();
    compiledHost.hidden = !compiled;
    if (!compiled) return;
    // while a newer one is on its way, the last one stays up so the page does not jump
    const shown = compiled.loading ? compiled.was : compiled;
    if (!shown) compiledHost.textContent = t("edit.compiling");
    else if (shown.error) compiledHost.textContent = shown.error;
    else {
      if (shown.tasks && shown.tasks.length) compiledHost.appendChild(el("div", "gd-hint", shown.tasks.join(" + ")));
      compiledHost.appendChild(el("pre", "gd-pre", shown.prompt || ""));
      if (shown.warnings && shown.warnings.length) compiledHost.appendChild(warnList(shown.warnings));
    }
    // while it is showing, it is the prompt of the document as it is now
    if (!compiled.loading && compiled.key !== contentKey()) setTimeout(compilePrompt, 0);
    if (!compiled.loading) {
      compiledHost.appendChild(row(btn(t("edit.compileClose"), () => { compiled = null; paintCompiled(); },
        "gd-btn gd-ghost gd-btn-sm")));
    }
  }

  // ---------------------------------------------------------------- text with mentions
  // Prompt text names material by id. A person reads and types "@name": a box shows names,
  // and what was typed is read back into ids when the box is left.
  let lastBoxKey = "";                   // which prompt box had the cursor last

  /** Put "@name " into a box where its cursor is. The box keeps the focus and commits
   *  when it is left, like anything else typed into it. */
  function insertMention(box, name) {
    const at = box.selectionStart ?? box.value.length;
    const before = box.value.slice(0, at).replace(/@[^\s@{}]*$/, "");
    const lead = before && !/\s$/.test(before) ? " " : "";
    box.value = `${before}${lead}@${name} ${box.value.slice(box.selectionEnd ?? at)}`;
    const caret = before.length + lead.length + name.length + 2;
    box.focus();
    box.setSelectionRange(caret, caret);
  }

  /** A prompt box: shows names, stores ids, offers the material that can be named after "@". */
  function mentionBox(key, value, onCommit, { rows = 5, shotId = "" } = {}) {
    const wrap = el("div", "gd-mbox");
    const box = el("textarea");
    box.rows = rows;
    box.dataset.mbox = key;
    box.value = showMentions(value, host.doc());
    let stored = String(value || "");
    const commit = () => {
      const next = readMentions(box.value, host.doc());
      if (next === stored) return;
      stored = next;
      onCommit(next);
    };
    const list = el("div", "gd-at");
    list.hidden = true;
    let active = 0;                      // which name Enter would take
    const close = () => { list.hidden = true; list.replaceChildren(); };
    const mark = () => [...list.children].forEach((b, i) => b.classList.toggle("on", i === active));
    const offer = () => {
      const typed = /@([^\s@{}]*)$/.exec(box.value.slice(0, box.selectionStart ?? 0));
      const d = host.doc();
      const part = typed ? typed[1].toLowerCase() : "";
      const hits = typed ? mentionable(d, shotId).filter((m) => m.name.toLowerCase().includes(part)).slice(0, 8) : [];
      if (!hits.length) { close(); return; }
      list.replaceChildren();
      for (const m of hits) {
        const b = btn(`@${m.name}`, () => { close(); insertMention(box, m.name); }, "gd-at-item");
        const where = m.shot === "" ? t("mat.shared")
          : m.own ? "" : t("edit.segShort", d.prompt.shots.findIndex((s) => s.id === m.shot) + 1);
        b.appendChild(el("span", "gd-hint", [t(`mat.kind.${m.kind}`), where].filter(Boolean).join(" · ")));
        // the click has to land without the box losing its focus
        b.addEventListener("mousedown", (e) => e.preventDefault());
        list.appendChild(b);
      }
      active = 0;
      mark();
      list.hidden = false;
    };
    box.addEventListener("input", offer);
    box.addEventListener("focus", () => { lastBoxKey = key; });
    // "gd-key": the panel hands a field its keys this way (see gd_modal.js)
    box.addEventListener("gd-key", (ev) => {
      const e = ev.detail;
      // a key pressed while an input method is composing belongs to the input method
      if (list.hidden || e.isComposing || e.keyCode === 229) return;
      const n = list.children.length;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") { active = (active + 1) % n; mark(); }
      else if (e.key === "ArrowUp") { active = (active + n - 1) % n; mark(); }
      else if (e.key === "Enter" || e.key === "Tab") list.children[active].click();
      else return;
      e.preventDefault();
    });
    box.addEventListener("change", commit);
    box.addEventListener("blur", () => { close(); commit(); });
    wrap.append(box, list);
    return wrap;
  }

  /** The prompt box a click on a material's "@" writes into. */
  function mentionTarget(d, shot) {
    const live = document.activeElement;
    if (live && live.dataset && live.dataset.mbox && body.contains(live)) return live;
    const find = (key) => body.querySelector(`textarea[data-mbox="${key}"]`);
    if (shot) return find(`shot:${shot.id}`);
    const sel = d.prompt.shots[d.view.selected_shot];
    return (lastBoxKey && find(lastBoxKey)) || (sel && find(`shot:${sel.id}`)) || find("global");
  }

  // ---------------------------------------------------------------- material
  const opened = new Set();              // what is unfolded: ids of material, names of folds

  /** The picture, or a symbol, that stands for a file. */
  function thumb(file, kind) {
    const th = el("div", `gd-mat-thumb gd-mat-${kind}`);
    tip(th, file);
    if (kind === "image" && file) {
      const im = el("img");
      im.src = host.viewUrl(file);
      im.loading = "lazy";
      th.appendChild(im);
    } else if (kind === "video" && file) {
      const v = el("video");
      v.src = `${host.viewUrl(file)}#t=0.5`;
      v.preload = "metadata";
      v.muted = true;
      th.appendChild(v);
    } else {
      th.textContent = kind === "audio" ? "♪" : kind === "video" ? "▶" : "✎";
    }
    return th;
  }

  /** A label over a control. Not a <label>: that clicks its first control when its text
   *  is clicked, which is right for one input and wrong for a row of buttons. */
  function vfield(label, control, hint, value) {
    const w = el("div", "gd-vfld");
    if (label) w.appendChild(el("span", "gd-fld-lbl", label));
    w.appendChild(control);
    if (value) w.appendChild(el("span", "gd-hint", value));      // a reading, not an explanation
    return tip(w, hint);
  }

  /** One piece of material: what it is, what it is called, what it is for. */
  function materialRow(d, key, it, shot) {
    const reference = d.family === "reference";
    const fc = d.derived.frame_count;
    const patch = (fn, label) => host.patchDoc(fn, label || t("h.material"));
    const mine = (x) => x[key].find((m) => m.id === it.id);
    const use = useOf(key, it);
    const kind = key === "subjects" || (key === "anchors" && it.kind === "image") ? "image"
      : key === "videos" || (key === "anchors" && it.kind === "clip") ? "video" : "audio";
    const file = key === "subjects" ? it.images[0] || "" : it.file;

    const box = el("div", "gd-mat");
    const line = el("div", "gd-mat-line");
    line.appendChild(thumb(file, kind));
    const name = input("text", it.name, (v) => patch((x) => { mine(x).name = v; }, t("h.rename")),
      { size: 10 });
    tip(name, t("mat.nameHint"));
    name.classList.add("gd-mat-name");
    line.appendChild(name);

    // what it is for: only what this kind of file can be, in this place, for this model
    let uses = kind === "image" ? IMAGE_USES : kind === "video" ? VIDEO_USES : AUDIO_USES;
    if (!shot) uses = uses.filter((u) => ["subject", "motion", "voice", "sound"].includes(u));
    if (!reference) uses = uses.filter((u) => !["storyboard", "motion", "voice", "sound"].includes(u));
    if (key === "subjects" && it.images.length !== 1) uses = ["subject"];   // not one picture
    if (!uses.includes(use)) uses = [use, ...uses];
    const useSel = select(uses.map((u) => [u, t(`use.${u}`)]), use, (v) => {
      patch((x) => {
        // "a frame in between": where the playhead is when it is in this shot, else the middle
        const here = shot ? currentFrame() - shot.start : 0;
        const at = shot && here > 0 && here < shot.length - 1 ? here : Math.floor((shot ? shot.length : 2) / 2);
        const id = setUse(x, it.id, v, at);
        if (v === "voice") {
          const a = x.audio.find((m) => m.id === id);
          if (a && !a.subject && x.subjects.length) a.subject = x.subjects[0].id;
        }
      }, t("h.use"));
    });
    tip(useSel, t(`use.${use}Hint`));
    useSel.disabled = uses.length < 2;
    line.appendChild(useSel);

    if (use === "voice") {
      line.appendChild(select(d.subjects.map((s) => [s.id, t("mat.voiceOf", s.name)]), it.subject,
        (v) => patch((x) => { mine(x).subject = v; })));
    }
    if (use === "frame" && shot) {
      const at = el("span", "gd-inline");
      at.appendChild(el("span", "gd-hint", t("mat.atFrame")));
      at.appendChild(number(it.offset, (v) => patch((x) => { Object.assign(mine(x), { at: "offset", offset: v }); }),
        { min: 1, max: Math.max(1, shot.length - 2), step: 1, "data-gd-tip": t("mat.atFrameHint", shot.start + it.offset) }));
      at.appendChild(el("span", "gd-hint", t("mat.atSeconds", seconds(it.offset))));
      const here = btn("⌖", () => patch((x) => {
        const off = currentFrame() - shot.start;
        if (off > 0 && off < shot.length - 1) Object.assign(mine(x), { at: "offset", offset: off });
      }), "gd-btn gd-ghost gd-btn-icon");
      tip(here, t("edit.toPlayhead"));
      at.appendChild(here);
      line.appendChild(at);
    }
    const tools = el("span", "gd-mat-tools");
    // what the prompt can name: in the base model nothing but subjects has a name there
    const named = key === "subjects" || (reference && (key !== "anchors" || (it.kind === "image" && it.cite)));
    if (named && d.prompt.mode !== "raw") {
      const ins = btn("@", () => {
        const target = mentionTarget(d, shot);
        if (target) insertMention(target, it.name);
      }, "gd-btn gd-ghost gd-btn-icon");
      tip(ins, t("mat.insert", it.name));
      ins.addEventListener("mousedown", (e) => e.preventDefault());
      tools.appendChild(ins);
    }
    const more = btn(opened.has(it.id) ? "▾" : "▸", () => {
      if (opened.has(it.id)) opened.delete(it.id); else opened.add(it.id);
      renderBody();
    }, "gd-btn gd-ghost gd-btn-icon");
    tip(more, t("mat.more"));
    tools.appendChild(more);
    const gone = removeBtn(() => patch((x) => removeMaterial(x, it.id), t("h.removeMaterial")));
    tip(gone, t("mat.remove"));
    tools.appendChild(gone);
    line.appendChild(tools);
    box.appendChild(line);

    if (!opened.has(it.id)) return box;
    const g = el("div", "gd-grid gd-mat-more");
    const keep = (list, value, set) => select(list.map((r) => [r, t(`keep.${r}`)]), value, set);
    const lists = { image: ["images", "gd-images"], video: [reference ? "videos" : "clips", "gd-videos"],
                    audio: ["audio", "gd-audio"] }[kind];
    if (key !== "subjects") {
      g.appendChild(field(t("mat.file"), mediaField(lists[0], it.file,
        (v) => { if (v) patch((x) => { mine(x).file = v; }); }, lists[1])));
    }
    if (key === "subjects") {
      g.appendChild(field(t("edit.subjectKind"), select(tr("kind", SUBJECT_KINDS), it.kind,
        (v) => patch((x) => { mine(x).kind = v; })), t("edit.subjectKindHint")));
      g.appendChild(field(t("edit.subjectDesc"), input("text", showMentions(it.description, d),
        (v) => patch((x) => { mine(x).description = readMentions(v, host.doc()); }),
        { placeholder: t("edit.subjectDescPh") }), t("edit.subjectDescHint")));
      g.appendChild(field(t("edit.subjectShort"), input("text", it.short_name,
        (v) => patch((x) => { mine(x).short_name = v; }), { placeholder: t("edit.subjectShortPh") }),
        t("edit.subjectShortHint")));
      if (reference) {
        g.appendChild(field(t("mat.keep"), keep(RETENTIONS, it.retention,
          (v) => patch((x) => { mine(x).retention = v; })), t("mat.keepHint")));
      }
      const il = el("div", "gd-thumbs");
      it.images.forEach((f, k) => {
        const th = el("div", "gd-thumb");
        const im = el("img");
        im.src = host.viewUrl(f); im.loading = "lazy"; tip(im, f);
        th.appendChild(im);
        if (it.images.length > 1) {
          th.appendChild(removeBtn(() => patch((x) => { mine(x).images.splice(k, 1); })));
        }
        il.appendChild(th);
      });
      il.appendChild(btn(t("mat.morePictures"), () => pick("images",
        (name) => patch((x) => { mine(x).images.push(name); })), "gd-btn gd-ghost gd-btn-sm"));
      g.appendChild(field(t("mat.pictures"), il, t("mat.picturesHint")));
    } else if (key === "videos") {
      g.appendChild(field(t("mat.what"), input("text", it.desc,
        (v) => patch((x) => { mine(x).desc = v; }), { placeholder: t("edit.videoDescPh") })));
      g.appendChild(field(t("mat.keep"), keep(RETENTIONS, it.retention,
        (v) => patch((x) => { mine(x).retention = v; })), t("mat.keepHint")));
      g.appendChild(field("", checkbox(it.audio, (v) => patch((x) => { mine(x).audio = v; }), t("edit.soundtrack")),
        t("mat.soundtrackHint")));
    } else if (key === "audio") {
      g.appendChild(field(t("mat.what"), input("text", it.desc,
        (v) => patch((x) => { mine(x).desc = v; }), { placeholder: t("edit.audioDescPh") })));
      g.appendChild(field(t("mat.keep"), keep(AUDIO_RETENTIONS, it.retention,
        (v) => patch((x) => { mine(x).retention = v; })), t("mat.keepHint")));
    } else if (it.kind === "image" && reference) {
      // The base model has nothing to choose here: a picture on the clip's first or last
      // frame goes in through the model's own input, any other is held at its frame.
      g.appendChild(field("", checkbox(it.pin, (v) => patch((x) => { mine(x).pin = v; }), t("edit.pin")),
        t("edit.pinHint")));
      g.appendChild(field("", checkbox(it.cite, (v) => patch((x) => { mine(x).cite = v; }), t("edit.cite")),
        t("edit.citeHint")));
      if (it.cite) {
        g.appendChild(field(t("mat.keep"), keep(RETENTIONS, it.retention,
          (v) => patch((x) => { mine(x).retention = v; })), t("mat.keepHint")));
      }
    } else if (it.kind === "clip") {
      const lens = [];
      for (let n = 5; n <= fc - it.frame; n += 17) lens.push(n);
      if (!lens.includes(it.clip_length)) lens.push(it.clip_length);
      g.appendChild(field(t("edit.clipFrom"), number(it.clip_start,
        (v) => patch((x) => { mine(x).clip_start = v; }), { min: 0, step: 1 }), t("mat.clipFromHint")));
      g.appendChild(field(t("mat.clipLength"), select(lens.map((n) => [n, t("mat.framesSeconds", n, seconds(n))]),
        it.clip_length, (v) => patch((x) => { mine(x).clip_length = Number(v); })), t("mat.clipLengthHint")));
      g.appendChild(field("", checkbox(it.with_audio, (v) => patch((x) => { mine(x).with_audio = v; }),
        t("edit.soundtrack")), t("mat.soundtrackHint")));
    }
    box.appendChild(g);
    return box;
  }

  /** The material of one kind in a shot (or shared, when `shot` is null), and its add button. */
  function materialGroup(d, kind, shot) {
    const sid = shot ? shot.id : "";
    const reference = d.family === "reference";
    const patch = (fn) => host.patchDoc(fn, t("h.addMaterial"));
    const group = el("div", "gd-matgroup");
    const held = (k) => d.anchors.filter((a) => a.kind === k && a.shot === sid).map((it) => ["anchors", it]);
    const items = kind === "image"
      ? [...d.subjects.filter((s) => s.shot === sid).map((it) => ["subjects", it]), ...(shot ? held("image") : [])]
      : kind === "video"
        ? [...d.videos.filter((v) => v.shot === sid).map((it) => ["videos", it]), ...(shot ? held("clip") : [])]
        : [...d.audio.filter((a) => a.shot === sid).map((it) => ["audio", it]), ...(shot ? held("audio") : [])];
    const head = el("div", "gd-matgroup-title");
    head.appendChild(el("span", null, t(`mat.group.${kind}`)));
    group.appendChild(head);
    for (const [key, it] of items) group.appendChild(materialRow(d, key, it, shot));

    const adds = el("div", "gd-inline");
    if (kind === "image") {
      adds.appendChild(tip(btn(t("mat.addImage"), () => pick("images", (name) => patch((x) => addPicked(x, sid, "image", name))),
        "gd-btn gd-ghost gd-btn-sm"), t("mat.addHint")));
      const words = btn(t("mat.addSubjectText"), () => patch((x) => {
        x.subjects.push({ id: freeId(x, "subjects"), shot: sid, images: [], description: t("edit.subjectDescPh") });
      }), "gd-btn gd-ghost gd-btn-sm");
      tip(words, t("mat.addSubjectTextHint"));
      adds.appendChild(words);
    } else if (kind === "video") {
      const b = btn(t("mat.addVideo"), () => pick(reference ? "videos" : "clips",
        (name) => patch((x) => addPicked(x, sid, "video", name))), "gd-btn gd-ghost gd-btn-sm");
      adds.appendChild(tip(b, t("mat.addHint")));
    } else {
      const b = btn(t("mat.addAudio"), () => pick("audio", (name) => patch((x) => addPicked(x, sid, "audio", name))),
        "gd-btn gd-ghost gd-btn-sm");
      adds.appendChild(tip(b, t("mat.addHint")));
    }
    group.appendChild(adds);
    return group;
  }

  /** A part of the page that folds away and remembers whether it is open. */
  function fold(key, title, build) {
    const box = el("details", "gd-fold");
    box.open = opened.has(key);
    box.appendChild(el("summary", null, title));
    box.addEventListener("toggle", () => { if (box.open) opened.add(key); else opened.delete(key); });
    box.appendChild(build());
    return box;
  }

  // ---------------------------------------------------------------- body
  /** Put the cursor back into the prompt box it was in before the cards were rebuilt. */
  function refocus(back) {
    const box = back && body.querySelector(`textarea[data-mbox="${back.key}"]`);
    if (!box) return;
    box.focus({ preventScroll: true });
    try { box.setSelectionRange(back.from, back.to); } catch (e) { /* not a text box any more */ }
  }

  function renderBody() {
    if (!body) return;
    // What is being typed is committed before the field it is typed into is thrown away:
    // leaving the field runs its change handler. If that changed the document, the cards
    // have been built again by the time blur() returns, and this call has nothing to do.
    const act = document.activeElement;
    const typing = act && body.contains(act) && /^(INPUT|TEXTAREA)$/.test(act.tagName) ? act : null;
    const back = typing && typing.dataset.mbox
      ? { key: typing.dataset.mbox, from: typing.selectionStart, to: typing.selectionEnd } : null;
    if (typing) {
      const seen = builds;
      typing.blur();
      if (builds !== seen) { refocus(back); return; }
    }
    builds += 1;
    const d = host.doc();
    const r = host.run();
    const media = host.media();
    const reference = d.family === "reference";
    const fc = d.derived.frame_count;
    const [cw, ch] = canvasOf(d);
    bodyKey = cardsKey();
    // a rebuild must not move the page under the reader
    const panel = scrollParent();
    const scrollTop = panel ? panel.scrollTop : 0;
    body.replaceChildren();

    const vids = datalist("gd-videos", (media.videos || []).map((x) => x.name));
    datalist("gd-images", (media.images || []).map((x) => x.name));
    datalist("gd-audio", [...(media.audio || []), ...(media.videos || [])].map((x) => x.name));
    const patch = (fn, label) => host.patchDoc(fn, label || t("h.edit"));

    if (tlHint) {
      tlHint.textContent = [
        t("edit.tlLength", seconds(fc), fc, FPS),
        t("edit.outSize", cw, ch),
        t("edit.tlSteps", r.steps),
        t("edit.tlSegs", d.prompt.shots.length),
        t(`mode.${clipMode(d)}`),
      ].join(" · ");
      tip(tlHint, t("edit.tlHint"));
    }

    // the same codes the server refuses a run with, worded in the panel's language
    const found = problemsCoded(d).map(([code, args]) => t(`problem.${code}`,
      ...args.map((a) => (typeof a === "string" ? showMentions(a, d) : a))));
    if (found.length) {
      const ps = section(t("edit.problems"));
      ps.classList.add("gd-sec-bad");
      ps.appendChild(warnList(found));
      body.appendChild(ps);
    }

    // ---------------------------------------------------------------- clip
    const cs = section(t("edit.clip"));
    cs.appendChild(recipes());
    const grid = el("div", "gd-grid");
    const famSel = select(tr("family", FAMILIES), d.family, (v) => patch((x) => { x.family = v; }, t("h.family")));
    grid.appendChild(field(t("edit.family"), famSel, t("edit.familyHint")));
    const lenBox = el("div", "gd-inline");
    for (const n of [124, 243, 362]) {
      lenBox.appendChild(btn(t("edit.secondsBtn", Math.round(n / FPS)),
        () => patch((x) => { x.clip.length = n; }, t("h.frames")),
        "gd-btn gd-btn-sm" + (fc === n ? "" : " gd-ghost")));
    }
    // Typed in seconds, like the buttons beside it: a "10" typed into a box of frames is
    // ten frames. What it comes to in frames, once fitted to a length the model takes, is
    // said next to it.
    const lenIn = number(Number((fc / FPS).toFixed(2)), (v) => {
      patch((x) => { x.clip.length = Math.max(5, Math.round(v * FPS)); }, t("h.frames"));
      // the length the clip really got: a length that fits to the one it had redraws nothing
      lenIn.value = (host.doc().derived.frame_count / FPS).toFixed(2);
    }, { min: 0.2, max: 150, step: 0.5 });
    lenBox.appendChild(lenIn);
    lenBox.appendChild(el("span", "gd-hint", t("edit.lengthNow", fc, FPS)));
    grid.appendChild(field(t("edit.frames"), lenBox, t("edit.framesHint")));
    const aspBox = el("div", "gd-inline");
    aspBox.appendChild(select(ASPECTS.includes(d.clip.aspect) ? ASPECTS.map((a) => [a, a === "source" ? t("edit.aspectSource") : a])
      : [...ASPECTS.map((a) => [a, a === "source" ? t("edit.aspectSource") : a]), [d.clip.aspect, d.clip.aspect]],
      d.clip.aspect, (v) => patch((x) => { x.clip.aspect = v; }, t("h.aspect"))));
    aspBox.appendChild(input("text", ASPECTS.includes(d.clip.aspect) ? "" : d.clip.aspect,
      (v) => { if (v.trim()) patch((x) => { x.clip.aspect = v.trim(); }, t("h.aspect")); },
      { placeholder: "896:512", size: 8 }));
    aspBox.appendChild(el("span", "gd-hint", t("edit.canvasNow", cw, ch)));
    grid.appendChild(field(t("edit.aspect"), aspBox, t("edit.aspectHint")));
    cs.appendChild(grid);
    const wired = host.modelName ? host.modelName() : "";
    if (wired) {
      const looks = /ref2v/i.test(wired) ? "reference" : /fl2v|fasth3|t2v|i2v/i.test(wired) ? "base" : "";
      if (looks && looks !== d.family) {
        cs.appendChild(el("div", "gd-badge-bad", t("edit.familyMismatch", wired, t(`family.${d.family}`))));
      }
    }
    body.appendChild(cs);

    // ---------------------------------------------------------------- shared material
    const use = budget(d);
    const com = section(t("edit.common"), t("edit.commonHint"));
    com.classList.add("gd-common");
    if (reference) {
      const over = use.files > use.max.files || use.images > use.max.images
        || use.videos > use.max.videos || use.audio > use.max.audio;
      com.appendChild(tip(el("div", "gd-budget" + (over ? " over" : ""), t("edit.budget",
        use.images, use.max.images, use.videos, use.max.videos, use.audio, use.max.audio,
        use.files, use.max.files)), t("edit.budgetHint")));
    }

    const two = el("div", "gd-shot-body");
    const left = el("div", "gd-shot-text");
    if (d.prompt.mode === "raw") {
      left.appendChild(vfield(t("edit.rawPrompt"), textarea(d.prompt.raw,
        (v) => patch((x) => { x.prompt.raw = v; }, t("h.globalPrompt")), 8), t("edit.rawHint")));
    } else {
      left.appendChild(vfield(t("edit.globalPrompt"),
        mentionBox("global", d.prompt.global, (v) => patch((x) => { x.prompt.global = v; }, t("h.globalPrompt")),
          { rows: 4 }),
        `${d.prompt.global.length} ${t("edit.chars")} · ${reference ? t("edit.globalHintRef") : t("edit.globalHintBase")}`));
      const line = (key, label, placeholder, hint, undo) => vfield(label, input("text", showMentions(d.prompt[key], d),
        (v) => patch((x) => { x.prompt[key] = readMentions(v, host.doc()); }, undo), { placeholder }), hint);
      left.appendChild(line("soundscape", t("edit.soundscape"), t("edit.soundscapePh"),
        t("edit.soundscapeHint"), t("h.soundscape")));
      left.appendChild(line("music", t("edit.music"), t("edit.musicPh"), t("edit.musicHint"), t("h.music")));
      if (reference) {
        left.appendChild(line("summary", t("edit.summary"), t("edit.summaryPh"), t("edit.summaryHint"),
          t("h.summary")));
      }
    }
    two.appendChild(left);
    const right = el("div", "gd-shot-mats");
    right.appendChild(materialGroup(d, "image", null));
    if (reference || d.videos.some((v) => !v.shot)) right.appendChild(materialGroup(d, "video", null));
    if (reference || d.audio.some((a) => !a.shot)) right.appendChild(materialGroup(d, "audio", null));
    dropZone(right, (files) => dropInto("", files), (items) => takeItems("", items));
    two.appendChild(right);
    com.appendChild(two);

    // the source clip: a video the whole clip starts from, edits, or both
    const ss = el("div", "gd-source");
    ss.appendChild(tip(el("div", "gd-matgroup-title", t("edit.source")), t("edit.sourceHint")));
    // a video dropped here becomes the source video
    dropZone(ss, async (files) => {
      const video = files.find((f) => fileKind(f) === "video");
      if (!video) return;
      try {
        const got = await host.importFiles([video]);
        if (got.length) setSource(got[0].name);
      } catch (e) { window.alert(t("lib.importFailed", String((e && e.message) || e))); }
    });
    const srow = el("div", "gd-grid");
    // "clips": input videos and earlier renders (continuing a finished clip needs the latter)
    srow.appendChild(field(t("edit.sourceVideo"), mediaField("clips", d.source.video, setSource, vids)));
    const startFrom = () => {
      const lat = el("div", "gd-inline");
      lat.appendChild(checkbox(d.source.as_latent,
        (v) => patch((x) => { x.source.as_latent = v; }, t("h.source")), t("edit.asLatent")));
      if (d.source.as_latent) {
        lat.appendChild(el("span", "gd-hint", t("edit.changeAmount")));
        lat.appendChild(number(d.source.denoise, (v) => patch((x) => { x.source.denoise = v; }, t("h.source")),
          { min: 0.05, max: 1, step: 0.05 }));
        // The schedule shift bends this number: at shift s, d starts the sampler at a noise
        // level of s*d / (1 + (s-1)*d). At the default shift of 12, 0.7 is already 97%
        // noise, so the number alone says very little about how much of the clip survives.
        const sh = Number(r.shift_video) || 1;
        const dn = Number(d.source.denoise);
        const level = (sh * dn) / (1 + (sh - 1) * dn);
        const ext = host.externalWired ? host.externalWired() : {};
        lat.appendChild(el("span", "gd-hint", ext.sigmas ? t("edit.noiseExternal")
          : t("edit.noiseLevel", Math.round(level * 100), Math.round((1 - level) * 100))));
      }
      return field(t("edit.useLatent"), lat, t("edit.asLatentHint"));
    };
    if (d.source.video) {
      if (reference) {
        const what = d.source.as_reference ? d.source.role : "none";
        srow.appendChild(field(t("edit.sourceUse"), select(
          [...SOURCE_ROLES.map((role) => [role, t(`role.${role}`)]), ["none", t("role.none")]], what,
          (v) => patch((x) => {
            if (v === "none") Object.assign(x.source, { as_reference: false, as_latent: true });
            else Object.assign(x.source, { as_reference: true, role: v });
          }, t("h.source"))), t("edit.sourceUseHint")));
        if (d.source.as_reference) {
          srow.appendChild(field("", checkbox(d.source.audio,
            (v) => patch((x) => { x.source.audio = v; }, t("h.source")), t("edit.soundtrack")),
            t("mat.soundtrackHint")));
        }
      } else {
        srow.appendChild(startFrom());     // all the base model can do with a clip
      }
      srow.appendChild(field("", btn(t("edit.clear"), () => setSource(""), "gd-btn gd-ghost gd-btn-sm")));
    }
    ss.appendChild(srow);
    if (d.source.video) {
      ss.appendChild(fold("source", t("edit.sourceMore"), () => {
        const more = el("div", "gd-grid");
        more.appendChild(field(t("edit.sourceStart"), number(d.source.start,
          (v) => patch((x) => { x.source.start = v; }, t("h.source")), { min: 0, step: 1 }),
          t("edit.sourceStartHint")));
        if (reference) more.appendChild(startFrom());
        if (reference && d.source.as_reference) {
          more.appendChild(field(t("mat.keep"), select(RETENTIONS.map((x) => [x, t(`keep.${x}`)]), d.source.retention,
            (v) => patch((x) => { x.source.retention = v; }, t("h.source"))), t("mat.keepHint")));
          more.appendChild(field(t("edit.refNote"), input("text", d.source.note,
            (v) => patch((x) => { x.source.note = v; }, t("h.source")),
            { placeholder: t("edit.refNotePh") }), t("edit.refNoteHint")));
        }
        return more;
      }));
    }
    com.appendChild(ss);
    body.appendChild(com);

    // ---------------------------------------------------------------- shots
    const segHead = section(null);
    segHead.classList.add("gd-seg-head");
    segHead.appendChild(tip(el("h3", null, `${t("edit.segments")} · ${d.prompt.shots.length}`),
      t(d.prompt.mode === "raw" ? "edit.shotsRaw" : "edit.shotsDialogue")));
    const spread = btn(t("edit.spreadPrompt"), spreadPrompts, "gd-btn gd-ghost");
    tip(spread, t("edit.spreadPromptHint"));
    spread.disabled = d.prompt.shots.length < 2;
    const show = btn(t("edit.compile"), compilePrompt, "gd-btn gd-ghost");
    tip(show, t("edit.compileHint"));
    segHead.appendChild(row(spread, show));
    compiledHost = el("div", "gd-compiled");
    segHead.appendChild(compiledHost);
    paintCompiled();
    body.appendChild(segHead);

    const wrap = el("div", "gd-segwrap");
    wrap.appendChild(buildNav(d));
    const col = el("div", "gd-segcol");
    wrap.appendChild(col);
    body.appendChild(wrap);

    /** Between two cards: how the lower shot follows the upper one. Two links, the
     *  picture's and the sound's. A long take's sound goes on with its picture, so that
     *  link is shown closed and cannot be opened while the picture's is. */
    const joinBar = (shot, si) => {
      const bar = el("div", "gd-join");
      bar.dataset.join = String(si);
      const longTake = shot.join === "continuous";
      const heard = longTake || shot.sound === "continuous";
      bar.appendChild(linkMark("picture", longTake, t(longTake ? "join.pictureOn" : "join.pictureOff"),
        () => patch((x) => {
          const s = x.prompt.shots[si];
          s.join = longTake ? "cut" : "continuous";
          // A boundary made a seam here gets the range the panel starts a seam with. One
          // that was a seam before this setting existed has none and keeps the rule it
          // was made with, until its range is set on the Generate page.
          if (!longTake && !s.seam) s.seam = DEFAULT_SEAM;
        }, t("h.join"))));
      bar.appendChild(linkMark("sound", heard,
        t(longTake ? "join.soundLocked" : heard ? "join.soundOn" : "join.soundOff"),
        () => patch((x) => { x.prompt.shots[si].sound = heard ? "cut" : "continuous"; }, t("h.joinSound")),
        longTake));
      return bar;
    };

    d.prompt.shots.forEach((shot, si) => {
      const live = d.derived.live_shot_indices.includes(si);
      const selected = si === d.view.selected_shot;
      if (si) col.appendChild(joinBar(shot, si));
      const block = el("section", "gd-seg" + (selected ? " selected" : "") + (live ? "" : " dead"));
      block.dataset.shot = String(si);
      block.style.setProperty("--seg", shotColor(si));
      // a click anywhere in a card selects its shot; the page is not rebuilt for it, so a
      // click on a control inside still does what it was for
      block.addEventListener("mousedown", () => { if (host.doc().view.selected_shot !== si) markSelected(si); });

      const head = el("div", "gd-seg-title");
      const tag = el("button", "gd-seg-tag", `${si + 1}`);
      tag.type = "button";
      tag.onclick = () => selectSeg(si);
      head.appendChild(tag);
      head.appendChild(el("strong", null, t("edit.segment", si + 1)));
      head.appendChild(el("span", "gd-hint", t("edit.segRange", seconds(shot.start),
        seconds(shot.start + shot.length), seconds(shot.length), shot.start, shot.start + shot.length - 1)));
      const mode = tip(el("span", "gd-mode", t(`mode.${shotMode(d, shot)}`)), t("edit.modeHint"));
      head.appendChild(mode);
      if (!live) head.appendChild(el("span", "gd-badge-bad", t("edit.segPinned")));
      const counts = [
        d.subjects.filter((m) => m.shot === shot.id).length + d.anchors.filter((a) => a.shot === shot.id && a.kind === "image").length,
        d.videos.filter((m) => m.shot === shot.id).length + d.anchors.filter((a) => a.shot === shot.id && a.kind === "clip").length,
        d.audio.filter((m) => m.shot === shot.id).length + d.anchors.filter((a) => a.shot === shot.id && a.kind === "audio").length,
      ];
      if (shot.collapsed && counts.some(Boolean)) {
        head.appendChild(el("span", "gd-badge-blue", t("edit.segCounts", ...counts)));
      }
      const headActions = el("div", "gd-seg-actions");
      headActions.appendChild(btn(t("edit.toSegStart"), () => { if (player) player.seek(shot.start); },
        "gd-btn gd-ghost gd-btn-sm"));
      headActions.appendChild(btn(shot.collapsed ? t("edit.expand") : t("edit.collapse"),
        () => patch((x) => { x.prompt.shots[si].collapsed = !shot.collapsed; }, t("h.collapse")),
        "gd-btn gd-ghost gd-btn-sm"));
      if (si > 0) {
        headActions.appendChild(btn(t("edit.mergePrev"), () => { selectSeg(si); deleteCut(); },
          "gd-btn gd-ghost gd-btn-sm"));
      }
      head.appendChild(headActions);
      block.appendChild(head);

      if (!shot.collapsed) {
        const cols = el("div", "gd-shot-body");
        const text = el("div", "gd-shot-text");
        if (d.prompt.mode === "raw") {
          text.appendChild(el("div", "gd-hint", t("edit.shotRawNote")));
        } else {
          text.appendChild(vfield(t("edit.segPrompt"),
            mentionBox(`shot:${shot.id}`, shot.text, (v) => patch(
              (x) => { x.prompt.shots[si].text = v; }, t("h.segPrompt", si + 1)), { rows: 7, shotId: shot.id }),
            t("edit.atHint"), `${shot.text.length} ${t("edit.chars")}`));
          // what the compiler does with a shot nobody wrote: see gd_compile._written
          const written = shot.text.trim() || d.subjects.some((m) => m.shot === shot.id)
            || (reference && (d.videos.some((m) => m.shot === shot.id)
              || d.audio.some((m) => m.shot === shot.id && !m.subject)));
          if (!written && d.prompt.shots.length > 1) {
            text.appendChild(el("div", "gd-badge-blue gd-wrap", t("edit.shotEmpty")));
          }
        }
        cols.appendChild(text);
        const mats = el("div", "gd-shot-mats");
        mats.appendChild(materialGroup(d, "image", shot));
        mats.appendChild(materialGroup(d, "video", shot));
        mats.appendChild(materialGroup(d, "audio", shot));
        dropZone(mats, (files) => dropInto(shot.id, files), (items) => takeItems(shot.id, items));
        cols.appendChild(mats);
        block.appendChild(cols);
      }
      col.appendChild(block);
    });

    // ---------------------------------------------------------------- redo part of a clip
    // Only a run that starts from a clip has anything to keep.
    if (d.derived.latent_source !== "empty" || d.mask.mode !== "whole_clip") {
      const ms = section(t("edit.mask"), t("edit.maskHint"));
      const mrow = el("div", "gd-mask-row");
      mrow.appendChild(labeled(t("edit.maskMode"), select(tr("mask", MASK_MODES), d.mask.mode,
        (v) => patch((x) => { x.mask.mode = v; }, t("h.maskMode")))));
      if (d.mask.mode === "free_cells") {
        mrow.appendChild(labeled(t("edit.freeCells"), input("text", d.mask.cells,
          (v) => patch((x) => { x.mask.cells = v; }, t("h.freeCells")),
          { placeholder: "3-4 | 0,2..3,7 | f39-72 | all" }), t("edit.freeCellsHint")));
      }
      if (d.mask.mode === "seam_repair") {
        mrow.appendChild(labeled(t("edit.cutFrames"), input("text", d.mask.cut_frames,
          (v) => patch((x) => { x.mask.cut_frames = v; }, t("h.cutFrames")),
          { placeholder: "39,90" })));
        mrow.appendChild(labeled(t("edit.radius"), number(d.mask.radius,
          (v) => patch((x) => { x.mask.radius = v; }, t("h.radius")), { min: 1, max: 4 })));
      }
      ms.appendChild(mrow);
      ms.appendChild(row(
        btn(t("edit.allFree"), () => patch((x) => {
          x.mask.mode = "whole_clip"; x.mask.cells = "";
        }, t("h.allFree")), "gd-btn gd-ghost"),
        btn(t("edit.onlySelected", d.view.selected_shot + 1), () => patch((x) => {
          const s = x.prompt.shots[x.view.selected_shot];
          if (!s) return;
          x.mask.mode = "free_cells";
          x.mask.cells = `f${s.start}-${s.start + s.length - 1}`;
        }, t("h.onlySelected")), "gd-btn gd-ghost"),
      ));
      body.appendChild(ms);
    }

    // ---------------------------------------------------------------- advanced
    const adv = section(null);
    adv.appendChild(fold("advanced", t("edit.advanced"), () => {
      const g = el("div", "gd-grid");
      g.appendChild(field(t("edit.promptMode"), select(tr("pmode", PROMPT_MODES), d.prompt.mode,
        (v) => patch((x) => { x.prompt.mode = v; }, t("h.promptMode"))), t("edit.promptModeHint")));
      const neg = input("text", d.prompt.negative, (v) => patch((x) => { x.prompt.negative = v; }, t("h.negative")));
      const off = Number(r.cfg) === 1;         // no guidance, no negative branch: it would do nothing
      neg.disabled = off;
      const nf = field(t("edit.negative"), neg, off ? t("edit.negativeOff") : t("edit.negativeOn", r.cfg));
      nf.appendChild(el("span", "gd-hint", off ? t("edit.negativeOff") : t("edit.negativeOn", r.cfg)));
      g.appendChild(nf);
      return g;
    }));
    body.appendChild(adv);

    watchNavFit();
    fitNav();
    if (panel) panel.scrollTop = scrollTop;
    refocus(back);
    requestAnimationFrame(fitNav);       // once more after layout settles
  }

  return {
    render() {
      if (!timeline) { buildShell(); return; }
      // The host renders the showing page again on every event of a run. With nothing the
      // cards are built from changed, rebuilding them would only throw away what is being
      // typed into one of them.
      if (cardsKey() !== bodyKey) renderBody();
      timeline.render(); syncPlayerToDoc(); paintFileLine(); paintSegBar();
      paintTimelineTip();
    },
    destroy() {
      if (onKey) { window.removeEventListener("keydown", onKey, true); onKey = null; }
      if (navScroller) { navScroller.removeEventListener("scroll", fitNav); navScroller = null; }
      if (navRo) { navRo.disconnect(); navRo = null; }
      if (player) { player.destroy(); player = null; }
      if (timeline) { timeline.destroy(); timeline = null; }
    },
  };
}
