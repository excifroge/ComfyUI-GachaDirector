// Gacha Director — JS mirror of gd_schema.py (the document schema) and of the gd_grid.py
// functions it needs.
//
// The panel shows derived values (cell bounds, free cells, where an anchor lands, which
// shots a masked run re-reads) without a server round trip, so the rules exist twice. Two
// implementations of one rule drift silently and the failure is nasty: the panel says
// cells 3-4 are free while the run frees something else. tests/make_parity_fixtures.py
// writes Python's answers and tests/parity.mjs holds
// this file to them. Change one side, re-run both.
//
// Python is the source of truth even where its answer is a quirk of the language:
// int("3.7") fails while int(3.7) truncates, an empty list counts as false, round() sends
// an exact half to the even neighbour. The first section reproduces those rules once; the
// sibling mirrors (presets, takes, output settings) import them from here.

// ---------------------------------------------------------------- Python semantics
export const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A document reaches Python as JSON, so every mirror starts from a JSON copy of its
// input: a key holding undefined is absent and NaN is null, exactly as the other side
// will read them. It also leaves the caller's object untouched.
export function jsonCopy(v) {
  const text = JSON.stringify(v);
  return text === undefined ? null : JSON.parse(text);
}

// Truth as Python sees it: an empty list and an empty object are false too.
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return typeof v === "number" ? v !== 0 : !!v;
}

// `a or b`
export const pyOr = (a, b) => (truthy(a) ? a : b);

// max() and min() keep their first argument unless the second is strictly better. With
// a NaN in play that makes the order of the arguments decide the result, so every clamp
// spells the order the way its Python original does.
export const pyMax = (a, b) => (b > a ? b : a);
export const pyMin = (a, b) => (b < a ? b : a);

const DIGITS = "\\d+(?:_\\d+)*";       // Python allows 1_000 in numeric text
const INT_TEXT = new RegExp(`^\\s*[+-]?${DIGITS}\\s*$`);
const FLOAT_TEXT = new RegExp(`^[+-]?(?:${DIGITS}\\.?(?:${DIGITS})?|\\.${DIGITS})(?:e[+-]?${DIGITS})?$`);

// int(): a float truncates, text must spell a whole number, anything else fails.
// Returns null where Python raises, so a caller can fall back to its default.
export function pyInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && INT_TEXT.test(v)) return Number(v.replace(/_/g, ""));
  return null;
}

// int() where Python lets the failure propagate.
export function requireInt(v) {
  const i = pyInt(v);
  if (i === null) throw new TypeError(`not a whole number: ${pyStr(v)}`);
  return i;
}

// float(): numbers, numeric text, and the spellings Python accepts for inf and nan.
export function pyFloat(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const text = v.trim().toLowerCase();
  const named = /^([+-]?)(?:(nan)|inf(?:inity)?)$/.exec(text);
  if (named) return named[2] ? NaN : (named[1] === "-" ? -Infinity : Infinity);
  return FLOAT_TEXT.test(text) ? Number(text.replace(/_/g, "")) : null;
}

// Python switches to exponent notation below 1e-4, JS below 1e-6, and pads the exponent.
function pyNumber(n) {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (Number.isInteger(n) || Math.abs(n) >= 1e-4) return String(n);
  return n.toExponential().replace(/e-(\d)$/, "e-0$1");
}

// repr(): how a value reads inside a printed list or dict. Text gets Python's choice of
// quotes and its escapes.
function pyRepr(v) {
  if (typeof v !== "string") return pyStr(v);
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  const named = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  return quote + v.replace(/[\\'"\x00-\x1f\x7f-\xa0\xad]/g, (c) => {
    if (named[c]) return named[c];
    if (c === "'" || c === '"') return c === quote ? `\\${c}` : c;
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }) + quote;
}

// str(): what Python prints for a JSON value, so that a number, a flag or a list that
// ended up in a text field reads the same on both sides. One gap cannot be closed: JSON
// has a single number type, so a 2.0 that Python prints as "2.0" arrives here as 2.
export function pyStr(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNumber(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}

// str(value or "")
export const pyText = (v) => pyStr(pyOr(v, ""));

// round(x, digits): Python rounds the exact binary value and sends a true half to the
// even neighbour. toFixed rounds the exact value as well but sends that half upwards, so
// only the tie needs its own branch. A double is a tie at `digits` decimals exactly when
// x * 2^(digits + 1) is an odd integer, and scaling by a power of two is exact.
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x)) return x;
  const halves = x * 2 ** (digits + 1);
  if (Number.isInteger(halves) && Math.abs(halves % 2) === 1) {
    const below = Math.floor(Math.abs(x) * 10 ** digits);
    return Math.sign(x) * (below % 2 === 0 ? below : below + 1) / 10 ** digits;
  }
  return Number(x.toFixed(digits));
}

// What a Python for-loop walks: the items of a list, the characters of a string, the
// keys of a dict. Anything else is not iterable there, so it throws here.
export function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`not iterable: ${pyStr(v)}`);
}

// dict(value or {}): a shallow copy of a mapping. Any other non-empty value throws, as
// it does in Python for everything but a list of pairs, which is refused here as well.
export function pyDict(v) {
  if (!truthy(v)) return {};
  if (isDict(v)) return { ...v };
  throw new TypeError(`not a mapping: ${pyStr(v)}`);
}

const range = (n) => Array.from({ length: n }, (_, i) => i);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------- grid (gd_grid.py)
// Time has two granularities: latent timesteps (what the tensor has) and cells (the
// windows a mask can address). Cells are 17 frames from frame 0; the short one is last.
export const FPS = 24;
export const SHORT_CELL = 5;
// latent frames per full cell, and in the short cell at the end
const CELL_LATENT = 5;
const SHORT_CELL_LATENT = 2;
export const CELL = 17;
const AUDIO_LATENT_FPS = 40;
const CANVAS_MULTIPLE = 32;
// The model's native canvas: a 768 px short edge, 1344x768 at 16:9.
export const NATIVE_MEGAPIXELS = 1344 * 768 / (1024 * 1024);

/** Snap up to the model's 17k+5 grid. */
export function alignFrameCount(n) {
  n = Math.max(SHORT_CELL, requireInt(n));
  while (n % CELL !== SHORT_CELL) n++;
  return n;
}

const videoLatentT = (fc) => (fc <= SHORT_CELL ? 2 : Math.floor((fc - SHORT_CELL) / CELL) * 5 + 2);
const audioLatentT = (fc) => pyRound(fc / FPS * AUDIO_LATENT_FPS);

function cellBounds(frameCount) {
  const fc = alignFrameCount(frameCount);
  const edges = [];
  for (let f = 0; f <= fc - SHORT_CELL; f += CELL) edges.push(f);
  edges.push(fc);
  return edges.slice(0, -1).map((first, i) => [first, edges[i + 1] - 1]);
}

