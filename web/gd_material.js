// Gacha Director — material as the panel shows it.
//
// The document stores material clip-wide, by what the model does with it: subjects (pictures
// that define something), reference videos and audio, and anchors (a picture, a clip or a
// sound held at a frame). The panel shows it the way a person thinks of it: "the pictures of
// shot 2", each with a use picked from a short list. This file is the translation between
// the two, and it is pure: it reads a normalized document and edits a draft of one, and
// touches no DOM, so tests/material.mjs runs it under Node.
//
//   mentions   prompt text names material as @{id}; a person reads and types @name
//   uses       what a picture, a video or a sound of a shot is for, in plain words
//   modes      what the material adds up to (T2V, I2V, ...): read off it, never switched
//   budget     how much of the model's reference allowance is used
//
// A piece of material is found by id everywhere here. Positions in the lists change as
// soon as something is added or removed; ids do not.

import {
  FPS, cleanName, guideClipLength, material, mentionRe, referenceSource, resolvedFrame,
} from "./gd_doc.js";

// ---------------------------------------------------------------- mentions
// A person reads and types "@name"; the text is stored with "@{id}". The two forms have to
// turn into each other exactly, or leaving a box would change what its text means. A name
// ends where a character that cannot be part of a name begins (a space, punctuation, the
// end): "@ella_20" is not "@ella_2" followed by a nought. Where what follows a mention
// could be read as more of the name, the name is shown in braces: "@{ella}_2".

/** The character at index i of a string, whole (not half of a surrogate pair), or "". */
function charAt(s, i) {
  const cp = s.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}
/** Can this character be part of a name? Whatever cleanName would leave inside one. */
function nameChar(ch) {
  return !!ch && (ch === "_" || cleanName(`a${ch}a`) === `a${ch}a`);
}

/** Text as stored (@{id}) -> text as a person reads it (@name). What points at nothing
 *  stays as it is, so it can be seen and removed. */
export function showMentions(text, d) {
  const all = material(d);
  return String(text || "").replace(mentionRe(), (whole, id, at, str) => {
    if (!all.has(id)) return whole;
    const name = all.get(id)[2].name;
    return nameChar(charAt(str, at + whole.length)) ? `@{${name}}` : `@${name}`;
  });
}

/** Text as typed (@name, or @{name}) -> text as stored (@{id}). The longest name that ends
 *  where the name ends wins. */
export function readMentions(text, d) {
  const s = String(text || "");
  const byName = new Map();
  for (const [, [, , it]] of material(d)) byName.set(it.name, it.id);
  if (!byName.size) return s;
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "@") { out += s[i++]; continue; }
    const close = s[i + 1] === "{" ? s.indexOf("}", i + 2) : -1;
    if (close > 0) {                       // @{name}; an id in braces is left as it is
      const inner = s.slice(i + 2, close);
      out += byName.has(inner) ? `@{${byName.get(inner)}}` : s.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    const hit = names.find((n) => s.startsWith(n, i + 1) && !nameChar(charAt(s, i + 1 + n.length)));
    if (hit) { out += `@{${byName.get(hit)}}`; i += 1 + hit.length; } else out += s[i++];
  }
  return out;
}

// Every text of a document that may name material. The same list is what gd_schema.problems
// looks through for names of things that are gone, and what gd_compile resolves.
const PROMPT_FIELDS = ["global", "summary", "soundscape", "music"];

/** Run `fn` over every text of a draft that can hold a mention. */
function eachText(x, fn) {
  for (const key of PROMPT_FIELDS) x.prompt[key] = fn(String(x.prompt[key] || ""));
  for (const shot of x.prompt.shots) shot.text = fn(String(shot.text || ""));
  for (const s of x.subjects || []) s.description = fn(String(s.description || ""));
}

const LISTS = ["subjects", "videos", "audio", "anchors"];
const PREFIX = { subjects: "s", videos: "v", audio: "a", anchors: "k" };

