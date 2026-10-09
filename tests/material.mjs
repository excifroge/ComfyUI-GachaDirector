// Material as the panel shows it: web/gd_material.js, which is pure.
//
//   node --experimental-default-type=module tests/material.mjs
//
// What is at stake: a mention in the prompt must go on naming the same thing when material
// is renamed, moved between "a picture of someone" and "the frame the shot opens on", or
// removed; and a cut that is added or dragged must not lose a shot's material.

import { normalize, problemsCoded } from "../web/gd_doc.js";
import {
  addAudio, addImage, addVideo, budget, clipMode, freeId, loosenAnchors, mentionable, readMentions,
  rehome, removeMaterial, setUse, shotMode, showMentions, useOf,
} from "../web/gd_material.js";

const failed = [];
const check = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const draft = (d) => JSON.parse(JSON.stringify(d));
const two = { shots: [{ id: "a", length: 68, text: "" }, { id: "b", length: 56, text: "" }] };

// ---------------------------------------------------------------- mentions
{
  const d = normalize({ prompt: two,
    subjects: [{ images: ["e.png"], name: "ella" }, { images: ["f.png"], name: "ella_2" },
               { images: ["g.png"], name: "艾拉" }],
    videos: [{ file: "run.mp4" }] });
  const typed = "@ella waves, @ella_2 runs like @run. @艾拉 推开门。 @nobody @{zz}";
  const stored = readMentions(typed, d);
  check("typed names become ids, the longest name first",
        stored, "@{s1} waves, @{s2} runs like @{v1}. @{s3} 推开门。 @nobody @{zz}");
  check("and are shown as names again", showMentions(stored, d), typed);
  // a name ends where a character that cannot be in a name begins
  check("more letters after a name: not that name",
        readMentions("@ellax, @ella_20, @ella's, @ella.", d), "@ellax, @ella_20, @{s1}'s, @{s1}.");
  check("a name written with no space before Chinese text is not taken for a mention",
        readMentions("@艾拉推开门", d), "@艾拉推开门");
  // what is shown reads back as what was stored, whatever follows the mention
  for (const text of ["@{s1}_2", "@{s1}x", "@{s3}推开门", "@{s1}@{s2}", "@{s2}0 and @{s1}", "(@{s1})"]) {
    check(`shown and read back: ${text}`, readMentions(showMentions(text, d), d), text);
  }
  check("a mention that would run into what follows is shown in braces",
        [showMentions("@{s1}_2", d), showMentions("@{s3}推开门", d), showMentions("@{s1}'s", d)],
        ["@{ella}_2", "@{艾拉}推开门", "@ella's"]);
  check("and braces are read as a name", readMentions("@{ella} and @{ella_2}x", d), "@{s1} and @{s2}x");
  const renamed = normalize({ ...draft(d), subjects: draft(d).subjects.map((s, i) => (i ? s : { ...s, name: "hero" })) });
  check("a renamed thing is still what the text means",
        showMentions(stored, renamed).startsWith("@hero waves, @ella_2"), true);
  check("what can be named in a shot: its own material first, then what is shared",
        mentionable(normalize({ ...draft(d), subjects: [...draft(d).subjects, { images: ["h.png"], shot: "b", name: "cabin" },
                                                        { images: ["i.png"], shot: "a", name: "kite" }] }), "b")
          .map((x) => x.name), ["cabin", "ella", "ella_2", "艾拉", "run", "kite"]);
}

// ---------------------------------------------------------------- removing
{
  const x = draft(normalize({ prompt: { global: "@{s1} and @{s2}", shots: [{ id: "a", text: "@{s1} waves at @{s2}." }] },
    subjects: [{ images: ["e.png"], name: "ella", short_name: "the girl" }, { images: ["k.png"], name: "old_kite" }],
    audio: [{ file: "v.wav", subject: "s1" }] }));
  removeMaterial(x, "s1");
  removeMaterial(x, "s2");
  check("a removed thing leaves its name in the text as plain words",
        [x.prompt.global, x.prompt.shots[0].text], ["the girl and old kite", "the girl waves at old kite."]);
  check("and its voice belongs to nobody", x.audio[0].subject, "");
  check("so nothing is left pointing at it", problemsCoded(x), []);
}
{
  // a subject's description may name other material: it is kept right like any prompt text
  const x = draft(normalize({ family: "reference", prompt: { shots: [{ id: "a", text: "" }] },
    subjects: [{ images: ["e.png"], name: "ella", description: "the dancer, whose motion comes from @{v1}" }],
    videos: [{ file: "run.mp4", shot: "a" }] }));
  const k = setUse(x, "v1", "continue");
  check("a change of use reaches a subject's description",
        [k, x.subjects[0].description], ["k1", "the dancer, whose motion comes from @{k1}"]);
  removeMaterial(x, k);
  check("and so does a removal", x.subjects[0].description, "the dancer, whose motion comes from run");
  check("a name of something gone, in a description, is a problem",
        problemsCoded(normalize({ subjects: [{ images: ["e.png"], description: "like @{v9}" }] })),
        [["mention_gone_other", ["@{v9}"]]]);
}

