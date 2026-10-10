// Gacha Director — the results page.
//
// Reads ComfyUI's own /history, keeps the entries that ran an GachaDirector node, and shows
// the video, the run report and the compiled prompt for each. Nothing is cached here
// beyond one fetch: history is the server's record, and duplicating it is how a results
// panel starts lying.
//
// A result is marked stale when the document it ran with no longer matches the current
// one, so an old render cannot be mistaken for the current settings.
//
// Candidates do NOT belong here. They are working material — many per clip — and they
// live on the takes page, where picking them is the point. This page is the finished
// pieces: a plain run and a composite. The count of what was filtered out is still shown,
// so nothing disappears silently.

import { t } from "./gd_i18n.js";
import { btn, el, fmtDuration, row, section } from "./gd_ui.js";
import { normalize } from "./gd_doc.js";
import { activePreset, normalizePresets } from "./gd_presets_doc.js";
import { sound } from "./gd_player.js";

// The clips listed here play with the browser's own controls; whether they are heard to begin
// with is the panel's one sound switch, like every other player (muting one of them with its own
// control is that clip's business).
sound.watch((on) => { for (const v of document.querySelectorAll(".gd-result-video")) v.muted = !on; });

/** The content of a document, ignoring what the run does not depend on. */
function contentKey(raw) {
  let d;
  try { d = normalize(typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {})); }
  catch (e) { return ""; }
  const { view, derived, ...rest } = d;
  return JSON.stringify(rest);
}

/** What kind of run a history entry was, from the save prefix the panel wrote. */
function runKind(prefix) {
  if (/_composite_/.test(prefix)) return "composite";
  if (/_refine_/.test(prefix)) return "refine";
  if (/_take_/.test(prefix)) return "take";
  return "run";
}

/** Is `from` the node `id`, or does it take anything from it, however far back? (`prompt`:
 *  the graph of a history entry, node id -> {inputs}; a link is [node id, output index].) */
export function takesFrom(prompt, from, id) {
  const seen = new Set();
  const walk = (nid) => {
    if (nid === id) return true;
    if (seen.has(nid)) return false;
    seen.add(nid);
    return Object.values((prompt[nid] && prompt[nid].inputs) || {}).some(
      (v) => Array.isArray(v) && v.length === 2 && prompt[String(v[0])] && walk(String(v[0])));
  };
  return walk(String(from));
}

