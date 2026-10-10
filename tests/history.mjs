// The panel's undo stack: web/gd_history.js, which is pure.
//
//   node --experimental-default-type=module tests/history.mjs
//
// What is at stake: an undo followed by a new edit leaves the undone steps behind for good.
// A redo that brought one of them back would put an abandoned state over the new edit.

import { createHistory } from "../web/gd_history.js";

const failed = [];
const check = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

// a clock the test moves: entries are stamped with Date.now()
let now = 1000;
const realNow = Date.now;
Date.now = () => now;

{
  let state = { v: 0 };
  const h = createHistory({ read: () => state, write: (s) => { state = s; } });
  h.reset("open");
  const edit = (v, label, at) => { now = at; state = { v }; h.push(label); };

  edit(1, "edit", 2000);
  edit(2, "edit", 2300);
  check("two edits of one kind within the window are one step", [h.index, state.v], [1, 2]);
  edit(3, "pick", 2400);
  check("another kind of edit is a step of its own", h.index, 2);
  edit(4, "pick", 4000);
  check("and so is the same kind after the window", h.index, 3);

  // undo twice, then edit at once with the label of the entry that is now current
  now = 4100;
  h.undo();
  h.undo();
  check("undone to the first edit", [h.index, state.v, h.canRedo()], [1, 2, true]);
  now = 2500;                          // inside the window of that entry's own time
  state = { v: 9 };
  h.push("edit");
  check("an edit after an undo leaves nothing to redo", [state.v, h.canRedo()], [9, false]);
  h.undo();
  check("and undoing it goes back to where the undo had stopped", state.v, 2);
  h.redo();
  check("from where redo brings the new edit back, not an abandoned one", state.v, 9);
}

Date.now = realNow;
if (failed.length) {
  console.log(failed.join("\n"));
  console.log(`${failed.length} FAILED`);
  process.exit(1);
}
console.log("history: all passed");