// ---------------------------------------------------------------- uses
{
  let x = draft(normalize({ prompt: { shots: [{ id: "a", length: 68, text: "It opens on @{s1}." }, { id: "b", length: 56 }] },
    subjects: [{ images: ["open.png"], shot: "a", name: "opening" }] }));
  const id = setUse(x, "s1", "first");
  let d = normalize(x);
  check("a picture of something can become the frame a shot opens on",
        d.anchors.map((a) => [a.id, a.name, a.shot, a.at, a.pin, a.cite, useOf("anchors", a)]),
        [[id, "opening", "a", "first", true, true, "first"]]);
  check("and the text still names it", d.prompt.shots[0].text, `It opens on @{${id}}.`);
  x = draft(d);
  setUse(x, id, "last");
  d = normalize(x);
  check("moved to the end of the shot", [d.anchors[0].at, d.anchors[0].frame, d.anchors[0].id], ["last", 67, id]);
  x = draft(d);
  setUse(x, id, "frame", 20);
  d = normalize(x);
  check("or to a frame inside it", [d.anchors[0].at, d.anchors[0].offset, d.anchors[0].frame], ["offset", 20, 20]);
  x = draft(d);
  setUse(x, id, "storyboard");
  d = normalize(x);
  check("a storyboard is cited and not pinned", [d.anchors[0].role, d.anchors[0].pin, d.anchors[0].cite, useOf("anchors", d.anchors[0])],
        ["storyboard", false, true, "storyboard"]);
  x = draft(d);
  x.anchors[0].retention = "attribute_transfer";
  const back = setUse(x, id, "subject");
  d = normalize(x);
  check("and back to a picture of something", [d.subjects.map((s) => [s.id, s.name, s.shot, s.images]), d.anchors.length,
                                                 d.prompt.shots[0].text],
        [[[back, "opening", "a", ["open.png"]]], 0, `It opens on @{${back}}.`]);
  check("how closely it is kept goes with it", d.subjects[0].retention, "attribute_transfer");
  // a subject that is several pictures is not one frame: asked to become one, it stays what it is
  const many = draft(normalize({ prompt: two, subjects: [{ images: ["a.png", "b.png"], shot: "a" }] }));
  check("a subject of two pictures does not become a frame",
        [setUse(many, "s1", "first"), many.subjects.length, many.anchors.length], ["s1", 1, 0]);
}
{
  const x = draft(normalize({ prompt: two }));
  const v = addVideo(x, "b", "run.mp4");
  const s = addAudio(x, "b", "wind.wav");
  const p = addImage(x, "b", "end.png", "last");
  const g = addImage(x, "", "ella.png");
  let d = normalize(x);
  check("added to a shot, each with the use it was given",
        [useOf("videos", d.videos[0]), useOf("audio", d.audio[0]), useOf("anchors", d.anchors[0]), d.subjects[0].shot],
        ["motion", "sound", "last", ""]);
  check("ids were handed out", [v, s, p, g], ["v1", "a1", "k1", "s1"]);
  const y = draft(d);
  const clip = setUse(y, v, "continue");
  const play = setUse(y, s, "play");
  d = normalize(y);
  check("a video to continue from is a clip held at the start of the shot; a sound to play is held too",
        d.anchors.map((a) => [a.id, a.kind, a.shot, a.at]).sort(),
        [[clip, "clip", "b", "first"], [play, "audio", "b", "first"], [p, "image", "b", "last"]].sort());
  check("the next id is free", freeId(d, "anchors"), "k4");
}
{
  // a video a shot carries on from is taken from its end, however it came to be that
  const x = draft(normalize({ prompt: two }));
  const added = addVideo(x, "a", "long.mp4", "continue", { frames: 300, frames24: 240, audio: true });
  const switched = setUse(x, addVideo(x, "b", "ntsc.mp4"), "continue", 1, { frames: 100 });
  check("its last 22 frames, counted at 24 fps when the server gave that count",
        x.anchors.map((a) => [a.id, a.clip_start, a.clip_length, a.with_audio]),
        [[added, 218, 22, true], [switched, 78, 22, false]]);
  const y = draft(normalize({ prompt: two }));
  addVideo(y, "a", "short.mp4", "continue", { frames24: 9 });
  addVideo(y, "b", "unprobed.mp4", "continue");
  check("a video shorter than that, or one nothing is known of, from its first frame",
        y.anchors.map((a) => a.clip_start), [0, 0]);
  // 17 frames before the clip ends: a clip held there is cut to 5, and those are the last 5
  const z = draft(normalize({ family: "reference",
    prompt: { shots: [{ id: "a", length: 107, text: "" }, { id: "b", length: 17, text: "" }] },
    videos: [{ file: "run.mp4", shot: "b" }] }));
  addVideo(z, "b", "long.mp4", "continue", { frames24: 240 });
  setUse(z, "v1", "continue", 1, { frames24: 124 });
  check("where the clip ends sooner than 22 frames on, the end of the video all the same",
        normalize(z).anchors.map((a) => [a.file, a.frame, a.clip_start, a.clip_length]),
        [["long.mp4", 107, 235, 5], ["run.mp4", 107, 119, 5]]);
}

