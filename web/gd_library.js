// Gacha Director — the material library: everything the clip can use, in one window.
//
// A window of the panel, not of a page: opened from the bar at the top, it stays where it is
// put while the pages change under it. What it lists comes in two halves, the way ComfyUI
// keeps files: what was brought in (input/) and what was generated (output/). Either half is
// narrowed by kind, by a search and by folder.
//
// The folders are the library's own. A file is never moved or renamed on disk (workflows
// name files by where they are, and a moved file is a missing one in every workflow that
// uses it): a folder is an entry in one list, kept with the user's ComfyUI data and shared
// by every workflow, and putting a file "in" it writes the file's name beside the folder's
// id. A file no folder has is unfiled; a folder whose files are gone from disk is empty.
//
// An item is used by dragging it onto a place that takes material (a shot's material, the
// shared material, the source video) or, when the window was opened for one such place
// ("+ picture"), by clicking it.

import { t } from "./gd_i18n.js";
import { btn, dropZone, el, fileKind, fmtBytes, icon, input, LIBRARY_ITEMS, tip } from "./gd_ui.js";
import { FPS } from "./gd_doc.js";

const GEOMETRY_KEY = "gachadirector.library.geometry";
const PAGE = 200;                     // cells drawn at once; "more" draws the next ones
const KINDS = ["image", "video", "audio"];

/** The folders and what is in them, as stored: unknown fields and broken entries dropped. */
export function normalizeIndex(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const folders = [];
  const seen = new Set();
  for (const f of Array.isArray(src.folders) ? src.folders : []) {
    if (!f || typeof f.id !== "string" || !f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    folders.push({ id: f.id, name: String(f.name || ""), root: f.root === "output" ? "output" : "input",
                   parent: typeof f.parent === "string" ? f.parent : "" });
  }
  // a folder lies in a folder of its own half, and in no ring
  for (const f of folders) {
    const up = folders.find((x) => x.id === f.parent);
    if (!up || up.root !== f.root) f.parent = "";
  }
  for (const f of folders) {
    const walked = new Set([f.id]);
    for (let up = f.parent; up; up = (folders.find((x) => x.id === up) || {}).parent || "") {
      if (walked.has(up)) { f.parent = ""; break; }
      walked.add(up);
    }
  }
  const items = {};
  for (const [name, id] of Object.entries(src.items && typeof src.items === "object" ? src.items : {})) {
    if (typeof id === "string" && seen.has(id)) items[name] = id;
  }
  return { version: 1, folders, items };
}

function readGeometry() {
  try { return JSON.parse(localStorage.getItem(GEOMETRY_KEY) || "null") || null; } catch (e) { return null; }
}
function writeGeometry(g) {
  try { localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g)); } catch (e) { /* a private window */ }
}

/**
 * @param opts.layer        the element of the panel the window is put in
 * @param opts.media        () => what /gachadirector/media answered
 * @param opts.viewUrl      (name) => where the file is served
 * @param opts.refresh      async () => read the media again
 * @param opts.importFiles  async (files) => [{name, kind}] once they are in input/
 * @param opts.index        () => the folders as last read
 * @param opts.saveIndex    (index) => keep them
 */
