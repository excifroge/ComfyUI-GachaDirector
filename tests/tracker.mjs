// Whose run is it? The run tracker of web/gd_editor.js, driven with made-up events.
//
//   node --experimental-default-type=module tests/tracker.mjs
//
// ComfyUI sends a prompt's start and end events to the client that queued it, and the
// preview event to everyone. The tracker follows a run from its start to its end: a run
// the takes page queued is this clip's; a run this browser queued some other way has to be
// asked about, because another workflow can hold a node with the same id. A run that was
// already going when the editor was made (page reloaded, workflow tab switched back) has no
// start event: a progress event names it, and it is followed when the queue says this page
// queued it. What is at stake is the live preview on the takes page and the timing a preset
// records.
//
// The tracker lives inside the editor's closure, so this file cuts the two sections out of
// the source by their header comments ("run tracker" to "server data") and runs them
// against stand-ins for the names they use from outside. If a section is renamed or starts
// using another outside name, this test says which.
//
// The stand-in for the server answers /queue either after a delay or, with `manual`, only
// when the test says so and with the queue as the test gives it: what can go wrong here
// goes wrong between a question and its answer. Not covered: the five-second timeout of a
// question (the stand-in ignores the abort signal), and anything in web/gd_director.js
// (the execution id of a node in a subgraph, the guard on a dropped node's listeners).

import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../web/gd_editor.js", import.meta.url), "utf8");
const from = src.indexOf("// ------------------------------------------------------------------ run tracker");
const to = src.indexOf("// ------------------------------------------------------------------ server data");
if (from < 0 || to < from) {
  console.error("tracker: the 'run tracker' .. 'server data' sections were not found in web/gd_editor.js");
  process.exit(2);
}
const block = src.slice(from, to);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);
const NODE = "10";
const graph = (uid, node = NODE) => ({ [String(node)]: { inputs: { gd_timeline: JSON.stringify(uid ? { uid } : {}) } } });
const item = (pid, uid, node = NODE) => [0, pid, graph(uid, node)];
/** A queue entry as ComfyUI keeps it, with the client that queued it. */
const queued = (pid, uid, client = "me") => [0, pid, graph(uid), { client_id: client }];

/** One panel: clip uid "mine", execution id `node`. */
function panel({ delay = 0, uid = "mine", fail = false, manual = false, node = NODE, client = "me" } = {}) {
  const who = { client };
  const seen = { live: [], timed: 0, seconds: [], refreshed: 0, results: 0 };
  const state = {
    running: new Map(), queuedRun: new Map(), started: new Map(), current: "",
    mine: new Set(), span: new Map(), verdict: new Map(), held: null, late: "", live: null,
    pages: { takes: { live: (x) => seen.live.push(x ? x.step : null) },
             results: { load: () => { seen.results += 1; } } },
  };
  const server = { running: [], history: {}, waiting: [], status: 200, attached: true, composite: "", refine: "" };
  /** Answer the questions that are out, oldest first, with what the queue holds now. */
  server.answer = async () => {
    while (server.waiting.length) server.waiting.shift()(null);
    await tick();
  };
  /** Answer one question (0 = the oldest still out) with a queue of the test's choosing. */
  server.answerOne = async (index, running) => {
    if (index < 0 || index >= server.waiting.length) {
      throw new Error(`tracker test: no question ${index} is out (${server.waiting.length} are)`);
    }
    server.waiting.splice(index, 1)[0](running);
    await tick();
  };
  const outside = {
    state,
    host: {
      nodeId: () => node,
      apiUrl: (p) => p,
      fetchHistory: async (pid) => server.history[pid] || null,
      attached: () => server.attached,
      clientId: () => who.client,
    },
    doc: () => ({ uid, derived: { frame_count: 124 } }),
    presets: () => ({ active: "p", presets: [{ id: "p", params: {} }] }),
    activePreset: (s) => s.presets[0],
    paramSummary: () => "summary",
    paramsSignature: () => "signature",
    takes: () => ({ takes: [], composite: { prompt_id: server.composite }, refine: { prompt_id: server.refine } }),
    commitTakes: () => {},
    updateTake: (x) => x,
    takesApi: { refreshTakes: () => { seen.refreshed += 1; } },
    commitPresets: () => { seen.timed += 1; },
    recordRun: (s, id, seconds) => { seen.seconds.push(Math.round(seconds)); return s; },
    t: (k) => k,
    fetch: async () => {
      let given = null;
      if (manual) given = await new Promise((r) => server.waiting.push(r));
      else await sleep(delay);
      if (fail) throw new Error("no queue");
      if (server.status !== 200) {
        return { ok: false, status: server.status, json: async () => ({ error: "queue unavailable" }) };
      }
      const now = (given || server.running).slice();   // what the queue holds when it answers
      return { ok: true, status: 200, json: async () => ({ queue_running: now }) };
    },
  };
  let fns;
  try {
    fns = new Function(...Object.keys(outside),
      `${block}\nreturn { onStart, onSuccess, onError, onExecuting, onPreview, onProgress, onReconnected };`)(...Object.values(outside));
  } catch (err) {
    console.error("tracker: the section no longer runs on its own:", err.message);
    process.exit(2);
  }
  const preview = (step, from = `${node}.0.0.5`) => fns.onPreview({ node_id: from, webp: `w${step}`, step, total_steps: 8 });
  const start = (pid) => fns.onStart({ prompt_id: pid });
  const progress = (pid) => fns.onProgress({ prompt_id: pid, value: 1, max: 8, node });
  /** The server is on one of this node's nodes; `ago` ms are added to that stretch, so the
   *  run counts as a render and not a cached result. */
  const onMine = (ago = 5000) => {
    fns.onExecuting(`${node}.0.0.7`);
    const span = state.span.get(state.current);
    if (span && span.since) span.since -= ago;
  };
  const queuedHere = (pid) => state.queuedRun.set(pid, { presetId: "p", summary: "summary", signature: "signature", frames: 124 });
  return { ...fns, state, server, seen, who, preview, start, progress, onMine, queuedHere };
}

