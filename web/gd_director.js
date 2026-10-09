// Gacha Director — the ComfyUI adapter. The only file here that imports from ComfyUI, and
// the only one that knows what a LiteGraph widget is.
//
// It does five things:
//   1. registers GDGROUP, the group header the Python node declares;
//   2. registers GDPRESET, the preset selector — its options come from the node's own
//      gd_presets widget, which is why it cannot be a plain server-side COMBO;
//   3. registers GDMETRICS, a read-only readout of canvas, frames, steps and what the
//      selected preset has cost before;
//   4. hides the four JSON storage widgets;
//   5. hands the editor a `host` that reads and writes real widgets.
//
// Nothing is cached. `getWidget` reads the live widget every time, so the canvas and the
// panel cannot drift apart.
//
// Portions adapted from Thefrizzy1's ComfyUI-MiniMaxH3-Director (js/director.js: the
// extension scaffold and the host accessors) and from AIMixer's ComfyUI_MiniMaxH3_Director
// (the group header widget), both Apache-2.0; modified. See NOTICE.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createEditor } from "./gd_editor.js";
import { t } from "./gd_i18n.js";
import { activePreset, fmtSeconds, normalizePresets, timingFor } from "./gd_presets_doc.js";
import { canvasSize, normalize as normalizeDoc } from "./gd_doc.js";

/** /view URL for a media name relative to a ComfyUI folder; splits "sub/dir/name.ext". */
function viewUrlFor(name, kind) {
  let p = String(name || "").replace(/\\/g, "/");
  const m = p.match(/^(.*?)\s\[(input|output|temp)\]$/);
  if (m) { p = m[1]; kind = m[2]; }
  const i = p.lastIndexOf("/");
  const file = i < 0 ? p : p.slice(i + 1);
  const sub = i < 0 ? "" : p.slice(0, i);
  return api.apiURL(`/view?filename=${encodeURIComponent(file)}&type=${kind}&subfolder=${encodeURIComponent(sub)}`);
}

