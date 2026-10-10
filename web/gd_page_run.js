// Gacha Director — the project page: how a clip is rendered. Presets on the left, the one in
// force on the right.
//
// What is asked first is what people ask first: how large is the picture, how many frames
// a second, how long will it take. A preset answers those; everything that is only there
// to be tuned sits folded away under them.
//
// A preset stores how many pixels a frame has, not a width and a height, because the shape
// of the frame belongs to the clip: the same preset renders a landscape clip and a portrait
// one. Nobody thinks in megapixels, though, so the page offers sizes, each shown as the
// width and height it comes to for the clip being edited.
//
// Timing history lives with the preset because that is the only place it means anything:
// "three minutes on average" is a fact about a configuration and a clip length. Change a
// number and the old timings stop describing it, which is what auto-reset is for.

import { t } from "./gd_i18n.js";
import {
  btn, checkbox, el, labeled, noisePercent, number, row, section, select, tip,
} from "./gd_ui.js";
import {
  BUILTIN_PRESETS, MODELS, REF_IMAGE_SIZES, REF_VIDEO_EDGES, SAMPLERS, SCHEDULERS, STAGING,
  fmtSeconds, paramSummary, timingFor,
} from "./gd_presets_doc.js";
import { FPS, canvasSize } from "./gd_doc.js";

// The sizes on offer: a pixel budget and what to call it. The widths and heights in the
// comments are what each comes to at 16:9.
export const SIZES = [
  [0.25, "small"],       // 672 x 384
  [0.4, "standard"],     // 864 x 480, the size of the official templates
  [0.6, "medium"],       // 1056 x 608
  [0.88, "hd"],          // 1280 x 736
  [0.98, "native"],      // 1344 x 768, what the model was trained at
  [2.0, "fullhd"],       // 1920 x 1088, beyond what it was trained at
];

// A size of one's own. The model takes widths and heights that are multiples of 32, and a
// preset holds between 0.03 and 4 megapixels (gd_presets.normalize_params): 2048 x 2048 is
// the 4. Below 256 a side has too few latent cells to hold a picture.
const SIDE_STEP = 32;
const SIDE_MIN = 256;
const SIDE_MAX = 2048;
const OWN = "own";                     // the entry of the list that opens the two boxes

/** A width and a height as typed -> what would be used: {ok: true, w, h, moved} with both
 *  on the model's grid (`moved` when that changed them), or {ok: false, why}. */
export function ownSize(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { ok: false, why: "empty" };
  if (w < SIDE_MIN || h < SIDE_MIN || w > SIDE_MAX || h > SIDE_MAX) return { ok: false, why: "range" };
  const W = Math.round(w / SIDE_STEP) * SIDE_STEP;
  const H = Math.round(h / SIDE_STEP) * SIDE_STEP;
  return { ok: true, w: W, h: H, moved: W !== w || H !== h };
}

/** The aspect ratio and the pixel budget that come to exactly this size: a size is not
 *  stored, the clip's ratio and the preset's budget are. null when no budget of three
 *  decimals lands on it (none was found that does not). */
export function sizeAsRatioAndBudget(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  const aspect = `${w / g}:${h / g}`;
  const exact = (w * h) / (1024 * 1024);
  for (const step of [0, 1, -1, 2, -2]) {
    const mp = Math.round(exact * 1000 + step) / 1000;
    if (mp <= 0) continue;
    const [cw, ch] = canvasSize(aspect, mp, null);
    if (cw === w && ch === h) return { aspect, megapixels: mp };
  }
  return null;
}

