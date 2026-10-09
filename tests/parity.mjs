// Parity check: the JS document mirrors in web/ against the answers Python wrote.
//
//   python tests/make_parity_fixtures.py
//   node --experimental-default-type=module tests/parity.mjs [fixtures.json]
//
// The flag is there because web/*.js are ES modules served to a browser, with no
// package.json to tell Node so (Node 20 and 21 need it; 22.7 and later detect the syntax
// on their own and accept the flag too). Prints the number of cases per section, every
// difference found, and exits non-zero if there is one.
//
// Besides the fixtures it checks two things Python has no say in: that every name the
// pages import is still exported, and the few behaviours that exist on the JS side only.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let parity, D, P, O, T;
try {
  [parity, D, P, O, T] = await Promise.all([
    import("./gd_parity.js"),
    ...["gd_doc", "gd_presets_doc", "gd_post_doc", "gd_takes_doc"]
      .map((name) => import(`../web/${name}.js`))]);
} catch (err) {
  if (!/outside a module|Unexpected token 'export'/.test(String(err && err.message))) throw err;
  console.error("web/*.js were loaded as CommonJS. Run:\n"
    + "  node --experimental-default-type=module tests/parity.mjs");
  process.exit(2);
}

const path = process.argv[2] || fileURLToPath(new URL("./_parity_fixtures.json", import.meta.url));
const result = parity.checkFixtures(JSON.parse(await readFile(path, "utf8")));

function check(section, name, messages) {
  const tally = result.sections[section] || (result.sections[section] = { total: 0, failed: 0 });
  result.total++;
  tally.total++;
  if (!messages.length) return;
  result.failed++;
  tally.failed++;
  result.diffs.push({ section, index: name, fn: "", in: [], messages });
}

// --- the names other modules import. A rename breaks a page at load time, where nothing
// reports it, so the list is held here.
const EXPORTS = [
  [D, "gd_doc.js", "value", `SHORT_CELL CELL FPS MIN_SHOT SCHEMA_VERSION FAMILIES MASK_MODES
    PROMPT_MODES RETENTIONS AUDIO_RETENTIONS SUBJECT_KINDS SOURCE_ROLES ANCHOR_KINDS
    PICTURE_ROLES MAX_REF_IMAGES MAX_REF_VIDEOS MAX_REF_AUDIO NATIVE_MEGAPIXELS SEAM_MOST DEFAULT_SEAM`],
  [D, "gd_doc.js", "function", `emptyDoc normalize problems problemsCoded resolvedFrame latentSource
    referenceSource makeGrid parseCells seamCells guideClipLength canvasSize alignFrameCount
    latentBounds cellsLatents cellOfLatent seamLatents seamAuto`],
  [P, "gd_presets_doc.js", "value", `PRESETS_VERSION PARAM_KEYS SAMPLERS SCHEDULERS STAGING MODELS
    REF_IMAGE_SIZES REF_VIDEO_EDGES MAX_RUNS DEFAULT_TAKES MAX_TAKES_PER_BATCH DEFAULT_PARAMS
    BUILTIN_PRESETS`],
  [P, "gd_presets_doc.js", "function", `emptyHistory emptyPresets normalizeParams paramsSignature
    normalizePresets activePreset activeParams timingFor recordRun clearHistory paramSummary
    fmtSeconds`],
  [O, "gd_post_doc.js", "value", "POST_VERSION SAVE_FORMATS SAVE_CODECS DEFAULT_POST"],
  [O, "gd_post_doc.js", "function", "normalizePost"],
  [T, "gd_takes_doc.js", "value", "TAKES_VERSION STATUSES MAX_TAKES"],
  [T, "gd_takes_doc.js", "function", `emptyTakes normalizeTakes finishedTakes segmentStatus
    allPicked splicePlan singleTake cutFrames addTake updateTake removeTake pickTake pickAll
    takesSummary`],
];
for (const [mod, file, kind, names] of EXPORTS) {
  for (const name of names.split(/\s+/)) {
    const found = typeof mod[name];
    const ok = kind === "function" ? found === "function" : found !== "undefined" && found !== "function";
    check("exports", `${file} ${name}`, ok ? [] : [`expected a ${kind}, found ${found}`]);
  }
}

