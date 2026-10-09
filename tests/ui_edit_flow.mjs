// The edit page, driven the way a person would drive it, with the document checked after
// every step: naming material with "@", changing what a picture is for, renaming, cutting
// a shot and merging it back, saying whether two shots are a montage or one long take,
// removing material, and what the model is finally sent.
//
//   node --experimental-websocket tests/shot.mjs tests/ui_edit_flow.mjs --lang zh
//
// Needs ComfyUI running with this package (see tests/shot.mjs for the address). Nothing is
// rendered: the one request to the server is for the compiled prompt. The expected labels
// are the Chinese ones, hence --lang zh. The files the document names do not have to
// exist: only their thumbnails would be missing. Screenshots go to the folder GD_SHOTS
// names, or to the system's temporary folder.

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.GD_SHOTS || join(tmpdir(), "gd-shots");
const WF = join(HERE, "..", "example_workflows", "GachaDirector_Reference.json");

const DOC = {
  schema_version: 7, family: "reference", clip: { length: 243, aspect: "16:9" },
  prompt: {
    mode: "structured", global: "Live-action, overcast afternoon on a city roof.",
    soundscape: "wind, distant traffic",
    shots: [
      { id: "a", length: 124, text: "@{s1} walks to the edge of the roof and looks down.\n@{s1} says quietly: It is a long way down." },
      { id: "b", length: 119, text: "A dog runs across the roof toward her." },
    ],
  },
  subjects: [
    { id: "s1", name: "girl", shot: "", images: ["sintel_face.png"], description: "a young woman with red hair" },
    { id: "s2", name: "dog", shot: "b", images: ["dog_mid.png"], description: "a brown dog" },
  ],
  videos: [{ id: "v1", name: "dance", shot: "b", file: "street_dancer.mp4" }],
  audio: [{ id: "a1", name: "girl_voice", shot: "", file: "baker_voice.wav", subject: "s1" }],
  anchors: [
    { id: "k1", name: "opening", kind: "image", file: "tos_city.png", shot: "a", at: "first", pin: true, cite: true },
    { id: "k2", name: "ending", kind: "image", file: "dog_last.png", shot: "b", at: "last", pin: true, cite: true },
  ],
};

const failed = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  if (!ok) failed.push(name);
}