// ---------------------------------------------------------------- cuts
{
  // a cut is inserted at frame 40: an anchor stays on its frame and finds its shot again
  const d = normalize({ prompt: { shots: [{ id: "a", length: 124, text: "" }] },
    anchors: [{ file: "f.png", shot: "a", at: "first" }, { file: "m.png", shot: "a", at: "offset", offset: 60 },
              { file: "l.png", shot: "a", at: "last" }],
    subjects: [{ images: ["s.png"], shot: "a" }] });
  const x = draft(d);
  loosenAnchors(x);
  x.prompt.shots = [{ id: "a", length: 40, text: "" }, { id: "new", length: 84, text: "" }];
  const cut = normalize(x);
  check("after a cut, anchors are where they were, in the shot that is there now",
        cut.anchors.map((a) => [a.file, a.shot, a.at, a.frame]),
        [["f.png", "a", "first", 0], ["m.png", "new", "offset", 60], ["l.png", "new", "last", 123]]);
  check("and the shot keeps its own material", cut.subjects[0].shot, "a");
  // the cut is removed again: the second shot's material goes to the first
  const y = draft(cut);
  y.subjects.push({ images: ["t.png"], shot: "new" });
  loosenAnchors(y);
  rehome(y, "new", "a");
  y.prompt.shots = [{ id: "a", length: 124, text: "" }];
  const merged = normalize(y);
  check("after a merge, everything belongs to the shot that is left",
        [merged.subjects.map((s) => s.shot), merged.anchors.map((a) => [a.shot, a.at, a.frame])],
        [["a", "a"], [["a", "first", 0], ["a", "offset", 60], ["a", "last", 123]]]);
}

// ---------------------------------------------------------------- modes
{
  const base = (more) => normalize({ family: "base", prompt: two, ...more });
  const ref = (more) => normalize({ family: "reference", prompt: two, ...more });
  const first = { file: "f.png", shot: "a", at: "first" }, last = { file: "l.png", shot: "b", at: "last" };
  check("modes of a clip", [
    clipMode(base({})), clipMode(base({ anchors: [first] })), clipMode(base({ anchors: [first, last] })),
    clipMode(base({ anchors: [last] })), clipMode(base({ anchors: [{ file: "m.png", shot: "a", at: "offset", offset: 9 }] })),
    clipMode(ref({ subjects: ["s.png"] })), clipMode(ref({ source: { video: "v.mp4", role: "edit" } })),
    clipMode(ref({ source: { video: "v.mp4", role: "edit" }, subjects: ["s.png"] })),
    clipMode(ref({ source: { video: "v.mp4", role: "continue" } })),
    clipMode(ref({ source: { video: "v.mp4", role: "motion" } })),
    clipMode(base({ source: { video: "v.mp4", as_latent: true } })),
    clipMode(base({ anchors: [{ kind: "clip", file: "c.mp4", shot: "a", at: "first" }] })),
    clipMode(ref({})),
  ], ["t2v", "i2v", "fl2v", "fl2v", "keyframes", "r2v", "v2v", "rv2v", "continue", "r2v", "v2v", "continue", "t2v"]);
  const d = ref({ prompt: { shots: [{ id: "a", length: 68, text: "@{s1} waves." }, { id: "b", length: 56, text: "Rain." }] },
                  subjects: [{ images: ["s.png"] }], anchors: [last] });
  check("modes of its shots: what each one uses", d.prompt.shots.map((s) => shotMode(d, s)), ["r2v", "fl2v"]);
  const e = ref({ source: { video: "v.mp4", role: "edit" } });
  check("an edit is an edit in every shot", e.prompt.shots.map((s) => shotMode(e, s)), ["v2v", "v2v"]);
}

// ---------------------------------------------------------------- budget
{
  const d = normalize({ family: "reference", prompt: two,
    subjects: [{ images: ["a.png", "b.png"] }, { description: "an old man" }],
    videos: [{ file: "v.mp4", audio: true }], audio: ["w.wav"],
    source: { video: "s.mp4", audio: true },
    anchors: [{ file: "f.png", shot: "a", at: "first", cite: true }, { file: "p.png", shot: "a", at: "last" }] });
  const b = budget(d);
  check("the allowance is counted for the whole clip, soundtracks included",
        [b.images, b.videos, b.audio, b.files], [3, 2, 3, 8]);
  check("the base model takes no references", budget(normalize({ family: "base", videos: ["v.mp4"] })).videos, 0);
}

if (failed.length) {
  console.error(failed.join("\n"));
  console.error(`material: ${failed.length} failed`);
  process.exit(1);
}
console.log("material: all passed");