export function createLibrary(opts) {
  const { layer, media, viewUrl, refresh, importFiles, index, saveIndex } = opts;
  let win = null;
  let parts = null;                   // the window's elements while it is open
  let root = "input";
  let kind = "all";
  let folder = "";                    // "" everything of the half, "-" unfiled, else a folder's id
  let shownCount = PAGE;
  let target = null;                  // {kinds, label, onPick, current, own}: picking for one place
  let renaming = "";                  // the folder whose name is being typed
  const selected = new Set();
  let lastClicked = "";
  let watcher = null;

  // ---------------------------------------------------------------- what there is
  function allItems() {
    const m = (typeof media === "function" ? media() : media) || {};
    const g = m.generated || { videos: m.renders || [] };
    const of = (list, k, r) => (list || []).map((x) => ({ ...x, kind: k, root: r }));
    return [...of(m.images, "image", "input"), ...of(m.videos, "video", "input"), ...of(m.audio, "audio", "input"),
            ...of(g.images, "image", "output"), ...of(g.videos, "video", "output"), ...of(g.audio, "audio", "output")];
  }
  const idx = () => normalizeIndex(index());
  const kindsNow = () => (target ? target.kinds : kind === "all" ? KINDS : [kind]);
  /** A folder and every folder inside it. */
  function withChildren(folders, id) {
    const out = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of folders) if (!out.has(f.id) && out.has(f.parent)) { out.add(f.id); grew = true; }
    }
    return out;
  }
  function visible() {
    const ix = idx();
    const kinds = kindsNow();
    const inside = folder && folder !== "-" ? withChildren(ix.folders, folder) : null;
    const q = parts ? parts.search.value.trim().toLowerCase() : "";
    return allItems()
      .filter((x) => x.root === root && kinds.includes(x.kind))
      .filter((x) => (folder === "" ? true : folder === "-" ? !ix.items[x.name] : inside.has(ix.items[x.name])))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }

  // ---------------------------------------------------------------- the folders
  function write(change) {
    const ix = idx();
    change(ix);
    saveIndex(normalizeIndex(ix));
    paint();
  }
  function newFolder() {
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const inside = folder && folder !== "-" ? folder : "";
    write((ix) => { ix.folders.push({ id, name: t("lib.folderName"), root, parent: inside }); });
    renaming = id;
    paintTree();
  }
  function removeFolder(id) {
    const ix = idx();
    const f = ix.folders.find((x) => x.id === id);
    if (!f || !window.confirm(t("lib.deleteFolderConfirm", f.name))) return;
    const gone = withChildren(ix.folders, id);
    if (gone.has(folder)) folder = "";
    write((x) => {
      x.folders = x.folders.filter((y) => !gone.has(y.id));
      for (const [name, at] of Object.entries(x.items)) if (gone.has(at)) delete x.items[name];
    });
  }
  /** Put files in a folder ("-": in none). Files of the other half stay where they are. */
  function file(names, id) {
    const ix = idx();
    const to = ix.folders.find((x) => x.id === id);
    const mine = new Set(allItems().filter((x) => x.root === (to ? to.root : root)).map((x) => x.name));
    write((x) => {
      for (const name of names) {
        if (!mine.has(name)) continue;
        if (to) x.items[name] = to.id; else delete x.items[name];
      }
    });
  }

  // ---------------------------------------------------------------- the window
  function place() {
    const box = layer.getBoundingClientRect();
    const g = readGeometry() || {};
    const w = Math.max(420, Math.min(g.w || 640, box.width - 16));
    const h = Math.max(280, Math.min(g.h || Math.round(box.height * 0.72), box.height - 16));
    const x = Math.max(8, Math.min(g.x == null ? box.width - w - 12 : g.x, box.width - w - 8));
    const y = Math.max(8, Math.min(g.y == null ? 12 : g.y, box.height - h - 8));
    Object.assign(win.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }
  function keep() {
    if (!win) return;
    writeGeometry({ x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight });
  }
  function grip(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, .gd-libwin-seg")) return;
      const box = layer.getBoundingClientRect();
      const dx = e.clientX - win.offsetLeft;
      const dy = e.clientY - win.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* an event made by a script */ }
      const move = (m) => {
        win.style.left = `${Math.max(8 - win.offsetWidth + 80, Math.min(m.clientX - dx, box.width - 80))}px`;
        win.style.top = `${Math.max(0, Math.min(m.clientY - dy, box.height - 36))}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        keep();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function build() {
    win = el("div", "gd-libwin");
    const head = el("div", "gd-libwin-head");
    head.appendChild(el("strong", null, t("gen.library")));
    const seg = el("div", "gd-libwin-seg");
    const halves = {};
    for (const r of ["input", "output"]) {
      halves[r] = btn(t(r === "input" ? "lib.rootInput" : "lib.rootOutput"), () => {
        if (root === r) return;
        root = r; folder = ""; shownCount = PAGE; selected.clear();
        paint();
      }, "gd-libwin-half");
      seg.appendChild(halves[r]);
    }
    head.appendChild(seg);
    head.appendChild(el("span", "gd-libwin-gap"));
    const state = el("span", "gd-lib-state");
    head.appendChild(state);
    const chooser = el("input");
    chooser.type = "file"; chooser.multiple = true; chooser.hidden = true;
    chooser.accept = "image/*,video/*,audio/*";
    chooser.addEventListener("change", () => { const files = [...chooser.files]; chooser.value = ""; bring(files); });
    head.appendChild(chooser);
    const bringBtn = tip(btn(t("lib.import"), () => chooser.click(), "gd-btn gd-btn-sm"), t("lib.importHint"));
    head.appendChild(bringBtn);
    head.appendChild(btn(t("res.refresh"), async () => { if (refresh) await refresh(); paint(); }, "gd-btn gd-ghost gd-btn-sm"));
    head.appendChild(btn("✕", () => close(), "gd-btn gd-ghost gd-btn-icon"));
    grip(head);

    const bar = el("div", "gd-libwin-bar");
    const chips = {};
    for (const k of ["all", ...KINDS]) {
      chips[k] = btn(t(k === "all" ? "lib.all" : `lib.kind.${k}`), () => {
        if (target) return;                       // the place being picked for says what fits
        kind = k; shownCount = PAGE; paint();
      }, "gd-libwin-chip");
      bar.appendChild(chips[k]);
    }
    const search = input("text", "", () => {}, { placeholder: t("lib.filter") });
    search.addEventListener("input", () => { shownCount = PAGE; paintGrid(); });
    bar.appendChild(search);
    const count = el("span", "gd-hint");
    bar.appendChild(count);

    const picking = el("div", "gd-libwin-target");
    const body = el("div", "gd-libwin-body");
    const tree = el("div", "gd-libwin-tree");
    const grid = el("div", "gd-libwin-grid");
    body.append(tree, grid);
    win.append(head, bar, picking, body);
    parts = { halves, chips, search, count, picking, tree, grid, state, bringBtn };

    // files from this computer, dropped anywhere on the window: brought in, and put in the
    // folder that is open
    if (importFiles) dropZone(win, bring);
    win.addEventListener("pointerdown", (e) => e.stopPropagation());
    grid.addEventListener("click", (e) => { if (e.target === grid) { selected.clear(); paintGrid(); } });
    layer.appendChild(win);
    place();
    if (typeof ResizeObserver !== "undefined") {
      watcher = new ResizeObserver(() => keep());
      watcher.observe(win);
    }
  }

  async function bring(files) {
    const mine = [...files].filter((f) => fileKind(f));
    if (!mine.length || !importFiles) return;
    parts.state.className = "gd-lib-state";
    parts.state.textContent = t("lib.importing", mine.length);
    try {
      const got = await importFiles(mine);
      parts.state.textContent = "";
      // one file of a kind the place asked for is what was wanted: use it at once
      if (target && got.length === 1 && target.kinds.includes(got[0].kind)) { choose(got[0].name); return; }
      root = "input";
      if (folder && folder !== "-" && (idx().folders.find((x) => x.id === folder) || {}).root === "input") {
        file(got.map((g) => g.name), folder);
      }
      selected.clear();
      for (const g of got) selected.add(g.name);
      paint();
    } catch (e) {
      parts.state.className = "gd-lib-state bad";
      parts.state.textContent = t("lib.importFailed", String((e && e.message) || e));
    }
  }

  /** The item clicked while a place is being picked for. */
  function choose(name) {
    const p = target;
    target = null;
    // close first: the pick may ask for the next one (first frame, then last frame)
    if (p.own) close(); else paint();
    p.onPick(name);
  }

  // ---------------------------------------------------------------- painting
  function paint() {
    if (!win) return;
    for (const r of ["input", "output"]) parts.halves[r].classList.toggle("on", root === r);
    const kinds = kindsNow();
    for (const k of ["all", ...KINDS]) {
      const on = target ? (k !== "all" && kinds.includes(k)) : kind === k;
      parts.chips[k].classList.toggle("on", on);
      parts.chips[k].disabled = !!target && !on;
    }
    parts.bringBtn.hidden = !importFiles;
    parts.picking.replaceChildren();
    parts.picking.hidden = !target;
    if (target) {
      parts.picking.appendChild(el("span", null, t("lib.pickFor", target.label)));
      parts.picking.appendChild(btn(t("lib.pickCancel"), () => {
        const own = target.own;
        target = null;
        if (own) close(); else paint();
      }, "gd-btn gd-ghost gd-btn-sm"));
    }
    paintTree();
    paintGrid();
  }

  function paintTree() {
    if (!win) return;
    const ix = idx();
    const kinds = kindsNow();
    const mine = allItems().filter((x) => x.root === root && kinds.includes(x.kind));
    const tree = parts.tree;
    tree.replaceChildren();
    const row = (id, label, n, depth, f) => {
      const r = el("div", "gd-libwin-folder" + (folder === id ? " on" : ""));
      r.style.paddingLeft = `${8 + depth * 14}px`;
      r.appendChild(icon(id === "" ? "stack" : id === "-" ? "tray" : "folder", 14));
      if (f && renaming === f.id) {
        const name = el("input");
        name.type = "text"; name.value = f.name;
        const done = (save) => {
          if (renaming !== f.id) return;
          renaming = "";
          const v = name.value.trim();
          if (save && v && v !== f.name) write((x) => { x.folders.find((y) => y.id === f.id).name = v; });
          else paintTree();
        };
        // the panel hands a field its keys as "gd-key" (gd_modal.js); Escape is asked of
        // the library as a whole (`escape` below)
        name.addEventListener("gd-key", (e) => { if (e.detail && e.detail.key === "Enter") done(true); });
        name.addEventListener("change", () => done(true));
        name.addEventListener("blur", () => done(true));
        r.appendChild(name);
        setTimeout(() => { name.focus(); name.select(); }, 0);
      } else {
        r.appendChild(el("span", "gd-libwin-fname", label));
        r.appendChild(el("span", "gd-libwin-n", String(n)));
        r.onclick = () => { folder = id; shownCount = PAGE; selected.clear(); paint(); };
        if (f) {
          r.ondblclick = () => { renaming = f.id; paintTree(); };
          const x = btn("×", (e) => { e.stopPropagation(); removeFolder(f.id); }, "gd-libwin-x");
          tip(x, t("lib.deleteFolder"));
          r.appendChild(x);
        }
      }
      // items of the library dropped on a folder go into it; on "unfiled", out of theirs
      if (id !== "") {
        r.addEventListener("dragover", (e) => {
          if (![...(e.dataTransfer.types || [])].includes(LIBRARY_ITEMS)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          r.classList.add("over");
        });
        r.addEventListener("dragleave", () => r.classList.remove("over"));
        r.addEventListener("drop", (e) => {
          r.classList.remove("over");
          const raw = e.dataTransfer.getData(LIBRARY_ITEMS);
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation();
          file(JSON.parse(raw).map((x) => x.name), id);
        });
      }
      tree.appendChild(r);
    };
    row("", t("lib.all"), mine.length, 0, null);
    const draw = (parent, depth) => {
      for (const f of ix.folders.filter((x) => x.root === root && x.parent === parent)) {
        const inside = withChildren(ix.folders, f.id);
        row(f.id, f.name, mine.filter((x) => inside.has(ix.items[x.name])).length, depth, f);
        draw(f.id, depth + 1);
      }
    };
    draw("", 0);
    row("-", t("lib.unfiled"), mine.filter((x) => !ix.items[x.name]).length, 0, null);
    const add = btn(t("lib.newFolder"), () => newFolder(), "gd-libwin-new");
    tree.appendChild(tip(add, t("lib.folderHint")));
  }

  // thumbnails of what is in sight only: a few hundred videos are not opened at once
  let sight = null;
  function paintGrid() {
    if (!win) return;
    const grid = parts.grid;
    const list = visible();
    parts.count.textContent = selected.size ? t("lib.selected", selected.size, list.length) : t("lib.count", list.length);
    grid.replaceChildren();
    if (sight) sight.disconnect();
    sight = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const v = en.target;
        sight.unobserve(v);
        if (v.dataset.src) { v.preload = "metadata"; v.src = v.dataset.src; }
      }
    }, { root: grid, rootMargin: "200px" }) : null;
    if (!list.length) {
      const none = allItems().some((x) => x.root === root && kindsNow().includes(x.kind));
      grid.appendChild(el("div", "gd-lib-empty", none ? t("lib.noMatch")
        : t(root === "output" ? "lib.emptyOutput" : importFiles ? "lib.emptyImport" : "lib.empty",
            kindsNow().map((k) => t(`lib.kind.${k}`)).join(" / "))));
      return;
    }
    for (const item of list.slice(0, shownCount)) grid.appendChild(cell(item, list));
    if (list.length > shownCount) {
      grid.appendChild(btn(t("lib.more", list.length - shownCount), () => { shownCount += PAGE; paintGrid(); },
        "gd-btn gd-ghost gd-libwin-more"));
    }
  }

  function cell(item, list) {
    const c = el("div", "gd-libwin-item" + (selected.has(item.name) ? " on" : "")
      + (target && target.current === item.name ? " current" : ""));
    const url = viewUrl(item.name);
    if (item.kind === "image") {
      const i = el("img", "gd-libwin-thumb");
      i.src = url; i.alt = ""; i.loading = "lazy"; i.draggable = false;
      c.appendChild(i);
    } else if (item.kind === "video") {
      const v = el("video", "gd-libwin-thumb");
      v.muted = true; v.preload = "none"; v.dataset.src = `${url}#t=0.1`;
      v.addEventListener("mouseenter", () => { v.play().catch(() => {}); });
      v.addEventListener("mouseleave", () => { v.pause(); });
      if (sight) sight.observe(v); else { v.preload = "metadata"; v.src = v.dataset.src; }
      c.appendChild(v);
    } else {
      const a = el("div", "gd-libwin-thumb gd-libwin-sound");
      a.appendChild(icon("sound", 26));
      c.appendChild(a);
    }
    c.appendChild(el("div", "gd-libwin-name", item.name.replace(/ \[output\]$/, "")));
    const long = item.frames24 ? `${(item.frames24 / FPS).toFixed(1)} s · ` : "";
    c.appendChild(el("div", "gd-libwin-meta", `${long}${fmtBytes(item.size)}`));
    tip(c, item.name);
    c.onclick = (e) => {
      if (target) { choose(item.name); return; }
      if (e.shiftKey && lastClicked) {
        const names = list.map((x) => x.name);
        const [a, b] = [names.indexOf(lastClicked), names.indexOf(item.name)].sort((x, y) => x - y);
        if (a >= 0) for (const n of names.slice(a, b + 1)) selected.add(n);
      } else if (e.ctrlKey || e.metaKey) {
        if (selected.has(item.name)) selected.delete(item.name); else selected.add(item.name);
      } else {
        selected.clear();
        selected.add(item.name);
      }
      lastClicked = item.name;
      paintGrid();
    };
    c.draggable = true;
    c.addEventListener("dragstart", (e) => {
      if (!selected.has(item.name)) { selected.clear(); selected.add(item.name); lastClicked = item.name; }
      const byName = new Map(list.map((x) => [x.name, x]));
      const carried = [...selected].filter((n) => byName.has(n)).map((n) => ({ name: n, kind: byName.get(n).kind }));
      e.dataTransfer.setData(LIBRARY_ITEMS, JSON.stringify(carried));
      e.dataTransfer.setData("text/plain", carried.map((x) => x.name).join("\n"));
      e.dataTransfer.effectAllowed = "copyMove";
      c.classList.add("on");
    });
    return c;
  }

  function close() {
    if (!win) return;
    keep();
    if (watcher) { watcher.disconnect(); watcher = null; }
    if (sight) { sight.disconnect(); sight = null; }
    win.remove();
    win = parts = null;
    target = null;
    renaming = "";
  }

  return {
    /**
     * Show the window. With `pick`, for one place: `{kinds, label, onPick, current}` — what
     * fits there is listed, and a click on an item hands its name over. A window that was
     * opened for the pick closes with it; one that was open already stays.
     */
    open({ pick = null } = {}) {
      const was = !!win;
      if (!win) build();
      if (pick) {
        target = { ...pick, own: !was };
        selected.clear();
        shownCount = PAGE;
      }
      paint();
    },
    close,
    toggle() { if (win) close(); else this.open(); },
    isOpen: () => !!win,
    /** Escape was pressed in the panel: true when the library took it (a name being
     *  typed is given up, a pick is called off, the window is closed: one at a time). */
    escape() {
      if (!win) return false;
      if (renaming) { renaming = ""; paintTree(); return true; }
      if (target && !target.own) { target = null; paint(); } else close();
      return true;
    },
    /** The media were read again, or the language changed. */
    repaint() { paint(); },
  };
}