function find(x, id) {
  for (const key of LISTS) {
    const i = (x[key] || []).findIndex((it) => it.id === id);
    if (i >= 0) return [key, i, x[key][i]];
  }
  return null;
}

/** An id nothing in the draft has yet, for the list `key`. */
export function freeId(x, key) {
  const taken = new Set(LISTS.flatMap((k) => (x[k] || []).map((it) => it.id)));
  let n = 1;
  while (taken.has(`${PREFIX[key]}${n}`)) n++;
  return `${PREFIX[key]}${n}`;
}

/** What can be named in a shot's text: the shot's own material first, then what is shared.
 *  [{id, name, kind: "subject" | "picture" | "video" | "audio", own}] */
export function mentionable(d, shotId) {
  const out = [];
  const add = (it, kind) => out.push({ id: it.id, name: it.name, kind, own: it.shot === shotId, shot: it.shot });
  for (const it of d.subjects) add(it, "subject");
  // the base model is given no labels: there, only a subject is anything a prompt can name
  if (d.family === "reference") {
    for (const it of d.anchors) if (it.kind === "image" && it.cite) add(it, "picture");
    for (const it of d.videos) add(it, "video");
    for (const it of d.audio) add(it, "audio");
  }
  const here = (it) => it.own || it.shot === "";
  return [...out.filter((it) => it.own), ...out.filter((it) => !it.own && here(it)),
          ...out.filter((it) => !here(it))];
}

/** What a piece of material is called in running text. */
const wordsOf = (it) => String(it.short_name || it.name || "").replace(/_/g, " ").trim();

/** A text for a document that holds only some of this one's material: every other thing
 *  the text names is said in plain words. `keep` are the ids that go along. */
export function plainMentions(text, d, keep = []) {
  const things = material(d);
  return String(text || "").replace(mentionRe(), (whole, id) => {
    if (keep.includes(id)) return whole;
    return things.has(id) ? wordsOf(things.get(id)[2]) : "";
  });
}

/** Remove a piece of material. Where the text named it, its name stays as plain words. */
export function removeMaterial(x, id) {
  const hit = find(x, id);
  if (!hit) return;
  const [key, i, it] = hit;
  x[key].splice(i, 1);
  const words = wordsOf(it);
  eachText(x, (text) => text.split(`@{${id}}`).join(words));
  if (key === "subjects") for (const a of x.audio) if (a.subject === id) a.subject = "";
}

// ---------------------------------------------------------------- uses
// What one of a shot's pictures, videos or sounds is for. A use is a few fields of one of
// two kinds of record, so changing it may move the item to the other list; its mentions
// follow it there.
export const IMAGE_USES = ["subject", "first", "last", "frame", "storyboard"];
export const VIDEO_USES = ["motion", "continue"];
export const AUDIO_USES = ["voice", "sound", "play"];

/** The use of an item, given the list it is in. */
export function useOf(key, it) {
  if (key === "subjects") return "subject";
  if (key === "videos") return "motion";
  if (key === "audio") return it.subject ? "voice" : "sound";
  if (it.kind === "clip") return "continue";
  if (it.kind === "audio") return "play";
  if (it.role === "storyboard") return "storyboard";
  return it.at === "first" ? "first" : it.at === "last" ? "last" : "frame";
}

/** The fields of an anchor for a use of a picture. */
function anchorFor(use, at) {
  if (use === "first") return { at: "first", offset: 0, pin: true, cite: true, role: "auto" };
  if (use === "last") return { at: "last", offset: 0, pin: true, cite: true, role: "auto" };
  if (use === "storyboard") return { at: "first", offset: 0, pin: false, cite: true, role: "storyboard" };
  return { at: "offset", offset: Math.max(1, at | 0), pin: true, cite: true, role: "auto" };
}