export function createResultsPage(host) {
  const root = host.container;
  const st = { entries: [], loading: false, error: "", hiddenTakes: 0 };

  function videoUrl(item) {
    const p = new URLSearchParams({
      filename: item.filename, type: item.type || "output", subfolder: item.subfolder || "",
    });
    return host.apiUrl(`/view?${p.toString()}`);
  }

  async function load() {
    st.loading = true; st.error = ""; render();
    try {
      const res = await fetch(host.apiUrl("/history?max_items=40"), { cache: "no-store" });
      const hist = (await res.json()) || {};
      // The newest runs are a window of forty, and a batch of takes fills it: the clip
      // that was joined before them, and its face refine, are asked for by name. (The
      // takes page keeps the ids of both.)
      const tk = host.takes ? host.takes() : null;
      for (const pid of tk ? [tk.composite.prompt_id, tk.refine.prompt_id] : []) {
        if (!pid || hist[pid]) continue;
        try {
          const one = await (await fetch(host.apiUrl(`/history/${encodeURIComponent(pid)}`), { cache: "no-store" })).json();
          if (one && one[pid]) hist[pid] = one[pid];
        } catch (e) { /* gone from the history: nothing to show of it */ }
      }
      const rows = [];
      for (const [pid, entry] of Object.entries(hist)) {
        const prompt = entry?.prompt?.[2] || {};
        // This clip's runs: the node with this node's id, running this clip's document.
        // (Two workflows can both have a node 10; the document's uid tells them apart. A
        // document without one, from a run queued outside the panel, is taken on its id.)
        const nodeId = String(host.nodeId());
        const gdNode = prompt[nodeId];
        if (!gdNode || gdNode.class_type !== "GachaDirector") continue;
        const docJson = String(gdNode?.inputs?.gd_timeline || "");
        let ranDoc = {};
        try { ranDoc = JSON.parse(docJson || "{}") || {}; } catch (e) { ranDoc = {}; }
        const myUid = (() => { try { return JSON.parse(host.currentDocJson() || "{}").uid || ""; } catch (e) { return ""; } })();
        if (ranDoc.uid && myUid && ranDoc.uid !== myUid) continue;
        // The knobs live in the preset store: read the preset the run selected.
        let params = {};
        let presetName = "";
        try {
          const store = normalizePresets(JSON.parse(gdNode?.inputs?.gd_presets || "{}"));
          const sel = String(gdNode?.inputs?.preset || store.active);
          const p = store.presets.find((x) => x.id === sel) || activePreset(store);
          if (p) { params = p.params; presetName = p.name; }
        } catch (e) { /* keep whatever the node carried */ }
        let prefix = "";
        try { prefix = JSON.parse(gdNode?.inputs?.gd_post || "{}")?.save?.filename_prefix || ""; }
        catch (e) { /* no post config */ }
        const splice = (ranDoc.source && ranDoc.source.splice) || [];
        // Takes that only meet at cuts are cut together: the run generated nothing again.
        let cutOnly = false;
        if (splice.length) {
          try { cutOnly = !((normalize(ranDoc).derived || {}).free_cells || []).length; }
          catch (e) { cutOnly = false; }
        }
        // Media saved by this node's expansion (its nodes report as "<id>.0.0.N"); the
        // report and the compiled prompt are the node's own output.
        const media = [];
        for (const [key, out] of Object.entries(entry?.outputs || {})) {
          if (!key.startsWith(`${nodeId}.`) && !key.startsWith(`${nodeId}:`)) continue;
          for (const kind of ["images", "gifs", "video", "videos"]) {
            for (const item of (out?.[kind] || [])) {
              if (item && item.filename) media.push(item);
            }
          }
        }
        const own = entry?.outputs?.[nodeId] || {};
        // The prompt holds the whole graph, this node included, whichever director node
        // it was queued for. A run that went well and has nothing of this node's in its
        // outputs was another node's. One that failed has no outputs at all: it is this
        // node's when it stopped in this node, or when this node was among those asked to
        // run (the fifth entry of the queue item; all output nodes for ComfyUI's Run).
        // Asked to run: the node itself, or a node that takes from it (running only a
        // save node behind it asks for that one alone). Stopped: by an error, or by hand.
        const messages = entry?.status?.messages || [];
        const mine = (key) => key === nodeId || key.startsWith(`${nodeId}.`) || key.startsWith(`${nodeId}:`);
        const stoppedIn = String(messages.find((m) => m[0] === "execution_error" || m[0] === "execution_interrupted")?.[1]?.node_id ?? "");
        const ranHere = Object.keys(entry?.outputs || {}).some(mine) || mine(stoppedIn);
        const asked = Array.isArray(entry?.prompt?.[4]) ? entry.prompt[4].map(String) : null;
        const wentWell = (entry?.status?.status_str || "") === "success";
        if (!ranHere && (wentWell || (asked && !asked.some((id) => takesFrom(prompt, id, nodeId))))) continue;
        const report = String((own.gd_report || [])[0] || "");
        const compiled = String((own.gd_prompt || [])[0] || "");
        const started = messages.find((m) => m[0] === "execution_start")?.[1]?.timestamp;
        const ended = messages.find((m) => m[0] === "execution_success")?.[1]?.timestamp;
        rows.push({
          pid,
          ok: (entry?.status?.status_str || "") === "success",
          media,
          report,
          compiled,
          docJson,
          seed: gdNode?.inputs?.seed,
          megapixels: params.megapixels,
          steps: params.steps,
          turbo: params.model === "turbo",
          presetName,
          kind: runKind(prefix),
          splicePieces: splice.length,
          cutOnly,
          started, ended,
          // Compare CONTENT, not raw strings: a take or composite is queued with an
          // overridden document, and even a plain run differs from the widget by
          // normalization alone. Only a real change of material, prompts or mask counts.
          stale: (() => {
            // a face refine runs a document of its own (the face, nothing else): it does
            // not describe the clip, so it cannot be out of date with it
            if (!docJson || runKind(prefix) === "refine") return false;
            let runDoc;
            try { runDoc = JSON.parse(docJson); } catch (e) { return false; }
            // a composite deliberately carries a splice and a seam mask; judge it on the rest
            if (runDoc && runDoc.source) { runDoc = { ...runDoc, source: { ...runDoc.source, splice: [] } }; }
            const cur = (() => { try { return JSON.parse(host.currentDocJson() || "{}"); } catch (e) { return {}; } })();
            if (runKind(prefix) === "composite" && runDoc && runDoc.mask) runDoc = { ...runDoc, mask: cur.mask || runDoc.mask };
            return contentKey(runDoc) !== contentKey(cur);
          })(),
        });
      }
      rows.sort((a, b) => (b.started || 0) - (a.started || 0));
      st.hiddenTakes = rows.filter((x) => x.kind === "take").length;
      st.entries = rows.filter((x) => x.kind !== "take");
    } catch (exc) {
      st.error = String(exc);
    } finally {
      st.loading = false;
      render();
    }
  }

  function render() {
    root.replaceChildren();
    const head = section(t("page.results"));
    head.appendChild(row(btn(t("res.refresh"), load)));
    if (st.error) head.appendChild(el("div", "gd-badge-bad", st.error));
    if (st.loading) head.appendChild(el("div", "gd-hint", "…"));
    root.appendChild(head);

    if (st.hiddenTakes) {
      root.appendChild(el("div", "gd-hint",
        t("res.takesHidden", st.hiddenTakes)));
    }
    if (!st.loading && !st.entries.length) {
      root.appendChild(el("div", "gd-note", t("res.none")));
      return;
    }

    for (const entry of st.entries) {
      const card = section(null);
      card.classList.add("gd-result");
      if (!entry.ok) card.classList.add("gd-sec-bad");

      const meta = el("div", "gd-result-meta");
      const kindLabel = entry.kind === "composite"
        ? t(entry.cutOnly ? "res.kindCutTogether" : "res.kindComposite", entry.splicePieces)
        : entry.kind === "take" ? t("res.kindTake")
          : entry.kind === "refine" ? t("res.kindRefine") : t("res.kindRun");
      meta.appendChild(el("span", entry.kind === "composite" ? "gd-badge-ok" : "gd-badge-blue", kindLabel));
      // nothing was generated when takes are only cut together: no size, steps or seed to show
      if (!entry.cutOnly) {
        meta.appendChild(el("strong", null,
          `${entry.megapixels ?? "?"} MP · ${entry.steps ?? "?"} steps`
          + (entry.turbo ? " · turbo" : "")
          + (entry.presetName ? ` · ${entry.presetName}` : "")));
        meta.appendChild(el("span", "gd-hint", `${t("res.seed")} ${entry.seed}`));
      }
      if (entry.started && entry.ended) {
        meta.appendChild(el("span", "gd-hint",
          `${t("res.duration")} ${fmtDuration((entry.ended - entry.started))}`));
      }
      if (entry.started) {
        meta.appendChild(el("span", "gd-hint",
          `${t("res.when")} ${new Date(entry.started).toLocaleString()}`));
      }
      if (entry.stale) meta.appendChild(el("span", "gd-badge-bad", t("res.stale")));
      card.appendChild(meta);

      const strip = el("div", "gd-result-media");
      for (const item of entry.media.slice(0, 4)) {
        const url = videoUrl(item);
        if (/\.(mp4|webm|mkv|mov)$/i.test(item.filename)) {
          const v = el("video", "gd-result-video");
          v.src = url; v.controls = true; v.loop = true; v.muted = !sound.on(); v.preload = "metadata";
          strip.appendChild(v);
        } else {
          const i = el("img", "gd-result-img");
          i.src = url; i.alt = item.filename;
          strip.appendChild(i);
        }
      }
      if (entry.media.length) {
        strip.appendChild(btn(t("res.open"),
          () => window.open(videoUrl(entry.media[0]), "_blank"), "gd-btn gd-ghost"));
      }
      card.appendChild(strip);

      if (entry.report) {
        const d = el("details", "gd-result-details");
        d.appendChild(el("summary", null, t("res.report")));
        d.appendChild(el("pre", "gd-pre", entry.report));
        card.appendChild(d);
      }
      if (entry.compiled) {
        const d = el("details", "gd-result-details");
        d.appendChild(el("summary", null, t("res.prompt")));
        d.appendChild(el("pre", "gd-pre", entry.compiled));
        card.appendChild(d);
      }
      root.appendChild(card);
    }
  }

  return { render, load };
}