(function injectCss() {
  const href = new URL("./gd_director.css", import.meta.url).href;
  if (![...document.querySelectorAll("link")].some((l) => l.href === href)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
})();

const NODE = "GachaDirector";
const DOC_WIDGET = "gd_timeline";
const POST_WIDGET = "gd_post";
const PRESETS_WIDGET = "gd_presets";
const TAKES_WIDGET = "gd_takes";
const HIDDEN = [DOC_WIDGET, POST_WIDGET, PRESETS_WIDGET, TAKES_WIDGET];

function widget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function hide(w) {
  if (!w) return;
  // A multiline STRING is a DOM widget in the current frontend, so `type = "hidden"`
  // alone leaves the textarea on screen. `hidden` is what the layout pass reads; the
  // inline style is belt and braces; computeSize(-4) cancels ComfyUI's widget padding.
  w.hidden = true;
  w.options = Object.assign(w.options || {}, { hidden: true });
  w.computeSize = () => [0, -4];
  if (w.element) w.element.style.display = "none";
}

function readJsonWidget(node, name) {
  const w = widget(node, name);
  try {
    const v = JSON.parse((w && w.value) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------- telling ComfyUI
// ComfyUI looks for changes to the workflow on mouse and key events. The panel also writes
// at other times: when a queue call returns, when a run starts or ends, when the seed moves
// on after a batch. Until the next click anywhere, ComfyUI does not know, and a reload
// restores the workflow without them (measured: a queued take gone from the list, the seed
// back where it was, and the next take a repeat of the last one). So every write asks
// ComfyUI to look, once the writes have stopped for a moment: a look serializes the whole
// graph, a drag in the panel writes on every move, and every look that finds a change is a
// step in ComfyUI's own undo history.
let lookTimer = 0;
function noteChange() {
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => {
    const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    const look = tracker && (tracker.captureCanvasState || tracker.checkState);
    if (!look) return;                 // a front end without it: the next click does the same
    try { look.call(tracker); } catch (e) { console.error("GachaDirector noteChange", e); }
  }, 250);
}

// ---------------------------------------------------------------- event bus
// One subscription per event name for the whole page, fanned out to whoever asked. Adding
// and removing api listeners per render would drop events mid-run.
const listeners = new Map();
const bus = {
  on(name, fn) {
    if (!listeners.has(name)) {
      const set = new Set();
      listeners.set(name, set);
      api.addEventListener(name, (event) => {
        for (const cb of set) {
          try { cb(event.detail); } catch (e) { console.error("GachaDirector bus", name, e); }
        }
      });
    }
    listeners.get(name).add(fn);
  },
  off(name, fn) {
    const set = listeners.get(name);
    if (set) set.delete(fn);
  },
};

/**
 * The id ComfyUI runs this node under. In the top-level graph that is the node's own id. A
 * node inside a subgraph runs as "<subgraph node id>:<node id>" (deeper: "a:b:c"), and the
 * prompt, the events and history all use that (measured: "32:10"). When one subgraph is
 * placed more than once, the first placement found is the one a take is queued for.
 */
function execId(node) {
  if (!node.graph) return String(node.id);    // not placed yet: ComfyUI may not even have a graph
  const root = app.rootGraph || app.graph;
  if (!root || node.graph === root) return String(node.id);
  const find = (graph, trail) => {
    for (const n of graph.nodes || graph._nodes || []) {
      if (!n.subgraph) continue;
      if (n.subgraph === node.graph) return [...trail, n.id];
      const deeper = find(n.subgraph, [...trail, n.id]);
      if (deeper) return deeper;
    }
    return null;
  };
  const chain = find(root, []);
  return chain ? [...chain, node.id].join(":") : String(node.id);
}

/**
 * The output nodes a take is for: this node, and the output nodes that hang off it (a
 * preview of its report, a save of its frames). ComfyUI runs every output node of a prompt
 * unless told which ones; without this a second director node in the same workflow, or an
 * unrelated save, would be rendered again with every take.
 */
function executionTargets(output, id) {
  const known = new Map();                  // node id -> does it depend on `id`?
  const dependsOn = (nid) => {
    if (nid === id) return true;
    if (known.has(nid)) return known.get(nid);
    known.set(nid, false);                  // also stops a loop, should the graph have one
    const inputs = (output[nid] && output[nid].inputs) || {};
    const hit = Object.values(inputs).some(
      (v) => Array.isArray(v) && v.length === 2 && output[String(v[0])] && dependsOn(String(v[0])));
    known.set(nid, hit);
    return hit;
  };
  const targets = [id];
  for (const [nid, n] of Object.entries(output)) {
    if (nid === id) continue;
    const def = globalThis.LiteGraph && globalThis.LiteGraph.registered_node_types[n.class_type];
    if (def && def.nodeData && def.nodeData.output_node && dependsOn(nid)) targets.push(nid);
  }
  return targets;
}

/** The node feeding input `name`, or null. */
function upstream(node, name) {
  const slot = (node.inputs || []).find((i) => i.name === name);
  if (!slot || slot.link == null || !node.graph) return null;
  const link = node.graph.links instanceof Map ? node.graph.links.get(slot.link)
    : node.graph.links[slot.link];
  return link ? node.graph.getNodeById(link.origin_id) : null;
}

/**
 * The checkpoint file behind an input, found by walking back through model patches
 * (LoRA loaders and the like) until a node with a model-name widget turns up. Only a
 * hint: a model fed through a subgraph or a custom loader simply reports "".
 */
function modelFileBehind(node, name) {
  let cur = upstream(node, name);
  for (let hops = 0; cur && hops < 12; hops++) {
    const w = (cur.widgets || []).find((x) => /^(unet_name|ckpt_name|model_name)$/.test(x.name));
    if (w && w.value) return String(w.value);
    cur = upstream(cur, "model");
  }
  return "";
}

function makeHost(node, launcherHost) {
  const guards = new Map();          // event name -> (the editor's listener -> its guarded version)
  const writeJson = (name, value) => {
    const w = widget(node, name);
    if (!w) return;
    const text = JSON.stringify(value);
    if (w.value === text) return;
    w.value = text;
    if (node.graph) noteChange();
  };
  return {
    launcherHost,
    // Events reach the editor only while its node is in a graph. ComfyUI can drop a node
    // without calling onRemoved ("convert to subgraph" builds a new one inside the subgraph),
    // and the dropped node's editor would go on reacting under the old id.
    bus: {
      on(name, fn) {
        const guarded = (detail) => { if (node.graph) fn(detail); };
        if (!guards.has(name)) guards.set(name, new Map());
        guards.get(name).set(fn, guarded);
        bus.on(name, guarded);
      },
      off(name, fn) {
        const mine = guards.get(name);
        if (mine && mine.has(fn)) { bus.off(name, mine.get(fn)); mine.delete(fn); }
      },
    },
    readDocument: () => readJsonWidget(node, DOC_WIDGET),
    writeDocument: (d) => writeJson(DOC_WIDGET, d),
    rawDocument: () => String(widget(node, DOC_WIDGET)?.value || ""),
    readPost: () => readJsonWidget(node, POST_WIDGET),
    writePost: (c) => writeJson(POST_WIDGET, c),
    readPresets: () => readJsonWidget(node, PRESETS_WIDGET),
    writePresets: (s) => {
      writeJson(PRESETS_WIDGET, s);
      // Keep the node's own selector in step with the store's active preset.
      const sel = widget(node, "preset");
      if (sel && s && s.active) sel.value = s.active;
    },
    readTakes: () => readJsonWidget(node, TAKES_WIDGET),
    writeTakes: (s) => writeJson(TAKES_WIDGET, s),
    hasTakesWidget: () => !!widget(node, TAKES_WIDGET),
    nodeId: () => execId(node),
    attached: () => !!node.graph,
    clientId: () => api.clientId || "",   // what ComfyUI records with a prompt this page queues
    getWidget: (name) => {
      const w = widget(node, name);
      return w ? w.value : undefined;
    },
    setWidget: (name, value) => {
      const w = widget(node, name);
      if (!w) return;
      w.value = value;
      if (w.callback) { try { w.callback(value); } catch (e) { /* widget said no */ } }
      if (node.graph) { node.graph.setDirtyCanvas(true, true); noteChange(); }
    },
    setWidgets(obj) {
      for (const [k, v] of Object.entries(obj)) this.setWidget(k, v);
    },
    markDirty: () => { if (node.graph) node.graph.setDirtyCanvas(true, true); },
    // Media names from /gachadirector/media are paths relative to the input folder
    // ("shots/clip.mp4"): /view wants the directory in `subfolder` and rejects a filename
    // with a slash in it, so split here. A trailing " [output]" annotation picks the type.
    viewUrl: (filename) => viewUrlFor(filename, "input"),
    apiUrl: (path) => api.apiURL(path),
    queuePrompt: async () => {
      // Through the app, so the graph is serialized exactly as the canvas has it.
      await app.queuePrompt(0, 1);
      return "";
    },
    /**
     * Queue the current graph with THIS node's inputs overridden. The takes page uses it
     * to run N candidates with different seeds, or the composite with a spliced source,
     * without changing what the canvas shows. Returns the prompt_id.
     *
     * The overrides go into the widgets for the moment the graph is serialized and are
     * taken out again right after. That way the prompt and the workflow saved inside the
     * output file describe the same run: opening a take's file restores that take, not
     * whatever the canvas happened to hold when the batch was queued.
     */
    queueWithOverrides: async (overrides) => {
      if (!node.graph) {               // a node ComfyUI dropped: its id may now be another node's
        const err = new Error("GachaDirector node is not in a graph");
        err.code = "node_missing";
        throw err;
      }
      const names = { timeline: "gd_timeline", post: "gd_post", presets: "gd_presets",
                      preset: "preset", seed: "seed" };
      const saved = [];
      let p = null;
      try {
        for (const [key, name] of Object.entries(names)) {
          if (overrides[key] === undefined) continue;
          const w = widget(node, name);
          if (!w) continue;
          const temp = typeof overrides[key] === "object" ? JSON.stringify(overrides[key]) : overrides[key];
          saved.push([w, w.value, temp]);
          w.value = temp;
        }
        p = await app.graphToPrompt();
      } finally {
        // put back only what is still ours: if something wrote the widget while the graph
        // was being serialized (a timing landing, an edit), that write stands
        for (const [w, value, temp] of saved) if (w.value === temp) w.value = value;
      }
      const id = execId(node);
      if (!p.output[id]) {
        // muted or bypassed (here or, inside a subgraph, the subgraph node around it)
        const err = new Error("GachaDirector node not found in the serialized prompt");
        err.code = "node_missing";
        throw err;
      }
      const res = await api.queuePrompt(0, { output: p.output, workflow: p.workflow },
        { partialExecutionTargets: executionTargets(p.output, id) });
      return (res && res.prompt_id) || "";
    },
    fetchHistory: async (promptId) => {
      const res = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" });
      const data = await res.json();
      return data && data[promptId] ? data[promptId] : null;
    },
    viewUrlOutput: (filename) => viewUrlFor(filename, "output"),
    modelName: () => modelFileBehind(node, "model"),
    turboWired: () => !!upstream(node, "model_turbo"),
    externalWired: () => ({ sampler: !!upstream(node, "sampler"), sigmas: !!upstream(node, "sigmas") }),
    interrupt: () => api.interrupt(),
    /**
     * What the card is holding, and how to hand it back. ComfyUI keeps models resident
     * between runs on purpose — with H3 that is a text encoder or a DiT of tens of
     * gigabytes still sitting there when the run is long over, which reads as "96% used"
     * and makes every other GPU app crawl. /free is ComfyUI's own unload, the same one
     * behind the menu's two buttons; it is safe mid-idle and costs one model reload on
     * the next run.
     */
    vramStats: async () => {
      const res = await api.fetchApi("/system_stats", { cache: "no-store" });
      const d = await res.json();
      const dev = (d.devices || [])[0];
      if (!dev) return null;
      return { name: dev.name, total: dev.vram_total, free: dev.vram_free,
               torchHeld: dev.torch_vram_total - dev.torch_vram_free };
    },
    freeMemory: () => api.fetchApi("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }),
    clearQueue: () => api.fetchApi("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    }),
  };
}

app.registerExtension({
  name: "GachaDirector",

  getCustomWidgets() {
    return {
      // ---- group header, decoration only
      GDGROUP(node, inputName, inputData) {
        const label = (inputData && inputData[1] && inputData[1].default) || inputName;
        const w = {
          name: inputName,
          type: "GDGROUP",
          value: label,
          label: "",
          options: (inputData && inputData[1]) || {},
          // A header IS serialized, even though its value is only a label.
          // widgets_values is positional: leave the headers out and the saved array is
          // shorter than the widget list, so every value after the first header lands one
          // slot early and a reloaded workflow reads the wrong setting into each widget.
          computeSize: () => [0, 24],
          draw(ctx, n, widgetWidth, y) {
            const margin = 14;
            ctx.save();
            ctx.fillStyle = "#243447";
            ctx.strokeStyle = "#34506b";
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(margin, y + 3, widgetWidth - margin * 2, 18, 4);
            else ctx.rect(margin, y + 3, widgetWidth - margin * 2, 18);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#9fd0ff";
            ctx.beginPath();
            ctx.rect(margin, y + 3, 3, 18);
            ctx.fill();
            ctx.fillStyle = "#cfe3f5";
            ctx.font = "600 11px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(String(this.value || label), margin + 10, y + 12);
            ctx.restore();
          },
        };
        return { widget: node.addCustomWidget(w), minWidth: 120, minHeight: 24 };
      },

      // ---- preset selector. A server-side COMBO has a fixed option list; the presets
      // live in this node's own JSON widget and the user can add and rename them, so the
      // options have to be read at draw/click time.
      GDPRESET(node, inputName, inputData) {
        const w = {
          name: inputName,
          type: "GDPRESET",
          value: String((inputData && inputData[1] && inputData[1].default) || ""),
          options: (inputData && inputData[1]) || {},
          computeSize: () => [0, 26],
          _store() { return normalizePresets(readJsonWidget(node, PRESETS_WIDGET)); },
          _current() {
            const store = this._store();
            const id = String(this.value || store.active);
            return store.presets.find((p) => p.id === id) || store.presets[0];
          },
          draw(ctx, n, widgetWidth, y) {
            const cur = this._current();
            const margin = 14;
            const h = 20;
            ctx.save();
            ctx.fillStyle = "#131b26";
            ctx.strokeStyle = "#4fd08f";
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(margin, y + 2, widgetWidth - margin * 2, h, 4);
            else ctx.rect(margin, y + 2, widgetWidth - margin * 2, h);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#7ee2a8";
            ctx.font = "600 11px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(cur ? cur.name : "-", margin + 8, y + 12);
            ctx.textAlign = "right";
            ctx.fillStyle = "#9fb3c8";
            ctx.fillText("▾", widgetWidth - margin - 8, y + 12);
            ctx.restore();
          },
          mouse(event, pos, n) {
            if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
            const store = this._store();
            // what each preset comes to for the clip on this node: a size, not a pixel budget
            let aspect = "16:9", src = null;
            try {
              aspect = normalizeDoc(readJsonWidget(node, DOC_WIDGET)).clip.aspect;
              src = (node._gdEditor && node._gdEditor.sourceSize) ? node._gdEditor.sourceSize() : null;
            } catch (e) { /* the menu still opens */ }
            const entries = store.presets.map((p) => {
              const [w, h] = canvasSize(aspect, p.params.megapixels, src);
              return {
                content: `${p.name}   ${w}×${h} · ${t("run.stepsN", p.params.steps)}`
                  + (p.params.model === "turbo" ? " · turbo" : "")
                  + (p.history.count ? `   ~${fmtSeconds(p.history.avg_seconds)}` : ""),
                id: p.id,
              };
            });
            new LiteGraph.ContextMenu(entries, {
              event,
              title: t("node.taskGroup"),
              callback: (entry) => {
                this.value = entry.id;
                const s = this._store();
                s.active = entry.id;
                const jw = widget(n, PRESETS_WIDGET);
                if (jw) jw.value = JSON.stringify(normalizePresets(s));
                if (n._gdEditor) n._gdEditor.refresh();
                if (n.graph) n.graph.setDirtyCanvas(true, true);
              },
            });
            return true;
          },
        };
        return { widget: node.addCustomWidget(w), minWidth: 120, minHeight: 26 };
      },

      // ---- read-only metrics: the headline numbers plus what this preset has cost
      GDMETRICS(node, inputName, inputData) {
        const w = {
          name: inputName,
          type: "GDMETRICS",
          value: "",
          options: (inputData && inputData[1]) || {},
          computeSize: () => [0, 52],
          draw(ctx, n, widgetWidth, y) {
            let lines = ["-", "-"];
            try {
              const store = normalizePresets(readJsonWidget(node, PRESETS_WIDGET));
              const sel = widget(node, "preset");
              const id = String((sel && sel.value) || store.active);
              const p = store.presets.find((x) => x.id === id) || activePreset(store);
              const d = normalizeDoc(readJsonWidget(node, DOC_WIDGET));
              const src = (node._gdEditor && node._gdEditor.sourceSize) ? node._gdEditor.sourceSize() : null;
              const [cw, ch] = canvasSize(d.clip.aspect, p.params.megapixels, src);
              const fc = d.derived.frame_count;
              lines[0] = `${cw}×${ch} · ${t("run.lengthValue", (fc / 24).toFixed(2))} · ${t("run.fpsValue", 24)}`
                + ` · ${t("run.stepsN", p.params.steps)}` + (p.params.model === "turbo" ? " · turbo" : "");
              // timings are for clips of this length: a 15 s clip is not a 5 s clip
              const tm = timingFor(p, fc);
              lines[1] = tm.count
                ? t("node.lastAvg", fmtSeconds(tm.last_seconds), fmtSeconds(tm.avg_seconds), tm.count)
                : t("node.noTiming");
            } catch (e) { /* draw the dashes */ }
            const margin = 14;
            ctx.save();
            ctx.fillStyle = "#101822";
            ctx.strokeStyle = "#2c3f55";
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(margin, y + 2, widgetWidth - margin * 2, 46, 4);
            else ctx.rect(margin, y + 2, widgetWidth - margin * 2, 46);
            ctx.fill();
            ctx.stroke();
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.font = "11px ui-monospace, Consolas, monospace";
            ctx.fillStyle = "#cfe3f5";
            ctx.fillText(lines[0], margin + 8, y + 15);
            ctx.fillStyle = "#9fb3c8";
            ctx.fillText(lines[1], margin + 8, y + 34);
            ctx.restore();
          },
        };
        return { widget: node.addCustomWidget(w), minWidth: 120, minHeight: 52 };
      },
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated && onCreated.apply(this, arguments);

      for (const name of HIDDEN) hide(widget(this, name));

      // The launcher is all the node shows of the panel: open + language, one row. No
      // status line and no picture: the node is a handle, everything else is in the panel.
      const launcherHost = document.createElement("div");
      const launcher = this.addDOMWidget("gd_launcher", "div", launcherHost, { serialize: false });
      launcher.computeSize = () => [0, 36];

      const editor = createEditor(makeHost(this, launcherHost));
      this._gdEditor = editor;

      // ComfyUI draws sampling previews and output images into a node's free area and
      // grows the node to fit them (setSizeForImage). This node shows neither: the panel
      // has the results page, and a node that balloons every run is in the way.
      this.onDrawBackground = function () {};
      this.imgs = null;

      this.size = [Math.max(this.size[0], 360), this.computeSize()[1]];
      this.color = "#1d2a3a";
      this.bgcolor = "#243447";
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure && onConfigure.apply(this, arguments);
      for (const name of HIDDEN) hide(widget(this, name));
      if (this._gdEditor) {
        setTimeout(() => { if (this._gdEditor) this._gdEditor.rehydrate(); }, 0);
      }
      // A workflow saved while the node still had a status widget or a preview carries
      // that tall size; the node has nothing to show there any more, so drop to fit.
      setTimeout(() => {
        // An input this node no longer has comes back from a workflow of an older version
        // as an empty socket. With nothing wired to it, it is only in the way.
        const known = new Set([...Object.keys((nodeData.input && nodeData.input.required) || {}),
                               ...Object.keys((nodeData.input && nodeData.input.optional) || {})]);
        for (let i = (this.inputs || []).length - 1; i >= 0; i--) {
          if (!known.has(this.inputs[i].name) && this.inputs[i].link == null) this.removeInput(i);
        }
        const h = this.computeSize()[1];
        if (this.size[1] > h + 4) this.setSize([this.size[0], h]);
      }, 0);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._gdEditor) this._gdEditor.destroy();
      onRemoved && onRemoved.apply(this, arguments);
    };
  },

  async afterConfigureGraph() {
    for (const node of app.graph._nodes || []) {
      if (node.type !== NODE) continue;
      for (const name of HIDDEN) hide(widget(node, name));
      if (node._gdEditor) node._gdEditor.rehydrate();
    }
  },
});
