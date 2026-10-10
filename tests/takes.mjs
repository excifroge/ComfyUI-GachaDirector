// What the panel works out by itself from what it stores, where there is no Python twin
// (tests/parity.mjs covers what has one): the takes store (web/gd_takes_doc.js) and the
// media library's folder list (web/gd_library.js).
//
//   node --experimental-default-type=module tests/takes.mjs
//
// What is at stake: a clip joined from several takes has its cuts where those takes had
// theirs and may be many frames shorter than the document. A face refine that looked for
// its shots where the document has them would follow a face across a cut, or work on
// another shot than the one asked for.

import { mergeIndex } from "../web/gd_library.js";
import { normalizeTakes, refineCuts } from "../web/gd_takes_doc.js";

const failed = [];
const check = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

const shots = [{ start: 0, join: "cut" }, { start: 31, join: "cut" }, { start: 62, join: "continuous" },
               { start: 93, join: "cut" }];
const joined = normalizeTakes({ composite: { status: "done", file: "final.mp4", starts: "0,25,44,63" } }).composite;

check("a take: where the document has its shots", refineCuts(shots, joined, "take_7.mp4"), "31,62~,93");
check("the joined clip: where it says its shots start", refineCuts(shots, joined, "final.mp4"), "25,44~,63");
check("a joined clip that did not say (one made before it was recorded): the document's",
      refineCuts(shots, normalizeTakes({ composite: { status: "done", file: "final.mp4" } }).composite, "final.mp4"),
      "31,62~,93");
check("a record for another cutting of the clip (one shot more or less): the document's",
      refineCuts(shots.slice(0, 3), joined, "final.mp4"), "31,62~");
check("a join that is not done yet: the document's",
      refineCuts(shots, { ...joined, status: "running" }, "final.mp4"), "31,62~,93");
check("one shot: nothing to look for", refineCuts(shots.slice(0, 1), joined, "final.mp4"), "");

// ---- the library's folders, changed here while the stored list could not be read
{
  const stored = { folders: [{ id: "a", name: "Old", root: "input", parent: "" },
                             { id: "b", name: "Sub", root: "input", parent: "a" }],
                   items: { "x.png": "a", "y.png": "b" } };
  const made = { folders: [{ id: "n", name: "New", root: "input", parent: "" }], items: { "z.png": "n", "x.png": "n" } };
  const both = mergeIndex(stored, made);
  check("every stored folder is kept and the new one added", both.folders.map((f) => f.id), ["a", "b", "n"]);
  check("what was filed meanwhile is where it was put, the rest where it was",
        both.items, { "x.png": "n", "y.png": "b", "z.png": "n" });
  check("nothing stored yet: what was made here", mergeIndex(null, made).folders.map((f) => f.id), ["n"]);
  check("nothing made here: what is stored", mergeIndex(stored, null), mergeIndex(stored, { folders: [], items: {} }));
}

if (failed.length) {
  console.log(failed.join("\n"));
  console.log(`${failed.length} FAILED`);
  process.exit(1);
}
console.log("takes: all passed");
