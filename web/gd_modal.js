// Gacha Director — the page-root modal, the node launcher, and the undo bar.
//
// A small launcher is all the node shows; behind it is one persistent full-screen shell
// with a header over an absolutely-positioned page stack. Adapted from the Motion
// Director's web/js/minimax_director_modal.js (j955229, GPL-3.0): the launcher, the
// overlay, the tab header and their style rules, renamed and restyled, with the undo bar
// and the keyboard capture added — see NOTICE. Closing hides; it never tears the pages down, so scroll
// position, a half-typed prompt and the canvas bitmap survive reopening.
//
// The staged tabs are the point: run / edit / takes / post / results is the order the work
// actually happens in, like the pages of an editing suite. Each page is handed an empty
// div and owns nothing else.
//
// Keyboard capture
// ----------------
// ComfyUI binds Ctrl+Z, Delete and Ctrl+A on the document. While this modal is open they
// have to mean something else, or a Backspace in a prompt box deletes the selected node
// and Ctrl+Z rolls back the canvas instead of the edit the user just made. The listener
// is installed on `window` in the CAPTURE phase, which runs before any document-level
// handler, and it stops propagation for the keys it claims. That is why Ctrl+Z can be
// scoped to the Director: not by asking ComfyUI to stand down, but by never letting the
// event reach it.

import { t, toggleLang, LANG_LABEL } from "./gd_i18n.js";
import { icon, tip } from "./gd_ui.js";

export const PAGES = ["run", "edit", "takes", "post", "results"];
export const LAUNCHER_HEIGHT = 34;

