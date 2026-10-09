// Gacha Director — the handful of DOM helpers every page uses.
// No framework, no template strings holding markup: a page builds nodes and attaches
// handlers, so there is never a stringly-typed selector to go stale.
//
// Portions adapted from Thefrizzy1's ComfyUI-MiniMaxH3-Director (js/timeline/editor.js),
// Apache-2.0; modified. See NOTICE.

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- tooltips
// What a control is for is said when the pointer rests on it, as in any production tool:
// not in a line of text under every field. One listener serves the whole document, so a
// page that is drawn again loses nothing, and the text sits in an attribute where a test
// (or a person with the inspector open) can read it.
const TIP_ATTR = "data-gd-tip";
const TIP_DELAY_MS = 500;
let tipBox = null;
let tipTimer = 0;
let tipWatch = 0;
let tipTarget = null;

function tipHide() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = 0; }
  if (tipWatch) { clearInterval(tipWatch); tipWatch = 0; }
  tipTarget = null;
  if (tipBox) tipBox.hidden = true;
}

function tipShow(target) {
  if (!target.isConnected) return;
  if (!tipBox) {
    tipBox = el("div", "gd-tip");
    tipBox.setAttribute("role", "tooltip");
    document.body.appendChild(tipBox);
  }
  // One line is a sentence. With more, the first says what the control is and the rest are
  // its values or the ways to use it: each on a line of its own, hanging where it wraps.
  const lines = (target.getAttribute(TIP_ATTR) || "").split("\n").filter((x) => x.trim());
  tipBox.replaceChildren(...lines.map((line, i) => el("div", i ? "gd-tip-line" : null, line)));
  tipBox.hidden = false;
  // under the control, or above it when there is no room; never off the window
  const r = target.getBoundingClientRect();
  const b = tipBox.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - b.width - 8));
  const below = r.bottom + 6;
  const top = below + b.height + 8 <= window.innerHeight ? below : Math.max(8, r.top - b.height - 6);
  tipBox.style.left = `${Math.round(left)}px`;
  tipBox.style.top = `${Math.round(top)}px`;
  // a page drawn again, or another page shown, takes the control away without the pointer
  // ever leaving it: the tooltip goes with it
  tipWatch = setInterval(() => {
    if (!target.isConnected || !target.getClientRects().length) tipHide();
  }, 250);
}

if (typeof document !== "undefined" && !window.__gdTipsBound) {
  window.__gdTipsBound = true;
  document.addEventListener("mouseover", (e) => {
    const target = e.target instanceof Element ? e.target.closest(`[${TIP_ATTR}]`) : null;
    if (target === tipTarget) return;
    tipHide();
    if (!target) return;
    tipTarget = target;
    tipTimer = setTimeout(() => { tipTimer = 0; if (tipTarget === target) tipShow(target); }, TIP_DELAY_MS);
  });
  for (const type of ["mousedown", "keydown", "wheel"]) document.addEventListener(type, tipHide, true);
  window.addEventListener("blur", tipHide);
}

/** Say what `target` is for when the pointer rests on it. Returns the target. */
export function tip(target, text) {
  if (!target) return target;
  if (text) target.setAttribute(TIP_ATTR, text); else target.removeAttribute(TIP_ATTR);
  return target;
}

// ---------------------------------------------------------------- icons
// Line drawings on a 20 x 20 grid, made here from plain shapes: [tag, attributes].
const ICONS = {
  // two links of a chain, through one another / apart
  linked: [["rect", { x: 2, y: 7, width: 10, height: 6, rx: 3 }], ["rect", { x: 8, y: 7, width: 10, height: 6, rx: 3 }]],
  unlinked: [["rect", { x: 1.5, y: 7, width: 7, height: 6, rx: 3 }], ["rect", { x: 11.5, y: 7, width: 7, height: 6, rx: 3 }]],
  // a frame with a play mark; a loudspeaker with two waves
  picture: [["rect", { x: 3, y: 5, width: 14, height: 10, rx: 1.5 }],
            ["path", { d: "M8.6 7.9 L12.2 10 L8.6 12.1 Z", fill: "currentColor" }]],
  sound: [["path", { d: "M3 8.4 H5.8 L9.4 5.6 V14.4 L5.8 11.6 H3 Z" }],
          ["path", { d: "M12 7.6 Q13.8 10 12 12.4" }], ["path", { d: "M14.2 5.8 Q17.4 10 14.2 14.2" }]],
  // a folder; sheets on one another (everything); a tray (what is in no folder)
  folder: [["path", { d: "M2.5 6 V15 H17.5 V7.5 H10 L8.5 5 H2.5 Z" }]],
  stack: [["path", { d: "M10 3.5 L17 7 L10 10.5 L3 7 Z" }], ["path", { d: "M3 10.5 L10 14 L17 10.5" }],
          ["path", { d: "M3 14 L10 17.5 L17 14" }]],
  tray: [["path", { d: "M3 11 L5 4.5 H15 L17 11 V15.5 H3 Z" }], ["path", { d: "M3 11 H7.5 V13 H12.5 V11 H17" }]],
  // the library: a shelf of three
  library: [["rect", { x: 3, y: 4, width: 3.2, height: 12, rx: 0.8 }], ["rect", { x: 8.4, y: 4, width: 3.2, height: 12, rx: 0.8 }],
            ["path", { d: "M13.6 5.2 L16.4 4.4 L18.6 15 L15.8 15.8 Z" }]],
};

