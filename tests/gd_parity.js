// Gacha Director — JS/Python parity check for the four document mirrors.
//
// gd_doc.js, gd_presets_doc.js, gd_post_doc.js and gd_takes_doc.js re-implement the pure
// Python modules so the panel can show derived values without a round trip. Two
// implementations of one rule drift silently, so the Python side writes its answers to
// tests/_parity_fixtures.json and this file checks the JS side against them, case by case.
//
//   python tests/make_parity_fixtures.py                        # write the answers
//   node --experimental-default-type=module tests/parity.mjs    # check them
//
// It lives in tests/ and not in web/ so the browser is never served test code; the
// mirrors themselves touch no DOM at import time, which is why they load under Node.

import * as D from "../web/gd_doc.js";
import * as O from "../web/gd_post_doc.js";
import * as P from "../web/gd_presets_doc.js";
import * as T from "../web/gd_takes_doc.js";

// section -> fixture function name -> the JS call that has to give the same answer.
// Grid cases carry a clip length where the function takes a grid object.
const CALLS = {
  doc: {
    empty: () => D.emptyDoc(),
    normalize: (doc) => D.normalize(doc),
    resolved_frame: (anchor, frameCount) => D.resolvedFrame(anchor, frameCount),
    latent_source: (doc) => D.latentSource(doc),
    reference_source: (doc) => D.referenceSource(doc),
    clean_name: (value) => D.cleanName(value),
    file_stem: (value) => D.fileStem(value),
  },
  problems: {
    problems: (doc) => ({ text: D.problems(doc), coded: D.problemsCoded(doc) }),
  },
  canvas: {
    canvas_size: (aspect, megapixels, source) => D.canvasSize(aspect, megapixels, source),
  },
  grid: {
    make_grid: (length) => D.makeGrid(length),
    align_frame_count: (n) => D.alignFrameCount(n),
    parse_cells: (spec, length) => D.parseCells(spec, D.makeGrid(length)),
    seam_cells: (cuts, length, radius) => D.seamCells(cuts, D.makeGrid(length), radius),
    guide_clip_length: (frames) => D.guideClipLength(frames),
    latent_bounds: (frames) => D.latentBounds(frames),
    cells_latents: (cells, total) => D.cellsLatents(cells, total),
    cell_of_latent: (t, total) => D.cellOfLatent(t, total),
    seam_latents: (frame, length, before, after) => D.seamLatents(frame, D.makeGrid(length), before, after),
    seam_auto: (frame, length) => D.seamAuto(frame, D.makeGrid(length)),
  },
  presets: {
    empty: () => P.emptyPresets(),
    empty_history: () => P.emptyHistory(),
    normalize: (store) => P.normalizePresets(store),
    normalize_params: (params) => P.normalizeParams(params),
    params_signature: (params) => P.paramsSignature(params),
    param_summary: (params) => P.paramSummary(params),
    active_preset: (store) => P.activePreset(store),
    active_params: (store) => P.activeParams(store),
    timing_for: (preset, frames) => P.timingFor(preset, frames),
    record_run: (store, id, seconds, summary, atMs, frames) =>
      P.recordRun(store, id, seconds, summary, atMs, frames),
    clear_history: (store, id) => P.clearHistory(store, id),
  },
  post: {
    empty: () => O.DEFAULT_POST,
    normalize: (cfg) => O.normalizePost(cfg),
  },
  takes: {
    empty: () => T.emptyTakes(),
    normalize: (store) => T.normalizeTakes(store),
    finished: (store) => T.finishedTakes(store),
    segment_status: (store, segment) => T.segmentStatus(store, segment),
    all_picked: (store, segmentCount) => T.allPicked(store, segmentCount),
    splice_plan: (store, shots) => T.splicePlan(store, shots),
    single_take: (plan) => T.singleTake(plan),
    cut_frames: (plan) => T.cutFrames(plan),
    seam_frames: (plan) => T.seamFrames(plan),
    hard_cuts: (plan) => T.hardCuts(plan),
    plan_key: (plan) => T.planKey(plan),
    layout_key: (shots) => T.layoutKey(shots),
    add_take: (store, fields) => T.addTake(store, fields),
    update_take: (store, id, fields) => T.updateTake(store, id, fields),
    remove_take: (store, id) => T.removeTake(store, id),
    pick: (store, segment, id) => T.pickTake(store, segment, id),
    pick_all: (store, segmentCount, id) => T.pickAll(store, segmentCount, id),
    summary: (store, segmentCount) => T.takesSummary(store, segmentCount),
  },
};

