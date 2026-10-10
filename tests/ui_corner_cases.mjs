// A few places of the panel where an ordinary clip is a corner case: a shot of a few frames
// on the timeline, a size typed in that comes out near one of the sizes on offer, a take
// removed while another shot shows it, and the Output page after a batch of takes, or
// beside a second director node.
//
//   node --experimental-websocket tests/shot.mjs tests/ui_corner_cases.mjs --lang zh
//
// Needs ComfyUI running with this package (see tests/shot.mjs for the address). Nothing is
// rendered: the page's calls to /history are answered here.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WF = join(HERE, "..", "example_workflows", "GachaDirector_Reference.json");

const failed = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  if (!ok) failed.push(name);
}

const DOC = {
  schema_version: 8, uid: "corner", family: "reference", clip: { length: 243, aspect: "16:9" },
  prompt: { mode: "structured", shots: [{ id: "a", length: 100, text: "One." }, { id: "b", length: 5, text: "Two." },
                                        { id: "c", length: 138, text: "Three." }] },
};
const lengths = (page) => page.eval(() => JSON.parse(window.app.graph._nodes.find((n) => n.type === "GachaDirector")
  .widgets.find((w) => w.name === "gd_timeline").value).prompt.shots.map((s) => s.length));

// The Output page, with /history answered by `make(nodeId, uid)`: the newest forty runs,
// and any run asked for by its id.
async function outputPage(page, make) {
  return page.eval(async (makeSrc) => {
    const node = window.app.graph._nodes.find((n) => n.type === "GachaDirector");
    const uid = JSON.parse(node.widgets.find((w) => w.name === "gd_timeline").value).uid;
    const { newest, byId } = (0, eval)(`(${makeSrc})`)(String(node.id), uid);
    const asked = [];
    const fetch0 = window.fetch.bind(window);
    const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    window.fetch = async (url, opts) => {
      const path = String(url).replace(/^[a-z]+:\/\/[^/]+/, "");
      if (/\/history\?/.test(path)) { asked.push("newest"); return answer(newest); }
      const one = path.match(/\/history\/([^/?]+)/);
      if (one) { asked.push(one[1]); return answer(byId[one[1]] ? { [one[1]]: byId[one[1]] } : {}); }
      return fetch0(url, opts);
    };
    try {
      const tab = [...document.querySelectorAll(".gd-tab")].filter((b) => b.offsetParent !== null)[4];
      tab.click();
      await new Promise((q) => setTimeout(q, 900));
      const shell = tab.closest("body > div") || document.body;
      return { cards: shell.querySelectorAll(".gd-result").length,
               videos: shell.querySelectorAll(".gd-result-video").length, asked };
    } finally { window.fetch = fetch0; }
  }, make.toString());
}

// A run of the node as the history has it. `prefix` tells its kind.
const RUNS = `
  const run = (nodeId, uid, prefix, outputsOf) => ({
    prompt: [0, "p", { [nodeId]: { class_type: "GachaDirector", inputs: {
      gd_timeline: JSON.stringify({ schema_version: 8, uid, family: "reference", clip: { length: 243, aspect: "16:9" },
        prompt: { mode: "raw", raw: "x", shots: [] } }),
      gd_post: JSON.stringify({ save: { filename_prefix: prefix } }), gd_presets: "{}", seed: 1 } } }, {}, [outputsOf]],
    outputs: { [outputsOf + ".0.0.9"]: { gifs: [{ filename: prefix + "_1.mp4", type: "output", subfolder: "" }] },
               [outputsOf]: { gd_report: ["report"] } },
    status: { status_str: "success", completed: true, messages: [] },
  });
  // one that failed: no outputs, the nodes it was asked to run, and the node it stopped in
  // (with a loader "4" in front of the director node and a save node "20" behind it)
  const failed = (nodeId, uid, askedOf, stoppedIn, how = "execution_error") => {
    const e = { ...run(nodeId, uid, "Mine", askedOf), outputs: {},
                status: { status_str: "error", completed: false, messages: [[how, { node_id: stoppedIn }]] } };
    e.prompt[2]["4"] = { class_type: "LoadImage", inputs: { image: "x.png" } };
    e.prompt[2][nodeId].inputs.first_frame = ["4", 0];
    e.prompt[2]["20"] = { class_type: "SaveVideo", inputs: { video: [nodeId, 0] } };
    return e;
  };`;