export function icon(name, size = 16) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `gd-icon gd-icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of ICONS[name] || []) {
    const shape = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
    svg.appendChild(shape);
  }
  return svg;
}

// ---------------------------------------------------------------- files from this computer
const FILE_KINDS = {
  image: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v"],
  audio: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus"],
};

/** What a file is, as material: "image", "video", "audio", or "" for anything else. */
export function fileKind(file) {
  const type = String((file && file.type) || "");
  for (const kind of Object.keys(FILE_KINDS)) if (type.startsWith(`${kind}/`)) return kind;
  const ext = String((file && file.name) || "").split(".").pop().toLowerCase();
  return Object.keys(FILE_KINDS).find((kind) => FILE_KINDS[kind].includes(ext)) || "";
}

/** Lets files be dropped on `target`: `onFiles(files)` gets the ones that are material.
 *  While files are held over it the target carries the class "gd-dropping". */
/** What a drag out of the material library carries: `[{name, kind}]` as JSON. */
export const LIBRARY_ITEMS = "application/x-gachadirector-material";

export function dropZone(target, onFiles, onItems = null) {
  const has = (e, type) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes(type);
  // files of this computer, or (where the target takes them) items of the material library
  const carries = (e) => has(e, "Files") || (!!onItems && has(e, LIBRARY_ITEMS));
  let depth = 0;
  const calm = () => { depth = 0; target.classList.remove("gd-dropping"); };
  target.addEventListener("dragenter", (e) => {
    if (!carries(e)) return;
    depth += 1;
    target.classList.add("gd-dropping");
  });
  target.addEventListener("dragleave", (e) => {
    if (!carries(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) calm();
  });
  target.addEventListener("dragover", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("drop", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    e.stopPropagation();
    calm();
    if (onItems && has(e, LIBRARY_ITEMS)) {
      let items = [];
      try { items = JSON.parse(e.dataTransfer.getData(LIBRARY_ITEMS) || "[]"); } catch (err) { items = []; }
      if (items.length) onItems(items);
      return;
    }
    const files = [...e.dataTransfer.files].filter((f) => fileKind(f));
    if (files.length) onFiles(files);
  });
  return target;
}

/** One of the two links between a shot and the one before it: the picture's or the sound's.
 *  With `onToggle` it is a button; without, a mark that only shows the state. */
export function linkMark(kind, on, text, onToggle, locked = false) {
  const b = el(onToggle ? "button" : "span", "gd-link" + (on ? " on" : "") + (locked ? " locked" : ""));
  b.dataset.link = kind;
  b.dataset.on = on ? "1" : "0";
  b.setAttribute("aria-label", text);
  b.append(icon(kind), icon(on ? "linked" : "unlinked"));
  if (onToggle) {
    b.type = "button";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    if (locked) b.setAttribute("aria-disabled", "true"); else b.onclick = onToggle;
  }
  return tip(b, text);
}

export function section(titleText, hint) {
  const s = el("section", "gd-sec");
  if (titleText != null) s.appendChild(tip(el("h3", null, titleText), hint));
  return s;
}

/** A label beside a control. What the control is for (`hint`) is a tooltip on the row. */
export function labeled(label, control, hint) {
  const row = el("label", "gd-row");
  row.appendChild(el("span", "gd-lbl", label));
  row.appendChild(control);
  return tip(row, hint);
}

export function input(type, value, oninput, attrs = {}) {
  const i = el("input");
  i.type = type;
  i.value = value ?? "";
  // `list` and friends are read-only as properties; always go through attributes.
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  i.addEventListener("change", () => oninput(i.value));
  return i;
}

export function number(value, oninput, attrs = {}) {
  return input("number", value, (v) => oninput(Number(v)), attrs);
}

export function checkbox(value, onchange, label) {
  const wrap = el("label", "gd-check");
  const i = el("input");
  i.type = "checkbox";
  i.checked = !!value;
  i.addEventListener("change", () => onchange(i.checked));
  wrap.appendChild(i);
  if (label) wrap.appendChild(el("span", null, label));
  return wrap;
}

export function textarea(value, oninput, rows = 4) {
  const t = el("textarea");
  t.value = value || "";
  t.rows = rows;
  t.addEventListener("change", () => oninput(t.value));
  return t;
}

export function select(options, value, onchange) {
  const s = el("select");
  for (const o of options) {
    const val = Array.isArray(o) ? o[0] : o;
    const text = Array.isArray(o) ? o[1] : o;
    const op = el("option", null, text);
    op.value = val;
    if (String(val) === String(value)) op.selected = true;
    s.appendChild(op);
  }
  s.addEventListener("change", () => onchange(s.value));
  return s;
}

export function btn(label, onclick, cls = "gd-btn") {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
}

export function row(...children) {
  const r = el("div", "gd-right");
  for (const c of children) if (c) r.appendChild(c);
  return r;
}

export function datalist(id, items) {
  let dl = document.getElementById(id);
  if (!dl) {
    dl = el("datalist");
    dl.id = id;
    document.body.appendChild(dl);
  }
  dl.replaceChildren();
  for (const it of items) {
    const o = el("option");
    o.value = it;
    dl.appendChild(o);
  }
  return id;
}

export function warnList(items) {
  const ul = el("ul", "gd-warn");
  for (const w of items) ul.appendChild(el("li", null, w));
  return ul;
}

/**
 * How much of a clip a "how much to change" setting really repaints, in percent. The
 * schedule shift bends the number: at shift s, a setting d starts the sampler at a noise
 * level of s*d / (1 + (s-1)*d). At the default shift of 12, 0.25 is already 80%.
 */
export function noisePercent(denoise, shift) {
  const s = Number(shift) || 1;
  const d = Math.max(0, Math.min(1, Number(denoise) || 0));
  return Math.round(((s * d) / (1 + (s - 1) * d)) * 100);
}

export function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s - m * 60).padStart(2, "0")}` : `${s}s`;
}