const failed = [];
const check = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

// ---------------------------------------------------------------- runs queued here
{
  const p = panel({ manual: true });
  p.queuedHere("a");
  p.start("a"); p.onMine(); p.preview(1); p.preview(2);
  check("own take: previews shown at once, nothing asked", [p.seen.live, p.server.waiting.length], [[null, 1, 2], 0]);
  p.onSuccess({ prompt_id: "a" });
  await tick();
  check("own take: timed", p.seen.seconds, [5]);
  check("own take: preview cleared at the end", p.state.live, null);
  check("own take: takes and results refreshed", [p.seen.refreshed, p.seen.results], [1, 1]);
}

// a composite is queued here too: shown, and not timed (it is another job than a take)
{
  const p = panel({ manual: true });
  p.state.queuedRun.set("c", { composite: true });
  p.start("c"); p.onMine(120000); p.preview(1);
  p.onSuccess({ prompt_id: "c" });
  await tick();
  check("composite: shown, nothing asked, not timed",
        [p.seen.live.filter((x) => x != null), p.server.waiting.length, p.seen.timed], [[1], 0, 0]);
}

// a composite queued before the page was reloaded starts as an announced run: not timed either
{
  const p = panel({ delay: 5 });
  p.server.composite = "c2";
  p.server.running = [item("c2", "mine")];
  p.start("c2"); p.onMine(120000); p.preview(1); await sleep(30);
  p.onSuccess({ prompt_id: "c2" }); await sleep(30);
  check("composite from before a reload: shown, not timed", [p.seen.live.filter((x) => x != null), p.seen.timed], [[1], 0]);
}

// ---------------------------------------------------------------- announced runs
// ComfyUI's own button on this clip: shown once the queue has answered, timed
{
  const p = panel({ manual: true });
  p.start("b"); p.onMine(); p.preview(1); p.preview(2);
  await tick();
  check("own run: nothing shown before the answer", p.seen.live, [null]);
  await p.server.answerOne(0, [item("b", "mine")]);
  check("own run: the newest preview shown after the answer", p.seen.live, [null, 2]);
  p.preview(3); await tick();
  check("own run: later previews shown", p.seen.live, [null, 2, 3]);
  p.onSuccess({ prompt_id: "b" });
  await tick();
  check("own run: timed once", [p.seen.timed, p.seen.seconds], [1, [5]]);
}

// another clip's run on the same node id, started from this browser: never shown, never timed
{
  const p = panel({ manual: true });
  p.start("c"); p.onMine(); p.preview(1);
  await p.server.answerOne(0, [item("c", "other")]);
  check("foreign run: not counted as a render in progress (the page's 'rendering' box)", p.state.running.size, 0);
  p.preview(2); await tick();
  p.onSuccess({ prompt_id: "c" });
  await tick();
  check("foreign run: no preview at any point", p.seen.live.filter((x) => x != null), []);
  check("foreign run: not timed", p.seen.timed, 0);
}

