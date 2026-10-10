// What the panel does while its node is being queued. Queueing a take puts that take's own
// settings into the node's widgets for as long as the graph takes to serialize, and takes
// them out again; an edit that lands in that moment has to be made on the clip, not on the
// take's settings, and has to be there afterwards.
//
//   node --experimental-websocket tests/shot.mjs tests/ui_queue_window.mjs --lang zh
//
// Needs ComfyUI running with this package (see tests/shot.mjs for the address). Nothing is
// rendered and nothing reaches the queue: the page's own call to /prompt is answered here.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WF = join(HERE, "..", "example_workflows", "GachaDirector_Base.json");

const failed = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  if (!ok) failed.push(name);
}

export default async function (page) {
  // The output settings as a workflow opened from a face-refined clip has them: marked as
  // a refine of that clip. And nothing is saved by itself, so a take's own "save" shows.
  await page.open(WF, null, { gd_post: JSON.stringify({
    save: { auto_save: false, filename_prefix: "GachaDirector" },
    face: { file: "refined_final.mp4", cuts: "61", shots: "2" } }) });
  await page.eval(() => {
    const node = () => window.app.graph._nodes.find((n) => n.type === "GachaDirector");
    const read = (name) => node().widgets.find((w) => w.name === name).value;
    window.T = {
      read,
      json: (name) => JSON.parse(read(name) || "{}"),
      sent: [],             // what was posted to /prompt
      open: 0,              // serializations waiting to be let go
      release: null,
    };
    // the graph is serialized as it is, then held until the test lets it go (first time only)
    const real = window.app.graphToPrompt.bind(window.app);
    let held = false;
    window.app.graphToPrompt = async (...a) => {
      const p = await real(...a);
      if (!held) {
        held = true;
        window.T.open += 1;
        await new Promise((r) => { window.T.release = r; });
        window.T.open -= 1;
      }
      return p;
    };
    // a queue call that reaches no server
    const fetch0 = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (String(url).replace(/\?.*$/, "").endsWith("/prompt") && opts && opts.method === "POST") {
        window.T.sent.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({ prompt_id: `stub-${window.T.sent.length}`, number: 1, node_errors: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return fetch0(url, opts);
    };
  });

  const before = await page.eval(() => ({
    prefix: T.json("gd_post").save.filename_prefix,
    autoSave: T.json("gd_post").save.auto_save,
    seed: T.read("seed"),
    global: T.json("gd_timeline").prompt.global,
  }));

  // ---- generate two takes; the first serialization stays open
  await page.tab(2);
  await page.eval(() => {
    const count = document.querySelector(".gd-takecount input");
    const go = [...count.closest(".gd-takecount").parentElement.querySelectorAll("button")]
      .find((b) => /候选/.test(b.innerText));
    go.click();
  });
  await page.wait(600);
  const during = await page.eval(() => ({
    open: T.open,
    widgetPrefix: T.json("gd_post").save.filename_prefix,
  }));
  check("while the graph is serialized, the widget holds the take's own file name",
    [during.open, /_take_/.test(during.widgetPrefix)], [1, true]);

  // ---- an output setting and the prompt are edited in that moment
  await page.tab(3);
  const edited = await page.eval(async (prefix) => {
    const box = [...document.querySelectorAll("input")].find((i) => i.value === prefix);
    if (!box) return { shown: [...document.querySelectorAll("input")].map((i) => i.value).slice(0, 12) };
    box.value = "EDITED";
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  }, before.prefix);
  check("the panel shows the clip's own file name there, not the take's", edited, { ok: true });
  await page.tab(1);
  await page.wait(500);
  await page.eval(async () => {
    const box = document.querySelector('textarea[data-mbox="global"]');
    box.focus();
    box.value = "EDITED WHILE QUEUEING";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.blur();
    await new Promise((r) => setTimeout(r, 300));
  });

  // ---- let the serialization go; both takes get queued
  await page.eval(() => T.release());
  await page.wait(1500);
  const after = await page.eval(() => {
    const id = String(window.app.graph._nodes.find((n) => n.type === "GachaDirector").id);
    return {
      sent: T.sent.length,
      prefixes: T.sent.map((s) => JSON.parse(s.prompt[id].inputs.gd_post).save.filename_prefix.replace(/_[a-z0-9]{5}$/, "_BATCH")),
      refines: T.sent.map((s) => { const f = JSON.parse(s.prompt[id].inputs.gd_post).face; return [f.file, f.cuts, f.shots]; }),
      saves: T.sent.map((s) => JSON.parse(s.prompt[id].inputs.gd_post).save.auto_save),
      face: T.json("gd_post").face,
      seeds: T.sent.map((s) => s.prompt[id].inputs.seed),
      post: T.json("gd_post").save,
      global: T.json("gd_timeline").prompt.global,
      splice: T.json("gd_timeline").source.splice,
      seed: T.read("seed"),
      takes: T.json("gd_takes").takes.length,
    };
  });
  // (a batch runs on the settings it was started with: the second take too)
  check("two takes were queued, each under its own file name and seed",
    [after.sent, after.prefixes, after.seeds],
    [2, [`${before.prefix}_take_${before.seed}_BATCH`, `${before.prefix}_take_${before.seed + 1}_BATCH`],
     [before.seed, before.seed + 1]]);
  check("a take is saved whatever the clip's setting, and is never a face refine",
    [after.saves, after.refines], [[true, true], [["", "", "2"], ["", "", "2"]]]);
  check("the output setting edited meanwhile is the clip's, and nothing of the take's is left in it",
    [after.post.filename_prefix, after.post.auto_save, before.autoSave], ["EDITED", false, false]);
  check("what the workflow came with is still in the clip's own settings",
    [after.face.file, after.face.cuts, after.splice], ["refined_final.mp4", "61", []]);
  check("the prompt edited meanwhile is there", after.global, "EDITED WHILE QUEUEING");
  check("the seed moved past the batch and both takes are listed", [after.seed, after.takes], [before.seed + 2, 2]);

  if (failed.length) { console.log(`${failed.length} FAILED`); process.exitCode = 1; } else console.log("all checks passed");
}