/** [[first_frame, last_frame]] per latent frame of the video, inclusive: a cell's first
 *  latent frame is its first frame alone, each one after it is four frames. */
export function latentBounds(frameCount) {
  const out = [];
  for (const [a, b] of cellBounds(frameCount)) {
    out.push([a, a]);
    for (let first = a + 1; first <= b; first += 4) out.push([first, Math.min(first + 3, b)]);
  }
  return out;
}

/** The cell a latent frame belongs to. */
export const cellOfLatent = (t, cellTotal) => Math.min(Math.floor(t / CELL_LATENT), cellTotal - 1);

/** [first, end) latent frames of a cell: five per full cell, two for the last one. */
function cellLatent(cell, cellTotal) {
  const first = cell * CELL_LATENT;
  return [first, first + (cell === cellTotal - 1 ? SHORT_CELL_LATENT : CELL_LATENT)];
}

/** Every latent frame of the cells given, in order. */
export function cellsLatents(cells, cellTotal) {
  const out = [];
  for (const c of [...new Set(cells)].sort((x, y) => x - y)) {
    const [a, b] = cellLatent(c, cellTotal);
    for (let t = a; t < b; t++) out.push(t);
  }
  return out;
}

/** Latent frames to free around a seam at `frame`: `before` of them in front of it and
 *  `after` from it on. A seam inside a latent frame has that latent frame as its own: it
 *  is always freed, with `before` in front of it and `after` behind it. */
export function seamLatents(frame, grid, before, after) {
  const bounds = latentBounds(grid.frame_count);
  const f = Math.max(0, Math.min(requireInt(frame), grid.frame_count - 1));
  const t = bounds.findIndex(([a, b]) => a <= f && f <= b);
  const end = t + requireInt(after) + (bounds[t][0] === f ? 0 : 1);
  const out = [];
  for (let k = t - requireInt(before); k < end; k++) if (k >= 0 && k < bounds.length) out.push(k);
  return out;
}

// A seam left to itself: how many frames are generated again at the least, and how many of
// them lie before the seam at the least (gd_grid.py says where the numbers are from).
const SEAM_AUTO_FRAMES = 12;
const SEAM_AUTO_BEFORE = 4;

/** Latent frames to free around a seam at `frame` that has no range of its own: the
 *  stretch ends where the next cell begins (at the seam itself, when the seam is on a
 *  cell's first frame) and begins on the first frame of a latent frame, far enough back. */
export function seamAuto(frame, grid) {
  const fc = grid.frame_count;
  const bounds = latentBounds(fc);
  const f = Math.max(0, Math.min(requireInt(frame), fc - 1));
  const [a, b] = grid.cells[cellOfFrame(f, fc)];
  const end = a === f ? a : b + 1;
  const want = Math.min(end - SEAM_AUTO_FRAMES, f - SEAM_AUTO_BEFORE);
  let lo = 0;
  for (const [first] of bounds) if (first <= want && first > lo) lo = first;
  const out = [];
  bounds.forEach(([first, last], t) => { if (first >= lo && last < end) out.push(t); });
  return out;
}

function cellOfFrame(frame, frameCount) {
  const bounds = cellBounds(frameCount);
  for (let i = 0; i < bounds.length; i++) {
    if (bounds[i][0] <= frame && frame <= bounds[i][1]) return i;
  }
  throw new RangeError(`frame ${frame} outside 0..${alignFrameCount(frameCount) - 1}`);
}

/** The grid object for a clip length: frame count, latent sizes and cell bounds. */
export function makeGrid(length) {
  const requested = requireInt(length);
  const fc = alignFrameCount(requested);
  const cells = cellBounds(fc);
  return {
    requested_length: requested,
    frame_count: fc,
    latent_t: videoLatentT(fc),
    audio_t: audioLatentT(fc),
    cell_count: cells.length,
    cells,
    snapped: fc !== requested,
  };
}

/** Parse a cell spec into a sorted cell list. Throws where Python raises ValueError.
 *
 *  Accepted, comma separated: `3`  `3-4`  `3..4`  `all`  `none`  and `f39-72` (a
 *  source-frame range, snapped outward to whole cells). */