// ... even when it is over and out of the queue before the answer is back: history says whose
{
  const p = panel({ manual: true });
  p.start("c2"); p.onMine(); p.preview(1);
  p.server.history.c2 = { prompt: [0, "c2", graph("other")] };
  p.onSuccess({ prompt_id: "c2" });
  await p.server.answerOne(0, []);                    // the queue as it is by then: empty
  check("foreign run that ended before the answer: not timed", p.seen.timed, 0);
  check("foreign run that ended before the answer: no preview", p.seen.live.filter((x) => x != null), []);
}

// ... and when nothing can say whose it was, it is not timed either
{
  const p = panel({ manual: true });
  p.start("c3"); p.onMine();
  p.onSuccess({ prompt_id: "c3" });
  await p.server.answerOne(0, []);                    // gone from the queue, and no history
  check("ownership unknown: not timed", p.seen.timed, 0);
}

// this clip's own short run, already out of the queue when the answer comes: history says mine
{
  const p = panel({ manual: true });
  p.start("c4"); p.onMine();
  p.server.history.c4 = { prompt: [0, "c4", graph("mine")] };
  p.onSuccess({ prompt_id: "c4" });
  await p.server.answerOne(0, []);
  check("own run that ended before the answer: timed", p.seen.timed, 1);
}

// the takes and the results page are refreshed at once, whatever the question is doing
{
  const p = panel({ manual: true });
  p.start("c5"); p.onMine();
  p.onSuccess({ prompt_id: "c5" });
  await tick();
  check("success with the question still out: takes and results refreshed", [p.seen.refreshed, p.seen.results], [1, 1]);
  check("success with the question still out: not timed yet", p.seen.timed, 0);
}

// a run with no uid in its document (queued before the panel was ever opened): the node id decides
{
  const p = panel({ delay: 10 });
  p.server.running = [item("d", "")];
  p.start("d"); p.onMine(); p.preview(1);
  await sleep(30);
  check("no uid: shown", p.seen.live, [null, 1]);
  p.onSuccess({ prompt_id: "d" });
  await sleep(30);
  check("no uid: timed", p.seen.timed, 1);
}

// a prompt in which this node id does not exist is not this panel's
{
  const p = panel({ delay: 10 });
  p.server.running = [item("h", "mine", "99")];
  p.start("h"); p.preview(1); await sleep(30);
  check("other node id: hidden", p.seen.live.filter((x) => x != null), []);
}

// the queue cannot be read: the node id decides (the fallback is to show)
{
  const p = panel({ delay: 5, fail: true });
  p.start("i"); p.onMine(); p.preview(1); await sleep(30);
  check("queue unreadable: shown", p.seen.live, [null, 1]);
  p.onSuccess({ prompt_id: "i" }); await sleep(30);
  check("queue unreadable: timed", p.seen.timed, 1);
}

// an HTTP error with a JSON body is "the queue cannot be read", not "the queue is empty"
{
  const p = panel({ delay: 5 });
  p.server.status = 503;
  p.start("i2"); p.onMine(); p.preview(1); await sleep(30);
  check("HTTP error: the node id decides, shown", p.seen.live, [null, 1]);
  p.onSuccess({ prompt_id: "i2" }); await sleep(30);
  check("HTTP error: timed", p.seen.timed, 1);
}

// ---------------------------------------------------------------- runs nobody announced
// queued from another browser or through the API: only previews arrive, and they are not
// shown, whoever's they are
{
  const p = panel({ manual: true });
  p.server.running = [item("e", "mine")];
  p.preview(1); p.preview(2); await tick();
  check("no run followed: previews not shown", p.seen.live, []);
  check("no run followed: the queue is not asked", p.server.waiting.length, 0);
  p.onSuccess({ prompt_id: "e" }); await tick();      // its end may still arrive (same client, page reloaded)
  check("end of a run whose start was missed: takes refreshed, not timed", [p.seen.refreshed, p.seen.timed], [1, 0]);
}