// --- behaviour with no Python counterpart
const same = (name, got, want) =>
  check("js-only", name, parity.diffValues(JSON.parse(JSON.stringify(got)), want, name, []));

same("fmtSeconds",
  [P.fmtSeconds(0), P.fmtSeconds("x"), P.fmtSeconds(42), P.fmtSeconds(59.6), P.fmtSeconds(185),
   P.fmtSeconds(185, (m, ss) => `${m}:${ss}`)],
  ["-", "-", "42s", "1m 00s", "3m 05s", "3:05"]);
// what JSON would not carry is read the way Python will read it: undefined is an absent
// key, NaN and Infinity are null
same("undefined is an absent key",
  D.normalize({ clip: { length: undefined }, anchors: [{ file: "a.png", pin: undefined }] }),
  JSON.parse(JSON.stringify(D.normalize({ clip: {}, anchors: [{ file: "a.png" }] }))));
same("NaN and Infinity are null",
  D.normalize({ source: { denoise: NaN, start: Infinity }, view: { zoom: -Infinity } }),
  JSON.parse(JSON.stringify(D.normalize({ source: { denoise: null, start: null }, view: { zoom: null } }))));
same("normalizeParams(undefined)", P.normalizeParams(undefined), { ...P.DEFAULT_PARAMS });
same("addTake stamps the time itself",
  (() => {
    const before = Date.now();
    const t = T.addTake(T.emptyTakes(), { seed: 7, prompt_id: "p" }).takes[0];
    return [t.at >= before && t.at <= Date.now(), t.id === `t${t.at.toString(16)}00`, t.seed, t.status];
  })(),
  [true, true, 7, "queued"]);
same("recordRun stamps the time itself",
  (() => {
    const before = Date.now();
    const run = P.activePreset(P.recordRun({}, "standard", 12.345)).history.runs[0];
    return [run.at >= before && run.at <= Date.now(), run.seconds, run.frames, run.summary];
  })(),
  [true, 12.35, 0, ""]);
same("takesCounts",
  T.takesCounts({ takes: [{ id: "a", status: "done", file: "a.mp4" }, { id: "b" }],
                  picks: { 0: "a", 2: "a" }, composite: { status: "running" } }, 3),
  { done: 1, total: 2, picked: 2, segments: 3, composite: { status: "running", file: "" } });

// every problem the document can report has its sentence in the panel's three languages
{
  const { t, setLang } = await import("../web/gd_i18n.js");
  const unworded = [];
  for (const lang of ["ja", "zh", "en"]) {
    setLang(lang);
    for (const code of D.PROBLEM_CODES) {
      if (t(`problem.${code}`) === `problem.${code}`) unworded.push(`${lang}:${code}`);
    }
  }
  same("every problem code is worded in gd_i18n.js", unworded, []);
}

const SHOWN = 25;
for (const d of result.diffs.slice(0, SHOWN)) {
  const input = JSON.stringify(d.in);
  const call = d.fn ? ` ${d.fn}(${input.length > 400 ? `${input.slice(0, 400)}...` : input})` : "";
  console.log(`\n${d.section}[${d.index}]${call}`);
  for (const line of d.messages) console.log(`    ${line}`);
}
if (result.diffs.length > SHOWN) console.log(`\n... and ${result.diffs.length - SHOWN} more failing cases`);
if (result.diffs.length) console.log("");

for (const [name, tally] of Object.entries(result.sections)) {
  const failed = tally.failed ? `   ${tally.failed} FAILED` : "";
  console.log(`${name.padEnd(9)}${String(tally.total).padStart(7)} cases${failed}`);
}
console.log(`${result.total} cases, ${result.failed} failed`);
process.exit(result.failed ? 1 : 0);