export function parseCells(spec, grid) {
  const n = grid.cell_count, fc = grid.frame_count;
  if (truthy(spec) && typeof spec !== "string") throw new TypeError("a cell spec is text");
  const text = (typeof spec === "string" ? spec : "").trim().toLowerCase();
  if (text === "" || text === "none") return [];
  if (text === "all") return range(n);
  const out = new Set();
  for (const part of text.split(" ").join("").split(",")) {
    if (!part) continue;
    const frames = part.startsWith("f");
    const body = frames ? part.slice(1) : part.split("..").join("-");
    // split at the first dash only: "-3" has an empty left side and fails as a number
    const dash = body.indexOf("-");
    const a = dash < 0 ? body : body.slice(0, dash);
    const b = (dash < 0 ? "" : body.slice(dash + 1)) || a;
    let lo, hi;
    if (frames) {
      lo = cellOfFrame(Math.max(0, requireInt(a)), fc);
      hi = cellOfFrame(Math.min(fc - 1, requireInt(b)), fc);
    } else {
      lo = requireInt(a);
      hi = requireInt(b);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo < 0 || hi >= n) throw new RangeError(`cell range ${lo}-${hi} outside 0..${n - 1}`);
    }
    for (let k = lo; k <= hi; k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

/** Cells to free for a seam-repair pass: `radius` cells on each side of each cut.
 *
 *  A cut ON a cell boundary (the normal case, since shot edges snap to boundaries) is the
 *  seam between cell c-1 and cell c: free c-radius .. c+radius-1. A cut INSIDE a cell has
 *  that cell as the seam itself: free c-radius .. c+radius. */
export function seamCells(cutFrames, grid, radius = 1) {
  const n = grid.cell_count, fc = grid.frame_count, cells = grid.cells;
  const out = new Set();
  for (const cut of cutFrames) {
    const f = Math.max(0, Math.min(requireInt(cut), fc - 1));
    const c = cellOfFrame(f, fc);
    const onBoundary = c > 0 && cells[c][0] === f;
    const hi = onBoundary ? c + radius - 1 : c + radius;
    for (let k = c - radius; k <= hi; k++) if (k >= 0 && k < n) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

/** Largest valid guide-clip length (5, 22, 39 ... = 17k+5) not above `frames`.
 *  Below 5 a batch is anchored as a single image. */
export function guideClipLength(frames) {
  frames = requireInt(frames);
  return frames < SHORT_CELL ? 1 : frames - ((frames - SHORT_CELL) % CELL);
}

// "16:9" / "896x512" / "1.5" -> ratio terms. Anything unreadable -> 16:9.
function parseAspect(aspect) {
  const text = pyText(aspect).trim().toLowerCase().split("x").join(":").split("/").join(":");
  const colon = text.indexOf(":");
  const w = pyFloat(colon < 0 ? text : text.slice(0, colon));
  const h = colon < 0 ? 1 : pyFloat(text.slice(colon + 1));
  return w !== null && h !== null && w > 0 && h > 0 ? [w, h] : [16, 9];
}

/** [width, height] for an aspect ratio and a megapixel budget, snapped to 32.
 *
 *  1 MP is 1024 * 1024 pixels, so "16:9 at 0.4 MP" lands on 864x480. An aspect of
 *  "source" follows `sourceSize` ([w, h]) when one is known. Throws where Python raises:
 *  megapixels that are not a number, or a ratio so extreme the size is not finite. */
export function canvasSize(aspect, megapixels, sourceSize = null) {
  const named = pyText(aspect).trim().toLowerCase();
  let ratio;
  if (named === "" || named === "source" || named === "auto") {
    ratio = truthy(sourceSize) && sourceSize[0] > 0 && sourceSize[1] > 0
      ? [sourceSize[0], sourceSize[1]] : [16, 9];
  } else {
    ratio = parseAspect(aspect);
  }
  const mp = pyFloat(megapixels);
  if (mp === null) throw new TypeError("megapixels is not a number");
  const total = pyMax(0.01, mp) * 1024 * 1024;
  const area = ratio[0] * ratio[1];
  if (area === 0) throw new RangeError("aspect ratio underflows");
  const scale = Math.sqrt(total / area);
  const snap = (side) => {
    const steps = side * scale / CANVAS_MULTIPLE;
    if (!Number.isFinite(steps)) throw new RangeError("canvas size is not finite");
    return Math.max(CANVAS_MULTIPLE, pyRound(steps) * CANVAS_MULTIPLE);
  };
  return [snap(ratio[0]), snap(ratio[1])];
}

// ---------------------------------------------------------------- schema (gd_schema.py)
// One document describes one clip. It stores material with a role, not a task mode:
// "text to video", "first/last frame", "video editing" and the rest are combinations of
// a prompt, anchors, references, a source clip and a mask. The only switch is `family`,
// because the two checkpoints take different conditioning and different prompt formats.
export const SCHEMA_VERSION = 8;

export const FAMILIES = ["reference", "base"];
export const MASK_MODES = ["whole_clip", "free_cells", "seam_repair"];
export const PROMPT_MODES = ["structured", "raw"];

// Fixed vocabulary of the official reference guide. An invented word would reach the
// prompt verbatim, so every marker is clamped to these.
export const RETENTIONS = ["fully_preserved", "partially_preserved", "attribute_transfer",
                           "weak_reference"];
export const AUDIO_RETENTIONS = ["reference", "fully_copy", "partially_copy", "weak_reference"];
export const SUBJECT_KINDS = ["person", "animal", "object", "environment", "clothing", "prop",
                              "interface", "effect", "style", "action", "expression", "pose"];

// What a source clip is to the target when it is also sent as a reference video.
export const SOURCE_ROLES = ["edit", "continue", "motion"];

export const ANCHOR_KINDS = ["image", "clip", "audio"];
/** Where in its shot an anchor sits. */
export const ANCHOR_ATS = ["first", "last", "offset"];

// Material belongs to a shot. It is stored clip-wide, because the model takes one reference
// sequence for the whole clip; every item says who it belongs to:
//   id     never changes; prompt text refers to material as @{id}
//   name   what the panel shows and what is typed after "@"; unique, no spaces
//   shot   the id of the shot it belongs to, "" = shared by every shot
// An anchor always belongs to a shot and sits at its first frame, its last, or `offset`
// frames in; `frame` is derived, so an anchor moves with its shot.
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
/** A reference to material in prompt text (make a new one for each scan: it is global). */
export const mentionRe = () => /@\{([a-z][a-z0-9_]{0,23})\}/g;
const LEGACY_REF_RE = /@ref([0-9]{1,6})(?![0-9])/g;
const NAME_SPACE = /[ \t\r\n\u3000]+/g;
const NAME_DROP = /[@{}<>\[\]()"'`,.;:!?\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001\uff08\uff09\u201c\u201d\u2018\u2019\u300a\u300b]/g;
// names the prompt syntax already uses: @ref1 is a subject by position, @voice(...) a voice
const NAME_TAKEN = /^(?:(?:ref|char|character)[0-9]+|voice)$/;
// How a cited anchor image is declared: a frame of the shot it sits in, or a storyboard.
export const PICTURE_ROLES = ["auto", "storyboard"];

// Official limits: 9 images, 3 videos, 3 audio clips.
export const MAX_SUBJECTS = 9;   // the planner numbers nine: @ref10 would stay as written
export const MAX_REF_IMAGES = 9;
export const MAX_REF_VIDEOS = 3;
export const MAX_REF_AUDIO = 3;
const MAX_REF_FILES = 12;

// A shot shorter than this cannot hold a legible label and cannot cover a latent cell.
export const MIN_SHOT = 5;

const DEFAULT_MASK = { mode: "whole_clip", cells: "", cut_frames: "", radius: 1, seam_denoise: 1.0 };
const DEFAULT_VIEW = { zoom: 1.0, playhead: 0, selected_shot: 0 };
const DEFAULT_SOURCE = {
  video: "", start: 0, as_latent: false, denoise: 1.0, as_reference: true, role: "edit",
  retention: "fully_preserved", desc: "", note: "", audio: false,
};

/** A fresh document. The editor starts from this. */
export function emptyDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    family: "reference",
    clip: { length: 124, aspect: "source" },
    source: { ...DEFAULT_SOURCE, splice: [] },
    anchors: [],
    subjects: [],
    videos: [],
    audio: [],
    prompt: { mode: "structured", global: "", shots: [], summary: "", soundscape: "",
              music: "", negative: "", raw: "" },
    mask: { ...DEFAULT_MASK },
    view: { ...DEFAULT_VIEW },
    derived: {},
  };
}

// --- small pieces. gd_schema's choice lower-cases; the preset mirror's does not.
const choice = (value, options, fallback) => {
  const text = pyText(value).trim().toLowerCase();
  return options.includes(text) ? text : fallback;
};
const clampi = (value, lo, hi, fallback) => {
  const i = pyInt(value);
  return i === null ? fallback : Math.max(lo, Math.min(hi, i));
};
const clampf = (value, lo, hi, fallback) => {
  const f = pyFloat(value);
  return f === null ? fallback : pyMax(lo, pyMin(hi, f));
};
const fileName = (value) => pyText(value).trim().split("\\").join("/");

// --- migration
function mediaFiles(bag, kind) {
  const out = [];
  if (!isDict(bag)) return out;
  for (let item of pyIter(pyOr(bag[kind], []))) {
    if (typeof item === "string") item = { file: item };
    if (isDict(item) && pyText(item.file).trim()) out.push(item);
  }
  return out;
}

// v5 knew one job: edit a plate. Re-express that as material with roles.
function migrateV5(doc) {
  const plate = pyDict(doc.plate);
  const oldAnchors = isDict(doc.anchors) ? doc.anchors : {};
  const common = doc.common;
  const prompt = pyDict(doc.prompt);
  delete doc.plate;
  delete doc.anchors;
  delete doc.common;

  doc.family = "reference";
  doc.clip = { length: requireInt(pyOr(plate.length, 124)), aspect: "source" };
  doc.source = {
    video: pyText(plate.video),
    as_latent: true, as_reference: true, role: "edit",
    retention: pyOr(plate.retention, "fully_preserved"),
    splice: pyOr(plate.splice, []),
  };

  const anchors = [], subjects = [], videos = [], audio = [];
  const cited = (file, frame) => ({ kind: "image", file, frame, pin: false, cite: true });
  const refVideo = (item) => ({ file: item.file, desc: pyOr(item.note, ""),
                                retention: pyOr(item.retention, "weak_reference") });
  const refAudio = (item) => ({ file: item.file, desc: pyOr(item.note, "") });

  if (truthy(oldAnchors.first)) anchors.push(cited(oldAnchors.first, 0));
  for (const m of pyIter(pyOr(oldAnchors.mids, []))) {
    if (isDict(m) && truthy(m.file)) anchors.push(cited(m.file, requireInt(pyOr(m.frame, 0))));
  }
  if (truthy(oldAnchors.last)) anchors.push(cited(oldAnchors.last, -1));
  if (truthy(oldAnchors.card)) {
    subjects.push({ images: [oldAnchors.card], description: pyOr(oldAnchors.card_note, "") });
  }

  for (const item of mediaFiles(common, "images")) {
    subjects.push({ images: [item.file], description: pyOr(item.note, "") });
  }
  for (const item of mediaFiles(common, "videos")) videos.push(refVideo(item));
  for (const item of mediaFiles(common, "audio")) audio.push(refAudio(item));

  // v5 kept material inside each shot. That is carried over as it was: once the shots are
  // flattened nothing can say any more which picture went with which shot.
  const shots = [];
  for (const s of pyIter(pyOr(prompt.shots, []))) {
    if (!isDict(s)) continue;
    const sid = pyStr(pyOr(s.id, `shot${shots.length}`));
    for (const item of mediaFiles(s.media, "images")) {
      anchors.push({ kind: "image", file: item.file, shot: sid, at: "first", pin: false,
                     cite: true, note: pyOr(item.note, "") });
    }
    for (const item of mediaFiles(s.media, "videos")) videos.push({ ...refVideo(item), shot: sid });
    for (const item of mediaFiles(s.media, "audio")) audio.push({ ...refAudio(item), shot: sid });
    const { media, ...rest } = s;
    rest.id = sid;
    shots.push(rest);
  }
  prompt.shots = shots;
  prompt.mode = prompt.plan_mode === "raw" ? "raw" : "structured";
  delete prompt.plan_mode;
  return Object.assign(doc, { prompt, anchors, subjects, videos, audio });
}

// v6 named a subject by its place in the list (@ref2, audio.subject = 2). Places change as
// soon as material is grouped by shot, so both become ids here, while the list is still in
// the order those numbers were written against.
function migrateV6(doc) {
  const subjects = [];
  for (const item of (Array.isArray(doc.subjects) ? doc.subjects : [])) {
    const n = normSubject(item);
    if (n !== null) {
      n.id = `s${subjects.length + 1}`;
      subjects.push(n);
    }
  }
  doc.subjects = subjects;
  const byPlace = (whole, digits) => {
    const k = parseInt(digits, 10);
    return k >= 1 && k <= subjects.length ? `@{s${k}}` : whole;
  };
  const pr = doc.prompt;
  if (isDict(pr)) {
    for (const key of ["global", "summary"]) {
      if (typeof pr[key] === "string") pr[key] = pr[key].replace(LEGACY_REF_RE, byPlace);
    }
    for (const shot of (Array.isArray(pr.shots) ? pr.shots : [])) {
      if (isDict(shot) && typeof shot.text === "string") shot.text = shot.text.replace(LEGACY_REF_RE, byPlace);
    }
  }
  for (const item of (Array.isArray(doc.audio) ? doc.audio : [])) {
    if (!isDict(item)) continue;
    const k = clampi(item.subject, 0, subjects.length, 0);
    item.subject = k ? `s${k}` : "";
  }
  return doc;
}

// Upgrade an older document in place (the caller hands over a private copy). Unknown
// keys are kept.
// v7 had no word for how a shot follows the one before it. A clip made over a source clip
// keeps the way its takes were joined (the frames around a change of take rendered again):
// its shots are marked as going on from one another. A shot that already says is left.
function migrateV7(doc) {
  const src = doc.source;
  if (!isDict(src)) return doc;
  // a composite of that time: its pieces go on from one another, whatever the clip is made over
  for (const p of (Array.isArray(src.splice) ? src.splice : [])) {
    if (isDict(p) && !own(p, "join")) p.join = "continuous";
  }
  if (!pyText(src.video).trim()) return doc;
  const shots = isDict(doc.prompt) ? doc.prompt.shots : null;
  for (const s of (Array.isArray(shots) ? shots : [])) {
    if (isDict(s) && !own(s, "join")) s.join = "continuous";
  }
  return doc;
}

function migrate(doc) {
  let v = requireInt(pyOr(doc.schema_version, 0));
  if (!truthy(doc)) return emptyDoc();
  if (v === 0) {
    // an unversioned document is a current one unless it carries the old layout
    const legacy = own(doc, "plate") || own(doc, "common") || isDict(doc.anchors);
    v = legacy ? 1 : SCHEMA_VERSION;
  }
  if (v === 1) {
    // v1 held a single whole-clip prompt in prompt.shot
    const pr = pyDict(doc.prompt);
    const text = pyOr(pr.shot, "");
    delete pr.shot;
    if (!truthy(pr.shots)) pr.shots = truthy(text) ? [{ id: "shot0", length: 0, text }] : [];
    doc.prompt = pr;
    v = 2;
  }
  if (v === 2) {
    // v3 moved the sampling knobs out of the document; the panel folds this into a
    // preset once and drops the key
    const run = doc.run;
    delete doc.run;
    if (isDict(run) && truthy(run)) doc._legacy_run = run;
    v = 5;
  }
  if (v === 3 || v === 4) v = 5;
  if (v === 5) {
    doc = migrateV5(doc);
    v = 6;
  }
  if (v === 6) {
    doc = migrateV6(doc);
    v = 7;
  }
  if (v === 7) doc = migrateV7(doc);
  doc.schema_version = SCHEMA_VERSION;
  return doc;
}

// --- pieces
/** A material's name as it can be typed after "@": no spaces, no punctuation. */
export function cleanName(value) {
  let text = pyText(value).replace(NAME_SPACE, "_").replace(NAME_DROP, "").replace(/^_+|_+$/g, "");
  text = Array.from(text).slice(0, 40).join("");
  return NAME_TAKEN.test(text) ? `${text}_` : text;
}

/** "shots/ella_front.png [output]" -> "ella_front". */
export function fileStem(value) {
  let base = fileName(value);
  base = base.slice(base.lastIndexOf("/") + 1);
  if (base.endsWith("]") && base.includes(" [")) base = base.slice(0, base.lastIndexOf(" ["));
  return base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
}

// Give every item an id of its own. `groups` is [[items, prefix]]; an id that is already
// there and not taken is kept, so ids survive every round trip.
function assignIds(groups) {
  const seen = new Set();
  for (const [items] of groups) {
    for (const it of items) {
      if (ID_RE.test(it.id) && !seen.has(it.id)) seen.add(it.id);
      else it.id = "";
    }
  }
  for (const [items, prefix] of groups) {
    let n = 1;
    for (const it of items) {
      if (it.id) continue;
      while (seen.has(`${prefix}${n}`)) n++;
      it.id = `${prefix}${n}`;
      seen.add(it.id);
    }
  }
}

// Give every item a name of its own. `groups` is [[items, default name of an item]].
function assignNames(groups) {
  const seen = new Set();
  for (const [items, fallback] of groups) {
    for (const it of items) {
      const base = cleanName(it.name) || cleanName(fallback(it)) || it.id;
      let name = base;
      for (let n = 2; seen.has(name); n++) name = `${base}_${n}`;
      it.name = name;
      seen.add(name);
    }
  }
}

// One id per shot, each its own: a repeated or missing id gets the first free shotN.
function shotIds(raw) {
  const taken = new Set(raw.map((x) => pyText(x.id)));
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    let sid = pyText(x.id);
    if (!sid || seen.has(sid)) {
      let n = 0;
      while (taken.has(`shot${n}`) || seen.has(`shot${n}`)) n++;
      sid = `shot${n}`;
    }
    seen.add(sid);
    out.push(sid);
  }
  return out;
}

// Shots tile [0, frameCount) with no gaps. Lengths are honoured where they fit, clamped
// to MIN_SHOT, and the last shot absorbs any remainder. `moved` receives
// (id of a shot that no longer fits -> id of the shot its text went to), so the material
// of those shots can follow.
/** The most latent frames a seam frees on one side (eight cells). */
export const SEAM_MOST = 40;
/** What the panel gives a boundary that becomes a seam: left to itself (`seamAuto`), which
 *  follows the boundary when it is moved. A range dragged on the Generate page is a pair
 *  of numbers instead and stays as it was set. */
export const DEFAULT_SEAM = "auto";

/** A seam's range: "auto", [before, after] in latent frames, or null when there is none
 *  (or it is neither). */
function normSeam(value) {
  if (value === "auto") return "auto";
  if (!Array.isArray(value) || value.length !== 2) return null;
  return [clampi(value[0], 0, SEAM_MOST, 0), clampi(value[1], 0, SEAM_MOST, 0)];
}

function normShots(shots, fc, moved = null) {
  const whole = () => [{ id: "shot0", start: 0, length: fc, text: "", collapsed: false, join: "cut",
                         sound: "cut", seam: null }];
  const raw = pyIter(pyOr(shots, [])).filter(isDict);
  if (!raw.length) return whole();
  const ids = shotIds(raw);

  const out = [];
  let used = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const left = fc - used;
    if (left < MIN_SHOT) {
      // shots that no longer fit give their text to the last one that does
      if (out.length) {
        const rest = raw.slice(i).map((x) => pyText(x.text).trim());
        const last = out[out.length - 1];
        last.text = [last.text.trim(), ...rest].filter((t) => t).join(" ");
        if (moved) for (const gone of ids.slice(i)) moved.set(gone, last.id);
      }
      break;
    }
    // keep room for the shots still to come, MIN_SHOT each, as far as the clip allows
    const after = raw.length - i - 1;
    const reserve = Math.min(after, Math.max(0, Math.floor((left - MIN_SHOT) / MIN_SHOT))) * MIN_SHOT;
    let want = clampi(s.length, 0, 1e6, 0);
    if (want <= 0) want = left - reserve;
    const length = Math.max(MIN_SHOT, Math.min(want, left - reserve));
    out.push({
      id: ids[i],
      start: used,
      length,
      text: pyText(s.text),
      collapsed: truthy(s.collapsed),
      // how it follows the shot before it: a cut, or the same shot going on. The first
      // shot follows nothing.
      join: out.length && s.join === "continuous" ? "continuous" : "cut",
      // the sound across a cut: "continuous" keeps it with the take it was with (the picture
      // changes take, the sound does not). Inside a long take it is not asked: there the
      // sound goes on with the picture, and this is kept for when it is cut.
      sound: out.length && s.sound === "continuous" ? "continuous" : "cut",
      // how much is generated again around the seam when this shot goes on from the one
      // before it and the two picked different takes: [latent frames before the boundary,
      // latent frames from it on]; null: `mask.radius` cells on either side
      seam: out.length ? normSeam(s.seam) : null,
    });
    used += length;
  }
  if (!out.length) return whole();
  if (used < fc) out[out.length - 1].length += fc - used;
  return out;
}

// One anchor: an image, a short clip or audio at a frame of the target.
//   pin   hold it at that frame (first/last frame input or a guide)
//   cite  give it a <Picture N> so the prompt can name it; images only
//   shot, at, offset   where it sits: the first frame of its shot, the last, or `offset`
//         frames in. `frame` is worked out from those. An anchor written before schema 7
//         has only a frame (-1 = the last frame of the clip); it goes to the shot that
//         frame is in.
function normAnchor(item, fc, shots, moved) {
  if (!isDict(item)) return null;
  const file = fileName(item.file);
  if (!file) return null;
  const kind = choice(item.kind, ANCHOR_KINDS, "image");
  let sid = pyText(item.shot);
  if (moved.has(sid)) sid = moved.get(sid);
  let at = pyText(item.at);
  let shot = shots.find((x) => x.id === sid);
  let offset;
  if (shot && ANCHOR_ATS.includes(at)) {
    offset = clampi(item.offset, 0, shot.length - 1, 0);
  } else {
    let old = clampi(item.frame, -1, fc - 1, 0);
    if (old < 0) old = fc - 1;
    shot = shots.find((x) => x.start <= old && old < x.start + x.length);
    at = "offset";
    offset = old - shot.start;
  }
  // the two ends are places of their own: an anchor on one stays on it when the shot grows
  if (at === "first" || (at === "offset" && offset === 0)) {
    at = "first";
    offset = 0;
  } else if (at === "last" || offset === shot.length - 1) {
    at = "last";
    offset = shot.length - 1;
  }
  if (kind === "clip" && at === "last") {          // a clip cannot hang off the last frame
    at = "first";
    offset = 0;
  }
  const frame = shot.start + offset;
  const out = {
    id: pyText(item.id),
    name: pyText(item.name),
    shot: shot.id,
    at,
    offset,
    kind,
    file,
    frame,
    pin: item.pin === undefined ? true : truthy(item.pin),
    cite: truthy(item.cite) && kind === "image",
    role: choice(item.role, PICTURE_ROLES, "auto"),
    retention: choice(item.retention, RETENTIONS, "fully_preserved"),
    note: pyText(item.note),
    clip_start: 0, clip_length: 0, with_audio: false,
  };
  if (kind === "clip") {
    const want = clampi(item.clip_length, 0, 1e6, 22) || 22;
    out.clip_start = clampi(item.clip_start, 0, 1e6, 0);
    out.clip_length = guideClipLength(Math.min(want, fc - frame));
    out.with_audio = truthy(item.with_audio);
    out.pin = true;                                // a clip has no other use
  }
  if (kind === "audio") out.pin = true;
  return out;
}

/** The frame an anchor lands on. */
export function resolvedFrame(anchor, frameCount) {
  const f = requireInt(pyOr(anchor.frame, 0));
  return f < 0 ? frameCount - 1 : Math.min(f, frameCount - 1);
}

// Something the prompt refers to as @ref1 and the model sees as <Subject N>.
function normSubject(item) {
  if (typeof item === "string") item = { images: [item] };
  if (!isDict(item)) return null;
  const images = [];
  const listed = pyOr(item.images, []);
  for (const img of (typeof listed === "string" || isDict(listed) ? [listed] : pyIter(listed))) {
    const file = fileName(isDict(img) ? img.file : img);
    if (file && !images.includes(file)) images.push(file);
  }
  const description = pyText(item.description);
  if (!images.length && !description.trim()) return null;
  return {
    id: pyText(item.id),
    name: pyText(item.name),
    shot: pyText(item.shot),
    images,
    description,
    short_name: pyText(item.short_name),
    kind: choice(item.kind, SUBJECT_KINDS, "person"),
    retention: choice(item.retention, RETENTIONS, "fully_preserved"),
    note: pyText(item.note),
  };
}

function normVideo(item) {
  if (typeof item === "string") item = { file: item };
  if (!isDict(item) || !fileName(item.file)) return null;
  return {
    id: pyText(item.id),
    name: pyText(item.name),
    shot: pyText(item.shot),
    file: fileName(item.file),
    desc: pyText(item.desc),
    retention: choice(item.retention, RETENTIONS, "fully_preserved"),
    note: pyText(item.note),
    audio: truthy(item.audio),
  };
}

function normAudio(item) {
  if (typeof item === "string") item = { file: item };
  if (!isDict(item) || !fileName(item.file)) return null;
  return {
    id: pyText(item.id),
    name: pyText(item.name),
    shot: pyText(item.shot),
    file: fileName(item.file),
    subject: pyText(item.subject),          // the id of the subject whose voice it is
    retention: choice(item.retention, AUDIO_RETENTIONS, "reference"),
    desc: pyText(item.desc),
    note: pyText(item.note),
  };
}

const normList = (items, fn) => (Array.isArray(items) ? items : []).map(fn).filter((v) => v !== null);

/** The long takes of a clip as [first frame, frame after the last]: every run of shots of
 *  which each but the first continues the one before it. A shot that is cut to and cut
 *  from is a long take of its own. */
export function longTakes(shots) {
  const out = [];
  for (const s of shots) {
    const a = requireInt(s.start), b = a + requireInt(s.length);
    if (out.length && s.join === "continuous") out[out.length - 1][1] = b;
    else out.push([a, b]);
  }
  return out;
}

/** [latent frames, cells] a masked run generates again. The cells of "whole_clip" and
 *  "free_cells" are free as a whole. Around a seam it is the shot's own range, in latent
 *  frames, when it has one (`shots[].seam`), and `mask.radius` cells on either side when it
 *  has none: the rule from before a seam had a range of its own. */
function freeOf(mask, grid, shots = []) {
  const n = grid.cell_count;
  if (mask.mode !== "seam_repair") {
    const cells = mask.mode === "whole_clip" ? range(n) : parseCells(pyOr(mask.cells, ""), grid);
    return [cellsLatents(cells, n), cells];
  }
  const cuts = pyText(mask.cut_frames).split(" ").join("").split(",").filter(Boolean).map(requireInt);
  const radius = requireInt(pyOr(mask.radius, 1));
  const bounds = latentBounds(grid.frame_count);
  // A frame inside a long take is repaired inside that long take: what reaches past its
  // ends holds a cut, and a cut generated again lands somewhere else. (A frame named by
  // hand as well as one where a shot begins; a frame ON a cut is the cut itself.)
  const inside = new Map();
  const own = new Map();
  const takes = longTakes(shots);
  for (const f of cuts) {
    for (const take of takes) if (take[0] < f && f < take[1]) inside.set(f, take);
  }
  for (const s of shots) if (s.join === "continuous" && s.seam) own.set(s.start, s.seam);
  const out = new Set();
  for (const f of cuts) {
    const take = inside.get(f);
    let latents;
    if (own.has(f)) {
      latents = own.get(f) === "auto" ? seamAuto(f, grid) : seamLatents(f, grid, own.get(f)[0], own.get(f)[1]);
      // a latent frame is freed whole or not at all
      if (take) latents = latents.filter((t) => bounds[t][0] >= take[0] && bounds[t][1] < take[1]);
    } else {
      let cells = seamCells([f], grid, radius);
      if (take) cells = cells.filter((c) => grid.cells[c][0] >= take[0] && grid.cells[c][1] < take[1]);
      latents = cellsLatents(cells, n);
    }
    for (const t of latents) out.add(t);
  }
  const latents = [...out].sort((x, y) => x - y);
  return [latents, [...new Set(latents.map((t) => cellOfLatent(t, n)))].sort((x, y) => x - y)];
}

function liveShots(shots, free, grid) {
  const out = [];
  shots.forEach((s, i) => {
    const a = s.start, b = s.start + s.length - 1;
    if (free.some((c) => !(b < grid.cells[c][0] || a > grid.cells[c][1]))) out.push(i);
  });
  return out;
}

// --- normalize
/** Return a complete, consistent document. Tidies, never vetoes: a switch that cannot
 *  work in the current family stays as set, and problems() says why it will not run. */
export function normalize(input) {
  const base = emptyDoc();
  const doc = migrate(isDict(input) ? jsonCopy(input) : {});

  const out = { ...base };
  for (const k of ["clip", "source", "prompt", "mask", "view"]) {
    out[k] = { ...base[k], ...(isDict(doc[k]) ? doc[k] : {}) };
  }
  for (const [k, v] of Object.entries(doc)) if (!own(out, k)) out[k] = v;   // unknown keys survive
  out.schema_version = SCHEMA_VERSION;
  out.family = choice(doc.family, FAMILIES, "reference");

  // --- clip and grid
  const grid = makeGrid(clampi(out.clip.length, 5, 3600, 124));
  const fc = grid.frame_count;
  out.clip.length = fc;
  out.clip.aspect = pyStr(pyOr(out.clip.aspect, "source")).trim() || "source";

  // --- source
  const s = out.source;
  s.video = fileName(s.video);
  s.start = clampi(s.start, 0, 1e6, 0);
  s.as_latent = truthy(s.as_latent);
  s.as_reference = truthy(s.as_reference);
  s.denoise = clampf(s.denoise, 0.05, 1.0, 1.0);
  s.role = choice(s.role, SOURCE_ROLES, "edit");
  s.retention = choice(s.retention, RETENTIONS, "fully_preserved");
  s.desc = pyText(s.desc);
  s.note = pyText(s.note);
  s.audio = truthy(s.audio);
  delete s.cite_ends;             // removed in 2.0: measured to change nothing
  // composite splice: only sane pieces survive, in order, clipped to the clip
  const pieces = [];
  for (const item of pyIter(pyOr(s.splice, []))) {
    if (!isDict(item) || !fileName(item.file)) continue;
    const start = clampi(item.start, 0, fc - 1, 0);
    pieces.push({ file: fileName(item.file), start,
                  length: clampi(item.length, 1, fc - start, 1),
                  take: pyText(item.take),
                  join: item.join === "continuous" ? "continuous" : "cut",
                  sound: item.sound === "continuous" ? "continuous" : "cut" });
  }
  pieces.sort((a, b) => a.start - b.start);
  if (pieces.length) pieces[0].join = pieces[0].sound = "cut";
  s.splice = pieces;

  // --- shots, which the material hangs on
  const pr = out.prompt;
  const moved = new Map();
  const shots = normShots(pr.shots, fc, moved);
  const shotIdSet = new Set(shots.map((x) => x.id));

  // --- material
  out.subjects = normList(doc.subjects, normSubject);
  out.videos = normList(doc.videos, normVideo);
  out.audio = normList(doc.audio, normAudio);
  const anchors = normList(doc.anchors, (x) => normAnchor(x, fc, shots, moved));
  for (const items of [out.subjects, out.videos, out.audio]) {
    for (const it of items) {
      const home = moved.has(it.shot) ? moved.get(it.shot) : it.shot;
      it.shot = shotIdSet.has(home) ? home : "";       // "" = shared by every shot
    }
  }
  assignIds([[out.subjects, "s"], [out.videos, "v"], [out.audio, "a"], [anchors, "k"]]);
  assignNames([
    [out.subjects, (x) => (x.images.length ? fileStem(x.images[0])
      : (x.short_name || Array.from(x.description).slice(0, 24).join("")))],
    [out.videos, (x) => fileStem(x.file)],
    [out.audio, (x) => fileStem(x.file)],
    [anchors, (x) => fileStem(x.file)],
  ]);
  const known = new Set(out.subjects.map((x) => x.id));
  for (const it of out.audio) if (!known.has(it.subject)) it.subject = "";
  if (out.family === "base") {
    // The base model is shown a picture through its first / last frame input, and that
    // input holds the frame as well: there is no citing without pinning.
    for (const a of anchors) if (a.cite) a.pin = true;
  }
  anchors.sort((a, b) => (resolvedFrame(a, fc) - resolvedFrame(b, fc))
    || (ANCHOR_KINDS.indexOf(a.kind) - ANCHOR_KINDS.indexOf(b.kind)));
  out.anchors = anchors;

  // --- prompt
  pr.mode = choice(pr.mode, PROMPT_MODES, "structured");
  for (const k of ["global", "summary", "soundscape", "music", "negative", "raw"]) pr[k] = pyText(pr[k]);
  pr.shots = shots;

  // --- mask
  const m = out.mask;
  m.mode = choice(m.mode, MASK_MODES, "whole_clip");
  m.cells = pyText(m.cells);
  m.cut_frames = pyText(m.cut_frames);
  m.radius = clampi(m.radius, 1, 4, 1);
  m.seam_denoise = clampf(m.seam_denoise, 0.05, 1.0, 1.0);

  // --- view
  const view = out.view;
  view.zoom = clampf(view.zoom, 1.0, 16.0, 1.0);
  view.playhead = clampi(view.playhead, 0, fc - 1, 0);
  view.selected_shot = clampi(view.selected_shot, 0, pr.shots.length - 1, 0);

  // --- derived: rebuilt on every pass, never trusted from the input
  let free;
  let freeLatents;
  try {
    [freeLatents, free] = freeOf(m, grid, pr.shots);
  } catch {
    freeLatents = [];
    free = [];                      // a spec that cannot be read frees nothing
  }
  out.derived = {
    frame_count: fc,
    seconds: pyRound(fc / FPS, 3),
    latent_t: grid.latent_t,
    audio_t: grid.audio_t,
    cell_count: grid.cell_count,
    cells: grid.cells,
    // what a masked run generates again: the latent frames are what the mask is made of,
    // the cells are those that hold any of them (a summary)
    free_latents: freeLatents,
    free_cells: free,
    latent_source: latentSource(out),
    anchor_frames: anchors.map((a) => resolvedFrame(a, fc)),
    // only shots overlapping a free cell are re-read by a masked run
    live_shot_indices: liveShots(pr.shots, free, grid),
  };
  return out;
}

/** What the sampler starts from: "splice", "source" or "empty". */
export function latentSource(doc) {
  const s = pyOr(doc.source, {});
  if (truthy(s.splice)) return "splice";
  if (truthy(s.video) && truthy(s.as_latent)) return "source";
  return "empty";
}

/** Is the source clip also sent as a reference video? */
export function referenceSource(doc) {
  const s = pyOr(doc.source, {});
  return doc.family === "reference" && truthy(s.video) && truthy(s.as_reference);
}

// ---------------------------------------------------------------- validation
/** States that cannot run, as the same sentences the node reports. Empty means the
 *  document is runnable as far as it can tell.
 *
 *  normalize never rewrites these away: a switch the user set stays set, and this says
 *  why it will not work. */
// Every state that cannot run, as a code and the English sentence for it (gd_schema.py
// PROBLEM_TEXT). The pages word the same codes in the panel's language: gd_i18n.js, keys
// "problem.<code>".
const PROBLEM_TEXT = {
  mask_no_source: "the mask keeps part of a clip, but there is no source clip in the latent "
    + "to keep (turn on \"start from the source clip\" or set the mask to the whole clip)",
  mask_frees_nothing: "the mask frees no cells, so the run would only reproduce its source",
  seam_no_cut: "seam repair needs at least one cut frame",
  splice_length: "the composite splice covers %d frames but the clip is %d: every segment needs a pick",
  base_source_reference: "the base model takes no reference videos: the source clip can only be used "
    + "as the starting latent here",
  base_videos: "the base model takes no reference videos (%d listed); switch to the reference model or remove them",
  base_audio: "the base model takes no reference audio (%d listed); pin audio at a frame instead, "
    + "or switch to the reference model",
  subjects: "%d subjects, but the limit is %d (subjects without a picture count too)",
  ref_images: "%d reference images, but the model takes at most %d",
  ref_videos: "%d reference videos, but the model takes at most %d",
  ref_audio: "%d reference audio clips, but the model takes at most %d",
  ref_audio_tracks: "%d reference audio clips (%d of them soundtracks), but the model takes at most %d",
  ref_files: "%d reference files in all, but the model takes at most %d",
  two_cited: "two pictures are cited at frame %d (%s and %s); a frame of the target can be shown one picture",
  clip_past_end: "the clip pinned at frame %d runs past the end of the video",
  two_pinned: "two pictures are pinned at frame %d (%s and %s)",
  raw_empty: "the prompt is in free-text mode but the text is empty",
  mention_gone: "the text of shot %d refers to material that is no longer there (%s)",
  mention_gone_other: "the ambient sound, the music or a subject's description refers to "
    + "material that is no longer there (%s)",
  mention_gone_global: "the overall description refers to material that is no longer there (%s)",
};

/** The codes problemsCoded can return: each needs a "problem.<code>" row in gd_i18n.js. */
export const PROBLEM_CODES = Object.keys(PROBLEM_TEXT);

/** States that cannot run, as [code, [arguments]]. Empty means runnable as far as the
 *  document can tell. */
export function problemsCoded(doc) {
  const d = normalize(doc);         // a derived block that came with the document is not trusted
  const out = [];
  const add = (code, ...args) => out.push([code, args]);
  const fam = d.family, s = d.source, fc = d.derived.frame_count;
  const src = d.derived.latent_source;

  if (d.mask.mode !== "whole_clip") {
    if (src === "empty") add("mask_no_source");
    else if (!truthy(d.derived.free_cells) && !(src === "splice" && d.mask.mode === "seam_repair")) {
      // (a composite whose takes meet only at cuts repairs no seam: nothing is free, and
      // nothing is rendered)
      add(d.mask.mode === "free_cells" ? "mask_frees_nothing" : "seam_no_cut");
    }
  }
  if (truthy(s.splice)) {
    // the pieces lie end to end from the first frame to the last: adding up to the clip's
    // length is not enough, two pieces can do that and overlap
    const spliced = s.splice.reduce((sum, p) => sum + p.length, 0);
    let at = 0, tiled = true;
    for (const p of s.splice) {
      tiled = tiled && p.start === at;
      at += p.length;
    }
    if (spliced !== fc || !tiled) add("splice_length", spliced, fc);
  }

  if (d.subjects.length > MAX_SUBJECTS) add("subjects", d.subjects.length, MAX_SUBJECTS);
  if (fam === "base") {
    if (truthy(s.video) && truthy(s.as_reference) && !truthy(s.as_latent)) add("base_source_reference");
    if (truthy(d.videos)) add("base_videos", d.videos.length);
    if (truthy(d.audio)) add("base_audio", d.audio.length);
  } else {
    const images = d.subjects.reduce((sum, x) => sum + x.images.length, 0)
      + d.anchors.filter((a) => truthy(a.cite)).length;
    if (images > MAX_REF_IMAGES) add("ref_images", images, MAX_REF_IMAGES);
    const videos = d.videos.length + (referenceSource(d) ? 1 : 0);
    if (videos > MAX_REF_VIDEOS) add("ref_videos", videos, MAX_REF_VIDEOS);
    // a soundtrack is an audio reference like any other
    const tracks = (referenceSource(d) && truthy(s.audio) ? 1 : 0)
      + d.videos.filter((v) => truthy(v.audio)).length;
    const audio = d.audio.length + tracks;
    if (audio > MAX_REF_AUDIO) {
      if (tracks) add("ref_audio_tracks", audio, tracks, MAX_REF_AUDIO);
      else add("ref_audio", audio, MAX_REF_AUDIO);
    }
    if (images + videos + audio > MAX_REF_FILES) add("ref_files", images + videos + audio, MAX_REF_FILES);
  }

  const pinned = new Map(), cited = new Map();
  for (const a of d.anchors) {
    if (!(truthy(a.pin) || truthy(a.cite))) continue;
    const f = resolvedFrame(a, fc);
    if (truthy(a.cite)) {
      if (cited.has(f)) add("two_cited", f, cited.get(f), a.file);
      cited.set(f, a.file);
    }
    if (a.kind === "clip" && f + a.clip_length > fc) add("clip_past_end", f);
    if (truthy(a.pin) && (a.kind === "image" || a.kind === "clip")) {
      if (pinned.has(f)) add("two_pinned", f, pinned.get(f), a.file);
      pinned.set(f, a.file);
    }
  }
  if (d.prompt.mode === "raw" && !d.prompt.raw.trim()) add("raw_empty");
  const ids = material(d);
  const gone = (text) => [...new Set([...text.matchAll(mentionRe())].map((m) => m[1])
    .filter((m) => !ids.has(m)))].sort();
  for (const key of ["global", "summary"]) {
    for (const g of gone(d.prompt[key])) add("mention_gone_global", `@{${g}}`);
  }
  d.prompt.shots.forEach((shot, i) => {
    for (const g of gone(shot.text)) add("mention_gone", i + 1, `@{${g}}`);
  });
  // every other text that may name material: see MENTION_FIELDS in gd_material.js
  const other = [d.prompt.soundscape, d.prompt.music, ...d.subjects.map((x) => x.description)].join("\n");
  for (const g of gone(other)) add("mention_gone_other", `@{${g}}`);
  return out;
}

/** Every piece of material of a normalized document by id: Map(id -> [list name, index,
 *  the item]). */
export function material(doc) {
  const out = new Map();
  for (const key of ["subjects", "videos", "audio", "anchors"]) {
    (doc[key] || []).forEach((it, i) => out.set(it.id, [key, i, it]));
  }
  return out;
}

/** problemsCoded, as English sentences: exactly what the Python side says. */
export function problems(doc) {
  return problemsCoded(doc).map(([code, args]) => {
    let i = 0;
    return PROBLEM_TEXT[code].replace(/%[ds]/g, () => pyStr(args[i++]));
  });
}