// ---------------------------------------------------------------- picked up late
// the page was reloaded, or the workflow tab left and come back to, while a run this page
// queued was going: a progress event names it, the queue says who queued it
{
  const p = panel({ manual: true });
  p.preview(1);                                        // nothing is known yet: not shown
  p.progress("L1"); p.progress("L1");
  check("late: asked once per prompt", p.server.waiting.length, 1);
  p.preview(2);                                        // the answer is not in: not shown, not kept
  await p.server.answerOne(0, [queued("L1", "mine")]);
  p.preview(3); p.onMine();
  check("late, this page's and this clip's: shown from the answer on", p.seen.live.filter((x) => x != null), [3]);
  p.onSuccess({ prompt_id: "L1" }); await tick();
  check("late: preview cleared at its end, not timed", [p.state.live, p.seen.timed, p.state.current], [null, 0, ""]);
}

// queued by nobody (the API) or by another browser: its end would never come here
for (const who of [null, "", "other"]) {
  const p = panel({ manual: true });
  p.progress("L2");
  await p.server.answerOne(0, [who === null ? item("L2", "mine") : queued("L2", "mine", who)]);
  p.preview(1); p.progress("L2");
  check(`late, queued by ${JSON.stringify(who)}: not followed, not asked again`,
        [p.seen.live, p.state.current, p.server.waiting.length], [[], "", 0]);
}

// another clip's run from this page (another workflow tab with a node of the same id)
{
  const p = panel({ manual: true });
  p.progress("L3");
  await p.server.answerOne(0, [queued("L3", "theirs")]);
  p.preview(1);
  check("late, another clip's: not followed", [p.seen.live, p.state.current], [[], ""]);
}

// the run ends before the answer is in
{
  const p = panel({ manual: true });
  p.progress("L4");
  p.onSuccess({ prompt_id: "L4" });                    // its end event: this page queued it
  await p.server.answerOne(0, [queued("L4", "mine")]); // an answer that still lists it
  p.preview(1);                                        // of whatever runs next
  check("late, over before the answer: not followed",
        [p.seen.live.filter((x) => x != null), p.state.current, p.state.late], [[], "", ""]);
}

// a start event arrives while the answer is out: the run that started is the one followed
{
  const p = panel({ manual: true });
  p.progress("L5");
  p.queuedHere("L6"); p.start("L6"); p.preview(1);
  await p.server.answerOne(0, [queued("L5", "mine")]);
  check("late answer after another start: the started run stays",
        [p.state.current, p.seen.live.filter((x) => x != null)], ["L6", [1]]);
  const q = panel({ manual: true });
  q.progress("L5");
  q.queuedHere("L6"); q.start("L6"); q.onSuccess({ prompt_id: "L6" });
  await q.server.answerOne(0, [queued("L5", "mine")]);   // an answer from before L6 even started
  check("late answer after another run came and went: nothing followed", q.state.current, "");
}

// progress while a run is being followed asks nothing
{
  const p = panel({ manual: true });
  p.queuedHere("L7"); p.start("L7"); p.progress("L7"); p.progress("zz");
  check("progress while a run is followed: nothing asked", p.server.waiting.length, 0);
}

// the queue cannot be read, the client id is not known yet: asked again at the next progress
// event, and followed once there is an answer
{
  const p = panel({ delay: 5 });
  p.server.status = 503;
  p.server.running = [queued("L8", "mine")];
  p.progress("L8"); await sleep(30); p.preview(1);
  check("late, queue unreadable: not followed", [p.seen.live, p.state.current, p.state.late], [[], "", ""]);
  p.server.status = 200;
  p.progress("L8"); await sleep(30); p.preview(2);
  check("late, queue readable again: followed", [p.seen.live, p.state.current], [[2], "L8"]);
  const q = panel({ manual: true, client: "" });
  q.progress("L9"); await tick(); q.preview(1);
  check("late, no client id yet: not followed, nothing asked", [q.seen.live, q.state.current, q.server.waiting.length], [[], "", 0]);
  q.who.client = "me";
  q.progress("L9");
  await q.server.answerOne(0, [queued("L9", "mine")]);
  q.preview(2);
  check("late, client id known now: followed", [q.seen.live, q.state.current], [[2], "L9"]);
}