export default async function (page) {
  await page.open(WF, DOC);
  await page.tab(1);
  await page.wait(800);
  // helpers that live in the page
  await page.eval(() => {
    window.T = {
      doc: () => JSON.parse(window.app.graph._nodes.find((n) => n.type === "GachaDirector")
        .widgets.find((w) => w.name === "gd_timeline").value),
      box: (key) => document.querySelector(`textarea[data-mbox="${key}"]`),
      card: (i) => document.querySelector(`.gd-seg[data-shot="${i}"]`),
      row: (scope, name) => [...scope.querySelectorAll(".gd-mat-line")]
        .find((l) => l.querySelector(".gd-mat-name").value === name),
      type: (box, text) => {
        box.focus();
        box.value = text;
        box.setSelectionRange(text.length, text.length);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      },
      set: (control, value) => { control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); },
      brief: () => {
        const d = window.T.doc();
        return {
          shots: d.prompt.shots.map((s) => [s.id.length > 3 ? "new" : s.id, s.length, s.text]),
          subjects: d.subjects.map((s) => [s.id, s.name, s.shot.length > 3 ? "new" : s.shot]),
          videos: d.videos.map((s) => [s.id, s.name, s.shot]),
          audio: d.audio.map((s) => [s.id, s.name, s.shot, s.subject]),
          anchors: d.anchors.map((s) => [s.id, s.name, s.kind, s.shot.length > 3 ? "new" : s.shot, s.at, s.frame, s.pin, s.cite]),
        };
      },
    };
  });

  // ---- A/B: "@" offers what can be named, the shot's own material first
  const offered = await page.eval(() => {
    T.type(T.box("shot:b"), "A dog runs. @");
    return [...document.querySelectorAll(".gd-at:not([hidden]) .gd-at-item")].map((b) => b.innerText.replace(/\s+/g, " "));
  });
  check("typing @ in shot 2 offers its own material first, then what is shared", offered,
    ["@dog 主体", "@ending 画面", "@dance 视频", "@girl 主体 · 共通", "@girl_voice 声音 · 共通", "@opening 画面 · 镜头 1"]);
  // (no screenshot here: taking one blurs the box, which commits it, as leaving it should)
  const typed = await page.eval(async () => {
    T.type(T.box("shot:b"), "A dog runs. @");
    const box = T.box("shot:b");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const shown = box.value;
    box.blur();
    await new Promise((r) => setTimeout(r, 300));
    return [shown, T.doc().prompt.shots[1].text, T.box("shot:b").value];
  });
  check("Enter takes the first name; leaving the box stores its id; the box shows the name again",
    typed, ["A dog runs. @dog ", "A dog runs. @{s2} ", "A dog runs. @dog "]);

  // Escape closes the list of names and leaves the panel open
  const esc = await page.eval(async () => {
    T.type(T.box("global"), "Live-action. @");
    const open = !document.querySelector(".gd-at:not([hidden])");
    T.box("global").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const out = [open, !!document.querySelector(".gd-at:not([hidden])"), document.querySelector(".gd-overlay").hidden];
    T.box("global").value = "Live-action, overcast afternoon on a city roof.";
    T.box("global").blur();
    await new Promise((r) => setTimeout(r, 300));
    return out;
  });
  check("Escape closes the list of names, not the panel", esc, [false, false, false]);

  // ---- C: the "@" button of a row writes into that shot's box
  const viaButton = await page.eval(async () => {
    document.activeElement && document.activeElement.blur();
    const line = T.row(T.card(1), "ending");
    [...line.querySelectorAll("button")].find((b) => b.textContent === "@").click();
    const shown = T.box("shot:b").value;
    T.box("shot:b").blur();
    await new Promise((r) => setTimeout(r, 300));
    return [shown, T.doc().prompt.shots[1].text];
  });
  check("the @ button of a row inserts its name into that shot's text",
    viaButton, ["A dog runs. @dog @ending ", "A dog runs. @{s2} @{k2} "]);

  // ---- D: changing what a picture is for moves it, and the text follows
  const used = await page.eval(async () => {
    T.set(T.row(T.card(1), "dog").querySelector("select"), "frame");
    await new Promise((r) => setTimeout(r, 300));
    const b = T.brief();
    return [b.subjects, b.anchors, b.shots[1][2],
            T.row(T.card(1), "dog").querySelector("select").value, T.box("shot:b").value];
  });
  check("a subject's picture becomes a frame inside the shot, and the text still names it", used, [
    [["s1", "girl", ""]],
    [["k1", "opening", "image", "a", "first", 0, true, true], ["k3", "dog", "image", "b", "offset", 183, true, true],
     ["k2", "ending", "image", "b", "last", 242, true, true]],
    "A dog runs. @{k3} @{k2} ", "frame", "A dog runs. @dog @ending "]);
  await page.scrollTo(".gd-seg-head");
  await page.shot(`${OUT}/flow_2_frame.png`);

  // ---- E: renaming
  const renamed = await page.eval(async () => {
    T.set(T.row(document.querySelector(".gd-common"), "girl").querySelector(".gd-mat-name"), "hero");
    await new Promise((r) => setTimeout(r, 300));
    return [T.doc().subjects[0].name, T.box("shot:a").value.split("\n")[0], T.doc().prompt.shots[0].text.split("\n")[0]];
  });
  check("a renamed subject is renamed in the boxes; the stored text does not change", renamed,
    ["hero", "@hero walks to the edge of the roof and looks down.", "@{s1} walks to the edge of the roof and looks down."]);

  // ---- F: a cut at frame 60: what is held on a frame stays there
  const cut = await page.eval(async () => {
    T.set(document.querySelector(".gd-player-frameinput"), "60");
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector(".gd-cutbar button").click();
    await new Promise((r) => setTimeout(r, 400));
    const b = T.brief();
    return [b.shots.map((s) => s.slice(0, 2)), b.anchors.map((a) => a.slice(0, 6)), b.subjects];
  });
  check("a cut at frame 60 splits shot 1 and moves nothing", cut, [
    [["a", 60], ["new", 64], ["b", 119]],
    [["k1", "opening", "image", "a", "first", 0], ["k3", "dog", "image", "b", "offset", 183],
     ["k2", "ending", "image", "b", "last", 242]],
    [["s1", "hero", ""]]]);

  // ---- G: merging it back
  const merged = await page.eval(async () => {
    [...T.card(1).querySelectorAll(".gd-seg-actions button")].pop().click();
    await new Promise((r) => setTimeout(r, 400));
    const b = T.brief();
    return [b.shots.map((s) => s.slice(0, 2)), b.anchors.map((a) => a.slice(0, 6))];
  });
  check("merging the new shot back restores the two shots", merged, [
    [["a", 124], ["b", 119]],
    [["k1", "opening", "image", "a", "first", 0], ["k3", "dog", "image", "b", "offset", 183],
     ["k2", "ending", "image", "b", "last", 242]]]);

  // ---- G2: montage or long take, on the bar between the two cards
  const joined = await page.eval(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bar = () => document.querySelector('.gd-join[data-join="1"]');
    const joins = () => T.doc().prompt.shots.map((s) => s.join || "cut");
    const sounds = () => T.doc().prompt.shots.map((s) => s.sound || "cut");
    // two links: the picture's and the sound's, each closed ("1") or open ("0")
    const link = (kind) => bar().querySelector(`.gd-link[data-link=${kind}]`);
    const state = () => [joins(), sounds(), ["picture", "sound"].map((k) => link(k).dataset.on).join(""),
      link("sound").classList.contains("locked")];
    const before = state();
    link("sound").click();
    await wait(400);
    const heard = state();
    link("picture").click();
    await wait(400);
    const long = state();
    link("sound").click();                       // locked while the picture goes on: nothing happens
    await wait(400);
    const still = state();
    link("sound").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await wait(800);
    const said = (document.querySelector(".gd-tip") || {}).hidden === false;
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // a cut put into a clip made from nothing is a montage, and the long take below it stays one
    T.set(document.querySelector(".gd-player-frameinput"), "60");
    await wait(300);
    document.querySelector(".gd-cutbar button").click();
    await wait(400);
    const three = joins();
    [...T.card(1).querySelectorAll(".gd-seg-actions button")].pop().click();
    await wait(400);
    const back = joins();
    link("picture").click();
    await wait(400);
    return [before, heard, long, still, said, three, back, state()];
  });
  check("the two links between two cards: picture and sound, set apart", joined, [
    [["cut", "cut"], ["cut", "cut"], "00", false],
    [["cut", "cut"], ["cut", "continuous"], "01", false],
    [["cut", "continuous"], ["cut", "continuous"], "11", true],
    [["cut", "continuous"], ["cut", "continuous"], "11", true],
    true,
    ["cut", "cut", "continuous"], ["cut", "continuous"],
    // the picture cut again: the sound is what it was set to before
    [["cut", "cut"], ["cut", "continuous"], "01", false]]);

  // ---- H: removing
  const removed = await page.eval(async () => {
    const line = T.row(T.card(1), "dog");
    [...line.querySelectorAll("button")].find((b) => b.textContent === "×").click();
    await new Promise((r) => setTimeout(r, 300));
    return [T.doc().anchors.map((a) => a.id), T.doc().prompt.shots[1].text,
            document.querySelector(".gd-sec-bad")?.innerText || ""];
  });
  check("a removed picture leaves its name in the text as a plain word",
    removed, [["k1", "k2"], "A dog runs. dog @{k2} ", ""]);

  // ---- I: what the model gets
  const compiled = await page.eval(async () => {
    [...document.querySelectorAll(".gd-seg-head button")].pop().click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const pre = document.querySelector(".gd-compiled pre");
      if (pre) return pre.textContent;
      const box = document.querySelector(".gd-compiled");
      if (box && box.textContent && !/…|\.\.\./.test(box.textContent)) return `ERROR ${box.textContent}`;
    }
    return "TIMEOUT";
  });
  console.log("---- compiled prompt ----\n" + compiled + "\n----");

  // ---- what is being typed survives what happens around it
  // the compiled prompt arriving, and a change made somewhere else, both while the cursor
  // is in a prompt box with text that has not been committed yet
  const kept = await page.eval(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    T.type(T.box("shot:a"), "She waits. @");
    T.box("shot:a").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    T.box("shot:a").value = "She waits.";
    const before = T.box("shot:a");
    document.querySelector(".gd-compiled button").click();          // close it
    [...document.querySelectorAll(".gd-seg-head button")].pop().click();   // and ask again
    await wait(1500);
    const same = T.box("shot:a") === before && document.activeElement === before && before.value === "She waits.";
    // now a change elsewhere: the clip's length. The cards are rebuilt for it.
    T.set(document.querySelector('.gd-edit-body .gd-inline input[type="number"]'), "5.17");    // seconds
    await wait(500);
    const after = T.box("shot:a");
    return [same, after !== before, after.value, document.activeElement === after,
            T.doc().prompt.shots[0].text, T.doc().clip.length];
  });
  check("typing is not lost when the compiled prompt arrives, nor when the page is rebuilt",
    kept, [true, true, "She waits.", true, "She waits.", 124]);
  await page.scrollTo(".gd-seg-head");
  await page.shot(`${OUT}/flow_3_compiled.png`);

  // ---- J: the base model, a first frame for shot 2
  const base = await page.eval(async () => {
    const famSel = [...document.querySelectorAll(".gd-edit-body .gd-fld select")][0];
    T.set(famSel, "base");
    await new Promise((r) => setTimeout(r, 300));
    return [T.doc().family, document.querySelector(".gd-sec-bad")?.innerText.replace(/\s+/g, " ") || "",
            [...(T.card(1) || T.card(0)).querySelectorAll(".gd-mat-line")].map((l) => [l.querySelector(".gd-mat-name").value,
              [...l.querySelector("select").options].map((o) => o.value).join(",")])];
  });
  console.log("base family:", JSON.stringify(base, null, 1));
  await page.scrollTo(".gd-edit-body");
  await page.shot(`${OUT}/flow_4_base.png`);

  console.log(failed.length ? `\n${failed.length} FAILED: ${failed.join("; ")}` : "\nall checks passed");
  if (failed.length) throw new Error("the edit page did not behave as expected");
}
