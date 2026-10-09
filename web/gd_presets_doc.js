// Gacha Director — JS mirror of gd_presets.py: run presets and their timing history.
//
// A preset is one named answer to "how much am I willing to spend on this run". It
// describes cost, not content: a megapixel budget rather than a width and a height (the
// aspect ratio belongs to the clip), a cap on the short edge of reference videos (their
// tokens ride through every sampling step), and which model input to use. The seed and
// the denoise are not here; they belong to the run and to the source clip.
//
// The store is written by the panel and read by the node, so both sides must agree on
// its shape, on every clamp, and on the signature string that ties a timing to the
// parameters it was measured with. tests/parity.mjs holds this file to the Python side.
// The built-in names and notes are data saved into the workflow, not interface text.

import {
  isDict, jsonCopy, pyDict, pyFloat, pyInt, pyIter, pyMax, pyMin, pyOr, pyRound, pyStr,
  pyText, requireInt, truthy,
} from "./gd_doc.js";

export const PRESETS_VERSION = 2;

// What a preset carries. Anything not here is content (the document) or per-run (seed).
export const PARAM_KEYS = ["megapixels", "steps", "cfg", "sampler_name", "scheduler",
                           "shift_video", "shift_audio", "model", "ref_video_edge",
                           "ref_image_size", "vram_staging"];

export const SAMPLERS = ["res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_sde",
                         "heun", "ddim", "uni_pc", "lcm"];
export const SCHEDULERS = ["simple", "normal", "karras", "beta", "linear_quadratic",
                           "sgm_uniform"];
export const STAGING = ["off", "auto", "on"];
export const MODELS = ["main", "turbo"];
export const REF_IMAGE_SIZES = ["match", "max"];
// 0 keeps the model's own bound (768 px short edge).
export const REF_VIDEO_EDGES = [0, 768, 640, 512, 384, 256];

// Keep the run log bounded so the workflow file does not grow without limit.
export const MAX_RUNS = 50;

// The official templates' own settings: res_multistep / simple, 20 steps, no CFG, and
// the model's default shifts.
export const DEFAULT_PARAMS = {
  megapixels: 0.4, steps: 20, cfg: 1.0,
  sampler_name: "res_multistep", scheduler: "simple",
  shift_video: 12.0, shift_audio: 3.0,
  model: "main", ref_video_edge: 0, ref_image_size: "match",
  vram_staging: "off",
};

// How many candidates a "generate" from the takes page queues. It sits beside `params`:
// it is not a property of one render, so it must not enter the timing signature.
export const DEFAULT_TAKES = 2;
export const MAX_TAKES_PER_BATCH = 12;

export const BUILTIN_PRESETS = [
  { id: "draft", name: "Draft",
    note: "Turbo model, 4 steps, small canvas, small reference videos. For judging "
      + "the prompt and the material, not for picking a take.",
    params: { ...DEFAULT_PARAMS, megapixels: 0.25, steps: 4, model: "turbo", ref_video_edge: 384 } },
  { id: "standard", name: "Standard",
    note: "The official template settings: 20 steps at 0.4 MP.",
    params: { ...DEFAULT_PARAMS } },
  { id: "final", name: "Final",
    note: "Native canvas (768 px short edge), 25 steps.",
    params: { ...DEFAULT_PARAMS, megapixels: 0.98, steps: 25 } },
];

const DEFAULT_SETTINGS = { auto_reset_on_change: true };

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// gd_presets clamps with min(hi, max(lo, x)) and matches choices case-sensitively: the
// argument order and the missing lower-casing both differ from the document mirror.
const clampf = (v, lo, hi, d) => {
  const f = pyFloat(v);
  return f === null ? d : pyMin(hi, pyMax(lo, f));
};
const clampi = (v, lo, hi, d) => {
  const i = pyInt(v);
  return i === null ? d : Math.min(hi, Math.max(lo, i));
};
const choice = (v, options, d) => {
  const text = pyText(v).trim();
  return options.includes(text) ? text : d;
};

// "%g" % v for the magnitudes a preset holds (below 1000, at most three decimals): six
// significant digits with trailing zeros dropped, so 12.0 reads "12" and 0.4 "0.4".
const fmtG = (v) => String(Number(v.toPrecision(6)));
// How Python prints a float inside a sentence: a whole number keeps its ".0".
const floatRepr = (v) => (Number.isInteger(v) ? `${v}.0` : pyStr(v));

// The longest timing kept. A value clamped to it is the one timing Python holds as an
// int rather than a float, which matters to the sum below.
const MAX_SECONDS = 1e7;