const STYLE_ID = "gachadirector-modal-styles";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.gd-launcher-host{width:100%;height:${LAUNCHER_HEIGHT}px;min-height:${LAUNCHER_HEIGHT}px;box-sizing:border-box;overflow:hidden}
.gd-launcher{display:flex;align-items:stretch;gap:6px;width:100%;height:${LAUNCHER_HEIGHT}px;padding:3px 0;box-sizing:border-box;font:12px/1 system-ui,sans-serif}
.gd-launcher button{min-width:0;border:1px solid #34506b;border-radius:5px;background:#1d2a3a;color:#cfe3f5;font:inherit;cursor:pointer}
.gd-launcher button:hover{border-color:#9fd0ff;background:#243447;color:#fff}
.gd-launcher-open{flex:1 1 auto;padding:0 10px;font-weight:600;text-align:left}
.gd-launcher-lang{flex:0 0 56px;text-align:center}
.gd-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:rgba(8,12,18,.78);backdrop-filter:blur(2px)}
.gd-overlay[hidden]{display:none!important}
.gd-shell{position:relative;width:96vw;height:94vh;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;min-width:0;min-height:0;background:#1a2330;border:1px solid #2f4a63;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.6);color:#e6edf3;font:13px/1.45 system-ui,sans-serif}
.gd-header{flex:0 0 46px;min-height:46px;display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid #2c3f55}
.gd-head-left{display:flex;align-items:center;gap:8px;min-width:0}
.gd-title{margin:0;flex:0 0 auto;font-size:13px;font-weight:650;color:#cfe3f5;white-space:nowrap}
.gd-nav{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0}
.gd-arrow,.gd-tab{height:30px;border:1px solid #34506b;border-radius:6px;background:#1d2a3a;color:#b9c7d6;cursor:pointer;font:inherit}
.gd-arrow{width:30px;font-size:16px;line-height:1}
.gd-tab{flex:0 1 auto;min-width:0;padding:0 16px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gd-tab:hover,.gd-arrow:hover{border-color:#9fd0ff;color:#fff}
.gd-tab.active{border-color:#4fd08f;background:#16311f;color:#7ee2a8}
.gd-head-right{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.gd-undo{display:flex;align-items:center;gap:4px}
.gd-undo button{height:28px;min-width:30px;padding:0 7px;border:1px solid #34506b;border-radius:5px;background:#1d2a3a;color:#cfe3f5;cursor:pointer;font:12px/1 system-ui,sans-serif}
.gd-undo button:hover:not(:disabled){border-color:#9fd0ff;color:#fff}
.gd-undo button:disabled{opacity:.35;cursor:default}
.gd-hist-wrap{position:relative}
.gd-hist-menu{position:absolute;top:32px;left:0;z-index:200;min-width:260px;max-height:320px;overflow:auto;background:#141c26;border:1px solid #34506b;border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:4px}
.gd-hist-menu[hidden]{display:none!important}
.gd-hist-item{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;font:11px/1.4 system-ui,sans-serif;color:#b9c7d6}
.gd-hist-item:hover{background:#22303f;color:#fff}
.gd-hist-item.current{background:#16311f;color:#7ee2a8}
.gd-hist-time{margin-left:auto;color:#6f8399;font:10px ui-monospace,Consolas,monospace}
.gd-shell-close{width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:#9fb3c8;font-size:17px;line-height:1;cursor:pointer}
.gd-shell-close:hover{border-color:#34506b;background:#243447;color:#fff}
.gd-stack{flex:1 1 auto;position:relative;min-width:0;min-height:0;overflow:hidden}
.gd-page{position:absolute;inset:0;overflow:auto;padding:10px 12px 16px;box-sizing:border-box;overscroll-behavior:contain}
.gd-page[hidden]{display:none!important}
.gd-sublayer{position:absolute;inset:46px 0 0;z-index:150;pointer-events:none;overflow:visible}
.gd-sublayer>*{pointer-events:auto}
`;
  document.head.appendChild(el);
}

export function createModal({ launcherHost, onOpen, onClose, onPageChange, onLangChange,
                              onLibrary, onEscape, history }) {
  ensureStyles();
  launcherHost.classList.add("gd-launcher-host");

  const launcher = document.createElement("div");
  launcher.className = "gd-launcher";
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "gd-launcher-open";
  const langBtn = document.createElement("button");
  langBtn.type = "button";
  langBtn.className = "gd-launcher-lang";
  launcher.append(openBtn, langBtn);
  launcherHost.replaceChildren(launcher);

  const overlay = document.createElement("div");
  overlay.className = "gd-overlay";
  overlay.hidden = true;
  const shell = document.createElement("div");
  shell.className = "gd-shell";

  // ---- header: title + undo bar | tabs | language + close
  const header = document.createElement("div");
  header.className = "gd-header";
  const headLeft = document.createElement("div");
  headLeft.className = "gd-head-left";
  const title = document.createElement("h2");
  title.className = "gd-title";
  const undoBar = document.createElement("div");
  undoBar.className = "gd-undo";
  const undoBtn = document.createElement("button");
  undoBtn.type = "button"; undoBtn.textContent = "↶";
  const redoBtn = document.createElement("button");
  redoBtn.type = "button"; redoBtn.textContent = "↷";
  const histWrap = document.createElement("div");
  histWrap.className = "gd-hist-wrap";
  const histBtn = document.createElement("button");
  histBtn.type = "button"; histBtn.textContent = t("modal.history");
  const histMenu = document.createElement("div");
  histMenu.className = "gd-hist-menu";
  histMenu.hidden = true;
  histWrap.append(histBtn, histMenu);
  undoBar.append(undoBtn, redoBtn, histWrap);
  headLeft.append(title, undoBar);

  const nav = document.createElement("div");
  nav.className = "gd-nav";
  const prev = document.createElement("button");
  prev.type = "button"; prev.className = "gd-arrow"; prev.textContent = "‹";
  const next = document.createElement("button");
  next.type = "button"; next.className = "gd-arrow"; next.textContent = "›";

  const headRight = document.createElement("div");
  headRight.className = "gd-head-right";
  const langBtn2 = document.createElement("button");
  langBtn2.type = "button"; langBtn2.className = "gd-tab"; langBtn2.style.minWidth = "62px";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.className = "gd-shell-close"; closeBtn.textContent = "✕";
  // the material library is the panel's, not a page's: its button sits with the pages
  const libBtn = document.createElement("button");
  libBtn.type = "button"; libBtn.className = "gd-tab gd-tab-lib";
  libBtn.onclick = () => onLibrary && onLibrary();
  libBtn.hidden = !onLibrary;
  headRight.append(libBtn, langBtn2, closeBtn);

  const stack = document.createElement("div");
  stack.className = "gd-stack";
  const sublayer = document.createElement("div");
  sublayer.className = "gd-sublayer";

  const tabs = {};
  const pages = {};
  for (const name of PAGES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "gd-tab";
    tab.dataset.page = name;
    tab.onclick = () => setPage(name);
    tabs[name] = tab;
    const page = document.createElement("div");
    page.className = "gd-page";
    page.hidden = true;
    pages[name] = page;
    stack.appendChild(page);
  }
  nav.append(prev, ...PAGES.map((n) => tabs[n]), next);
  header.append(headLeft, nav, headRight);
  shell.append(header, stack, sublayer);
  for (const type of ["dragover", "drop"]) {
    shell.addEventListener(type, (e) => {
      if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === "dragover") e.dataTransfer.dropEffect = "none";
    });
  }
  overlay.appendChild(shell);

  let current = "edit";
  let open = false;

  function paintChrome() {
    openBtn.textContent = t("app.open");
    langBtn.textContent = LANG_LABEL();
    langBtn2.textContent = LANG_LABEL();
    title.textContent = t("app.title");
    for (const name of PAGES) {
      tabs[name].textContent = t(`page.${name}`);
      tabs[name].classList.toggle("active", name === current);
    }
    tip(closeBtn, t("app.close"));
    libBtn.replaceChildren(icon("library", 15), document.createTextNode(t("gen.library")));
    tip(libBtn, t("lib.openHint"));
    paintUndo();
  }

  function paintUndo() {
    if (!history) { undoBar.hidden = true; return; }
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
    tip(undoBtn, "Ctrl+Z");
    tip(redoBtn, "Ctrl+Shift+Z / Ctrl+Y");
  }

  function paintHistoryMenu() {
    histMenu.replaceChildren();
    if (!history) return;
    for (const row of history.list()) {
      const item = document.createElement("div");
      item.className = "gd-hist-item" + (row.current ? " current" : "");
      const label = document.createElement("span");
      label.textContent = row.label;
      const when = document.createElement("span");
      when.className = "gd-hist-time";
      when.textContent = new Date(row.at).toLocaleTimeString();
      item.append(label, when);
      item.onclick = () => {
        history.jump(row.i);
        histMenu.hidden = true;
        paintUndo();
      };
      histMenu.appendChild(item);
    }
  }

  /** Nothing plays on in what is not shown: a clip left playing would go on being heard. */
  const stopPlaying = (root) => { for (const v of root.querySelectorAll("video, audio")) v.pause(); };

  function setPage(name) {
    if (!PAGES.includes(name)) return;
    current = name;
    for (const p of PAGES) {
      pages[p].hidden = p !== name;
      if (p !== name) stopPlaying(pages[p]);
    }
    paintChrome();
    onPageChange && onPageChange(name);
  }

  function show(page) {
    if (!overlay.isConnected) document.body.appendChild(overlay);
    overlay.hidden = false;
    open = true;
    window.addEventListener("keydown", onKey, true);
    setPage(page || current);
    onOpen && onOpen();
  }
  function hide() {
    stopPlaying(overlay);
    overlay.hidden = true;
    open = false;
    histMenu.hidden = true;
    window.removeEventListener("keydown", onKey, true);
    onClose && onClose();
  }

  const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  function isEditable(target) {
    let el = target;
    while (el && el !== overlay) {
      if (EDITABLE.has(String(el.tagName || "").toUpperCase())) return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  function onKey(e) {
    if (!open) return;
    const editable = isEditable(e.target);
    const mod = e.ctrlKey || e.metaKey;
    const key = String(e.key || "").toLowerCase();

    // a list of names open under a prompt box: Escape closes that (below), not the panel
    if (key === "escape" && !overlay.querySelector(".gd-at:not([hidden])")) {
      // something of the panel that is open over the pages closes first (the library)
      if (onEscape && onEscape()) { e.preventDefault(); e.stopPropagation(); return; }
      hide(); e.stopPropagation(); return;
    }

    // Undo/redo belong to the Director while it is open. Claimed in the capture phase so
    // ComfyUI's document-level handler never sees them. Inside a text field the browser's
    // own text undo is more useful, so leave it alone there.
    if (mod && !editable && (key === "z" || key === "y")) {
      if (history) {
        if (key === "y" || (key === "z" && e.shiftKey)) history.redo();
        else history.undo();
        paintUndo();
        paintHistoryMenu();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      return;
    }

    // Everything typed into a field stays in the field: ComfyUI would otherwise read
    // Backspace as "delete the selected node" and Ctrl+A as "select all nodes". Stopping the
    // key here, on its way down, keeps it from the field's own listeners as well, so the
    // field is handed it first: a listener for "gd-key" gets the key event as `detail` and
    // may call preventDefault on it.
    if (editable) {
      e.target.dispatchEvent(new CustomEvent("gd-key", { detail: e }));
      e.stopPropagation();
      return;
    }

    if (key === "delete" || key === "backspace" || (mod && key === "a")) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      return;
    }
    if (key === "tab") {
      setPage(PAGES[(PAGES.indexOf(current) + (e.shiftKey ? -1 : 1) + PAGES.length) % PAGES.length]);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  prev.onclick = () => setPage(PAGES[(PAGES.indexOf(current) - 1 + PAGES.length) % PAGES.length]);
  next.onclick = () => setPage(PAGES[(PAGES.indexOf(current) + 1) % PAGES.length]);
  closeBtn.onclick = hide;
  openBtn.onclick = () => show();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) hide(); });
  undoBtn.onclick = () => { history && history.undo(); paintUndo(); paintHistoryMenu(); };
  redoBtn.onclick = () => { history && history.redo(); paintUndo(); paintHistoryMenu(); };
  histBtn.onclick = () => {
    if (histMenu.hidden) { paintHistoryMenu(); histMenu.hidden = false; }
    else histMenu.hidden = true;
  };
  document.addEventListener("mousedown", (e) => {
    if (!histMenu.hidden && !histWrap.contains(e.target)) histMenu.hidden = true;
  });
  const doLang = () => { toggleLang(); paintChrome(); onLangChange && onLangChange(); };
  langBtn.onclick = doLang;
  langBtn2.onclick = doLang;

  paintChrome();

  return {
    pages, sublayer, show, hide, setPage,
    get page() { return current; },
    get isOpen() { return open; },
    repaintChrome: paintChrome,
    repaintUndo: paintUndo,
    destroy() {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      launcher.remove();
    },
  };
}