export default async function (page) {
  // ---- a shot of five frames on the timeline
  await page.open(WF, DOC);
  // a narrow window: the shot is as wide as one handle. (Made narrow once the panel is
  // open: a front end may not draw the button of a node that is out of sight.)
  await page.viewport(760, 900);
  await page.tab(1);
  await page.wait(1000);
  const drawn = await page.eval(async () => {
    const canvas = [...document.querySelectorAll("canvas.gd-tl-canvas")].find((c) => c.offsetParent !== null);
    if (!canvas) return "no timeline canvas";
    const r = canvas.getBoundingClientRect();
    const x = (frame) => r.left + (frame / 243) * r.width;
    const y = r.top + r.height * 0.6;
    const fire = (type, cx) => (type === "mousedown" ? canvas : window).dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 }));
    fire("mousedown", x(105) - 2);      // just inside the short shot, by its right edge
    for (let k = 1; k <= 8; k++) { fire("mousemove", x(105) + 1 + k * (x(125) - x(105)) / 8); await new Promise((q) => setTimeout(q, 30)); }
    fire("mouseup", x(125));
    await new Promise((q) => setTimeout(q, 700));
    return Math.round(x(105) - x(100));
  });
  console.log("      the five-frame shot is this many px wide:", JSON.stringify(drawn));
  const after = await lengths(page);
  check("dragging the right edge of a five-frame shot makes that shot longer",
    [after[0], after[1] > 5, after[1] + after[2]], [100, true, 143]);

  // ---- a size of the user's own, near one of the sizes on offer
  await page.viewport(1680, 1000);
  await page.reload();
  await page.open(WF, DOC, { gd_presets: JSON.stringify({ version: 2, active: "standard", presets: [
    { id: "standard", name: "Standard", takes: 2, params: { megapixels: 0.396, steps: 20, model: "main" } }] }) });
  await page.tab(0);
  await page.wait(600);
  const size = await page.eval(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => /×/.test(o.textContent)));
    return sel ? [sel.options[sel.selectedIndex].textContent.replace(/\s+/g, " "), sel.value] : "no size list";
  });
  console.log("      the size list shows:", JSON.stringify(size));
  check("864 x 480 (0.396 MP) is shown as a size of its own, not as the first size of the list",
    [/自定义/.test(size[0]), size[1]], [true, "0.396"]);

  // ---- a take removed in one shot's row, while the other shot was showing it too
  await page.reload();
  const two = { ...DOC, prompt: { mode: "structured", shots: [{ id: "a", length: 122, text: "One." }, { id: "b", length: 121, text: "Two." }] } };
  const take = (id, seed) => ({ id, seed, prompt_id: `p${id}`, status: "done", file: `corner_${id}.mp4`, at: 1,
                                preset: "Draft", frames: 243, layout: "0,122" });
  await page.open(WF, two, { gd_takes: JSON.stringify({ takes: [take("A", 1), take("B", 2)], picks: { 0: "B", 1: "B" } }) });
  await page.tab(2);
  await page.wait(800);
  const shown = await page.eval(async () => {
    const rows = () => [...document.querySelectorAll(".gd-takeseg-body")].filter((r) => r.offsetParent !== null);
    // the line under each shot's player names the take it shows, by its seed
    const seeds = () => rows().map((r) => ((r.querySelector(".gd-takeview-line .gd-hint") || {}).textContent || "").replace(/^.*seed (\d+).*$/, "$1"));
    const pause = () => new Promise((q) => setTimeout(q, 400));
    for (const i of [0, 1]) { rows()[i].querySelectorAll(".gd-cand")[0].click(); await pause(); }
    const before = seeds();
    [...rows()[0].querySelectorAll(".gd-takeview-line button")].pop().click();     // "delete take", in the first shot
    await pause();
    return { before, after: seeds() };
  });
  check("a take removed while two shots showed it: both go back to the take that is picked", shown, { before: ["1", "1"], after: ["2", "2"] });

  // ---- and a take that failed can still be looked at, which is how it is removed
  await page.reload();
  await page.open(WF, two, { gd_takes: JSON.stringify({ takes: [take("B", 2), { ...take("Q", 3), status: "failed", file: "" }], picks: { 0: "B", 1: "B" } }) });
  await page.tab(2);
  await page.wait(800);
  const failedTake = await page.eval(async () => {
    const rows = () => [...document.querySelectorAll(".gd-takeseg-body")].filter((r) => r.offsetParent !== null);
    const seed = () => ((rows()[0].querySelector(".gd-takeview-line .gd-hint") || {}).textContent || "").replace(/^.*seed (\d+).*$/, "$1");
    const cards = () => rows()[0].querySelectorAll(".gd-cand").length;
    const pause = () => new Promise((q) => setTimeout(q, 400));
    rows()[0].querySelectorAll(".gd-cand")[1].click(); await pause();
    const looked = seed();
    [...rows()[0].querySelectorAll(".gd-takeview-line button")].pop().click(); await pause();
    return { looked, then: seed(), cards: cards() };
  });
  check("a failed take that is clicked is the one shown, and removing it removes that one", failedTake, { looked: "3", then: "2", cards: 1 });

  // ---- the Output page after forty takes: the clip joined before them is still found
  await page.reload();
  await page.open(WF, DOC, { gd_takes: JSON.stringify({ takes: [], picks: {},
    composite: { prompt_id: "joined", file: "GD_composite_1.mp4", status: "done", at: 1, seed: 1, key: "k", frames: 243 } }) });
  const many = await outputPage(page, new Function("nodeId", "uid", `${RUNS}
    const newest = {};
    for (let i = 0; i < 40; i++) newest["take" + i] = run(nodeId, uid, "GD_take_" + i, nodeId);
    return { newest, byId: { joined: run(nodeId, uid, "GD_composite_7", nodeId) } };`));
  check("the joined clip is listed though forty takes came after it", [many.cards, many.videos, many.asked], [1, 1, ["newest", "joined"]]);

  // ---- the Output page beside a second director node: its run is not listed here
  await page.reload();
  await page.open(WF, DOC, { gd_takes: "{}" });
  const other = await outputPage(page, new Function("nodeId", "uid", `${RUNS}
    return { newest: { theirs: run(nodeId, uid, "GD_composite_7", "999"), ours: run(nodeId, uid, "Mine", nodeId) }, byId: {} };`));
  check("a run that another director node made is not listed; this node's own run is", [other.cards, other.videos], [1, 1]);

  // ---- and a run that failed is listed by the node it was asked of, or stopped in
  await page.reload();
  await page.open(WF, DOC, { gd_takes: "{}" });
  const bad = await outputPage(page, new Function("nodeId", "uid", `${RUNS}
    return { newest: {
      theirs: failed(nodeId, uid, "999", "999.0.0.4"),                      // another node's, start to finish
      ours: failed(nodeId, uid, nodeId, "3"),                               // asked of this node
      inOurs: failed(nodeId, uid, "999", nodeId + ".0.0.4"),                // stopped inside this node
      behind: failed(nodeId, uid, "20", "4"),                               // only the save node behind it was asked for
      byHand: failed(nodeId, uid, "999", nodeId, "execution_interrupted"),  // stopped by hand, in this node
    }, byId: {} };`));
  check("of five runs that did not finish, only the one that was another node's from start to finish is not listed",
    [bad.cards, bad.videos], [4, 0]);

  if (failed.length) { console.log(`${failed.length} FAILED`); process.exitCode = 1; } else console.log("all passed");
}
