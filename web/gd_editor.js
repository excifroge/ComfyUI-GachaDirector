// Gacha Director — the panel orchestrator.
//
// Knows nothing about ComfyUI. The adapter (gd_director.js) hands it a `host` that reads
// and writes the node's widgets, resolves URLs, listens to the server event stream and
// queues a prompt. This file owns the modal, the five pages, the undo stack, the run
// tracker, and the one rule that makes the whole thing predictable:
//
//   every write goes to a widget, and every read comes back from that widget.
//
// There is no panel-side copy of the state, no snapshot on the node object and no proxy
// widget: two sources of truth for one field always drift, and then a copied workflow
// carries whichever one was wrong.
//
// Four JSON widgets hold everything: gd_timeline (the clip), gd_post (preview and save),
// gd_presets (run settings + timing history), gd_takes (candidates, picks, composite).
// The undo stack snapshots the first three; takes are a record of what the server did
// and are never undone.

import { t, getLang } from "./gd_i18n.js";
import { createModal, PAGES } from "./gd_modal.js";
import { createHistory } from "./gd_history.js";
import { fileKind } from "./gd_ui.js";
import { createLibrary, mergeIndex, normalizeIndex } from "./gd_library.js";
import {
  cellsLatents, latentBounds, normalize, seamAuto, seamCells, seamLatents, SEAM_MOST,
} from "./gd_doc.js";
import { plainMentions } from "./gd_material.js";
import { normalizePost } from "./gd_post_doc.js";
import {
  activePreset, clearHistory, normalizeParams, normalizePresets, paramSummary, paramsSignature,
  recordRun,
} from "./gd_presets_doc.js";
import {
  addTake, hardCuts, layoutKey, normalizeTakes, pickAll, pickTake, planKey, refineCuts, removeTake, seamFrames,
  singleTake,
  splicePlan,
  updateTake,
} from "./gd_takes_doc.js";
import { createRunPage } from "./gd_page_run.js";
import { createEditPage } from "./gd_page_edit.js";
import { createTakesPage } from "./gd_page_takes.js";
import { createPostPage } from "./gd_page_post.js";
import { createResultsPage } from "./gd_page_results.js";

export { normalize };            // tests/gd_parity.js checks this against the Python side
export { PAGES };