// an interrupt is broadcast: the asked-about run's own interrupt voids the question, another
// prompt's does not; two late runs in a row with the answers the wrong way round
{
  const p = panel({ manual: true });
  p.progress("L11");
  p.onError({ prompt_id: "L11" });                       // interrupted before the answer
  await p.server.answerOne(0, [queued("L11", "mine")]);
  check("late, interrupted before the answer: not followed", p.state.current, "");
  const q = panel({ manual: true });
  q.progress("L12");
  q.onError({ prompt_id: "elsewhere" });                 // an interrupt of some other prompt
  await q.server.answerOne(0, [queued("L12", "mine")]);
  check("late, another prompt's interrupt: still followed", q.state.current, "L12");
  const o = panel({ manual: true });
  o.progress("L13"); o.onSuccess({ prompt_id: "L13" });
  o.progress("L14");
  await o.server.answerOne(1, [queued("L14", "mine")]);  // L14's answer first
  await o.server.answerOne(0, [queued("L13", "mine")]);  // then L13's, from when it was running
  check("late, answers the wrong way round: the later run is the one followed", o.state.current, "L14");
}

// the node is gone
{
  const r = panel({ manual: true });
  r.progress("L10"); r.server.attached = false;
  await r.server.answerOne(0, [queued("L10", "mine")]);
  check("late, dropped node: not followed", r.state.current, "");
}

// ---------------------------------------------------------------- the server came back
// after a crash no end event comes: every run is forgotten and the takes are asked about
{
  const p = panel({ manual: true });
  p.queuedHere("s1"); p.start("s1"); p.onMine(); p.preview(3);
  p.onReconnected();
  const s = p.state;
  check("reconnected: nothing of the run is kept, the preview is gone",
        [s.running.size, s.queuedRun.size, s.mine.size, s.span.size, s.current, s.live], [0, 0, 0, 0, "", null]);
  check("reconnected: the takes are asked about", p.seen.refreshed, 1);
  p.preview(4);                                          // a frame of whatever runs now
  check("reconnected: a preview with no run followed is not shown", p.state.live, null);
}
// only the connection dropped and the run is still going: it is picked up late, not timed
{
  const p = panel({ manual: true });
  p.queuedHere("s2"); p.start("s2"); p.onMine(); p.preview(1);
  p.onReconnected();
  p.progress("s2");
  await p.server.answerOne(0, [queued("s2", "mine")]);
  p.preview(2); p.onMine();
  check("reconnected, run still going: its preview is back", p.state.live && p.state.live.step, 2);
  p.onSuccess({ prompt_id: "s2" }); await tick();
  check("reconnected, run still going: not timed, preview cleared at its end", [p.seen.timed, p.state.live], [0, null]);
}
// an answer about a run from before the connection dropped changes nothing afterwards
{
  const p = panel({ manual: true });
  p.start("s3"); p.onMine(); p.preview(1);               // announced, the answer is out
  p.onReconnected();
  await p.server.answerOne(0, [item("s3", "mine")]);
  check("reconnected: a late answer shows nothing", p.state.live, null);
}

// ---------------------------------------------------------------- one run after another
// the end of the run before this one, arriving late, does not clear this run's preview
{
  const p = panel({ manual: true });
  p.queuedHere("x1"); p.queuedHere("x2");
  p.start("x1"); p.onMine(); p.preview(8);
  p.start("x2"); p.onMine(); p.preview(1);            // the server has moved on
  p.onSuccess({ prompt_id: "x1" }); await tick();     // x1's end arrives after x2's start
  check("late end of the run before: this run's preview stays", p.state.live && p.state.live.step, 1);
  p.onError({ prompt_id: "zzz" });                    // an error of a prompt that is not this one
  check("another prompt's error: this run's preview stays", p.state.live && p.state.live.step, 1);
  p.onSuccess({ prompt_id: "x2" }); await tick();
  check("its own end: preview cleared", p.state.live, null);
  check("both timed once each", p.seen.timed, 2);
}

// a new run is announced: a preview left on the page, or held back, is not carried over
{
  const p = panel({ manual: true });
  p.start("y1"); p.preview(7);                        // held: y1's question is not answered
  p.start("y2");                                      // y1 never got an end here
  await p.server.answerOne(0, [item("y1", "mine")]);  // y1's answer, late
  check("held frame of the run before: not shown after the next start", p.seen.live.filter((x) => x != null), []);
  await p.server.answerOne(0, [item("y2", "mine")]);
  p.preview(1); await tick();
  check("the new run's own preview is shown", p.seen.live.filter((x) => x != null), [1]);
}