/** Add a picture to a shot ("" = shared). Returns the new id. */
export function addImage(x, shotId, file, use = "subject", at = 1) {
  if (use === "subject" || !shotId) {
    const id = freeId(x, "subjects");
    x.subjects.push({ id, shot: shotId, images: [file], description: "" });
    return id;
  }
  const id = freeId(x, "anchors");
  x.anchors.push({ id, shot: shotId, kind: "image", file, ...anchorFor(use, at) });
  return id;
}

/** How many frames of a video a continuation is given to start from, where there is room. */
const CONTINUE_FRAMES = 22;

/** Which frames of a video a continuation takes: its last ones, `want` of them, or as many
 *  as normalize leaves a clip that is held at `frame` (fewer when the clip ends sooner than
 *  that), so that what is kept is still the end of the video. `info` is what the server
 *  knows of the file ({frames24, frames}); a file it has not probed is taken from its
 *  first frame, and the row's start frame shows it. */
function tailOf(x, frame, info, want = CONTINUE_FRAMES) {
  const frames = info ? (info.frames24 || info.frames || 0) : 0;
  const room = frame >= 0 && x.derived ? x.derived.frame_count - frame : want;
  const length = guideClipLength(Math.min(want, room));
  return { clip_start: Math.max(0, frames - length), clip_length: length };
}

/** The anchor that continues a video: its last frames, held at the start of a shot of `x`. */
function clipFor(x, shotId, file, info, withAudio) {
  const shot = x.prompt.shots.find((s) => s.id === shotId);
  return { kind: "clip", file, at: "first", offset: 0, ...tailOf(x, shot ? shot.start : -1, info),
           with_audio: !!withAudio };
}

export function addVideo(x, shotId, file, use = "motion", info = null) {
  if (use === "motion" || !shotId) {
    const id = freeId(x, "videos");
    x.videos.push({ id, shot: shotId, file });
    return id;
  }
  const id = freeId(x, "anchors");
  x.anchors.push({ id, shot: shotId, ...clipFor(x, shotId, file, info, info && info.audio) });
  return id;
}

/** Another file for something already in the clip. A video a shot carries on from is
 *  taken from the end of the new file, at the length it had and where it sits: where the
 *  old one was taken from says nothing about this one, and may lie past its last frame. */
export function setFile(x, id, file, info = null) {
  const hit = find(x, id);
  if (!hit || !file) return;
  const it = hit[2];
  if (hit[0] === "anchors" && it.kind === "clip") {
    Object.assign(it, tailOf(x, it.frame, info, it.clip_length || CONTINUE_FRAMES));
  }
  it.file = file;
}

export function addAudio(x, shotId, file, use = "sound") {
  if (use !== "play" || !shotId) {
    const id = freeId(x, "audio");
    x.audio.push({ id, shot: shotId, file, subject: "" });
    return id;
  }
  const id = freeId(x, "anchors");
  x.anchors.push({ id, shot: shotId, kind: "audio", file, at: "first", offset: 0 });
  return id;
}

/** Change what an item is for. `at` is the frame inside the shot, for use "frame"; `info`
 *  is what the server knows of a video's file, for use "continue". */
export function setUse(x, id, use, at = 1, info = null) {
  const hit = find(x, id);
  if (!hit) return id;
  const [key, i, it] = hit;
  const was = useOf(key, it);
  if (was === use) return id;
  // a subject with several pictures (or none) is not one picture: it stays a subject
  if (key === "subjects" && use !== "subject" && (it.images || []).length !== 1) return id;
  const kept = it.retention ? { retention: it.retention } : {};
  const move = (toKey, record) => {
    const nid = freeId(x, toKey);
    x[key].splice(i, 1);
    x[toKey].push({ ...record, id: nid, name: it.name, shot: it.shot });
    eachText(x, (text) => text.split(`@{${id}}`).join(`@{${nid}}`));
    if (key === "subjects") for (const a of x.audio) if (a.subject === id) a.subject = "";
    return nid;
  };
  if (IMAGE_USES.includes(use)) {
    if (key === "subjects") {                 // a subject's picture becomes a frame
      return move("anchors", { kind: "image", file: it.images[0], ...kept, ...anchorFor(use, at) });
    }
    if (use === "subject") return move("subjects", { images: [it.file], description: "", ...kept });
    Object.assign(it, anchorFor(use, at));
    return id;
  }
  if (VIDEO_USES.includes(use)) {
    if (use === "continue") return move("anchors", clipFor(x, it.shot, it.file, info, it.audio));
    return move("videos", { file: it.file, audio: !!it.with_audio, desc: it.desc || "" });
  }
  if (use === "play") return move("anchors", { kind: "audio", file: it.file, at: "first", offset: 0 });
  if (key === "anchors") return move("audio", { file: it.file, subject: "" });
  if (use === "sound") it.subject = "";
  return id;                                  // "voice": the caller sets whose
}

