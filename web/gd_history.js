// Gacha Director — undo / redo for the panel's own state.
//
// ComfyUI's undo covers the graph: node positions, links, and widget values as a whole
// workflow snapshot. Inside the Director that granularity is useless — one Ctrl+Z would
// throw away every edit made since the panel opened, or worse, undo something on the
// canvas while the user was looking at a prompt box. So the panel keeps its own stack of
// the three JSON widgets it owns, and the modal swallows Ctrl+Z while it is open.
//
// A snapshot is the whole state, not a diff. The state is a few kilobytes of JSON and the
// stack is capped, so storing it whole removes every question about replaying edits in
// order — and an undo can never half-apply.

import { t } from "./gd_i18n.js";

const LIMIT = 60;
/** Two pushes with the same label inside this window collapse into one entry, so dragging
 *  a boundary does not fill the stack with fifty near-identical states. */
const COALESCE_MS = 700;

/**
 * @param io.read   () => state object (must be JSON-serialisable)
 * @param io.write  (state) => void, applied without pushing a new entry
 */
export function createHistory(io) {
  const st = { entries: [], index: -1, applying: false };

  const snap = (label) => ({
    label: label || t("h.edit"),
    at: Date.now(),
    state: JSON.parse(JSON.stringify(io.read())),
  });

  function reset(label) {
    st.entries = [snap(label || t("h.open"))];
    st.index = 0;
  }

  function push(label) {
    if (st.applying) return;           // an undo/redo must not record itself
    const entry = snap(label);
    const cur = st.entries[st.index];
    if (cur && JSON.stringify(cur.state) === JSON.stringify(entry.state)) return;
    // same kind of edit, still in flight: replace rather than stack. Only at the end of
    // the stack: after an undo, the entries ahead are what the new edit leaves behind.
    if (cur && st.index === st.entries.length - 1 && cur.label === entry.label
        && entry.at - cur.at < COALESCE_MS) {
      st.entries[st.index] = entry;
      return;
    }
    st.entries = st.entries.slice(0, st.index + 1);
    st.entries.push(entry);
    if (st.entries.length > LIMIT) st.entries.shift();
    st.index = st.entries.length - 1;
  }

  function apply(i) {
    if (i < 0 || i >= st.entries.length) return false;
    st.applying = true;
    try {
      io.write(JSON.parse(JSON.stringify(st.entries[i].state)));
      st.index = i;
    } finally {
      st.applying = false;
    }
    return true;
  }

  return {
    reset,
    push,
    undo: () => apply(st.index - 1),
    redo: () => apply(st.index + 1),
    jump: (i) => apply(i),
    canUndo: () => st.index > 0,
    canRedo: () => st.index < st.entries.length - 1,
    get index() { return st.index; },
    /** Newest first, with the current position marked. */
    list() {
      return st.entries.map((e, i) => ({
        i, label: e.label, at: e.at, current: i === st.index,
      })).reverse();
    },
    get isApplying() { return st.applying; },
  };
}