// ---------------------------------------------------------------- whose node
// node 10 does not claim "10:77" (a node inside subgraph node 10), nor "100"
{
  const p = panel({ delay: 5, fail: true });           // even with the queue unreadable
  p.start("n1");
  p.onExecuting("10:77.0.0.7"); p.onExecuting("100.0.0.7");
  p.preview(1, "10:77.0.0.5"); p.preview(2, "100.0.0.5");
  await sleep(30);
  p.onSuccess({ prompt_id: "n1" }); await sleep(30);
  check("other ids starting with this one: no preview", p.seen.live.filter((x) => x != null), []);
  check("other ids starting with this one: not timed", p.seen.timed, 0);
}

// a node inside a subgraph is followed under its execution id
{
  const p = panel({ delay: 5, node: "32:10" });
  p.server.running = [item("n2", "mine", "32:10")];
  p.start("n2"); p.onMine(); p.preview(1); await sleep(30);
  p.onSuccess({ prompt_id: "n2" }); await sleep(30);
  check("node in a subgraph: shown and timed", [p.seen.live.filter((x) => x != null), p.seen.timed], [[1], 1]);
}

// a node ComfyUI dropped changes nothing, even from an answer that arrives afterwards
{
  const p = panel({ manual: true });
  p.start("o1"); p.onMine(); p.preview(1);
  p.onSuccess({ prompt_id: "o1" });
  p.server.attached = false;                          // the node is gone from its graph
  await p.server.answerOne(0, [item("o1", "mine")]);
  check("dropped node: a late answer times nothing", p.seen.timed, 0);
  const q = panel({ manual: true });
  q.start("o2"); q.onMine(); q.preview(1);
  q.server.attached = false;
  await q.server.answerOne(0, [item("o2", "mine")]);
  check("dropped node: a late answer shows nothing", q.seen.live.filter((x) => x != null), []);
}

// ---------------------------------------------------------------- timing
// what a preset records is the time on this node, not the time of the prompt: another
// director node in the same workflow runs in the same prompt (measured in the browser:
// 196 s for the prompt, 99 s for one node)
{
  const p = panel({ delay: 5 });
  p.server.running = [item("j", "mine")];
  p.start("j");
  p.onExecuting("1");                          // a loader
  p.onMine(100000);                            // this node: 100 s
  p.onExecuting("32.0.0.7");                   // the other director node takes over
  p.onExecuting("30");                         // a preview wired after this node
  await sleep(20);
  p.onSuccess({ prompt_id: "j" });
  await sleep(30);
  check("two director nodes: this node's own time", p.seen.seconds, [100]);
}

// ComfyUI runs other nodes in between (measured: the node, two previews, the node again):
// the stretches on this node are added up
{
  const p = panel({ delay: 5 });
  p.server.running = [item("k", "mine")];
  p.start("k");
  p.onMine(10000);                             // 10 s
  p.onExecuting("31"); p.onExecuting("30");
  p.onMine(5000);                              // and 5 s more
  p.onExecuting(null);                         // the prompt is over
  p.onSuccess({ prompt_id: "k" });
  await sleep(30);
  check("interleaved: stretches added up", p.seen.seconds, [15]);
}

// a prompt in which this node did nothing (everything cached, or not part of it) is not timed
{
  const p = panel({ delay: 5 });
  p.server.running = [item("m", "mine")];
  p.start("m"); p.onExecuting("32.0.0.7");
  p.onSuccess({ prompt_id: "m" });
  await sleep(30);
  check("this node did not run: not timed", p.seen.timed, 0);
}

// nothing is left behind after many runs
{
  const p = panel({ delay: 0 });
  for (let i = 0; i < 20; i++) {
    const pid = `r${i}`;
    p.server.running = [item(pid, "mine")];
    p.start(pid); p.onMine(); p.preview(1);
    await tick();
    if (i % 2) p.onSuccess({ prompt_id: pid }); else p.onError({ prompt_id: pid });
    await tick();
  }
  const s = p.state;
  check("after 20 runs: nothing kept",
        [s.running.size, s.queuedRun.size, s.started.size, s.mine.size, s.span.size, s.verdict.size, s.current, s.held, s.late, s.live],
        [0, 0, 0, 0, 0, 0, "", null, "", null]);
  check("after 20 runs: the ten that succeeded were timed", p.seen.timed, 10);
}

if (failed.length) {
  console.error(failed.join("\n"));
  console.error(`tracker: ${failed.length} failed`);
  process.exit(1);
}
console.log("tracker: all passed");