export function createRunPage(host) {
  const root = host.container;
  let open = false;                    // the advanced part, across re-renders
  let own = false;                     // the boxes of a size of one's own are showing

  /** A preset in a line a person can read: size for this clip, steps, model. */
  function brief(params, doc, info) {
    const [w, h] = canvasSize(doc.clip.aspect, params.megapixels, info);
    return `${w}×${h} · ${t("run.stepsN", params.steps)} · ${t(`run.model.${params.model}`)}`;
  }

  /** Two boxes and a button: a width and a height of one's own. What would really be used
   *  is said while typing; a size that cannot be used is said in red and cannot be applied. */
  function ownSizeRow(cw, ch, set) {
    const box = el("div", "gd-ownsize");
    const line = el("div", "gd-inline");
    const field = (value) => {
      const i = el("input");
      i.type = "number"; i.step = "1"; i.min = "1";
      i.value = String(value);
      return i;
    };
    const w = field(cw), h = field(ch);
    const go = btn(t("run.sizeApply"), () => apply());
    const say = el("div", "gd-hint gd-ownsize-say");
    const read = () => ownSize(w.value.trim() === "" ? NaN : Number(w.value), h.value.trim() === "" ? NaN : Number(h.value));
    const paint = () => {
      const r = read();
      go.disabled = !r.ok || (r.w === cw && r.h === ch);
      say.classList.toggle("gd-bad", !r.ok);
      say.textContent = !r.ok ? t(r.why === "range" ? "run.sizeBadRange" : "run.sizeBadEmpty", SIDE_MIN, SIDE_MAX)
        : r.moved ? t("run.sizeMoved", r.w, r.h) : t("run.sizeOwnHint");
    };
    function apply() {
      const r = read();
      if (!r.ok) { paint(); return; }
      const as = sizeAsRatioAndBudget(r.w, r.h);
      if (!as) { say.classList.add("gd-bad"); say.textContent = t("run.sizeBadRange", SIDE_MIN, SIDE_MAX); return; }
      own = false;
      if (host.doc().clip.aspect !== as.aspect) host.patchDoc((x) => { x.clip.aspect = as.aspect; }, t("h.aspect"));
      set({ megapixels: as.megapixels });
    }
    for (const i of [w, h]) {
      i.addEventListener("input", paint);
      // Enter in a field of the panel arrives as this event (see onKey in gd_modal.js)
      i.addEventListener("gd-key", (e) => { if (e.detail.key === "Enter" && !e.detail.isComposing) apply(); });
    }
    line.append(el("span", "gd-hint", t("run.sizeW")), w, el("span", "gd-hint", "×"),
      el("span", "gd-hint", t("run.sizeH")), h, el("span", "gd-hint", "px"), go);
    box.append(line, say);
    paint();
    return box;
  }

  function render() {
    const store = host.presets();
    const active = store.presets.find((p) => p.id === store.active) || store.presets[0];
    const doc = host.doc();
    const frames = doc.derived.frame_count;
    const info = host.sourceSize ? host.sourceSize() : null;
    const secs = (frames / FPS).toFixed(2);
    root.replaceChildren();

    const split = el("div", "gd-run-split");
    const left = el("div", "gd-run-list");
    const right = el("div", "gd-run-params");
    split.append(left, right);
    root.appendChild(split);

    // ---------------------------------------------------------------- preset list
    const lhead = el("div", "gd-run-list-head");
    lhead.appendChild(tip(el("h3", null, t("run.presets")), t("run.nodeHint")));
    left.appendChild(lhead);

    for (const p of store.presets) {
      const item = el("div", "gd-preset" + (p.id === store.active ? " active" : ""));
      const nameRow = el("div", "gd-preset-name");
      nameRow.appendChild(el("span", null, p.name));
      if (p.id === store.active) nameRow.appendChild(el("span", "gd-badge-ok", t("run.active")));
      item.appendChild(nameRow);
      const line = el("div", "gd-preset-params", brief(p.params, doc, info));
      tip(line, paramSummary(p.params));
      item.appendChild(line);
      const tm = timingFor(p, frames);
      item.appendChild(el("div", "gd-preset-time", tm.count
        ? t("run.historyOf", tm.count, fmtSeconds(tm.last_seconds), fmtSeconds(tm.avg_seconds))
        : t("run.noHistory")));
      item.onclick = () => host.selectPreset(p.id);
      left.appendChild(item);
    }

    left.appendChild(row(
      btn(t("run.add"), () => host.addPreset()),
      btn(t("run.duplicate"), () => host.duplicatePreset(active.id), "gd-btn gd-ghost"),
    ));

    // ---------------------------------------------------------------- the preset in force
    if (!active) return;
    const p = active.params;
    const set = (patch) => host.patchPresetParams(active.id, patch);
    const [cw, ch] = canvasSize(doc.clip.aspect, p.megapixels, info);
    const aspect = doc.clip.aspect === "source" ? t("edit.aspectSource") : doc.clip.aspect;

    const meta = section(null);
    const nameField = el("input");
    nameField.type = "text";
    nameField.value = active.name;
    nameField.addEventListener("change", () => host.renamePreset(active.id, nameField.value));
    meta.appendChild(labeled(t("run.name"), nameField));
    const noteField = el("textarea");
    // A built-in preset's note is data saved into the workflow, in English. While it is
    // still the one the preset came with, it is shown in the interface language; what is
    // typed here is kept as typed.
    const cameWith = BUILTIN_PRESETS.find((p) => p.note === active.note);
    noteField.value = cameWith ? t(`run.note.${cameWith.id}`) : active.note;
    noteField.rows = 2;
    noteField.addEventListener("change", () => host.patchPreset(active.id, { note: noteField.value }));
    meta.appendChild(labeled(t("run.note"), noteField));
    meta.appendChild(row(
      store.presets.length > 1
        ? btn(t("run.delete"), () => {
          if (window.confirm(t("run.deleteConfirm") + `\n\n${active.name}`)) {
            host.deletePreset(active.id);
          }
        }, "gd-btn gd-ghost")
        : null,
    ));
    right.appendChild(meta);

    // ---------------------------------------------------------------- the picture
    const s1 = section(t("run.picture"));
    const facts = el("div", "gd-facts");
    // a reading under each number; where it comes from and where it is set is the tooltip
    const fact = (label, value, note, hint) => {
      const box = el("div", "gd-fact");
      box.appendChild(el("span", "gd-fact-lbl", label));
      box.appendChild(el("strong", null, value));
      if (note) box.appendChild(el("span", "gd-hint", note));
      facts.appendChild(tip(box, hint));
    };
    fact(t("run.size"), `${cw} × ${ch}`, t("run.sizeNote", aspect), t("run.sizeTip"));
    fact(t("run.fps"), t("run.fpsValue", FPS), t("run.fpsNote"), t("run.fpsTip"));
    fact(t("run.length"), t("run.lengthValue", secs), t("run.lengthNote", frames), t("run.lengthTip"));
    const tm0 = timingFor(active, frames);
    fact(t("run.time"), tm0.count ? fmtSeconds(tm0.avg_seconds) : "—",
      tm0.count ? t("run.timeNote", tm0.count, fmtSeconds(tm0.last_seconds)) : t("run.timeNone"),
      t("run.timeTip"));
    s1.appendChild(facts);

    // (one of the sizes on offer, exactly: the list selects by value, and a size typed
    // in that comes out near one of them, 864 x 480 at 0.396 MP say, is a size of its own)
    const known = SIZES.find(([mp]) => Math.abs(mp - p.megapixels) < 1e-9);
    const sizes = SIZES.map(([mp, key]) => {
      const [w, h] = canvasSize(doc.clip.aspect, mp, info);
      return [mp, `${w} × ${h}　${t(`run.size.${key}`)}`];
    });
    if (!known) sizes.push([p.megapixels, `${cw} × ${ch}　${t("run.sizeCustom")}`]);
    sizes.push([OWN, t("run.sizeOwn")]);
    const sizeBox = el("div", "gd-vfld");
    sizeBox.appendChild(select(sizes, own ? OWN : p.megapixels, (v) => {
      if (v === OWN) { own = true; render(); return; }
      own = false;
      set({ megapixels: Number(v) });
    }));
    if (own || !known) sizeBox.appendChild(ownSizeRow(cw, ch, set));
    s1.appendChild(labeled(t("run.size"), sizeBox, t("run.sizeHint", aspect)));
    s1.appendChild(labeled(t("run.steps"), number(p.steps, (v) => set({ steps: v }),
      { min: 1, max: 200 }), t("run.stepsHint")));
    const wired = host.turboWired ? host.turboWired() : true;
    const modelRow = labeled(t("run.model"), select(MODELS.map((m) => [m, t(`run.model.${m}`)]), p.model,
      (v) => set({ model: v })), t("run.modelHint"));
    // something that would stop the run is said on the page, not in a tooltip
    if (p.model === "turbo" && !wired) modelRow.appendChild(el("span", "gd-hint gd-hint-bad", t("run.turboMissing")));
    s1.appendChild(modelRow);
    s1.appendChild(labeled(t("run.takesCount"), number(active.takes,
      (v) => host.patchPreset(active.id, { takes: v }), { min: 1, max: 12 }),
      t("run.takesHint")));
    right.appendChild(s1);

    // ---------------------------------------------------------------- reference material
    // Only the reference model reads these, and they cost time rather than change the size
    // of the result: a group of their own.
    const s2 = section(t("run.refs"), t("run.refsHint"));
    s2.appendChild(labeled(t("run.refVideo"), select(
      REF_VIDEO_EDGES.map((e) => [e, e ? t("run.refEdgePx", e) : t("run.refEdgeNative")]), p.ref_video_edge,
      (v) => set({ ref_video_edge: Number(v) })), t("run.refEdgeHint")));
    s2.appendChild(labeled(t("run.refImage"), select(
      REF_IMAGE_SIZES.map((v) => [v, t(`run.refImage.${v}`)]), p.ref_image_size,
      (v) => set({ ref_image_size: v })), t("run.refImageHint")));
    right.appendChild(s2);

    // ---------------------------------------------------------------- advanced
    const s3 = section(null);
    const adv = el("details", "gd-fold");
    adv.open = open;
    adv.addEventListener("toggle", () => { open = adv.open; });
    adv.appendChild(el("summary", null, t("run.advanced")));
    // a sampler or a schedule wired into the node wins over what is set here: say so
    const ext = host.externalWired ? host.externalWired() : {};
    if (ext.sigmas) adv.appendChild(el("div", "gd-note", t("run.sigmasWired")));
    if (ext.sampler) adv.appendChild(el("div", "gd-note", t("run.samplerWired")));
    adv.appendChild(labeled(t("run.megapixels"), number(p.megapixels, (v) => set({ megapixels: v }),
      { min: 0.05, max: 4, step: 0.05 }), t("run.megapixelsHint", cw, ch)));
    adv.appendChild(labeled(t("run.cfg"), number(p.cfg, (v) => set({ cfg: v }),
      { min: 0, max: 30, step: 0.5 }), t("run.cfgHint")));
    adv.appendChild(labeled(t("run.sampler"), select(SAMPLERS, p.sampler_name,
      (v) => set({ sampler_name: v })), t("run.samplerHint")));
    adv.appendChild(labeled(t("run.scheduler"), select(SCHEDULERS, p.scheduler,
      (v) => set({ scheduler: v }))));
    adv.appendChild(labeled(t("run.shiftVideo"), number(p.shift_video, (v) => set({ shift_video: v }),
      { min: 0.01, max: 100, step: 0.5 }), t("run.shiftVideoHint", noisePercent(0.5, p.shift_video))));
    adv.appendChild(labeled(t("run.shiftAudio"), number(p.shift_audio, (v) => set({ shift_audio: v }),
      { min: 0.01, max: 100, step: 0.5 }), t("run.shiftAudioHint")));
    adv.appendChild(labeled(t("run.staging"), select(STAGING.map((v) => [v, t(`run.staging.${v}`)]), p.vram_staging,
      (v) => set({ vram_staging: v })), t("run.stagingHint")));
    s3.appendChild(adv);
    right.appendChild(s3);

    // ---------------------------------------------------------------- memory
    // Resident models are the reason the card reads 90-something percent while nothing is
    // running. Showing the number next to the button is the point: without it you cannot
    // tell whether pressing it did anything.
    const s4 = section(t("run.perf"));
    const vram = el("div", "gd-vram");
    const read = el("span", "gd-hint", t("run.vramReading"));
    const gb = (n) => `${(n / 1024 ** 3).toFixed(1)}G`;
    const paint = async () => {
      if (!host.vramStats) { read.textContent = ""; return; }
      try {
        const v = await host.vramStats();
        if (!v) { read.textContent = t("run.vramUnknown"); return; }
        const used = v.total - v.free;
        read.textContent = t("run.vram", gb(used), gb(v.total), Math.round(used / v.total * 100))
          + " · " + t("run.vramResident", gb(v.torchHeld));
      } catch (e) { read.textContent = t("run.vramUnknown"); }
    };
    const btn2 = btn(t("run.vramFree"), async () => {
      read.textContent = t("run.vramFreeing");
      try { await host.freeMemory(); } catch (e) { /* shown by the reading below */ }
      setTimeout(paint, 1200);          // the driver's counters lag by a second or two
    }, "gd-btn gd-ghost");
    tip(btn2, t("run.vramFreeHint"));
    vram.append(read, btn2);
    s4.appendChild(vram);
    paint();
    right.appendChild(s4);

    // ---------------------------------------------------------------- how long it took
    const s5 = section(t("run.history"));
    const h = active.history;
    const tm = timingFor(active, frames);
    const stat = el("div", "gd-run-stats");
    stat.appendChild(el("span", null, t("run.forThisLength", secs, frames)));
    stat.appendChild(el("span", null, `${t("run.runCount")} ${tm.count}`));
    stat.appendChild(el("span", null, `${t("run.lastRun")} ${fmtSeconds(tm.last_seconds)}`));
    stat.appendChild(el("span", null, `${t("run.avgRun")} ${fmtSeconds(tm.avg_seconds)}`));
    s5.appendChild(stat);

    s5.appendChild(labeled(t("run.autoReset"), checkbox(store.settings.auto_reset_on_change,
      (v) => host.patchSettings({ auto_reset_on_change: v })), t("run.autoResetHint")));

    if (h.runs.length) {
      const table = el("div", "gd-runs");
      table.appendChild(el("div", "gd-runs-head", t("run.historyTable")));
      for (const r of [...h.runs].reverse()) {
        const line = el("div", "gd-run-row");
        line.appendChild(el("span", "gd-run-when", new Date(r.at).toLocaleString()));
        line.appendChild(el("span", "gd-run-secs", fmtSeconds(r.seconds)));
        line.appendChild(el("span", "gd-run-sum", (r.frames ? `${r.frames}f · ` : "") + (r.summary || "")));
        table.appendChild(line);
      }
      s5.appendChild(table);
    } else {
      s5.appendChild(el("div", "gd-hint", t("run.noHistory")));
    }

    s5.appendChild(row(
      btn(t("run.clearThis"), () => host.clearHistory(active.id), "gd-btn gd-ghost"),
      btn(t("run.clearAll"), () => {
        if (window.confirm(t("run.clearAllConfirm"))) host.clearHistory(null);
      }, "gd-btn gd-ghost"),
    ));
    right.appendChild(s5);
  }

  return { render };
}