const VERSIONS = {
  schema: D.SCHEMA_VERSION, presets: P.PRESETS_VERSION, post: O.POST_VERSION, takes: T.TAKES_VERSION,
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const show = (v) => {
  const text = JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
};
// What a value looks like once it has crossed to Python and back.
const wire = (v) => {
  const text = JSON.stringify(v);
  return text === undefined ? null : JSON.parse(text);
};

/** Append one line per difference between a JS value and Python's to `out`.
 *
 *  Key order is ignored, list order is not. Numbers are compared exactly: the mirrors
 *  are written to produce the same doubles, so a tolerance would only hide a rounding
 *  rule that differs. */
export function diffValues(js, py, path, out, limit = 12) {
  if (out.length >= limit) return out;
  if (Array.isArray(js) && Array.isArray(py)) {
    if (js.length !== py.length) {
      out.push(`${path}: length js ${js.length} != py ${py.length} (js ${show(js)}, py ${show(py)})`);
      return out;
    }
    js.forEach((item, i) => diffValues(item, py[i], `${path}[${i}]`, out, limit));
    return out;
  }
  if (isObject(js) && isObject(py)) {
    for (const k of [...new Set([...Object.keys(js), ...Object.keys(py)])].sort()) {
      if (!own(js, k)) out.push(`${path}.${k}: missing in js (py ${show(py[k])})`);
      else if (!own(py, k)) out.push(`${path}.${k}: only in js (${show(js[k])})`);
      else diffValues(js[k], py[k], `${path}.${k}`, out, limit);
    }
    return out;
  }
  if (js !== py) out.push(`${path}: js ${show(js)} != py ${show(py)}`);
  return out;
}

function checkCase(call, c) {
  if (!call) return [`no JS counterpart for "${c.fn}"`];
  const out = [];
  const args = wire(c.in);
  let got, threw = null;
  try {
    got = wire(call(...args));
  } catch (err) {
    threw = err;
  }
  if (JSON.stringify(args) !== JSON.stringify(c.in)) out.push("the call modified its arguments");
  if (c.error) {
    if (!threw) out.push(`python raised ${c.raised}, js returned ${show(got)}`);
    return out;
  }
  if (threw) return [...out, `python returned ${show(c.out)}, js threw ${threw}`];
  diffValues(got, c.out, "out", out);
  if (c.stable || "again" in c) {
    // A second pass over the JS result has to land where Python's second pass does. That
    // is usually the same value; where Python itself moves, the fixture says where to.
    try {
      diffValues(wire(call(got)), c.stable ? c.out : c.again, "again", out);
    } catch (err) {
      out.push(`again: js threw ${err}`);
    }
  }
  return out;
}

/** Run every fixture case. `data` is the parsed _parity_fixtures.json.
 *  Returns { total, failed, sections: { name: { total, failed } }, diffs }. */
export function checkFixtures(data) {
  const sections = {}, diffs = [];
  let total = 0, failed = 0;
  const report = (section, index, fn, input, messages) => {
    total++;
    sections[section].total++;
    if (!messages.length) return;
    failed++;
    sections[section].failed++;
    diffs.push({ section, index, fn, in: input, messages });
  };

  // answers written for another version of a module prove nothing about this one
  sections.versions = { total: 0, failed: 0 };
  for (const [name, version] of Object.entries(VERSIONS)) {
    const theirs = (data.versions || {})[name];
    report("versions", name, name, [], theirs === version ? []
      : [`fixtures are for version ${show(theirs)}, this mirror is version ${version}`]);
  }
  for (const [section, calls] of Object.entries(CALLS)) {
    sections[section] = { total: 0, failed: 0 };
    (data[section] || []).forEach((c, i) => report(section, i, c.fn, c.in, checkCase(calls[c.fn], c)));
  }
  return { total, failed, sections, diffs };
}