export function createEditor(host) {
  const state = {
    media: { images: [], videos: [], audio: [], renders: [] },
    pages: {},
    modal: null,
    history: null,
    seeded: false,
    // run tracker: prompt_id -> {startedAt, presetId}
    running: new Map(),
    queuedRun: new Map(),         // prompt_id -> {presetId, summary, frames} as queued
    queuing: false,               // a batch is being sent: no second one alongside it
    started: new Map(),           // the same, for prompts the Run button queued
    current: "",                  // the prompt the server is executing now
    mine: new Set(),              // prompts in which this node actually ran
    span: new Map(),              // prompt_id -> {acc, since}: how long the server was on this node
    verdict: new Map(),           // announced prompt_id -> promise of "mine" | "foreign" | "unknown"
    held: null,                   // the newest preview, kept back until it is known whose run it is
    late: "",                     // a prompt whose start was missed, asked about once
    live: null,                   // the newest sampling preview: {webp, step, total, fps}
    takesFallback: null,          // used only when the node has no gd_takes widget yet
  };

  // ------------------------------------------------------------------ reads
  function doc() { return normalize(host.readDocument()); }
  function post() { return normalizePost(host.readPost()); }
  function presets() { return normalizePresets(host.readPresets()); }
  function takes() {
    if (host.hasTakesWidget && !host.hasTakesWidget()) {
      return normalizeTakes(state.takesFallback || {});
    }
    return normalizeTakes(host.readTakes());
  }
  /** The parameters actually in force: the active preset, plus the node's own seed. */
  function run() {
    const p = normalizeParams(activePreset(presets()).params);
    const seed = host.getWidget("seed");
    p.seed = seed == null ? 0 : Number(seed);
    p.sampler = p.sampler_name;
    return p;
  }

  // ------------------------------------------------------------------ writes
  function writeAll(next, label) {
    if (next.doc !== undefined) host.writeDocument(normalize(next.doc));
    if (next.post !== undefined) host.writePost(normalizePost(next.post));
    if (next.presets !== undefined) host.writePresets(normalizePresets(next.presets));
    if (next.picks !== undefined) {
      // Only the picks: the takes themselves are a record of what the server did.
      // normalize drops a pick whose take has been deleted since.
      const tk = takes();
      tk.picks = next.picks;
      writeTakesStore(normalizeTakes(tk));
    }
    host.markDirty();
    if (state.history && label) state.history.push(label);
    refresh();
  }
  function writeTakesStore(s) {
    if (host.hasTakesWidget && !host.hasTakesWidget()) state.takesFallback = s;
    else host.writeTakes(s);
  }
  function commitDoc(next, label) {
    const d = normalize(next);
    // What makes this clip this clip, across runs: the results page matches history
    // entries on it. Made once, here, because normalize has to stay a pure function.
    if (!d.uid) d.uid = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // A pre-v3 document arrives with its old run block in _legacy_run. Fold it into a
    // preset once, then drop the key so it never masquerades as live state.
    if (d._legacy_run) {
      const legacy = d._legacy_run;
      delete d._legacy_run;
      const store = presets();
      const side = Number(legacy.size) || 0;
      const params = normalizeParams({
        ...activePreset(store).params,
        ...(side ? { megapixels: (side * side) / (1024 * 1024) } : {}),
        ...legacy,
        sampler_name: legacy.sampler || activePreset(store).params.sampler_name,
      });
      store.presets.push({
        id: `legacy${Date.now().toString(36)}`,
        name: t("h.legacyTask"),
        note: t("h.legacyTaskNote"),
        takes: 1,
        params,
        history: { runs: [], count: 0, last_seconds: 0, last_at: 0, avg_seconds: 0, signature: "" },
      });
      store.active = store.presets[store.presets.length - 1].id;
      if (legacy.seed != null) host.setWidget("seed", legacy.seed);
      host.writePresets(normalizePresets(store));
    }
    host.writeDocument(d);
    host.markDirty();
    if (state.history) state.history.push(label || t("h.edit"));
    refresh();
  }
  function patchDoc(mutate, label) {
    const d = normalize(host.readDocument());
    mutate(d);
    commitDoc(d, label);
  }
  function commitPost(next, label) {
    host.writePost(normalizePost(next));
    host.markDirty();
    if (state.history) state.history.push(label || t("h.post"));
    refresh();
  }
  function patchPost(sectionName, patch) {
    const c = post();
    c[sectionName] = { ...c[sectionName], ...patch };
    commitPost(c, t("h.postSection", sectionName));
  }
  function commitPresets(next, label) {
    host.writePresets(normalizePresets(next));
    host.markDirty();
    if (state.history) state.history.push(label || t("h.task"));
    refresh();
  }
  /** Takes are a record of what the server did — written, never undone. (The picks are
   *  the exception: undo restores them together with the shots they belong to.) */
  function commitTakes(next) {
    writeTakesStore(normalizeTakes(next));
    host.markDirty();
    refresh();
  }

  // ------------------------------------------------------------------ preset actions
  const presetApi = {
    selectPreset(id) {
      const s = presets();
      s.active = id;
      commitPresets(s, t("h.taskSwitch"));
    },
    addPreset() {
      const s = presets();
      const id = `preset${Date.now().toString(36)}`;
      s.presets.push({
        id, name: t("h.newTaskName", s.presets.length + 1), note: "", takes: activePreset(s).takes,
        params: normalizeParams(activePreset(s).params),
        history: { runs: [], count: 0, last_seconds: 0, last_at: 0, avg_seconds: 0, signature: "" },
      });
      s.active = id;
      commitPresets(s, t("h.taskNew"));
    },
    duplicatePreset(id) {
      const s = presets();
      const src = s.presets.find((p) => p.id === id);
      if (!src) return;
      const nid = `${id}_copy${Date.now().toString(36).slice(-3)}`;
      s.presets.push({
        id: nid, name: t("h.copySuffix", src.name), note: src.note, takes: src.takes,
        params: { ...src.params },
        history: { runs: [], count: 0, last_seconds: 0, last_at: 0, avg_seconds: 0, signature: "" },
      });
      s.active = nid;
      commitPresets(s, t("h.taskDup"));
    },
    renamePreset(id, name) {
      const s = presets();
      const p = s.presets.find((x) => x.id === id);
      if (!p) return;
      p.name = String(name || p.id);
      commitPresets(s, t("h.taskRename"));
    },
    patchPreset(id, patch) {
      const s = presets();
      const p = s.presets.find((x) => x.id === id);
      if (!p) return;
      Object.assign(p, patch);
      commitPresets(s, t("h.taskProps"));
    },
    patchPresetParams(id, patch) {
      const s = presets();
      const p = s.presets.find((x) => x.id === id);
      if (!p) return;
      p.params = normalizeParams({ ...p.params, ...patch });
      // normalizePresets drops timings whose signature no longer matches when
      // auto_reset_on_change is on, so the average never describes settings that changed.
      commitPresets(s, t("h.taskParams"));
    },
    deletePreset(id) {
      const s = presets();
      if (s.presets.length < 2) return;
      s.presets = s.presets.filter((p) => p.id !== id);
      if (s.active === id) s.active = s.presets[0].id;
      commitPresets(s, t("h.taskDelete"));
    },
    patchSettings(patch) {
      const s = presets();
      s.settings = { ...s.settings, ...patch };
      commitPresets(s, t("h.histSettings"));
    },
    clearHistory(id) {
      commitPresets(clearHistory(presets(), id), t("h.histClear"));
    },
  };

  // ------------------------------------------------------------------ takes actions
  // Everything here that waits on the server re-reads the store afterwards. A take can
  // finish, be picked or be deleted while a request is in flight, and writing back a
  // copy taken before the wait would undo it.
  const VIDEO_RE = /\.(mp4|webm|mkv|mov)$/i;

  /**
   * The video this node saved in a finished prompt. The expansion's nodes report under
   * ids that start with this node's ("7.0.0.28" for node 7), which is what tells its
   * SaveVideo from any other one in the graph.
   */
  function outputVideoOf(entry) {
    const mine = String(host.nodeId());
    for (const [key, out] of Object.entries(entry?.outputs || {})) {
      if (!isMine(key) || key === mine) continue;
      for (const kind of ["images", "gifs", "video", "videos"]) {
        for (const item of (out?.[kind] || [])) {
          if (!item || !item.filename || !VIDEO_RE.test(item.filename)) continue;
          // keep the subfolder: a save prefix like "video/clip" lands in output/video/,
          // and the composite reads the take back from there
          return item.subfolder ? `${item.subfolder}/${item.filename}` : item.filename;
        }
      }
    }
    return "";
  }

  /** Prompt ids the server still has in its queue, running or waiting. Throws when the
   *  answer is not the queue (an error from a server that is restarting, or from what
   *  stands in front of it): that says nothing about what is queued, and a take must not
   *  be given up for lost on it. */
  async function queuedPromptIds() {
    const ids = new Set();
    const res = await fetch(host.apiUrl("/queue"), { cache: "no-store" });
    if (!res.ok) throw new Error(`queue: HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) {
      throw new Error("queue: not a queue");
    }
    for (const item of [...data.queue_running, ...data.queue_pending]) {
      if (item && item[1]) ids.add(String(item[1]));
    }
    return ids;
  }

  /** What became of a prompt: {status, file}, or null while the server is still on it. */
  async function outcomeOf(promptId, queued) {
    let entry = null;
    try { entry = await host.fetchHistory(promptId); } catch (e) { return null; }
    if (entry) {
      const ok = (entry.status?.status_str || "") === "success";
      const file = ok ? outputVideoOf(entry) : "";
      // a composite also says how long it came out and what it did at every join
      const said = (name) => {
        for (const [key, out] of Object.entries(entry.outputs || {})) {
          if (isMine(key) && out && out[name] && out[name].length) return out[name][0];
        }
        return null;
      };
      return { status: ok ? (file ? "done" : "missing") : "failed", file,
               frames: Number(said("gd_frames")) || 0, note: String(said("gd_cuts") || ""),
               starts: String(said("gd_starts") || "") };
    }
    // not finished and not queued either: cleared from the queue, or the server restarted
    if (queued && !queued.has(promptId) && !state.running.has(promptId)) return { status: "missing", file: "" };
    return null;
  }

  /**
   * Why the server refused a prompt, in ComfyUI's own words: the first few node errors
   * ("CLIPLoader 2: Value not in list (clip_name: ...)"), or the error's message.
   */
  function refusal(e) {
    const r = e && e.response;
    const out = [];
    for (const [id, ne] of Object.entries((r && r.node_errors) || {})) {
      for (const er of (ne && ne.errors) || []) {
        const details = er.details ? ` (${String(er.details).slice(0, 140)})` : "";
        out.push(`${(ne && ne.class_type) || "node"} ${id}: ${er.message || er.type || "error"}${details}`);
      }
    }
    if (!out.length && e && e.code === "node_missing") return t("takes.nodeMissing");
    if (!out.length && r && r.error) out.push(String(r.error.message || r.error.type || r.error));
    if (!out.length && e) out.push(String(e.message || e));
    return out.slice(0, 3).join(" · ");
  }

  /** A clip gets its uid the first time it is committed. Opening the panel and queueing
   *  takes make sure it has one, so the results page can tell this clip's runs apart. */
  function ensureUid() {
    if (!doc().uid) commitDoc(doc(), t("h.edit"));
  }

  /**
   * What is generated again around each seam of a plan, seam by seam: its own long take is
   * where a range ends, whatever another seam frees beyond it (the mask is the union of
   * them all, but the bar a seam is shown as, and the ends that are dragged, are its own).
   *
   *   frame, shot   the seam: the first frame of that shot
   *   kind          "auto" (left to itself), "own" (a pair of numbers), "old" (no range of
   *                 its own: `mask.radius` cells on either side, as before there were ranges)
   *   lo, end       the frames freed, end exclusive; both `frame` when nothing is
   *   limited       less is freed than was asked: the long take ends there
   *   mineLo/End    the latent frame the seam is in (on a line: the seam itself, twice):
   *                 it is freed whenever anything is, and no end can cross it
   *   lines         where latent frames begin in the long take (and where the last ends)
   *   leftLines, rightLines   where either end may be put: its side of the seam, inside the
   *                 long take, and no further out than a range can be stored
   *   alike         how alike the two takes are where they meet (dB), null until measured
   */
  function seamRanges(d, plan) {
    const g = d.derived;
    const shots = d.prompt.shots;
    const bounds = latentBounds(g.frame_count);
    return seamFrames(plan).map((f) => {
      const shot = shots.findIndex((x) => x.start === f);
      const x = shots[shot];
      let a = shot;
      while (a > 0 && shots[a].join === "continuous") a--;
      let b = shot;
      while (b + 1 < shots.length && shots[b + 1].join === "continuous") b++;
      const from = shots[a].start;
      const to = shots[b].start + shots[b].length;
      const within = (t) => bounds[t][0] >= from && bounds[t][1] < to;
      let asked, got;
      if (x.seam) {
        asked = x.seam === "auto" ? seamAuto(f, g) : seamLatents(f, g, x.seam[0], x.seam[1]);
        got = asked.filter(within);
      } else {
        // whole cells, and a cell is freed whole or not at all
        const cells = seamCells([f], g, d.mask.radius);
        asked = cellsLatents(cells, g.cell_count);
        got = cellsLatents(cells.filter((c) => g.cells[c][0] >= from && g.cells[c][1] < to), g.cell_count);
      }
      const mine = bounds.findIndex(([lo, hi]) => lo <= f && f <= hi);
      const onLine = bounds[mine][0] === f;
      const inside = bounds.map((_, t) => t).filter(within);
      const lines = inside.map((t) => bounds[t][0]);
      if (inside.length) lines.push(bounds[inside[inside.length - 1]][1] + 1);
      const firstAfter = mine + (onLine ? 0 : 1);     // the first latent frame behind the seam's own
      const here = plan.findIndex((p) => p.start === f);
      return {
        frame: f, shot, id: x.id, kind: x.seam === "auto" ? "auto" : x.seam ? "own" : "old",
        latents: got, limited: got.length < asked.length,
        alike: here > 0 ? alikeAt(plan[here - 1].file, plan[here].file, f) : null,
        lo: got.length ? bounds[got[0]][0] : f, end: got.length ? bounds[got[got.length - 1]][1] + 1 : f,
        mineLo: bounds[mine][0], mineEnd: onLine ? f : bounds[mine][1] + 1,
        from, to, lines,
        leftLines: inside.filter((t) => t <= mine && mine - t <= SEAM_MOST).map((t) => bounds[t][0]),
        rightLines: [...inside, inside.length ? inside[inside.length - 1] + 1 : mine]
          .filter((t) => t >= firstAfter && t - firstAfter <= SEAM_MOST)
          .map((t) => (t < bounds.length && inside.includes(t) ? bounds[t][0] : bounds[t - 1][1] + 1)),
      };
    });
  }

  /** What a composite was rendered from: the picks, and how the seam was to be repaired. */
  function compositeKey(d, plan) {
    // While no seam of the plan has a range of its own the key is the one from before there
    // were ranges: a composite made then is still the composite of these picks. Otherwise
    // it is made of the mask itself, the latent frames freed by all the seams together: a
    // range that the long take cuts off anyway, one that another seam covers, or a radius
    // no seam uses, change nothing and must not make a composite stale.
    const ranges = seamRanges(d, plan);
    const base = `${planKey(plan)}#r${d.mask.radius}#s${d.mask.seam_denoise}`;
    if (ranges.every((r) => r.kind === "old")) return base;
    const free = [...new Set(ranges.flatMap((r) => r.latents))].sort((a, b) => a - b);
    const runs = [];
    for (const t of free) {
      if (runs.length && runs[runs.length - 1][1] === t - 1) runs[runs.length - 1][1] = t;
      else runs.push([t, t]);
    }
    return `${planKey(plan)}#s${d.mask.seam_denoise}#v2:${runs.map(([a, b]) => `${a}-${b}`).join(",")}`;
  }

  // ------------------------------------------------------------------ where takes really cut
  // The model puts a cut a few frames off the frame it is asked for, differently in every
  // take. A take's shot is shown, and joined, from where the take really cuts into it to
  // where it really cuts out of it. The server measures a file; the answer is kept here,
  // by file and by the cuts that were asked about.
  // "file|cuts|total" -> {real: [real frame per cut] or null, asking, again, failedAt}
  const cutsKnown = new Map();
  let cutsTimer = 0;
  const CUTS_BATCH = 64;              // the server answers for this many files a request
  const CUTS_RETRY_MS = 30000;        // a file it could not read is asked about again after this

  /** The frames of a take that are one shot: [first, last]. The frames asked for until the
   *  server has said where the take cuts. A boundary inside a long take is no cut and stays
   *  where it is, as far as it lies in the long take as the take really has it: from the
   *  cut into it to the cut out of it. (A stretch that a late cut leaves nothing of is one
   *  frame of its long take, never frames of the shot before.) */
  function realRange(file, shotIndex) {
    const d = doc();
    const shots = d.prompt.shots;
    const s = shots[shotIndex];
    if (!s) return [0, 0];
    const asked = [s.start, s.start + s.length - 1];
    if (!file) return asked;
    const cuts = shots.slice(1).filter((x) => x.join !== "continuous").map((x) => x.start);
    if (!cuts.length) return asked;
    const key = `${file}|${cuts.join(",")}|${d.derived.frame_count}`;
    let known = cutsKnown.get(key);
    if (!known) {
      known = { real: null, asking: false, again: true, failedAt: 0 };
      cutsKnown.set(key, known);
    }
    if (known.again || (known.failedAt && Date.now() - known.failedAt > CUTS_RETRY_MS)) {
      known.again = false;
      known.failedAt = 0;
      known.asking = true;
      if (!cutsTimer) cutsTimer = setTimeout(fetchCuts, 60);       // one request for a page of takes
    }
    const real = known.real;
    if (!real) return asked;
    const at = (frame) => { const i = cuts.indexOf(frame); return i < 0 ? frame : real[i]; };
    let a = shotIndex;
    while (a > 0 && shots[a].join === "continuous") a--;
    let b = shotIndex;
    while (b + 1 < shots.length && shots[b + 1].join === "continuous") b++;
    const from = a === 0 ? 0 : at(shots[a].start);
    const to = (b + 1 < shots.length ? at(shots[b + 1].start) : d.derived.frame_count) - 1;
    if (to < from) return asked;
    const inside = (frame) => Math.min(Math.max(frame, from), to);
    const first = shotIndex === a ? from : inside(asked[0]);
    const last = shotIndex === b ? to : inside(asked[1]);
    return last >= first ? [first, last] : [first, first];
  }
  // ------------------------------------------------------------------ how alike two takes are
  // Where two takes meet inside a long take, what joining can do depends on how alike they
  // are there, more than on how much is generated again. The server measures a pair at a
  // frame; the answer is kept here. "a|b|frame" -> {db: number or null, asking}
  const alikeKnown = new Map();
  let alikeTimer = 0;
  /** dB between two takes around a frame, or null until the server has said. */
  function alikeAt(a, b, frame) {
    if (!a || !b || a === b) return null;
    const key = `${a}|${b}|${frame}`;
    let known = alikeKnown.get(key);
    if (!known) {
      known = { db: null, asking: false, failedAt: 0 };
      alikeKnown.set(key, known);
    }
    // not known yet, and not asked (or asked in vain a while ago: a take still being written)
    if (known.db == null && !known.asking && Date.now() - known.failedAt > CUTS_RETRY_MS) {
      known.asking = true;
      if (!alikeTimer) alikeTimer = setTimeout(fetchAlike, 80);
    }
    return known.db;
  }
  async function fetchAlike() {
    alikeTimer = 0;
    const waiting = [...alikeKnown.entries()].filter(([, v]) => v.asking).map(([k]) => k);
    if (!waiting.length) return;
    let answers = [];
    try {
      const res = await fetch(host.apiUrl("/gachadirector/alike"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: waiting.map((k) => { const [a, b, f] = k.split("|"); return [a, b, Number(f)]; }) }),
      });
      const data = await res.json();
      answers = (data && data.db) || [];
    } catch (e) { answers = []; }
    let changed = false;
    waiting.forEach((key, i) => {
      const known = alikeKnown.get(key);
      known.asking = false;
      if (typeof answers[i] === "number") { known.db = answers[i]; changed = true; }
      else known.failedAt = Date.now();       // asked again later, not on every drawing
    });
    if (changed && attached()) refresh();
  }

  /** Ask again where every take cuts, keeping the answers in use until the new ones are in:
   *  a file written again under its name cuts somewhere else. */
  function forgetCuts() {
    for (const known of cutsKnown.values()) known.again = true;
  }
  async function fetchCuts() {
    cutsTimer = 0;
    const waiting = [...cutsKnown.entries()].filter(([, v]) => v.asking).map(([k]) => k);
    // keys of one clip share their cuts and length: ask for them together
    const groups = new Map();
    for (const key of waiting) {
      const [file, cuts, total] = key.split("|");
      const g = `${cuts}|${total}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(file);
    }
    let changed = false;
    for (const [g, all] of groups) {
      const [cuts, total] = g.split("|");
      for (let i = 0; i < all.length; i += CUTS_BATCH) {
        const files = all.slice(i, i + CUTS_BATCH);
        let answer = {};
        try {
          const res = await fetch(host.apiUrl("/gachadirector/cuts"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files, cuts: cuts.split(",").map(Number), total: Number(total) }),
          });
          const data = await res.json();
          answer = (data && data.real) || {};
        } catch (e) { answer = {}; }
        for (const file of files) {
          const known = cutsKnown.get(`${file}|${g}`);
          if (!known) continue;
          known.asking = false;
          const real = answer[file];
          if (!Array.isArray(real)) { known.failedAt = Date.now(); continue; }   // asked again later
          if (JSON.stringify(real) !== JSON.stringify(known.real)) changed = true;
          known.real = real;
        }
      }
    }
    if (changed && attached()) refresh();
  }

  /** The document a composite of this plan is queued with: the picks as the latent to
   *  start from, and free for rendering again only the cells around the joins that lie
   *  inside a long take. Where two takes meet at a cut nothing is rendered. */
  function compositeDoc(d, plan) {
    const tl = JSON.parse(JSON.stringify(d));
    delete tl.derived;
    tl.source.splice = plan;
    // radius and seam_denoise are the clip's own settings, set on the post page
    tl.mask = { ...tl.mask, mode: "seam_repair", cut_frames: seamFrames(plan).join(",") };
    return tl;
  }

  /** What joining the picks, as they are now, comes to; null when there is nothing to
   *  join (a shot without a pick). One take picked for every shot is a plan too: no cut,
   *  no seam, and the take is put out as it is.
   *
   *    cuts    frames where two takes meet at a cut: put one after the other as they are
   *    seams   frames where two takes of one long take meet: rendered again around there
   *    dead    seams of which nothing can be rendered again (the long take is shorter
   *            than the cells that would be free)
   *    kept    per shot, {kept, length}: how many of its frames are not generated again.
   *            A short stretch of a long take between two seams can be redone entirely:
   *            its pick then makes no difference, which the pages have to say.
   *    ranges  per seam, what is generated again around it: see `seamRanges`. */
  function joinPlan() {
    const d = doc();
    const { plan } = splicePlan(takes(), d.prompt.shots);
    if (!plan) return null;
    const made = normalize(compositeDoc(d, plan));
    const g = made.derived;
    const bounds = latentBounds(g.frame_count);
    const free = new Set(g.free_latents);
    const seams = seamFrames(plan);
    const touched = (f) => bounds.some(([lo, hi], t) => free.has(t) && (lo === f || hi === f - 1 || (lo < f && f <= hi)));
    const ranges = seamRanges(d, plan);
    // cuts across which the picture changes take and the sound does not (gd_cuts.plan)
    const carried = [];
    let voice = plan[0].take;
    for (const p of plan.slice(1)) {
      if (p.join !== "continuous" && p.sound === "continuous") {
        if (voice !== p.take) carried.push(p.start);
      } else voice = p.take;
    }
    return {
      plan,
      cuts: hardCuts(plan),
      seams,
      carried,
      dead: seams.filter((f) => !touched(f)),
      renders: free.size > 0,
      ranges,
      kept: d.prompt.shots.map((s) => {
        let kept = 0;
        bounds.forEach(([lo, hi], t) => {
          if (!free.has(t)) kept += Math.max(0, Math.min(hi, s.start + s.length - 1) - Math.max(lo, s.start) + 1);
        });
        return { kept, length: s.length };
      }),
    };
  }
  function keptOfShots() {
    const j = joinPlan();
    return j ? j.kept : null;
  }

  /** The file made of the picks as they are now: the composite with the current key, ""
   *  while there is none. This is the final clip the Results page lists. */
  function madeFile(d) {
    const tk = takes();
    const { plan } = splicePlan(tk, d.prompt.shots);
    const c = tk.composite;
    return plan && c.status === "done" && c.file && c.key === compositeKey(d, plan) ? c.file : "";
  }
  /** The file a later step works on (the face refine): what was made of the picks, or,
   *  while nothing was, the one take every shot picked. That take stands in for the final
   *  clip, as it did before there was a button to put it out as a file: a refine made of
   *  it then is still a refine of the clip. "" while there is neither. */
  function finalFile(d) {
    const made = madeFile(d);
    if (made) return made;
    const tk = takes();
    const { plan } = splicePlan(tk, d.prompt.shots);
    const one = plan ? singleTake(plan) : "";
    const take = one ? tk.takes.find((x) => x.id === one) : null;
    return take && take.status === "done" ? take.file : "";
  }
  /** What a face refine was made from and with: the clip, every setting that shapes it, the
   *  subject as it is now (its pictures and description go into the run), where the shots
   *  are cut, and the preset the region is generated with. */
  /** Output settings for a run that is not a face refine. A refine is marked by the clip
   *  it works on (`face.file`), which the panel only ever puts into the copy it queues; a
   *  workflow opened from a refined clip's file comes with it filled in. */
  function notRefining(c) {
    c.face.file = "";
    c.face.cuts = "";
    return c;
  }
  function refineKey(file, f) {
    const d = doc();
    const who = d.subjects.find((s) => s.id === f.subject);
    // (a boundary the shot goes on across is cut for the refine in another way than a cut:
    // marked as when the run is queued. A clip of cuts only keeps the key it had.)
    const made = [
      d.family, d.prompt.shots.slice(1).map((s) => `${s.start}${s.join === "continuous" ? "~" : ""}`).join(","),
      // (the description as the refine is given it: with what it names in plain words)
      who ? JSON.stringify([who.images, plainMentions(who.description, d, [who.id]), who.short_name,
                            who.kind, who.retention]) : "",
      paramsSignature(activePreset(presets()).params),
    ].join("|");
    return [file, f.strength, f.padding, f.feather, f.min_score, f.subject, f.text, f.shots, made].join("#");
  }

  const takesApi = {
    takes,
    compositeKey,
    finalFile: () => finalFile(doc()),
    madeFile: () => madeFile(doc()),
    keptOfShots,
    joinPlan,
    /** Give the seam at the start of shot `index` a range of its own: generated again
     *  from frame `lo` to frame `end` (exclusive), both where a latent frame begins. */
    setSeamRange(index, lo, end) {
      const d = doc();
      const s = d.prompt.shots[index];
      if (!s) return;
      const bounds = latentBounds(d.derived.frame_count);
      // the latent frame the seam is in (or begins)
      const own = bounds.findIndex(([a, b]) => a <= s.start && s.start <= b);
      const first = bounds.findIndex(([a]) => a >= lo);
      let last = bounds.length;                 // one past the last latent frame freed
      for (let k = 0; k < bounds.length; k++) if (bounds[k][0] >= end) { last = k; break; }
      const onLine = bounds[own][0] === s.start;
      const before = Math.max(0, own - (first < 0 ? own : first));
      const after = Math.max(0, last - own - (onLine ? 0 : 1));
      if (Array.isArray(s.seam) && s.seam[0] === before && s.seam[1] === after) return;
      patchDoc((x) => { x.prompt.shots[index].seam = [before, after]; }, t("h.seamRange"));
    },
    /** Leave the seam at the start of shot `index` to itself again. */
    setSeamAuto(index) {
      const s = doc().prompt.shots[index];
      if (!s || s.seam === "auto") return;
      patchDoc((x) => { x.prompt.shots[index].seam = "auto"; }, t("h.seamRange"));
    },
    /** How long the final clip really is: a composite says so once it is done (cuts
     *  between takes can cost it a few frames), anything else is the clip's length. */
    finalFrames: () => {
      const d = doc();
      const c = takes().composite;
      return c.status === "done" && c.frames && c.file === finalFile(d) ? c.frames : d.derived.frame_count;
    },
    refineKey,
    refineError: () => (state.refineError && state.refineError.pid === takes().refine.prompt_id
      ? state.refineError.text : ""),
    activePreset: () => activePreset(presets()),
    queuing: () => state.queuing,

    /** Queue N whole-clip renders, each with the next seed. */
    async queueTakes(n) {
      if (state.queuing) return;
      state.queuing = true;
      try {
        ensureUid();
        const d = doc();
        const c = post();
        const store = presets();        // frozen: every take of the batch runs these settings
        const p = activePreset(store);
        // (the widget takes seeds up to 2^64, a number counts exactly up to 2^53: past
        // that, seed + 1 is seed again and two takes of a batch would be one. A batch
        // that has no room below that starts over from 0.)
        const typed = Number(host.getWidget("seed")) || 0;
        const base = typed > Number.MAX_SAFE_INTEGER - n ? 0 : typed;
        const tl = JSON.parse(JSON.stringify(d));
        delete tl.derived;
        tl.source.splice = [];
        if (tl.mask.mode === "seam_repair") tl.mask = { ...tl.mask, mode: "whole_clip", cut_frames: "" };
        let queued = 0;
        let why = "";
        // A take's file is found among the outputs its run reports, and a run that is cached
        // from end to end reports none. The file name carries a token of this batch, so the
        // save always runs: a take that repeats an earlier one (same seed, same settings)
        // costs a moment and gets a file, instead of ending as "file missing".
        const batch = Date.now().toString(36).slice(-5);
        for (let k = 0; k < n; k++) {
          const seed = base + k;
          const postK = JSON.parse(JSON.stringify(c));
          notRefining(postK);
          postK.save.auto_save = true;
          postK.save.filename_prefix = `${c.save.filename_prefix}_take_${seed}_${batch}`;
          let pid = "";
          try {
            pid = await host.queueWithOverrides({ timeline: tl, post: postK, seed, preset: p.id,
                                                  presets: store });
          } catch (e) {
            console.error("GachaDirector queueTakes", e);
            why = refusal(e);
            break;
          }
          state.queuedRun.set(pid, { presetId: p.id, summary: paramSummary(p.params),
                                     signature: paramsSignature(p.params),
                                     frames: d.derived.frame_count });
          let tk = addTake(takes(), { seed, prompt_id: pid, preset: p.name,
                                      summary: paramSummary(p.params),
                                      frames: d.derived.frame_count,
                                      layout: layoutKey(d.prompt.shots) });
          // An idle server starts the prompt before the queue call even returns, so
          // execution_start can arrive while the take is not in the store yet.
          if (state.running.has(pid)) {
            const hit = tk.takes.find((x) => x.prompt_id === pid);
            if (hit) tk = updateTake(tk, hit.id, { status: "running" });
          }
          commitTakes(tk);
          queued++;
        }
        // Advance the node seed so the next batch does not repeat these.
        if (queued) host.setWidget("seed", base + queued);
        if (state.pages.takes && state.pages.takes.note) {
          const refused = why ? t("takes.queueFailedWhy", why) : t("takes.queueFailed");
          state.pages.takes.note(!queued ? refused
            : (queued < n ? `${t("takes.queuedN", queued, base)} ${refused}` : t("takes.queuedN", queued, base)));
        }
      } finally {
        state.queuing = false;
        refresh();
      }
    },

    /**
     * Queue the composite: the picked ranges spliced into the starting latent, and the
     * cells around every cut where the take changes left free. With one take everywhere
     * there is nothing to join and nothing is rendered: the take is put out as the final
     * clip, a file of its own.
     */
    async queueComposite() {
      if (state.queuing) return;
      ensureUid();
      const d = doc();
      const { plan, why } = splicePlan(takes(), d.prompt.shots);
      if (!plan) {
        window.alert(t("takes.compositeBlocked", why ? t(why.key, ...(why.args || [])) : ""));
        return;
      }
      state.queuing = true;
      try {
        const store = presets();
        const p = activePreset(store);
        const seed = Number(host.getWidget("seed")) || 0;
        const tl = compositeDoc(d, plan);
        const c = post();
        notRefining(c);
        c.save.auto_save = true;
        c.save.filename_prefix = `${c.save.filename_prefix}_composite_${seed}`;
        let pid = "";
        try {
          pid = await host.queueWithOverrides({ timeline: tl, post: c, seed, preset: p.id,
                                                presets: store });
        } catch (e) {
          console.error("GachaDirector queueComposite", e);
          const why = refusal(e);
          if (state.pages.takes && state.pages.takes.note) {
            state.pages.takes.note(why ? t("takes.queueFailedWhy", why) : t("takes.queueFailed"));
          }
          return;
        }
        // Followed like a take, not timed: a composite is another job than a render of the
        // clip (measured: 128 s against 100 s for a take of the same clip and preset), and
        // its time would go into what the preset says a render costs.
        state.queuedRun.set(pid, { composite: true });
        const next = takes();
        next.composite = { prompt_id: pid, file: "", at: Date.now(), seed, key: compositeKey(d, plan),
                           frames: 0, note: "",
                           status: state.running.has(pid) ? "running" : "queued" };
        commitTakes(next);
        host.setWidget("seed", seed + 1);
      } finally {
        state.queuing = false;
        refresh();
      }
    },

    /**
     * Queue the face refine of the final clip: one more run over the region its main face
     * is in. The run's document describes the face and nothing else; the clip, and where
     * its shots start, travel in the output settings of this one run.
     */
    async queueFaceRefine() {
      if (state.queuing) return;
      ensureUid();
      const d = doc();
      const file = finalFile(d);
      if (!file) return;
      // the clip as long as it really is: one cut together from several takes can be a
      // few frames short of the document (the run holds its last frame to fill the grid)
      const frames = takesApi.finalFrames();
      state.queuing = true;
      try {
        const store = presets();
        const p = activePreset(store);
        const seed = Number(host.getWidget("seed")) || 0;
        const c = post();
        const f = c.face;
        const who = d.subjects.find((s) => s.id === f.subject);
        const text = [who ? `A close-up of the face of @{${who.id}}.` : "A close-up of a face.",
                      "Sharp, natural detail in the eyes, the skin and the hair.",
                      f.text.trim()].filter(Boolean).join(" ");
        const tl = {
          schema_version: d.schema_version, uid: d.uid, family: d.family,
          clip: { length: frames, aspect: "1:1" },
          prompt: { mode: "structured", shots: [{ id: "face", length: 0, text }] },
          // only this subject goes along: what its description names of the rest of the
          // clip (the video its movement comes from, say) is said in plain words here
          subjects: who ? [{ ...who, shot: "", description: plainMentions(who.description, d, [who.id]) }] : [],
        };
        const key = refineKey(file, f);
        c.save.auto_save = true;
        c.save.filename_prefix = `${c.save.filename_prefix}_refine_${seed}`;
        c.face.file = file;
        c.face.cuts = refineCuts(d.prompt.shots, takes().composite, file);
        let pid = "";
        try {
          pid = await host.queueWithOverrides({ timeline: tl, post: c, seed, preset: p.id,
                                                presets: store });
        } catch (e) {
          console.error("GachaDirector queueFaceRefine", e);
          const why = refusal(e);
          window.alert(why ? t("takes.queueFailedWhy", why) : t("takes.queueFailed"));
          return;
        }
        state.queuedRun.set(pid, { composite: true });     // followed, not timed: see queueComposite
        const next = takes();
        next.refine = { prompt_id: pid, file: "", at: Date.now(), seed, key, of: file,
                        status: state.running.has(pid) ? "running" : "queued" };
        commitTakes(next);
        host.setWidget("seed", seed + 1);
      } finally {
        state.queuing = false;
        refresh();
      }
    },

    /** Ask the server what became of every unfinished take (and the composite, the refine). */
    async refreshTakes() {
      const waiting = (x) => x.prompt_id && (x.status === "queued" || x.status === "running");
      const before = takes();
      const pending = before.takes.filter(waiting);
      const jobs = [before.composite, before.refine].filter(waiting);
      const comp = jobs.length ? jobs : null;
      if (!pending.length && !comp) { refresh(); return; }
      let queued = null;
      try { queued = await queuedPromptIds(); } catch (e) { queued = null; }
      const outcomes = new Map();
      for (const item of [...pending, ...(comp || [])]) {
        const o = await outcomeOf(item.prompt_id, queued);
        if (o) outcomes.set(item.prompt_id, o);
      }
      if (!outcomes.size) { refresh(); return; }
      if (!attached()) return;         // the node was dropped while the server was being asked
      // apply to the store as it is now, not as it was before the requests
      let tk = takes();
      for (const take of tk.takes) {
        const o = waiting(take) ? outcomes.get(take.prompt_id) : null;
        // (a take's `frames` is the length it was asked for, not something a run reports)
        if (o) tk = updateTake(tk, take.id, { status: o.status, file: o.file });
      }
      for (const job of ["composite", "refine"]) {
        const c = tk[job];
        if (waiting(c) && outcomes.has(c.prompt_id)) tk[job] = { ...c, ...outcomes.get(c.prompt_id) };
      }
      commitTakes(tk);
    },

    pick(segment, id) {
      commitTakes(pickTake(takes(), segment, id));
      state.history.push(t("h.pick"));
    },
    pickAll(id) {
      commitTakes(pickAll(takes(), doc().prompt.shots.length, id));
      state.history.push(t("h.pick"));
    },
    removeTake(id) { commitTakes(removeTake(takes(), id)); },
    clearTakes() {
      const tk = normalizeTakes({});
      commitTakes(tk);
    },
    /**
     * Keep picks on their shots when a cut is added or removed: picks are stored by shot
     * number, and a new shot in the middle would otherwise hand every later pick to its
     * neighbour. `at` is the shot that was split (its second half is new and inherits the
     * pick) or the shot that was merged into the one before it.
     */
    shiftPicks(kind, at) {
      const tk = takes();
      const next = {};
      for (const [key, id] of Object.entries(tk.picks)) {
        const i = Number(key);
        if (kind === "split") {
          next[String(i > at ? i + 1 : i)] = id;
          if (i === at) next[String(at + 1)] = id;
        } else if (i !== at) {
          next[String(i > at ? i - 1 : i)] = id;
        }
      }
      tk.picks = next;
      commitTakes(tk);
      // The shots a face refine is asked for are shot numbers too (from 1). Both halves of
      // a split shot stay asked for; of two that are merged, the one that is left is.
      const c = post();
      const asked = c.face.shots.split(",").filter(Boolean).map(Number);
      if (asked.length) {
        const moved = new Set();
        for (const n of asked) {
          const i = n - 1;
          if (kind === "split") {
            moved.add(i > at ? n + 1 : n);
            if (i === at) moved.add(n + 1);
          } else {
            moved.add(i >= at ? n - 1 : n);
          }
        }
        c.face.shots = [...moved].sort((a, b) => a - b).join(",");
        host.writePost(normalizePost(c));
      }
    },
  };

  // ------------------------------------------------------------------ run tracker
  // Whose run is it? The live preview and a preset's timing belong to this clip's own runs.
  //
  // ComfyUI sends a prompt's start and end events to the client that queued it and to
  // nobody else, and the preview event to everyone, without saying which prompt it is of.
  // This panel follows one run at a time, up to its end event, and only a run whose end
  // event is certain to come here:
  //
  //   queued here     the takes page queued it: it is this clip's, nothing to ask.
  //   announced       this browser queued it some other way (ComfyUI's own button, another
  //                   workflow tab). Another workflow can hold a node with this node's id,
  //                   so the prompt's own document decides: when both documents carry a
  //                   uid and they differ, it is another clip's run. Until that is known,
  //                   no picture of the run is shown and it is not timed; once it is known
  //                   to be another clip's, the takes page no longer says a render is going.
  //
  //   picked up late  the run was already going when this editor was made: the page was
  //                   reloaded, or the workflow tab was left and come back to. There is no
  //                   start event, but a progress event names the prompt. It is followed
  //                   from there on when the queue says this page queued it (so that its
  //                   end event comes here too) and it is this clip's. It is not timed.
  //
  // A preview that arrives while no run is being followed (queued from another browser or
  // through the API) is not shown. An earlier version tried to work out whose it was by
  // asking the queue on every such preview; three reviews in a row found new interleavings
  // in which that went wrong: nothing tells this page when such a run ends.
  // tests/tracker.mjs runs this section and the next one on their own.
  function isMine(nodeId) {
    const owner = String(nodeId ?? "");
    const mine = String(host.nodeId());
    return owner === mine || owner.startsWith(`${mine}.`);   // "7.0.0.28" is node 7's expansion
  }
  /** Still on the canvas? A node ComfyUI dropped (see gd_director.js) must change nothing. */
  function attached() {
    return !host.attached || host.attached();
  }
  /** "mine" or "foreign", from a prompt's graph. */
  function verdictOf(graph) {
    const node = (graph || {})[String(host.nodeId())];
    if (!node) return "foreign";
    let theirs = "";
    try { theirs = JSON.parse((node.inputs && node.inputs.gd_timeline) || "{}").uid || ""; } catch (e) { /* not ours to read */ }
    const ours = doc().uid || "";
    return theirs && ours && theirs !== ours ? "foreign" : "mine";
  }
  /** What the server is running now. Gives up after five seconds rather than hang. */
  async function queueRunning() {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : 0;
    try {
      const res = await fetch(host.apiUrl("/queue"), { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      // an error page with a JSON body is not an empty queue
      if (res.ok === false) throw new Error(`queue: HTTP ${res.status}`);
      return (await res.json()).queue_running || [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Whose an announced run is: "mine", "foreign", or "unknown" when nothing can say. */
  async function askOwner(pid) {
    let items;
    try { items = await queueRunning(); } catch (e) { return "mine"; }   // no queue: the node id decides
    const item = items.find((x) => x && String(x[1]) === pid);
    if (item) return verdictOf(item[2]);
    // A short run is out of the queue before the answer is back; history has its prompt.
    try {
      const entry = await host.fetchHistory(pid);
      if (entry && entry.prompt && entry.prompt[2]) return verdictOf(entry.prompt[2]);
    } catch (e) { /* nothing more to try */ }
    return "unknown";
  }
  /**
   * A progress event of a prompt that is not being followed. ComfyUI sends progress to the
   * client that queued the prompt, and to everyone when nobody did (the API), so the queue
   * is asked whose it is: once per prompt, or again at the next progress event when the
   * question could not be answered. The event itself says the run is going now: its end
   * event is still to come. That event, or the start of another run, clears `state.late`,
   * and an answer that comes after it follows nothing.
   */
  function onProgress(detail) {
    const pid = String(detail?.prompt_id || "");
    if (!pid || state.current || state.late === pid) return;
    state.late = pid;
    askLate(pid).then((mine) => {
      if (state.late !== pid || !attached()) return;
      if (mine) state.current = pid;
      else if (mine == null) state.late = "";    // not answered: the next progress event asks again
    });
  }
  /** Did this page queue the running prompt `pid`, and is it this clip's? null: could not tell. */
  async function askLate(pid) {
    const client = host.clientId ? host.clientId() : "";
    if (!client) return null;
    let items;
    try { items = await queueRunning(); } catch (e) { return null; }
    const item = items.find((x) => x && String(x[1]) === pid);
    return !!item && (item[3] || {}).client_id === client && verdictOf(item[2]) === "mine";
  }
  function onStart(detail) {
    const pid = String(detail?.prompt_id || "");
    state.current = pid;
    state.late = "";
    state.running.set(pid, Date.now());
    // a preview still on the page, or held back, is of a run before this one
    state.held = null;
    hideLive();
    if (!state.queuedRun.has(pid)) {
      const asked = askOwner(pid);
      state.verdict.set(pid, asked);
      asked.then((whose) => {
        if (state.current !== pid || !attached()) return;
        // not this clip's: the takes page is not to say "rendering" for it either
        if (whose !== "mine") { state.running.delete(pid); hideLive(); }
        else if (state.held) { showLive(state.held); state.held = null; }
      });
      // A plain Run button: what is selected now is what was just queued. A composite that
      // was queued before the page was reloaded starts here too, and a composite is not timed.
      if (takes().composite.prompt_id !== pid && takes().refine.prompt_id !== pid) {
        const p = activePreset(presets());
        state.started.set(pid, { presetId: p.id, summary: paramSummary(p.params),
                                 signature: paramsSignature(p.params),
                                 frames: doc().derived.frame_count });
      }
    }
    let tk = takes();
    const hit = tk.takes.find((x) => x.prompt_id === pid && x.status === "queued");
    if (hit) commitTakes(updateTake(tk, hit.id, { status: "running" }));
    else {
      for (const job of ["composite", "refine"]) {
        if (tk[job].prompt_id === pid && tk[job].status === "queued") {
          tk[job].status = "running";
          commitTakes(tk);
        }
      }
    }
  }
  /** The run being followed is over: its preview goes. Another run's end changes nothing here. */
  function endOf(pid) {
    if (state.late === pid) state.late = "";    // over before the answer about it was in
    if (state.current !== pid) return;
    state.current = "";
    state.held = null;
    hideLive();
  }
  function onSuccess(detail) {
    const pid = String(detail?.prompt_id || "");
    state.running.delete(pid);
    // What is timed is this node's own share of the prompt: another director node in the
    // same workflow, a loader reading a checkpoint from disk or a save wired after this
    // node is not what the preset costs.
    const span = state.span.get(pid);
    state.span.delete(pid);
    const seconds = span ? (span.acc + (span.since ? Date.now() - span.since : 0)) / 1000 : 0;
    endOf(pid);
    // the takes and the results page wait for nothing
    takesApi.refreshTakes();
    if (state.pages.results) state.pages.results.load();
    const ran = state.mine.delete(pid);
    const asQueued = state.queuedRun.get(pid) || state.started.get(pid);
    const asked = state.verdict.get(pid);
    state.queuedRun.delete(pid);
    state.started.delete(pid);
    state.verdict.delete(pid);
    // Under a second is ComfyUI serving a cached result, not a render.
    const record = () => {
      if (!(seconds >= 1 && ran && asQueued) || asQueued.composite || !attached()) return;
      const s = presets();
      const p = s.presets.find((x) => x.id === asQueued.presetId);
      // a preset edited while the run was going no longer describes what was measured
      if (p && paramsSignature(p.params) === asQueued.signature) {
        commitPresets(recordRun(s, p.id, seconds, asQueued.summary, Date.now(), asQueued.frames),
                      t("h.recordTime"));
      }
    };
    // a run is timed only once it is known to be this clip's
    if (asked) asked.then((whose) => { if (whose === "mine") record(); });
    else record();
  }
  /**
   * `executing` carries the node the server is on; a node of the expansion reports as this
   * node. Besides marking the prompt as one this node ran in, it keeps the clock: the
   * stretches on this node are added up, since ComfyUI runs other nodes in between.
   */
  function onExecuting(nodeId) {
    const pid = state.current;
    if (!pid) return;
    let span = state.span.get(pid);
    if (nodeId != null && isMine(nodeId)) {
      state.mine.add(pid);
      if (!span) { span = { acc: 0, since: 0 }; state.span.set(pid, span); }
      if (!span.since) span.since = Date.now();
    } else if (span && span.since) {
      span.acc += Date.now() - span.since;      // the server moved on to another node
      span.since = 0;
    }
  }
  /**
   * The connection to the server is back. What was running may be gone with the server, and
   * then its end event never comes (measured: after a crash the takes page went on saying
   * "rendering" and the take stayed "running" until the page was reloaded). So every run is
   * forgotten, as by a new editor: a run that is still going names itself with its next
   * progress event and is picked up late, and the takes ask the server what became of them.
   */
  function onReconnected() {
    state.running.clear();
    state.queuedRun.clear();
    state.started.clear();
    state.mine.clear();
    state.span.clear();
    state.verdict.clear();
    state.current = "";
    state.late = "";
    state.held = null;
    hideLive();
    takesApi.refreshTakes();
  }
  function onError(detail) {
    const pid = String(detail?.prompt_id || "");
    state.running.delete(pid);
    state.mine.delete(pid);
    state.span.delete(pid);
    state.verdict.delete(pid);
    state.queuedRun.delete(pid);
    state.started.delete(pid);
    endOf(pid);
    let tk = takes();
    const hit = tk.takes.find((x) => x.prompt_id === pid);
    if (hit) commitTakes(updateTake(tk, hit.id, { status: "failed" }));
    else if (tk.composite.prompt_id === pid) { tk.composite.status = "failed"; commitTakes(tk); }
    else if (tk.refine.prompt_id === pid) {
      // why, in the node's words (which shots it left alone, and for what): kept for the
      // page while it is open, not stored
      state.refineError = { pid, text: String(detail?.exception_message || "").trim() };
      tk.refine.status = "failed";
      commitTakes(tk);
    }
  }

  // ------------------------------------------------------------------ the queue changed
  // A take, a join or a refine that is taken out of ComfyUI's queue before it starts sends
  // no event about itself: the queue just gets shorter. So when the queue changes while
  // something of this clip is waiting, the server is asked what became of it, a moment
  // later and once for a burst of changes.
  let queueTimer = 0;
  function onQueueChanged() {
    if (queueTimer || !attached()) return;
    const tk = takes();
    const waiting = (x) => x.prompt_id && x.status === "queued";
    if (!tk.takes.some(waiting) && !waiting(tk.composite) && !waiting(tk.refine)) return;
    queueTimer = setTimeout(() => {
      queueTimer = 0;
      if (attached()) takesApi.refreshTakes();
    }, 1500);
  }

  // ------------------------------------------------------------------ live preview
  // The preview node in the expansion pushes an animated WebP of the clip as it stands
  // every few steps. Nothing else in ComfyUI shows it, so the takes page does: a render
  // that is going wrong can be seen and interrupted long before it finishes.
  function onPreview(detail) {
    const owner = String(detail?.node_id ?? "");
    if (owner && !isMine(owner)) return;
    const pid = state.current;
    if (!pid) return;                            // no run is being followed: not shown
    const live = { webp: detail.webp, step: detail.step, total: detail.total_steps,
                   fps: detail.fps, frames: detail.frames };
    const asked = state.verdict.get(pid);
    if (!asked) { showLive(live); return; }      // queued here
    state.held = live;                           // the newest one, until it is known whose run it is
    asked.then((whose) => {
      if (whose === "mine" && state.current === pid && state.held === live && attached()) {
        state.held = null;
        showLive(live);
      }
    });
  }
  function showLive(live) {
    state.live = live;
    if (state.pages.takes && state.pages.takes.live) state.pages.takes.live(state.live);
  }
  function hideLive() {
    state.live = null;
    if (state.pages.takes && state.pages.takes.live) state.pages.takes.live(null);
  }

  // ------------------------------------------------------------------ server data
  async function refreshMedia() {
    try {
      const res = await fetch(host.apiUrl("/gachadirector/media"), { cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) {
        state.media = { images: data.images, videos: data.videos, audio: data.audio,
                        renders: data.renders || [], generated: data.generated || null };
      }
    } catch (e) { /* keep whatever we had */ }
    refresh();
    if (state.library) state.library.repaint();
  }

  // The library's folders: one list for every workflow, kept with the user's ComfyUI data
  // (ComfyUI's own store for such files). A folder is an entry there and nothing on disk.
  //
  // The stored list is written whole, so it is only written once it has been read: a
  // read that failed (the server busy, a connection dropped) is not "no folders yet", and
  // writing a list made on top of that would wipe the folders that are there.
  const LIBRARY_FILE = "gachadirector.library.json";
  let libraryTimer = 0;
  let libraryRead = false;         // the stored list has been read, or found not to exist yet
  let libraryEdited = false;       // something was changed here before that
  let libraryReading = null;       // the read that is under way: one at a time
  function loadLibraryIndex() {
    if (libraryRead) return Promise.resolve();
    if (!libraryReading) {
      libraryReading = (async () => {
        try {
          const res = await fetch(host.apiUrl(`/userdata/${LIBRARY_FILE}`), { cache: "no-store" });
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
          const stored = res.ok ? await res.json() : null;  // 404: nothing was ever stored
          // what was changed here meanwhile was changed on nothing: it goes on top of what
          // is stored. From here on the list here is the list, and nothing read later may
          // be laid over it (it would bring back a folder removed since).
          state.libraryIndex = libraryEdited ? mergeIndex(stored, state.libraryIndex) : normalizeIndex(stored);
          libraryRead = true;
          libraryEdited = false;
        } catch (e) {
          if (!state.libraryIndex) state.libraryIndex = normalizeIndex(null);
        }
        libraryReading = null;
        if (state.library) state.library.repaint();
      })();
    }
    return libraryReading;
  }
  function saveLibraryIndex(index) {
    state.libraryIndex = index;
    if (!libraryRead) libraryEdited = true;
    clearTimeout(libraryTimer);
    libraryTimer = setTimeout(async () => {
      if (!libraryRead) await loadLibraryIndex();           // (which keeps what was changed here)
      if (!libraryRead) return;                             // still not readable: nothing is written
      fetch(host.apiUrl(`/userdata/${LIBRARY_FILE}?overwrite=true`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.libraryIndex),
      }).catch((e) => console.error("GachaDirector library", e));
    }, 300);
  }

  /** Files from this computer, copied into ComfyUI's input folder through ComfyUI's own
   *  upload (which takes any media, not only pictures; a name that is taken gets a number).
   *  Returns what each is called there and what it is: [{name, kind}]. */
  async function importFiles(files) {
    const out = [];
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) continue;
      const form = new FormData();
      form.append("image", file, file.name);
      form.append("type", "input");
      const res = await fetch(host.apiUrl("/upload/image"), { method: "POST", body: form });
      if (!res.ok) throw new Error(`${file.name}: HTTP ${res.status}`);
      const data = await res.json();
      out.push({ name: data.subfolder ? `${data.subfolder}/${data.name}` : data.name, kind });
    }
    if (out.length) await refreshMedia();
    return out;
  }

  /** [width, height] of the source clip when the media listing has probed it, else null. */
  function sourceSize() {
    const d = doc();
    const hit = [...(state.media.videos || []), ...(state.media.renders || [])]
      .find((x) => x.name === d.source.video);
    return hit && hit.width && hit.height ? [hit.width, hit.height] : null;
  }

  // ------------------------------------------------------------------ page host
  function pageHost(container) {
    return {
      container,
      doc, post, run, presets,
      normalizeDoc: normalize,
      commitDoc, patchDoc,
      // View-only writes (playhead, zoom, selection while scrubbing): the widget is
      // updated so the next patch sees them, but nothing goes into the undo history and
      // no page re-renders — a player pausing must not rebuild every textarea.
      // (the timeline hands over the document it has been drawing, which may be a moment
      // old: only where the playhead and the zoom are is taken from it, so that an edit or
      // an undo made in that moment stands)
      commitView: (d) => {
        const now = normalize(host.readDocument());
        now.view = normalize(d).view;
        host.writeDocument(normalize(now));      // (the playhead and the selection fitted to it)
        host.markDirty();
      },
      setPlayhead: (f) => {
        const d = normalize(host.readDocument());
        if (d.view.playhead === f) return;
        d.view.playhead = f;
        host.writeDocument(d);
        host.markDirty();
      },
      patch: patchPost,
      ...presetApi,
      ...takesApi,
      takesStorageMissing: () => !!(host.hasTakesWidget && !host.hasTakesWidget()),
      setWidget: (name, value) => { host.setWidget(name, value); refresh(); },
      media: () => state.media,
      refreshMedia,
      importFiles,
      sourceSize,
      nodeId: host.nodeId,
      modelName: host.modelName,
      turboWired: host.turboWired,
      externalWired: host.externalWired,
      realRange,
      forgetCuts,
      // What the model would read, compiled by the server with the same code the node runs.
      planPrompt: async () => {
        const body = JSON.parse(JSON.stringify(doc()));
        delete body.derived;
        const res = await fetch(host.apiUrl("/gachadirector/plan"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: body, params: run() }),
        });
        const data = await res.json();
        if (!data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
        return data;
      },
      frameCount: () => doc().derived.frame_count,
      cellCount: () => doc().derived.cell_count,
      sublayer: () => state.modal && state.modal.sublayer,
      library: () => state.library,
      goPage: (name) => state.modal && state.modal.setPage(name),
      viewUrl: host.viewUrl,
      viewUrlOutput: host.viewUrlOutput,
      apiUrl: host.apiUrl,
      currentDocJson: () => host.rawDocument(),
      bus: host.bus,
      interrupt: host.interrupt,
      clearQueue: host.clearQueue,
      live: () => state.live,
      rendering: () => state.running.size > 0,
      vramStats: host.vramStats,
      freeMemory: host.freeMemory,
    };
  }

  // ------------------------------------------------------------------ lifecycle
  function build() {
    state.history = createHistory({
      read: () => ({
        doc: host.readDocument(),
        post: host.readPost(),
        presets: host.readPresets(),
        picks: takes().picks,
      }),
      write: (snapshot) => writeAll(snapshot, null),
    });

    state.modal = createModal({
      launcherHost: host.launcherHost,
      history: state.history,
      onOpen: () => {
        ensureUid();                      // from here on this clip's runs can be told apart
        state.history.reset(t("h.open"));
        refreshMedia();
        takesApi.refreshTakes();
        renderPage(state.modal.page);
      },
      onPageChange: (page) => renderPage(page),
      onLibrary: () => state.library.toggle(),
      onEscape: () => state.library.escape(),
      onClose: () => state.library.close(),
      onLangChange: () => {
        state.modal.repaintChrome();
        state.library.repaint();
        makePages();                     // shells carry text too
        renderPage(state.modal.page);
      },
    });

    state.library = createLibrary({
      layer: state.modal.sublayer,
      media: () => state.media,
      viewUrl: host.viewUrl,
      refresh: refreshMedia,
      importFiles,
      index: () => state.libraryIndex,
      saveIndex: saveLibraryIndex,
    });
    makePages();
    // the node's own readout needs the source clip's size before the panel is ever opened
    refreshMedia();
    loadLibraryIndex();

    host.bus.on("execution_start", onStart);
    host.bus.on("executing", onExecuting);
    host.bus.on("execution_success", onSuccess);
    host.bus.on("execution_error", onError);
    host.bus.on("execution_interrupted", onError);
    host.bus.on("minimax_h3_preview", onPreview);
    host.bus.on("progress", onProgress);
    host.bus.on("reconnected", onReconnected);
    host.bus.on("status", onQueueChanged);
  }

  /**
   * Build the page objects over the modal's containers. Called once when the panel
   * is created and again on a language switch: a page's shell (timeline header, segment
   * bar, player controls, help line) is built once and never re-rendered, so translating
   * it means building it again.
   */
  function makePages() {
    for (const p of Object.values(state.pages)) if (p && p.destroy) p.destroy();
    state.pages.run = createRunPage(pageHost(state.modal.pages.run));
    state.pages.edit = createEditPage(pageHost(state.modal.pages.edit));
    state.pages.takes = createTakesPage(pageHost(state.modal.pages.takes));
    state.pages.post = createPostPage(pageHost(state.modal.pages.post));
    state.pages.results = createResultsPage(pageHost(state.modal.pages.results));
  }

  function renderPage(page) {
    const p = state.pages[page];
    if (!p) return;
    p.render();
    if (page === "results" && p.load) p.load();
  }

  function refresh() {
    if (state.modal && state.modal.isOpen) {
      renderPage(state.modal.page);
      state.modal.repaintUndo();
    }
  }

  function rehydrate() {
    const raw = host.readDocument();
    if (!state.seeded && raw && raw.run && typeof raw.run === "object") {
      state.seeded = true;
      commitDoc(raw, t("h.importOld"));
      return;
    }
    state.seeded = true;
    refresh();
  }

  build();

  return {
    open: (page) => state.modal.show(page),
    close: () => state.modal.hide(),
    setPage: (page) => state.modal.setPage(page),
    rehydrate,
    refresh,
    doc, post, run, presets, takes, sourceSize,
    queueTakes: takesApi.queueTakes,
    queueComposite: takesApi.queueComposite,
    refreshTakes: takesApi.refreshTakes,
    history: () => state.history,
    destroy() {
      host.bus.off("execution_start", onStart);
      host.bus.off("executing", onExecuting);
      host.bus.off("execution_success", onSuccess);
      host.bus.off("execution_error", onError);
      host.bus.off("execution_interrupted", onError);
      host.bus.off("minimax_h3_preview", onPreview);
      host.bus.off("progress", onProgress);
      host.bus.off("reconnected", onReconnected);
      host.bus.off("status", onQueueChanged);
      for (const p of Object.values(state.pages)) if (p.destroy) p.destroy();
      if (state.modal) state.modal.destroy();
    },
  };
}