// ---------------------------------------------------------------- prompts and shots
/** Is this line something somebody says ("@name says quietly: ...")? The planner reads such
 *  a line as a line: run into other text, it is narration. */
export const spokenLine = (line) => /^\s*@[^\s:]+[^:\n]*:\s*\S/.test(line || "");

const SENTENCE = /[^.!?。！？]+[.!?。！？]+["'”’)\]]*|[^.!?。！？]+$/g;

/**
 * Spread the shots' text over the shots again: sentences in order, each shot taking a share
 * of the text proportional to its length in frames. The whole-clip description written
 * before the cuts existed is the normal case, and this is how it gets split without
 * retyping it. A spoken line moves as a whole and stays a line of its own. Every shot's
 * text is joined first, so doing it twice is stable. Returns one text per shot.
 */
export function spreadText(shots) {
  const units = [];                    // [text, a spoken line?]
  let prose = [];
  const flush = () => {
    const text = prose.join(" ").replace(/\s+/g, " ").trim();
    prose = [];
    // (text in which no sentence is found, "..." say, is one unit: nothing typed is dropped)
    for (const u of (text.match(SENTENCE) || (text ? [text] : []))) if (u.trim()) units.push([u.trim(), false]);
  };
  for (const s of shots) {
    for (const line of String(s.text || "").split("\n")) {
      if (spokenLine(line)) { flush(); units.push([line.trim(), true]); } else prose.push(line);
    }
  }
  flush();
  if (!units.length) return shots.map((s) => s.text || "");
  const chars = units.reduce((a, u) => a + u[0].length, 0) || 1;
  const total = shots.reduce((a, s) => a + s.length, 0) || 1;
  // char-space boundaries proportional to frames, then each unit goes where its middle
  // falls: order is preserved by construction
  const bounds = [];
  let acc = 0;
  for (const s of shots) { acc += s.length; bounds.push((chars * acc) / total); }
  const buckets = shots.map(() => []);
  let pos = 0;
  for (const u of units) {
    const mid = pos + u[0].length / 2;
    let i = bounds.findIndex((b) => mid < b);
    if (i < 0) i = shots.length - 1;
    buckets[i].push(u);
    pos += u[0].length + 1;
  }
  // A shot left empty while a neighbour holds several reads as a bug, so pull one across,
  // from the left neighbour's tail or the right one's head, order intact.
  for (let pass = 0; pass < shots.length; pass++) {
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length) continue;
      if (i > 0 && buckets[i - 1].length > 1) buckets[i].push(buckets[i - 1].pop());
      else if (i < buckets.length - 1 && buckets[i + 1].length > 1) buckets[i].push(buckets[i + 1].shift());
    }
  }
  return buckets.map((list) => list.reduce(
    (text, [u, own], k) => text + (k === 0 ? "" : own || list[k - 1][1] ? "\n" : " ") + u, ""));
}

// ---------------------------------------------------------------- shots change
/** Before a cut is added or removed: let every anchor find its shot again from the frame
 *  it is on. normalize puts an anchor that has a frame and no shot into the shot that
 *  frame is in, at the end of it when it sat on an end. */
export function loosenAnchors(x) {
  for (const a of x.anchors) {
    delete a.shot;
    delete a.at;
    delete a.offset;
  }
}

