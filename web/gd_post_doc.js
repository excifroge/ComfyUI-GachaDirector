// Gacha Director — JS mirror of gd_post.py: the live preview, what gets saved, face refine.
//
// Kept in its own widget rather than in the clip document: the document is content, this
// is how a render is watched, written out and touched up afterwards, and mixing them would
// make every output tweak dirty the clip. The page clamps and completes the settings
// locally so the form never shows a value the server would silently change;
// tests/parity.mjs holds the two sides together.
//
// There is no general refine or upscale stage. Settings from older versions that had one
// are dropped: only `preview`, `save`, `face` and `version` survive, and inside those
// sections only the keys listed below.

import { isDict, jsonCopy, pyFloat, pyInt, pyOr, pyRound, pyStr, pyText, truthy } from "./gd_doc.js";

export const POST_VERSION = 3;

export const SAVE_FORMATS = ["auto", "mp4", "webm", "mkv"];
export const SAVE_CODECS = ["auto", "h264", "av1"];

export const DEFAULT_POST = {
  version: POST_VERSION,
  preview: {
    enabled: true,
    preview_every: 1,            // sampler steps between previews
    max_resolution: 1024,
    jpeg_quality: 80,
  },
  save: {
    auto_save: true,
    filename_prefix: "GachaDirector",
    format: "mp4",
    codec: "h264",
  },
  // Refining a face: one more run, over the region of a finished clip the face is in.
  face: {
    strength: 0.85,              // the share of noise the run starts from
    padding: 2.0,                // side of the region, in face sizes
    feather: 0.15,               // how much of the region's edge is blended away
    min_score: 0.6,              // how sure the detector has to be of a face
    subject: "",                 // id of the subject whose pictures show this face
    text: "",                    // words added to the description of the face
    shots: "",                   // shots to refine, from 1: "1,3"; "" = wherever a face is
    file: "",                    // set for the one run that refines: the finished clip
    cuts: "",                    // and the frames at which its shots start
  },
};

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clampi = (v, lo, hi, d) => {
  const i = pyInt(v);
  return i === null ? d : Math.min(hi, Math.max(lo, i));
};
const clampf = (v, lo, hi, d) => {
  const f = pyFloat(v);
  if (f === null || !Number.isFinite(f)) return d;
  return pyRound(Math.min(hi, Math.max(lo, f)), 3);
};
const choice = (v, options, d) => {
  const text = pyText(v).trim().toLowerCase();
  return options.includes(text) ? text : d;
};

/** Complete, clamped, idempotent. */
export function normalizePost(cfg) {
  cfg = isDict(cfg) ? jsonCopy(cfg) : {};
  const out = jsonCopy(DEFAULT_POST);
  for (const section of ["preview", "save", "face"]) {
    if (!isDict(cfg[section])) continue;
    for (const [k, v] of Object.entries(cfg[section])) if (own(out[section], k)) out[section][k] = v;
  }

  const p = out.preview;
  p.enabled = truthy(p.enabled);
  p.preview_every = clampi(p.preview_every, 1, 100, 1);
  p.max_resolution = clampi(p.max_resolution, 128, 4096, 1024);
  p.jpeg_quality = clampi(p.jpeg_quality, 10, 100, 80);

  const s = out.save;
  s.auto_save = truthy(s.auto_save);
  s.filename_prefix = pyStr(pyOr(s.filename_prefix, "GachaDirector"));
  s.format = choice(s.format, SAVE_FORMATS, "mp4");
  s.codec = choice(s.codec, SAVE_CODECS, "h264");

  const f = out.face;
  f.strength = clampf(f.strength, 0.05, 0.95, 0.85);
  f.padding = clampf(f.padding, 1.2, 4.0, 2.0);
  f.feather = clampf(f.feather, 0.02, 0.45, 0.15);
  f.min_score = clampf(f.min_score, 0.1, 0.99, 0.6);
  f.subject = pyText(f.subject);
  f.text = pyText(f.text);
  f.file = pyText(f.file);
  f.shots = pyText(f.shots).split(" ").join("").split(",").filter((x) => /^[0-9]+$/.test(x)).join(",");
  // "~" after a frame: the shot that starts there goes on from the one before (no cut)
  f.cuts = pyText(f.cuts).split(" ").join("").split(",").filter((x) => /^[0-9]+~?$/.test(x)).join(",");
  return out;
}