// sum() the way CPython 3.12 and later add floats: with Neumaier compensation, so the
// total is the correctly rounded one far more often than a plain running sum. The average
// is rounded to two decimals right after, and a plain sum can land on the other side of
// that rounding. Ints are added without compensation, and so is the first float.
function pySum(values) {
  const isInt = (x) => x === MAX_SECONDS;
  let i = 0, total = 0, lost = 0;
  while (i < values.length && isInt(values[i])) total += values[i++];
  if (i < values.length) total += values[i++];
  for (; i < values.length; i++) {
    const x = values[i], next = total + x;
    if (!isInt(x)) lost += Math.abs(total) >= Math.abs(x) ? (total - next) + x : (x - next) + total;
    total = next;
  }
  return lost && Number.isFinite(lost) ? total + lost : total;
}
const average = (runs) => pyRound(pySum(runs.map((r) => r.seconds)) / runs.length, 2);

export function emptyHistory() {
  return { runs: [], count: 0, last_seconds: 0.0, last_at: 0, avg_seconds: 0.0, signature: "" };
}

const builtinPresets = () => jsonCopy(BUILTIN_PRESETS)
  .map((p) => ({ ...p, takes: DEFAULT_TAKES, history: emptyHistory() }));

export function emptyPresets() {
  return {
    version: PRESETS_VERSION,
    active: "standard",
    presets: builtinPresets(),
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function normalizeParams(params) {
  const src = pyDict(jsonCopy(params));
  // v1 presets held a width and a height; the area is what they cost
  if (!own(src, "megapixels") && truthy(src.width) && truthy(src.height)) {
    const w = pyFloat(src.width), h = pyFloat(src.height);
    if (w !== null && h !== null) src.megapixels = w * h / (1024 * 1024);
  }
  const p = { ...DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(src)) if (own(DEFAULT_PARAMS, k)) p[k] = v;
  p.megapixels = pyRound(clampf(p.megapixels, 0.03, 4.0, 0.4), 3);
  p.steps = clampi(p.steps, 1, 200, 20);
  p.cfg = pyRound(clampf(p.cfg, 0.0, 30.0, 1.0), 3);
  p.sampler_name = choice(p.sampler_name, SAMPLERS, "res_multistep");
  p.scheduler = choice(p.scheduler, SCHEDULERS, "simple");
  p.shift_video = pyRound(clampf(p.shift_video, 0.01, 100.0, 12.0), 3);
  p.shift_audio = pyRound(clampf(p.shift_audio, 0.01, 100.0, 3.0), 3);
  p.model = choice(p.model, MODELS, "main");
  // an edge that is not on the list snaps to the nearest one; a tie goes to the larger
  const edge = clampi(p.ref_video_edge, 0, 768, 0);
  p.ref_video_edge = REF_VIDEO_EDGES.includes(edge) ? edge : REF_VIDEO_EDGES.filter(Boolean)
    .reduce((best, e) => (Math.abs(e - edge) < Math.abs(best - edge) ? e : best));
  p.ref_image_size = choice(p.ref_image_size, REF_IMAGE_SIZES, "match");
  p.vram_staging = choice(p.vram_staging, STAGING, "off");
  return p;
}

/** The parameters a timing belongs to, as one stable string.
 *
 *  Written here and compared in Python, so both sides have to spell it identically:
 *  `key=value` pairs in PARAM_KEYS order joined by `;`, numbers in their shortest form
 *  (12.0 -> "12", 0.4 -> "0.4"). */
export function paramsSignature(params) {
  const p = normalizeParams(params);
  return PARAM_KEYS.map((k) => `${k}=${typeof p[k] === "number" ? fmtG(p[k]) : p[k]}`).join(";");
}

function normalizeHistory(hist, signature, autoReset) {
  const h = emptyHistory();
  const src = isDict(hist) ? hist : {};
  let runs = [];
  for (const r of pyIter(pyOr(src.runs, []))) {
    if (!isDict(r)) continue;
    const secs = clampf(r.seconds, 0.0, MAX_SECONDS, 0.0);
    if (secs <= 0) continue;
    runs.push({
      at: clampi(r.at, 0, 1e13, 0),
      seconds: secs,
      frames: clampi(r.frames, 0, 1e5, 0),
      signature: pyText(r.signature),
      summary: pyText(r.summary),
    });
  }
  runs.sort((a, b) => a.at - b.at);
  // A timing measured with different parameters does not describe this preset any more.
  if (autoReset && signature) runs = runs.filter((r) => !r.signature || r.signature === signature);
  runs = runs.slice(-MAX_RUNS);
  h.runs = runs;
  h.count = runs.length;
  if (runs.length) {
    h.last_seconds = runs[runs.length - 1].seconds;
    h.last_at = runs[runs.length - 1].at;
    h.avg_seconds = average(runs);
  }
  h.signature = signature;
  return h;
}

// The store as JSON would carry it -> complete and clamped. Works on a private copy.
function norm(src) {
  const out = { version: PRESETS_VERSION };

  const given = pyOr(src.settings, {});
  if (!isDict(given)) throw new TypeError("settings is not a mapping");
  const settings = { ...DEFAULT_SETTINGS, ...given };
  settings.auto_reset_on_change = truthy(settings.auto_reset_on_change);
  out.settings = settings;

  const raw = Array.isArray(src.presets) && src.presets.length ? src.presets : builtinPresets();
  const seen = new Set();
  const presets = [];
  raw.forEach((item, i) => {
    if (!isDict(item)) return;
    let pid = pyStr(pyOr(item.id, `preset${i}`)).trim() || `preset${i}`;
    while (seen.has(pid)) pid = `${pid}_2`;
    seen.add(pid);
    const params = normalizeParams(item.params);
    presets.push({
      id: pid,
      name: pyStr(pyOr(item.name, pid)),
      note: pyText(item.note),
      takes: clampi(item.takes, 1, MAX_TAKES_PER_BATCH, DEFAULT_TAKES),
      params,
      history: normalizeHistory(item.history, paramsSignature(params), settings.auto_reset_on_change),
    });
  });
  // a list with nothing usable in it falls back to the built-ins as they are
  out.presets = presets.length ? presets : builtinPresets();

  const active = pyText(src.active);
  const ids = out.presets.map((p) => p.id);
  out.active = ids.includes(active) ? active : (ids.includes("standard") ? "standard" : ids[0]);

  for (const [k, v] of Object.entries(src)) if (!own(out, k)) out[k] = v;   // unknown keys survive
  return out;
}

/** Complete, clamped. Always leaves at least one preset and a valid active id. */
export function normalizePresets(store) {
  return norm(isDict(store) ? jsonCopy(store) : {});
}

export function activePreset(store) {
  const s = normalizePresets(store);
  return s.presets.find((p) => p.id === s.active) || s.presets[0];
}

export function activeParams(store) {
  return { ...activePreset(store).params };
}

/** { count, last_seconds, avg_seconds } over the runs measured at `frames`.
 *
 *  A 5 second clip and a 15 second clip cost very different amounts under one preset, so
 *  an average over both describes neither. `frames` of 0 takes every run. */
export function timingFor(preset, frames = 0) {
  const runs = preset.history.runs.filter(
    (r) => !truthy(frames) || !truthy(r.frames) || r.frames === requireInt(frames));
  if (!runs.length) return { count: 0, last_seconds: 0.0, avg_seconds: 0.0 };
  return { count: runs.length, last_seconds: runs[runs.length - 1].seconds, avg_seconds: average(runs) };
}

/** Append one timing to a preset and return the new store. */
export function recordRun(store, presetId, seconds, summary = "", atMs = null, frames = 0) {
  const s = normalizePresets(store);
  const p = s.presets.find((x) => x.id === presetId);
  if (p) {
    const secs = pyFloat(seconds);
    if (secs === null) throw new TypeError("seconds is not a number");
    p.history.runs.push({
      at: atMs == null ? Date.now() : requireInt(atMs),
      seconds: pyRound(secs, 2),
      frames: requireInt(pyOr(frames, 0)),
      signature: paramsSignature(p.params),
      summary: pyOr(summary, ""),
    });
  }
  return norm(s);
}

/** Drop timings for one preset, or for all of them when `presetId` is null. */
export function clearHistory(store, presetId = null) {
  const s = normalizePresets(store);
  for (const p of s.presets) {
    if (presetId == null || p.id === presetId) {
      p.history = emptyHistory();
      p.history.signature = paramsSignature(p.params);
    }
  }
  return norm(s);
}

export function paramSummary(params) {
  const p = normalizeParams(params);
  return `${floatRepr(p.megapixels)}MP ${p.steps}st cfg${floatRepr(p.cfg)} `
    + `${p.sampler_name}/${p.scheduler} shift ${floatRepr(p.shift_video)}/${floatRepr(p.shift_audio)}`
    + (p.model === "turbo" ? " turbo" : "")
    + (p.ref_video_edge ? ` ref${p.ref_video_edge}` : "")
    + (p.vram_staging !== "off" ? " staging" : "");
}

/** "-" for nothing, "42s" under a minute, minutes and seconds above. This module does not
 *  translate: pass `minSec(minutes, paddedSeconds)` to word the long form differently. */
export function fmtSeconds(s, minSec = (m, ss) => `${m}m ${ss}s`) {
  const n = Math.round(Number(s) || 0);
  if (!n) return "-";
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  return minSec(m, String(n - m * 60).padStart(2, "0"));
}