/** A shot is merged into another: what belonged to it belongs to that one now. */
export function rehome(x, fromId, intoId) {
  for (const key of ["subjects", "videos", "audio"]) {
    for (const it of x[key]) if (it.shot === fromId) it.shot = intoId;
  }
}

// ---------------------------------------------------------------- modes
// What people call a mode is read off the material. Nothing is switched: the model has no
// such switch, and a selector beside the material could only disagree with it.
export const MODES = ["t2v", "i2v", "fl2v", "keyframes", "r2v", "v2v", "rv2v", "continue"];

function framePictures(d, test) {
  return d.anchors.filter((a) => a.kind === "image" && a.pin && test(a));
}

/** The mode of the whole clip. */
export function clipMode(d) {
  const fc = d.derived.frame_count;
  const refs = d.subjects.length + (d.family === "reference" ? d.videos.length + d.audio.length : 0);
  if (d.anchors.some((a) => a.kind === "clip" && resolvedFrame(a, fc) === 0)) return "continue";
  if (d.source.video) {
    if (referenceSource(d)) {
      if (d.source.role === "continue") return "continue";
      if (d.source.role === "edit") return d.subjects.length ? "rv2v" : "v2v";
      return "r2v";
    }
    if (d.source.as_latent) return d.subjects.length ? "rv2v" : "v2v";
  }
  if (d.family === "reference" && refs) return "r2v";
  const first = framePictures(d, (a) => resolvedFrame(a, fc) === 0).length > 0;
  const last = framePictures(d, (a) => resolvedFrame(a, fc) === fc - 1).length > 0;
  const mid = framePictures(d, (a) => resolvedFrame(a, fc) > 0 && resolvedFrame(a, fc) < fc - 1).length > 0;
  if (mid) return "keyframes";
  if (first && last) return "fl2v";
  if (first) return "i2v";
  if (last) return "fl2v";
  return "t2v";
}

/** The mode of one shot: what its own material, and what its text names, add up to. */
export function shotMode(d, shot) {
  const whole = clipMode(d);
  if (whole === "v2v" || whole === "rv2v") return whole;
  const said = new Set([...String(shot.text || "").matchAll(mentionRe())].map((m) => m[1]));
  const uses = (it) => it.shot === shot.id || said.has(it.id);
  const refs = d.subjects.some(uses)
    || (d.family === "reference" && (d.videos.some(uses) || d.audio.some(uses)));
  const mine = d.anchors.filter((a) => a.shot === shot.id);
  if (mine.some((a) => a.kind === "clip")) return "continue";
  const pics = mine.filter((a) => a.kind === "image" && a.pin);
  const first = pics.some((a) => a.at === "first"), last = pics.some((a) => a.at === "last");
  if (refs) return "r2v";
  if (pics.some((a) => a.at === "offset")) return "keyframes";
  if (first && last) return "fl2v";
  if (first) return "i2v";
  if (last) return "fl2v";
  return "t2v";
}

// ---------------------------------------------------------------- budget
/** How much of the model's reference allowance the clip uses. The allowance is for the
 *  whole clip: every shot's material goes into one sequence. */
export function budget(d) {
  const reference = d.family === "reference";
  const images = d.subjects.reduce((n, s) => n + s.images.length, 0)
    + d.anchors.filter((a) => a.cite).length;
  const videos = reference ? d.videos.length + (referenceSource(d) ? 1 : 0) : 0;
  const tracks = reference ? (referenceSource(d) && d.source.audio ? 1 : 0)
    + d.videos.filter((v) => v.audio).length : 0;
  const audio = reference ? d.audio.length + tracks : 0;
  return { reference, images, videos, audio, files: images + videos + audio,
           max: { images: 9, videos: 3, audio: 3, files: 12 } };
}

/** Seconds, to two places, the way the panel writes a time. */
export const seconds = (frames) => (frames / FPS).toFixed(2);
