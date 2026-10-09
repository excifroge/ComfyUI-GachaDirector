// Gacha Director — JS mirror of gd_takes.py: the candidates rendered for a clip, the pick
// per segment, and the composite built from the picks.
//
//   candidates  ->  pick per segment  ->  final
//
// A take is one finished whole-clip render. Every take is a candidate for every segment:
// the model renders the whole clip every time, so "re-render only this segment" would
// cost exactly what a new take costs and would start from generated frames. Another roll
// is another seed.
//
// The final clip is one of two things. If every segment picked the same take, that take
// is the final clip and nothing is rendered again. If the picks span several takes, the
// picked ranges are spliced into one clip that becomes the starting latent of one more
// run with a seam-repair mask around every cut where the take changes.
//
// tests/parity.mjs holds this file to the Python side. Nothing here translates: text
// meant for the user is returned as a key plus arguments, or as counts.

import { isDict, jsonCopy, pyInt, pyIter, pyOr, pyStr, pyText, requireInt } from "./gd_doc.js";

export const TAKES_VERSION = 2;
export const STATUSES = ["queued", "running", "done", "failed", "missing"];
export const MAX_TAKES = 200;

export function emptyTakes() {
  return {
    version: TAKES_VERSION,
    // [{id, seed, prompt_id, file, status, at, preset, summary, note, frames, layout}]
    // `frames` is the clip length the take was rendered at (0 = not recorded): a take of
    // another length is not material for this clip.
    takes: [],
    picks: {},          // {"<segment index>": take id}
    // `key` names the picks the composite was rendered from (planKey), so a composite of
    // earlier picks is never shown as the final clip of the current ones.
    composite: { prompt_id: "", file: "", status: "", at: 0, seed: 0, key: "", frames: 0, note: "" },
    // the final clip with its face refined: one more run over `of`
    refine: { prompt_id: "", file: "", status: "", at: 0, seed: 0, key: "", of: "" },
  };
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clampi = (v, lo, hi, d) => {
  const i = pyInt(v);
  return i === null ? d : Math.min(hi, Math.max(lo, i));
};

// The store as JSON would carry it -> complete and clamped. Works on a private copy.
function norm(src) {
  const out = emptyTakes();

  const seen = new Set();
  const takes = [];
  pyIter(pyOr(src.takes, [])).forEach((t, i) => {
    if (!isDict(t)) return;
    // v1 had takes scoped to one segment (rendered from other takes); they are not
    // candidates in this model
    if (t.scope != null && t.scope !== "whole") return;
    const tid = pyStr(pyOr(t.id, `take${i}`)).trim() || `take${i}`;
    if (seen.has(tid)) return;
    seen.add(tid);
    const status = pyStr(pyOr(t.status, "queued"));
    takes.push({
      id: tid,
      seed: clampi(t.seed, 0, 2 ** 64, 0),
      prompt_id: pyText(t.prompt_id),
      file: pyText(t.file),
      status: STATUSES.includes(status) ? status : "queued",
      at: clampi(t.at, 0, 1e13, 0),
      preset: pyText(t.preset),
      summary: pyText(t.summary),
      note: pyText(t.note),
      frames: clampi(t.frames, 0, 1e6, 0),
      // how the clip was divided into shots when this take was rendered (layoutKey); ""
      // for a take from before that was recorded
      layout: pyText(t.layout),
    });
  });
  takes.sort((a, b) => a.at - b.at);
  out.takes = takes.slice(-MAX_TAKES);
  const ids = new Set(out.takes.map((t) => t.id));

  // a pick survives only while it names a segment and a take that still exists
  const picks = pyOr(src.picks, {});
  if (!isDict(picks)) throw new TypeError("picks is not a mapping");
  for (const [k, v] of Object.entries(picks)) {
    const seg = pyInt(k);
    if (seg !== null && seg >= 0 && ids.has(pyStr(v))) out.picks[String(seg)] = pyStr(v);
  }

  const c = isDict(src.composite) ? src.composite : {};
  const status = pyText(c.status);
  out.composite = {
    prompt_id: pyText(c.prompt_id),
    file: pyText(c.file),
    status: STATUSES.includes(status) ? status : "",
    at: clampi(c.at, 0, 1e13, 0),
    seed: clampi(c.seed, 0, 2 ** 64, 0),
    key: pyText(c.key),
    // what the run reported once it was done: how long the clip came out (a cut between
    // two takes can cost a few frames) and what was done at each join
    frames: clampi(c.frames, 0, 1e6, 0),
    note: pyText(c.note),
  };
  const r = isDict(src.refine) ? src.refine : {};
  const rstatus = pyText(r.status);
  out.refine = {
    prompt_id: pyText(r.prompt_id),
    file: pyText(r.file),
    status: STATUSES.includes(rstatus) ? rstatus : "",
    at: clampi(r.at, 0, 1e13, 0),
    seed: clampi(r.seed, 0, 2 ** 64, 0),
    key: pyText(r.key),
    of: pyText(r.of),
  };
  for (const [k, v] of Object.entries(src)) if (!own(out, k)) out[k] = v;   // unknown keys survive
  return out;
}

export function normalizeTakes(store) {
  return norm(isDict(store) ? jsonCopy(store) : {});
}

/** Takes a segment can pick from. */
export function finishedTakes(store) {
  return normalizeTakes(store).takes.filter((t) => t.status === "done" && t.file);
}

/** "picked" | "takes" | "none" — what the navigation timeline paints. */
export function segmentStatus(store, segment) {
  const s = normalizeTakes(store);
  if (own(s.picks, String(requireInt(segment)))) return "picked";
  return s.takes.some((t) => t.status === "done" && t.file) ? "takes" : "none";
}

export function allPicked(store, segmentCount) {
  const s = normalizeTakes(store);
  if (!(segmentCount > 0)) return false;
  for (let i = 0; i < segmentCount; i++) if (!own(s.picks, String(i))) return false;
  return true;
}

/** { plan, why }: `plan` is [{file, start, length, take}] per segment in order, or null
 *  when a segment has no pick, its take has no finished file, or the take was rendered
 *  at another clip length. `why` is then { key, args } for the caller to translate —
 *  "takesdoc.noPick" or "takesdoc.noFile" with the 1-based segment number, or
 *  "takesdoc.wrongLength" with the segment, the take's frames and the clip's — and ""
 *  otherwise. */
export function splicePlan(store, shots) {
  const s = normalizeTakes(store);
  const byId = new Map(s.takes.map((t) => [t.id, t]));
  const plan = [];
  for (let i = 0; i < shots.length; i++) {
    const tid = own(s.picks, String(i)) ? s.picks[String(i)] : "";
    if (!tid) return { plan: null, why: { key: "takesdoc.noPick", args: [i + 1] } };
    const t = byId.get(tid);
    if (!t || t.status !== "done" || !t.file) {
      return { plan: null, why: { key: "takesdoc.noFile", args: [i + 1] } };
    }
    if (t.frames) {
      const total = shots.reduce((sum, x) => sum + requireInt(x.length), 0);
      if (t.frames !== total) {
        return { plan: null, why: { key: "takesdoc.wrongLength", args: [i + 1, t.frames, total] } };
      }
    }
    plan.push({ file: t.file, start: requireInt(shots[i].start),
                length: requireInt(shots[i].length), take: tid,
                join: plan.length && shots[i].join === "continuous" ? "continuous" : "cut",
                sound: plan.length && shots[i].sound === "continuous" ? "continuous" : "cut" });
  }
  return { plan, why: "" };
}

/** The take id when every segment picked the same one, else "".
 *  A plan like that needs no composite: the take is already the final clip. */
export function singleTake(plan) {
  const ids = new Set(plan.map((p) => p.take));
  return ids.size === 1 ? [...ids][0] : "";
}

/** What a composite is made from, as one string: equal keys mean equal picks, joined the
 *  same way. */
export function planKey(plan) {
  // "~": the shot goes on; "^": the picture cuts and the sound goes on
  const mark = (p) => (p.join === "continuous" ? "~" : p.sound === "continuous" ? "^" : "");
  return plan.map((p) => `${p.file}:${requireInt(p.start)}+${requireInt(p.length)}${mark(p)}`).join("|");
}

/** How a clip is divided into shots, as one string: the frame each shot starts at, with
 *  "~" where it goes on from the shot before (a long take). A take keeps the one it was
 *  rendered with: its cuts lie where the shots were then, so when the division has changed
 *  since, the panel can say that the take is of another one. */
export function layoutKey(shots) {
  return shots.map((s, i) => `${requireInt(s.start)}${i && s.join === "continuous" ? "~" : ""}`).join(",");
}

/** Frames where the take changes: the joins a composite has to make. */
export function cutFrames(plan) {
  return plan.slice(1).filter((b, i) => plan[i].take !== b.take).map((b) => requireInt(b.start));
}

/** The joins inside a long take: two takes of one shot meet, and the frames around the
 *  join are rendered again so that the one runs into the other. */
export function seamFrames(plan) {
  return plan.slice(1).filter((b, i) => plan[i].take !== b.take && b.join === "continuous")
    .map((b) => requireInt(b.start));
}

/** The joins at a cut: two shots from two takes, put one after the other as they are. */
export function hardCuts(plan) {
  return plan.slice(1).filter((b, i) => plan[i].take !== b.take && b.join !== "continuous")
    .map((b) => requireInt(b.start));
}

export function addTake(store, {
  seed, prompt_id, preset = "", summary = "", at, id, frames = 0, layout = "",
} = {}) {
  const s = normalizeTakes(store);
  const when = at == null ? Date.now() : requireInt(at);
  const tid = pyOr(id, `t${(when || Date.now()).toString(16)}${String(s.takes.length).padStart(2, "0")}`);
  s.takes.push({ id: tid, seed: requireInt(seed), prompt_id, file: "", status: "queued",
                 at: when, preset, summary, note: "", frames, layout });
  return norm(s);
}

/** Set fields of one take. Only fields a take has are written. */
export function updateTake(store, id, fields) {
  const s = normalizeTakes(store);
  for (const t of s.takes) {
    if (t.id !== id) continue;
    for (const [k, v] of Object.entries(fields || {})) if (own(t, k)) t[k] = v;
  }
  return norm(s);
}

/** Drop a take, and with it every pick that pointed at it. */
export function removeTake(store, id) {
  const s = normalizeTakes(store);
  s.takes = s.takes.filter((t) => t.id !== id);
  for (const k of Object.keys(s.picks)) if (s.picks[k] === id) delete s.picks[k];
  return norm(s);
}

/** Pick a take for one segment; an id of null clears the pick. */
export function pickTake(store, segment, id) {
  const s = normalizeTakes(store);
  const key = String(requireInt(segment));
  if (id == null) delete s.picks[key];
  else s.picks[key] = pyStr(id);
  return norm(s);
}

/** Pick one take for every segment. */
export function pickAll(store, segmentCount, id) {
  const s = normalizeTakes(store);
  const n = requireInt(segmentCount);
  for (let i = 0; i < n; i++) s.picks[String(i)] = pyStr(id);
  return norm(s);
}

/** The numbers behind takesSummary, for a caller that words them itself. */
export function takesCounts(store, segmentCount) {
  const s = normalizeTakes(store);
  let picked = 0;
  for (let i = 0; i < segmentCount; i++) if (own(s.picks, String(i))) picked++;
  return {
    done: s.takes.filter((t) => t.status === "done").length,
    total: s.takes.length,
    picked,
    segments: segmentCount,
    composite: { status: s.composite.status, file: s.composite.file },
  };
}

/** One line for a report, worded exactly as the Python side words it. */
export function takesSummary(store, segmentCount) {
  const c = takesCounts(store, segmentCount);
  const composite = c.composite.status
    ? `composite ${c.composite.status}` + (c.composite.file ? ` ${c.composite.file}` : "")
    : "no composite";
  return `${c.done}/${c.total} takes done, ${c.picked}/${c.segments} segments picked, ${composite}`;
}
