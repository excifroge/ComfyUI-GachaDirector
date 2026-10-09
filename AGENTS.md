# Gacha Director: Handoff Notes for AI Assistants

This file is written for an AI coding assistant that has been asked to explain, change or extend this
project. It gives the background that is not obvious from reading one file at a time: how the parts fit
together, which names are contracts, what ComfyUI and the model do that will surprise you, and how to check
your work. The user manual is [README.md](README.md) ([中文](README_ZH.md), [日本語](README_JA.md)); what it
says is not repeated here.

## 1. What this project is

A ComfyUI custom-node package for the MiniMax H3 video-and-audio model. It registers one operating node,
`GachaDirector`, and a browser panel that opens from it. The user describes one clip in the panel (shots, what
happens in each, and the pictures, videos and sounds each one uses), picks a run preset, renders candidates
("takes"), picks a take per shot and gets a final clip, whose face can then be refined.

    panel (web/)  --writes JSON into four hidden widgets-->  GachaDirector.run()
    GachaDirector.run()  --returns a subgraph of stock ComfyUI nodes-->  ComfyUI executes it

Design goals, in priority order. When two pull apart, the earlier one wins.

1. **Nothing about sampling is re-implemented.** The node expands into ComfyUI's own MiniMax H3 nodes,
   samplers and VAE nodes. What it emits for a given use has to stay equivalent to the official template
   for that use.
2. **No entity without a measured need.** Several features were removed after measurement showed they
   changed nothing (section 7). Before adding a switch, find out whether it does anything.
3. **Nothing the user listed is dropped or rewritten silently.** `normalize` completes and clamps a
   document. What it removes: an entry that names no file, a second copy of one image inside one subject,
   shots that no longer fit a shortened clip (their text moves into the last shot that fits), and the
   owner of a sound whose subject is no longer there (`audio[].subject` becomes empty; the sound stays).
   `problems` names what cannot run. `gd_compile.build_plan` counts what the planner would send against
   what was listed and raises when it is less.
4. **The panel puts generated frames back into generation in exactly three places:** the repair of a seam
   inside a long take when a composite joins two takes there (two takes that meet at a cut are put
   together without the model), continuation from the tail of a clip (which the model's own documentation defines), and face
   refine, which regenerates the region a face is in and no other pixel. There is no whole-clip refine
   pass, no upscale-and-resample, no per-shot re-render. This is a design rule, not a check: nothing stops
   a user from naming a rendered file as a source clip, and the README says how to upscale-and-resample
   that way by hand. What a second pass over a whole clip does was measured (section 13): nothing at the
   clip's own size, a clearer picture at a larger one for the price of a render at that size. There
   is no button for it.
5. **One clip per node.** A clip is one generation window; longer pieces are chained by continuation.
6. **The panel speaks the user's language, not the model's.** It exists to make scattered nodes usable:
   a size is a width and a height, a length is seconds, a picture is "the first frame of this shot" and
   not an anchor that is pinned and cited. What the model needs (labels, declarations, megapixels, a
   denoise bent by the schedule) is worked out from that. A control that needs a term from the node graph
   to be understood belongs under an "Advanced" fold or does not belong.

Conventions it follows: ComfyUI custom-node layout (`NODE_CLASS_MAPPINGS`, `WEB_DIRECTORY`), node expansion
through `comfy_execution.graph_utils.GraphBuilder`, no pip dependencies beyond ComfyUI's own.

## 2. Repository map

| Path | What it is |
| --- | --- |
| `__init__.py` | registers the nodes and the HTTP routes; `__version__` |
| `gd_*.py` | the package's Python modules (section 6) |
| `vendor/` | two upstream files, byte for byte, with their hashes in `vendor/UPSTREAM.json`. Never edit |
| `web/` | the panel: plain ES modules served by ComfyUI, no build step, no framework |
| `example_workflows/` | **generated** by `templates/make_workflows.py` |
| `docs/` | the pictures the README files show. `docs/zh`, `docs/ja`, `docs/en` hold the same thirteen screenshots each, one set per README: twelve of the panel and `node.jpg` of the node on the canvas. They are taken by a script (section 9) and are retaken when the panel changes. Two figures of renders serve all three languages, `modes.jpg` (one clip per way of driving the model) and `example-edit.jpg` (the worked example), each with a looping animation of the same clips (`modes.webp`, `example-edit.webp`, 12 fps): they change only if those clips are rendered again. The footage in them is credited in `NOTICE`; a picture from any other source needs its licence checked and a line there |
| `templates/make_workflows.py` | the generator of the example workflows |
| `tests/` | Python tests, three checks run with Node (JS/Python parity, the run tracker, the panel's material helpers), a driver for a headless browser with one flow through the Edit page, three measurement scripts |
| `tests/_parity_fixtures.json` | **generated**, git-ignored |
| `LICENSE`, `LICENSES/`, `NOTICE` | GPL-3.0; the Apache-2.0 texts of two upstream projects; what came from where |

The whole directory is the shipped product. Only `web/` is served to the browser.

## 3. Architecture in one page

```
 browser                                              server
 ------------------------------------------           ---------------------------------------------
 gd_director.js   ComfyUI adapter, widgets            gd_director.py   GachaDirector.run(): expansion
 gd_editor.js     state, actions, run tracking        gd_schema.py     the clip document
 gd_modal.js      the paged shell                     gd_compile.py    document -> planner input
 gd_page_*.js     run / edit / takes / post / results vendor/minimax_plan.py   prompt planner
 gd_material.js   material as the panel shows it      gd_h3.py         conditioning nodes, guides
 gd_doc.js        JS mirror of gd_schema + gd_grid    gd_grid.py       frames, cells, canvas
 gd_presets_doc.js, gd_post_doc.js, gd_takes_doc.js   gd_faces.py      face track, cut out, put back
   (mirrors of the Python modules of the same name)   gd_presets.py, gd_post.py, gd_takes.py
                                                      gd_routes.py     /gachadirector/media, /plan
```

The five pages are called Project, Edit, Generate, Post and Output in the panel. Their code names are
older: `run`, `edit`, `takes`, `post`, `results` (file names, `PAGES` in `gd_modal.js`, i18n key prefixes).

State lives in four string widgets on the node, each holding JSON: `gd_timeline` (the clip document),
`gd_post` (output settings, face refine), `gd_presets` (presets and their timings), `gd_takes` (takes,
picks, composite, refine).
Everything is written from the browser: by the panel, and by the preset selector drawn on the node itself
(`GDPRESET` in `gd_director.js`). Python reads the first three; it never reads `gd_takes`.

The panel's undo history (`gd_history.js`) covers the clip document, the output settings, the preset store
and the picks. It does not cover the takes: those record what the server did.

One run, step by step:

1. The user presses "Generate N takes". `gd_editor.js` `takesApi.queueTakes` builds, per take, a copy of the
   document and of the output settings (save prefix `<prefix>_take_<seed>_<batch>`), and calls
   `host.queueWithOverrides` in `gd_director.js`.
2. `queueWithOverrides` writes the overrides into the node's widgets, calls `app.graphToPrompt()`, restores
   the widgets and posts the prompt. The take is added to the `gd_takes` store with the prompt id.
   The prompt holds the whole graph, but it is posted with `partial_execution_targets`: this node and
   the output nodes that depend on it (`executionTargets` in `gd_director.js`). Without that every
   output node of the workflow would run with every take, a second director node included (measured:
   two director nodes, one take, one render). ComfyUI's own Run button still runs everything.
3. On the server `GachaDirector.VALIDATE_INPUTS` runs `gd_schema.problems`. Then `GachaDirector.run` normalizes the
   document, resolves the active preset, calls `gd_compile.build_plan` (which runs the vendored planner) and
   `gd_h3.emit`, and builds the rest of the graph: sigma shift, live preview, the starting latent, guider,
   sampler, decode, save. It returns `{"ui": ..., "result": ..., "expand": graph}`.
4. ComfyUI executes the expansion. The preview node pushes `minimax_h3_preview` events; `gd_editor.js`
   `onPreview` shows them on the takes page.
5. On `execution_success`, `onSuccess` records the timing and calls `refreshTakes`, which reads
   `/history/<prompt_id>` and stores the output file name in the take. What is timed is the node's own
   share of the prompt: `onExecuting` adds up the stretches during which the server was on this node
   (`state.span`), so loaders, nodes wired after it and other director nodes in the same prompt are left
   out. The timing goes to the preset and
   clip length captured when the run was queued (takes) or when it started (a plain Run; also a take
   that was queued before the page was reloaded and starts after it, since the snapshot taken at queue
   time lived in the old editor), and only if this node ran in the prompt for at least a second and
   that preset's parameters have the same `paramsSignature` when the run ends. A composite is followed
   like a take but not timed, also when it starts after a reload as an announced run (`onStart` leaves
   it out of `state.started`): it is another job than a render of the clip (measured: 128 s against
   100 s for a take of the same clip and preset) and would skew what the preset says a render costs.

A composite is the same path with two differences made by `queueComposite` (`compositeDoc`):
`source.splice` holds the picked ranges, each with the `join` of its shot, and `mask.mode` is
`seam_repair` with the frames where the take changes *inside a long take* (`seamFrames`). What happens
then depends on what those joins are (see "Cuts and long takes" in section 5):

- `GachaDirectorCutSplice` reads the picked takes, finds where each really cuts, and lays the picks out on
  the clip's own frames, joined at those cuts.
- If any cell is free (a seam inside a long take), the clip is encoded, the free cells are sampled
  again and it is decoded, as before. If none is, nothing is sampled, encoded or decoded: the frames
  and the sound of `GachaDirectorCutSplice` go on as they are, and the node hands on no latent and no
  conditioning (a link in an expansion's result is executed whether it is wired on or not, so handing
  them on would load the text encoder for a clip that is only cut together).
- `GachaDirectorDropFrames` leaves out the frames that belong to neither of two shots that meet at a cut,
  from picture and sound, and records in its UI output what was done (`gd_cuts`), how long the clip
  came out (`gd_frames`) and where its shots start (`gd_starts`: a shot of the same take as the one
  before it starts at that take's own cut, and no shot starts before the one before it). `outcomeOf`
  in `gd_editor.js` reads the first two into `composite.note` and `composite.frames`; nothing reads
  `gd_starts` yet. The sound is first made as long as the picture it came with, to the sample (the
  model's sound ends a few milliseconds before its picture), and frames are then counted out of both.
- `GachaDirectorCutSplice` refuses a take that is shorter than the clip, by name and frame count: it was
  rendered at another clip length. (The panel refuses it earlier when the take recorded its length;
  an old take did not.)

A face refine is the same path again, made by `queueFaceRefine`. The document it sends is not the clip's:
it describes a face (one shot the length of the clip, square, and the chosen subject), and the output
settings of that one run carry the job in `face.file` (the final clip, a name in `output/`) and `face.cuts`
(where its shots start, as `61,122~,183`: `~` after a frame says the shot that starts there goes on
from the one before, so no cut is looked for there and it does not narrow the search for the cuts
around it; `gd_faces.real_cuts(frames, asked, soft)` keeps such a boundary where it is, between the
cuts found on either side). `GachaDirector.run` then reads the clip at its own size, finds the face
(`GachaDirectorFaceTrack`), cuts the region out at the preset's size (`GachaDirectorCropRegion`), samples from
that with a denoise worked out from `face.strength`, puts the result back (`GachaDirectorPasteRegion`) and
saves it with the clip's own sound (a clip without a soundtrack gets the sound this run generated). The
result is recorded in `gd_takes` under `refine`; the clip it was made from is not touched. The run fails,
saying why, when the file is longer than the document says or more than a cell (17 frames) shorter (a
clip cut together from several takes can be a few frames short: it is refined with its last frame held
to the end), and when no shot qualifies: the tracker's
message names every shot it left alone and the reason (`gd_faces.describe`), and the Post page shows that
message under the button (`refineError` in `gd_editor.js`, kept while the page is open, not stored).

## 4. The parts

| Node id | Display name | Role |
| --- | --- | --- |
| `GachaDirector` | Gacha Director | the operating node; `OUTPUT_NODE`; expands into everything else |
| `GachaDirectorLoadFrames` | load frames (internal) | reads a frame range of a video from `input/`, `output/` or `temp/`, conforms to 24 fps, resizes |
| `GachaDirectorTimeMask` | time mask (internal) | the video and audio noise masks, at latent resolution |
| `GachaDirectorFreeMemory` | free memory (internal) | unloads models between stages when `vram_staging` asks for it |
| `GachaDirectorPreview` | live preview (internal) | subclass of the vendored preview node; registered only if its imports succeed |
| `GachaDirectorFaceTrack` | find the face (internal) | where the main face is in every frame of a clip, shot by shot, and how much of the generated region each frame takes back; raises when no shot qualifies |
| `GachaDirectorCropRegion` | cut out a region (internal) | the region of every frame, resampled to one size |
| `GachaDirectorPasteRegion` | put a region back (internal) | generated regions feathered back into the frames they were cut from |
| `GachaDirectorCutSplice` | cut takes together (internal) | the picked takes laid out on the clip's frames, joined where the takes really cut; also what a later render must leave alone |
| `GachaDirectorDropFrames` | leave frames out (internal) | removes what a cut between two takes costs, from picture and sound; an output node, whose UI output is the record of the join |

"Internal" nodes exist because `run()` only builds a graph: anything that has to happen between two stages
must itself be a node in that graph.

What the user builds is decided by the material in the document, not by a mode switch:

| Document contains | Emitted conditioning |
| --- | --- |
| `family: "base"` | `MiniMaxH3ImageToVideo`; a cited image at frame 0 / the last frame goes to its `first_frame` / `last_frame` |
| `family: "reference"` | `MiniMaxH3ReferenceToVideo` with `ref_images.*`, `ref_videos.*`, `ref_video_audios.*`, `ref_audios.*` |
| pinned anchors (either family) | a chain of `MiniMaxH3AddGuide` (`gd_compile.guides` decides which anchors) |
| `source.splice` whose takes meet only at cuts | `GachaDirectorCutSplice` -> `GachaDirectorDropFrames` -> save; nothing is sampled |
| `source.video` with `as_latent`, or a `source.splice` with a seam inside a long take | `VAEEncode` + `LTXVSeparateAVLatent` + `LTXVConcatAVLatent` (+ `SetLatentNoiseMask` when masked) |
| (output settings) `face.file` | the three face nodes around the same `VAEEncode` / sampler / `VAEDecode`; the sound is the clip's, read with `LoadAudio` |

## 5. Contracts: names that other code or saved files depend on

**Saved in workflows.** Two different kinds of contract, with different failures:

- **Position.** `widgets_values` in a saved workflow is a list in the order of
  `gd_director.WIDGET_ORDER` (with one extra slot after `seed` for ComfyUI's own
  `control_after_generate`): 0 `gd_timeline` (the clip document, a JSON string), 1 `gd_post`,
  2 `gd_presets`, 3 `gdg_run`, 4 `preset`, 5 `seed`, 6 `control_after_generate`, 7 `gd_metrics`,
  8 `gd_takes` (takes, picks, the composite and the refine, a JSON string; a take's `file` is a name
  in `output/`). A workflow saved from the canvas can carry one more value after these, with nothing
  in it. Frames are counted from 0 everywhere. The order is append-only; `tests/test_widget_order.py` holds the released
  order as a literal list. Insert or move a widget and every later saved value lands in the wrong one:
  the workflow still opens and silently renders with the wrong settings.
- **Name.** The four widget names are looked up by name in `web/gd_director.js`, are the keys of the
  node's inputs in every queued prompt, and three of them (`gd_timeline`, `gd_presets`, `gd_post`) are
  read back by name from history by the results page (`gd_takes` is the workflow's own record; no run
  is read for it).
  Renaming one in place moves no saved value, but breaks all three unless every reader changes with it,
  and prompts already in history keep the old name.
- The node's input names (`model`, `clip`, `vae`, `audio_vae`, `model_turbo`, `sampler`, `sigmas`) and the
  order of `RETURN_NAMES` (links are stored by output index).
- Node ids in `NODE_CLASS_MAPPINGS`.
- The four widget names and the JSON inside them:

| Widget | Module | Version field | Top-level keys |
| --- | --- | --- | --- |
| `gd_timeline` | `gd_schema.py` / `web/gd_doc.js` | `schema_version` (8) | `family`, `clip`, `source`, `anchors`, `subjects`, `videos`, `audio`, `prompt`, `mask`, `view`, `derived`, `uid` |
| `gd_post` | `gd_post.py` / `web/gd_post_doc.js` | `version` (3) | `preview`, `save`, `face` |
| `gd_presets` | `gd_presets.py` / `web/gd_presets_doc.js` | `version` (2) | `active`, `presets[]` (`id`, `name`, `note`, `takes`, `params`, `history`), `settings` |
| `gd_takes` | `gd_takes.py` / `web/gd_takes_doc.js` | `version` (2) | `takes[]`, `picks`, `composite`, `refine` |

  `derived` is recomputed by every `normalize` and is never trusted as input: `problems` normalizes
  whatever it is given. Unknown keys survive `normalize`, at the top level (that is how `uid` gets
  through Python) and inside `clip`, `source`, `prompt`, `mask` and `view`.

  `uid` is written by the panel: when it is opened, when it commits the document and when it queues takes
  (`gd_editor.js` `ensureUid`, `commitDoc`). The results page keeps a history entry when its node id is
  this node's and, if both documents carry a uid, the uids are equal. That is as far as the isolation
  goes: a document that was run with ComfyUI's own button before the panel was ever opened has no uid
  and is matched on the node id alone, and a copied node or a copied workflow keeps the uid of the
  original. So a run of a document with another uid is left out, and a run that cannot be told apart by
  uid (none on one side, or a copy) is listed and marked stale when its content differs.

  The run tracker in `gd_editor.js` applies the same rule to what is running, for the live preview and
  for the timing a preset records. ComfyUI sends a prompt's start and end events only to the client that
  queued it, and none at all for a prompt queued without a client id (only `execution_interrupted` is
  broadcast), while the preview event is
  broadcast and does not say which prompt it belongs to. The tracker follows one run at a time, from
  the moment it knows the run has started to the run's end event, and only a run whose end event is
  certain to come here:

  | Kind | How it got queued | Whose it is |
  | --- | --- | --- |
  | queued here | the takes page (`state.queuedRun`) | this clip's, nothing to ask |
  | announced | this browser, some other way: ComfyUI's own Run button, another workflow tab | `askOwner` reads the prompt from `/queue`, or from `/history` when the run is already over; the answer is a promise in `state.verdict` |
  | picked up late | this page, before it was reloaded or before the workflow tab was left and come back to: the editor is new and saw no start event | a `progress` event names the prompt (`onProgress`); `askLate` follows it when `/queue` lists it as running, queued by this page's client id, and `verdictOf` calls it this clip's (the same test as for an announced run). Previews that arrive after the answer are shown; not timed |
  | not followed | another client: another browser, or the API without this page's client id. No start event arrives, and no end event is certain to | not shown, not timed |

  The invariants, each of which was once a bug: no picture of an announced run is shown and it is not timed
  until the answer is in (`state.held` keeps the newest preview back); a run found not to be this clip's
  is taken out of `state.running`, which is what the takes page's "rendering" box and its interrupt
  button go by (`rendering` in `pageHost`), so that box is not up for another clip's run (a run picked up late is not in `state.running`: its box
  comes with its first preview); an empty queue means "over", not
  "mine", and an HTTP error is not an empty queue; a prompt found in neither the queue nor the history is
  nobody's ("unknown": not shown, not timed); the takes and the results page are refreshed on
  success without waiting for any answer; only the end of the run being followed clears its preview
  (`endOf`); a node ComfyUI dropped changes nothing through the tracker, even from an answer that arrives late
  (`attached`); when the connection to the server comes back, every run is forgotten and the takes are
  asked what became of them (`onReconnected`: after a crash no end event comes, and the takes page went
  on saying "rendering" with the take at "running" until a reload, measured; a run that is in fact still
  going is then picked up late). For an announced run, when `/queue` cannot be read, or one of the two
  documents has no uid, the node id decides and the run is shown.

  Why a late pick-up needs the client id: ComfyUI sends `progress` to the client that queued the prompt,
  and to every client when nobody did (`main.py` `hijack_progress` passes a client id of `None`). A
  prompt of another client has no end event here, and a run followed without one would be followed
  for ever. The queue is asked once per prompt (`state.late`); the run's end event, or the start of
  another run, clears `state.late`, and an answer that arrives after that follows nothing. When the
  question cannot be answered (the queue unreadable, the client id not known yet), `state.late` is
  cleared and the next progress event asks again.

  An earlier version also tried to show previews of runs of other clients, by asking the queue on
  every preview it could not place and on every queue change. Each revision of it had new
  interleavings in which that showed another clip's frame or lost this clip's; it was removed. Nothing
  tells this page when such a run ends, so do not bring it back. `tests/tracker.mjs` runs these two sections on
  their own against a stand-in server whose answers the test releases by hand. Add the scenario first.

**Cuts and long takes.** Every shot but the first says how it follows the one before it:
`prompt.shots[].join` is `"cut"` (the default: another shot, a hard cut between the two) or
`"continuous"` (the same shot going on; the boundary is there so that the two stretches can be
described, timed and picked apart). A run of shots of which each but the first continues the one
before it is a *long take* (`gd_schema.long_takes`, `longTakes` in `web/gd_doc.js`). Three things
follow from the join, and all three have to keep agreeing:

- *The prompt.* `gd_compile._long_takes` gives the planner one segment per long take, at its first
  frame; `_one_paragraph` joins what its shots say, in order (narration runs on, a spoken line stays a
  line of its own, which is how the planner knows it). `[Shot N] At <time>` is therefore a cut and
  nothing else. The official format has no wording for a time inside a shot, so the order of events
  in a long take is the order of the text and their timing is the model's. A picture on the first or
  last frame of a shot in the middle of a long take is declared as a composition anchor at its time,
  not as the first or last frame of a `[Shot]` (`_records`).
- *The picks.* A pick is per shot of the document, long take or not. `splice_plan` carries the join
  into every piece; `seam_frames(plan)` are the joins inside a long take and `hard_cuts(plan)` the
  joins at a cut (`seamFrames`, `hardCuts` in `web/gd_takes_doc.js`); `plan_key` marks a continuing
  piece with `~`, so a composite made for other joins is not shown as current.
- *The join.* At a cut, two takes are put one after the other where each really cuts (`gd_cuts.plan`):
  with `a` the left take's real cut and `b` the right one's, the join is at a frame both allow when
  `b <= a` (the clip keeps its length) and the frames `a..b-1` are left out when `b > a` (they are
  another shot in both takes; the clip is that much shorter). Inside a long take the join is made at
  the frame asked for and what lies around it is sampled again. `gd_schema._free` keeps that inside the
  long take: of a seam's own range the latent frames that lie in it whole, under the old rule
  (`mask.radius`) the cells that do (what reaches past its ends holds a cut); `_free_cells` is the
  summary, the cells that hold any of it. At run time
  `GachaDirectorTimeMask` drops any cell that holds a frame next to a real cut (`keep`, the `guards` of
  `gd_cuts.plan`): where the takes really cut is known only once they have been read, and a cut that
  is rendered again lands somewhere else.

The sound has a join of its own: `prompt.shots[].sound`, `"cut"` (the default: at a cut the sound
changes take with the picture) or `"continuous"` (the sound that was playing before the cut goes on
across it; the picture changes take, the sound does not). It is stored as set and kept apart from
`join`, but it means something only at a picture cut: inside a long take the sound always goes on
with the picture, whatever the field says, and the panel shows the sound link closed and locked
there. It changes neither the prompt nor the generation, only whose sound each frame of the final
clip has: `gd_cuts.plan` returns that as `sound` (`[{file, start, end}]` on the final clip's own
frames, the carried take named in `joins[i]["voice"]`), `GachaDirectorCutSplice` assembles the audio
from it and fades only where the sound really changes take, and `plan_key` marks such a piece with
`^` so that a composite made with the other sound is not shown as current. Several carried cuts in
a row keep the sound of the take before the first of them. `layout_key` does not include it: takes
made before the setting changed are the same takes.

A seam (two takes meeting inside a long take) has a range of its own too: `prompt.shots[].seam`, on
the shot that goes on. Three values, and all three stay:

- `null` — no range of its own. `mask.radius` cells on either side of the seam's cell, the rule from
  before there were ranges. `normalize` never fills it in: a document saved then, and a composite
  made then, behave and are keyed as they were.
- `"auto"` — left to itself (`gd_grid.seam_auto`): from a little before the seam (the first frame of
  a latent frame, at least `SEAM_AUTO_FRAMES` before the end and `SEAM_AUTO_BEFORE` before the seam)
  to the end of the cell the seam is in; a seam on a cell's first frame frees only what is before
  it. That comes to 12, 16, 17 or 21 frames depending on where in its cell the seam is (13 on the last
  frames of a clip), and to fewer where the clip begins or where the long take
  cuts it off: "at least 12 frames" is what it aims at, not what it promises. It is worked out
  from where the seam is, so it follows a boundary that is moved. The panel gives it to every
  boundary it makes continuous (`DEFAULT_SEAM` in `web/gd_doc.js`).
- `[before, after]` — latent frames in front of the seam and from it on (`gd_grid.seam_latents`). A
  seam inside a latent frame has that latent frame as its own, freed whatever the numbers are, so
  `[0, 0]` is nothing at all for a seam on a line and one latent frame for one that is not: it is a
  range, never a switch. This is what dragging an end on the Generate page writes
  (`setSeamRange` in `web/gd_editor.js`, which turns two frames back into the two counts).

Whatever the value, a range ends where the seam's long take ends, a latent frame at a time
(`gd_schema._free`, `freeOf` in `web/gd_doc.js`). What comes of it is `derived.free_latents`, and
that is what the mask is made of; `derived.free_cells` is only the cells that hold any of them and
must not be turned back into a mask. Why the automatic range ends on a cell's first frame is a
measurement, not a taste (section 7, "A cell is not the smallest thing"; section 13).

On the page a seam is one entry of `joinPlan().ranges` (`seamRanges` in `web/gd_editor.js`): its own
range, cut off at its own long take even when another seam frees more beyond it, with the lines
either end may stand on (`leftLines`, `rightLines`: inside the long take, on the right side of the
seam's own latent frame, and no further out than `SEAM_MOST` latent frames, the most a range is
stored with). `paintSeams` in `web/gd_page_takes.js` draws them in the strip the timeline lends
under its picture (`timeline.below`: as wide as the canvas and scrolling with it, things placed by
share of its width). A drag writes nothing until the end is let go somewhere else than it was, a
cancelled drag puts the bar back, and the strip is not rebuilt while an end is held (the page is
drawn again on every event of a run). `compositeKey` is the old string while every seam of the plan
is `null`, and otherwise carries the mask itself: the runs of latent frames all the seams free
together (`#v2:lo-hi,...`). A range the long take cuts off anyway, one another seam covers, or a
radius no seam uses, does not make a composite stale.

Two ranges may lie over one another, even entirely. The bar under the pointer is on top; a bar
wholly under another never is, so every seam has a head on its line (`.gd-seam-at::before`) and
pressing it brings that seam's bar and readout to the front (`seamFront` in `paintSeams`; two seams
are never on one frame). The line itself lets the pointer through: it runs through the middle of a
handle that stands on the seam.

Beside a bar the page says how alike the two takes are there (`alikeAt` in `web/gd_editor.js`,
`POST /gachadirector/alike`, `gd_routes.alike`): the PSNR between them over the frames from eight
before the seam to eight after it, as many of those as both files have, on small pictures. Under
`SEAM_UNLIKE` (22 dB) the readout is red and the tooltip says the repair may fail. That number is
a hint between two measured pairs (section 13), not a calibrated limit; do not word it as one.

How much a frame differs from the one before it is measured on the structure of the picture, not
on its brightness (`gd_splice.frame_changes`): the pictures small and grey, each brought to zero mean
and its spread divided by `sqrt(spread^2 + FLAT^2)`, and half their mean squared difference. For
pictures with structure that is close to one minus their correlation (about 0 for the same picture,
about 1 for two unrelated ones); a black or flat frame is left near zero instead of being blown up,
so contrast is evened out rather than removed (the same picture at a spread of 0.01 and of 0.02
measures 0.03 against itself). Lightning or an explosion lighting up a shot changes brightness a great deal and structure
little. An earlier version compared brightness and took lightning for cuts between dark shots.

`gd_splice.real_cut(changes, stays, cuts, cut, total)` is the one place that finds a cut: the splice,
the route and the face tracker all ask it, with the frames at which the document asks for *cuts* (a
boundary inside a long take is not among them).

A real cut is the frame that differs from the one before it by at least `gd_cuts.CUT_RATIO` (5)
times the clip's median change, or by `gd_splice.CUT_SURE` (0.5) where that is less: a take that
moves hard from end to end has a usual change so large that five times it is what its cuts measure
(two chase takes at the standard preset: usual change 0.15 and 0.16, cuts 0.72 to 1.07, which
is 4.4 to 6.9 times; without the cap two of the six would not be looked at). It is
looked for no further than `CUT_REACH` frames from the frame asked and no further than half the way
to the next cut of the document (`gd_cuts.reach_of`), and confirmed by `gd_splice._stays`, which
asks four things of a frame, in this order:

1. The change is at least `CUT_LEAST` (0.05; cuts measure 0.28 and more). In a clip that hardly
   moves the usual change is next to nothing and everything is many times it: one picture fading in
   is no cut.
2. Of the eight frames before it, three in four are unlike what the eight after it mostly look like
   (their median), and the other way round (`STAY_FRAMES`, `STAY_SHARE`). Into a flash and out of it
   that holds on one side only.
3. The same of the eight frames beyond those, on either side, as far as they exist and lie no
   further than half the way to the cuts the document asks for on either side (`check(f, lo, hi)`;
   the callers pass `gd_cuts.reach_of(..., reach=total)`). After a burst of light of up to about
   half a second the picture is the old one again; after a cut it is not. The limit is what keeps a
   shot of six to thirteen frames that the document asks for (cut to, and cut back from to the same
   picture) from being passed over as a burst; the same frames with no cut asked there are passed
   over, which is intended.
4. The four frames before it and the four from it on, as two groups (`_apart`): what the groups look
   like on average is at least `APART` (2) times further apart than their frames wobble around
   those averages. Flickering light and a movement that goes on come to about 1 (measured: 1.0 for
   lightning ten frames before a soft cut, 2.7 for that cut; 1.1 for a wingbeat in a long take).

Where a window is short (the ends of a clip) the frames that exist are counted, three in four of
them. The largest change in the window that passes is the cut: the ratio alone separates nothing
(cuts measure 4.4 to 800 times the usual change, lightning up to 105). Lowering `CUT_RATIO` instead of
capping it was tried: at 3 a change in a long take is taken for a cut, at 2 two are. Of changes that pass and are
of one size (within `gd_cuts.CUT_TIE`, 15%, of the largest), the one nearest the frame asked for is
the cut: in a shot that moves fast the model now and then jumps inside the shot, and such a jump
measures what a cut measures (0.86 beside a cut of 0.83, 0.83 beside 0.82; the cuts 1 and 4 frames
from the frame asked, the jumps 7 and 17). A jump clearly larger than the cut of its window would
still be taken for it; none was seen.

What is known not to work: a hard cut between two frames with nothing in them (plain black to plain
white: neither has structure, and in a composite that also renders, the cell holding such a cut is
not held back); a shot of fewer than six frames; a burst of light that ends on the frames right
next to a cut may still move the cut found (it did not in 12 cuts of a thunderstorm). A cut that
is not found (a dissolve, a whip pan, two shots that look alike) is joined at
the frame asked for; the record says `no cut found`. `POST /gachadirector/cuts` (`gd_routes.real_cuts`)
answers the same question for the panel, which shows a take's shot from its real cut-in to its real
cut-out (`realRange` in `gd_editor.js`), and `gd_faces.real_cuts` for the face tracker.

A cell that is guarded, like every cell that is not free, is still encoded and decoded once by a render:
"kept" means not sampled again, not identical pixel for pixel.

What the panel knows of a take's real cuts (`cutsKnown` in `gd_editor.js`) is kept by file name, the cuts
asked about and the clip's length, for as long as the editor lives. It asks the server in batches of 64
files (what the route answers at once), asks again after half a minute about a file the server could
not read, and asks about everything again when "Refresh" is pressed on the Generate page
(`forgetCuts`), keeping the old answers in use until the new ones are in. Between two presses it does
not notice a file written again under the same name; the server's readers do (`gd_routes.real_cuts`
by size and time, `GachaDirectorCutSplice.IS_CHANGED` likewise, and the node itself: see `file_marks`
below). Take files carry a seed and a batch tag in their names, so this takes a file replaced by hand.

`realRange` gives a stretch of a long take the frames asked for, as far as they lie inside the long
take as the take really has it (from its cut-in to its cut-out). A stretch that a late cut leaves
nothing of is shown as one frame of its long take, never as frames of the shot before.

A composite can come out shorter than the document's `frame_count`. Everything after it has to ask how
long it is: `finalFrames()` in `gd_editor.js`, the node's `frame_count` output (the
`GachaDirectorDropFrames` count), and a face refine, which is queued for the clip's real length and runs
with its last frame held up to the next valid length (`short` in `GachaDirector.run`).

**Material.** Every subject, reference video, reference audio and anchor of a document has:

- `id`: `s1`, `v1`, `a1`, `k1`, ... (`gd_schema.ID_PREFIX`), unique across all four lists. `normalize`
  keeps every id it finds and gives material without one the lowest number that is free
  (`_assign_ids`; `freeId` in `gd_material.js`), so the id of something removed can come back on
  something new: nothing remembers retired numbers. Everything that refers to a piece of material uses its id: prompt
  text as `@{id}` (`MENTION_RE`), `audio[].subject` as a subject's id.
- `name`: what the panel shows and what the user types after `@`. Unique, without spaces and without
  the characters that would end a mention or read as part of the prompt's own marks (`clean_name`
  drops `@ { } < > [ ] ( )`, quotes, and sentence punctuation, Latin and full-width; `/ + - #` and
  the like stay); defaults to the file's stem. `voice` is not available as a name (it is the planner's
  `@voice(...)`). A rename changes nothing in the stored text.
- `shot`: the id of the shot it belongs to, or `""` for material every shot shares. Shot ids are unique;
  material of a shot that `normalize` drops moves to the last shot that is kept.

A mention (`@{id}`) may stand in the overall description, the summary, the ambient sound, the music, a
shot's text and a subject's description, and nowhere else. `eachText` in `web/gd_material.js` is the one
list of those fields in the panel (a rename, a change of use and a removal walk it), and `problems`
names a mention of something that no longer exists: `mention_gone` for a shot's text,
`mention_gone_global` for the overall description and the summary,
`mention_gone_other` for the ambient sound, the music and a subject's description. In a text box an id
is shown as `@name`. A name ends at the first character that cannot be part of one, so when the text
goes straight on with such a character the box shows `@{name}` instead; `readMentions` accepts both and
tries the longest name first, and `showMentions` then `readMentions` gives the stored text back exactly
(`tests/material.mjs`).

An anchor is placed by `shot` + `at` (`"first" | "last" | "offset"`) + `offset`; `frame` is derived, so an
anchor moves with its shot. An anchor given only a `frame` (older documents, and what `loosenAnchors`
leaves behind on purpose) is put into the shot that frame is in. What the model is told is worked out at
compile time and stored nowhere: `gd_compile.labels(doc)` gives every id its `<Subject N>` /
`<Picture N>` / `<Video N>` / `<Audio N>` (or `@refK`, which the planner turns into the subject label or
its description), `_resolve` puts them into the text, and `_unsaid` adds a sentence for material that
belongs to a shot whose text does not mention it (`AUTO_SUBJECT`, `AUTO_VIDEO`, `AUTO_AUDIO`). The
planner expands `@refK` in the overall description, the summary and the shots only, so the texts it
passes on untouched (a subject's description, the ambient sound, the music) go through `_final`, which
writes the final name itself. A line of a shot that begins with a mention of a sound and reads as
dialogue is handed to the planner as `@audioN` (`_AUDIO_SPEAKS`), the form its dialogue rule knows. The labels
are read off `_records`, the same list the planner's segments are built from, and `build_plan` checks
afterwards that the planner numbered the pictures in that order.

In the panel the translation between "a picture of shot 2 used as its first frame" and those records is
`web/gd_material.js` (pure, tested by `tests/material.mjs`): `useOf` / `setUse` (a change of use may move
an item from `subjects` to `anchors`; its id changes and every mention is rewritten), `addImage` /
`addVideo` / `addAudio`, `removeMaterial` (mentions become plain words), `showMentions` / `readMentions`
(ids to names for a text box and back), `loosenAnchors` + `rehome` (what a cut inserted or removed has
to call so that anchors stay on their frames and material follows the merged shot), `clipMode` /
`shotMode` (the read-only "text to video", "first / last frame", ... tags) and `budget`.

**Between the panel and the server.**

- `picks` in the takes store is keyed by **shot index** as a string. `gd_editor.js` `shiftPicks` renumbers
  them when a cut is inserted or deleted; any new way of adding or removing a shot has to call it, and
  `loosenAnchors` (and `rehome` for a merge) with it.
- A key typed into a field of the panel is stopped at the window, on its way down, so that ComfyUI never
  sees it (`onKey` in `gd_modal.js`). That keeps it from the field's own `keydown` listeners too. A field
  that needs its keys listens for `gd-key` instead: a `CustomEvent` whose `detail` is the key event
  (the list of names under a prompt box does, for arrows, Enter and Escape).
- A file name may end in ` [output]` or ` [temp]` (ComfyUI's own annotation). `gd_frames.resolve`,
  `gd_routes.probe`, core's `LoadImage` / `LoadAudio` and the panel's `viewUrlFor` all understand it. That is
  how a rendered clip is used as material.
- Save prefixes: a take is saved as `<prefix>_take_<seed>_<batch>`, a composite as
  `<prefix>_composite_<seed>`, a face refine as `<prefix>_refine_<seed>`. `web/gd_page_results.js`
  `runKind` tells the kind of a run from that, by looking for `_take_`, `_composite_` and `_refine_`
  in the saved file's name: a plain run saved under a prefix of the user's that holds one of those
  is taken for that kind (and one taken for a refine is never marked out of date). A composite whose document frees no cell
  (`normalize(doc).derived.free_cells` empty, the same test as the node's `cut_only`) is labeled
  "cut together" there and shows no megapixels, steps or seed: that run rendered nothing. `<batch>` is a few characters that differ from one press
  of Generate to the next: without it a take that repeats an earlier one exactly is served from
  ComfyUI's cache, the nodes of the expansion report no output, and the take ends "file missing".
- `take.frames` is the clip length the take was rendered at; a take of another length cannot be picked.
  Nothing else invalidates a take: one rendered with an earlier prompt stays pickable, by intent.
  `take.layout` is how the clip was divided into shots at that time (`layout_key(shots)` in
  `gd_takes.py`, `layoutKey` in `web/gd_takes_doc.js`: the frame each shot starts at, `~` after one
  that continues the shot before, e.g. `0,61,122,183~`). A take whose layout differs from the
  current one stays pickable; the Generate page marks it and says how many there are, because the
  cuts in a take lie where the shots were when it was rendered. `""` (a take from before this was
  recorded) is not judged.
  `composite.key` is `compositeKey(doc, plan)` in `gd_editor.js`: the picks, the seam strength and
  what the seams free (the radius while every seam follows the old rule, the freed latent frames
  otherwise). A composite whose key differs from the current one is not shown as the final clip.
  `refine.of` is the file a face refine was made from and `refine.key` is `refineKey(file, face)`: that
  file, every face setting, and what else the result depends on (the model family, where the shots
  start and which of them go on from the one before, the chosen subject's pictures and description,
  the active preset's `paramsSignature`).
  `madeFile(doc)` is the composite with the current key, and nothing else: the file the monitor of
  the Generate page plays as the final clip and the Output page lists. One take picked for every
  shot is not a made file by itself; joining it (the same button, the same `queueComposite`) puts
  the take out as a file of its own without a render. `finalFile(doc)` is what the steps after
  joining work on: the made file, and while there is none, the one take every shot picked (a face
  refine made of that take in a workflow from before the button existed stays valid). A refine of
  anything else is "from another clip" on the Post page.
- A size is not stored. The clip holds an aspect ratio (`clip.aspect`, any `W:H`) and the preset a pixel
  budget (`megapixels`); `canvas_size` makes the width and height from the two, on a grid of 32. A size
  typed on the Project page (`ownSize`, `sizeAsRatioAndBudget` in `web/gd_page_run.js`) is turned into
  the ratio and the three-decimal budget that land on exactly that size, and both are written: the
  ratio into the document, the budget into the active preset. Every size from 256 to 2048 px a side
  on the grid was checked to come back exactly, in the browser and through `gd_grid.canvas_size` (3249
  sizes). The bounds are the preset's own (4 megapixels is 2048 x 2048) and a floor of 256.
- The size of the take cards on the Generate page is kept in the browser and not in the workflow,
  like the panel's language: `localStorage` `gachadirector.cardSizes`, a map from a pool (a shot's index)
  to a card width, whose lowest value is the list. Every shot's pool has its own slider.
- The Generate page has no list of whole takes. What applies to a take as a whole (use it for every
  shot, delete it) sits under each shot's player and acts on the take that player shows; a clip of one
  shot gets the same block as a shot of many, without the navigator.
- `joinPlan()` in `gd_editor.js` says what joining the picks, as they are now, comes to: the `cuts`
  and the `seams`, the `dead` seams (inside a long take too short to hold a free cell), whether
  anything `renders`, and per shot how many frames stay the picked take's (`kept`, also
  `keptOfShots()`). It normalizes the very document `queueComposite` would send (`compositeDoc`) and
  reads its `free_cells`, so the pages and the run cannot disagree, except for what only the run knows:
  a cell dropped at run time because a take really cuts inside it. A seam left to itself redoes 12
  to 21 frames; one that follows the old rule redoes two cells (34 frames) on a cell boundary and
  three (51) inside a cell, and a range dragged wide as much as it was given. A short stretch of a
  long take between two seams can so be redone entirely; its pick then has no say, which the pages
  mark.
- A job that was cancelled while it waited in the queue never starts and never ends, so no event names
  it. `onQueueChanged` in `gd_editor.js` listens to ComfyUI's `status` event (the queue's length changed)
  and, when a take, a composite or a refine of this node is still marked queued, asks again a moment
  later; `refreshTakes` then finds it gone.
- Routes: `POST /gachadirector/cuts` with `{files, cuts, total}` -> `{ok, real: {file: [frame]}}`, where each
  of a list of rendered files really cuts near the frames a cut was asked for (measured once a file,
  kept by path, size and modification time);
  `GET /gachadirector/media` -> `{ok, images, videos, audio, renders, generated, root}` (every file
  of `input/`; `generated`: the newest files of `output/` by kind, 1000 pictures, 400 videos, 400
  sounds, takes and composites included; `renders` is its videos);
  `POST /gachadirector/plan` with `{doc, params}` -> `{ok, prompt, tasks, warnings, problems, canvas}`.
- `gd_schema.PROBLEM_TEXT` codes. `problems_coded` returns `[code, [args]]`; the panel words them through
  the i18n rows `problem.<code>`, whose `%1`, `%2` are the arguments in order. `tests/parity.mjs` fails
  when a code has no row.
- The node's UI output: `{"gd_report": [text], "gd_prompt": [text]}`, stored by ComfyUI in history under the
  node's id. The results page reads it there.
- The preview event name `minimax_h3_preview` and its payload come from `vendor/minimax_preview.py`.
- What three of the node's outputs really are: `source_frames` is the starting clip (source or splice)
  and, when the run started from noise, the generated frames; `model` is the model after the sigma shift
  and without the preview wrapper; `positive` is the conditioning before the memory hand-off node.

**Sockets of core nodes.** `MiniMaxH3ReferenceToVideo` takes its references through autogrow inputs whose
names contain a dot: `ref_images.ref_image_0`, `ref_videos.ref_video_0`, `ref_video_audios.ref_video_audio_0`,
`ref_audios.ref_audio_0`. The index in the name is the number the prompt uses minus one, so the order
`gd_h3.emit` wires them in must be the order the planner numbered them in. `tests/test_expand.py` checks it.

**Name in the panel -> name in the code** (the panel text is in `web/gd_i18n.js`):

| Panel (English) | Code |
| --- | --- |
| Project / Edit / Generate / Post / Output (pages) | `run` / `edit` / `takes` / `post` / `results` |
| Reference model / Base model | `family: "reference"` / `"base"` |
| Clip | the document; `clip.length`, `clip.aspect` |
| Resolution (a width and a height) | the preset's `megapixels`; `SIZES` in `web/gd_page_run.js` are the values on offer |
| Resolution · custom… | `clip.aspect` and the preset's `megapixels` together (`sizeAsRatioAndBudget`) |
| Shot | `prompt.shots[]` (older code and i18n keys say "segment") |
| Shared material | material whose `shot` is `""`; the overall description is `prompt.global` |
| A picture's use: who or what is in it | `subjects[]` |
| ... the first / the last frame / a frame in between | `anchors[]`, `kind: "image"`, `pin` and `cite`, `at: "first" / "last" / "offset"` |
| ... a storyboard | the same with `role: "storyboard"`, `pin: false` |
| A video's use: movement and camera / carry on from it | `videos[]` / `anchors[]` with `kind: "clip"` |
| A sound's use: somebody's voice / a sound to follow / played as it is | `audio[]` with a `subject` / without one / `anchors[]` with `kind: "audio"` |
| Hold the frame to this picture / Tell the model what this picture is | an anchor's `pin` / `cite` (under a picture's More, reference model) |
| How closely it is kept | `retention` |
| Source video · What it is used for | `source.as_reference` + `source.role`; "not shown to the model" is `as_reference: false` |
| Repaint over the original · how much to change | `source.as_latent`, `source.denoise` |
| Redo only part | `mask.mode`, `mask.cells` |
| Cell | `derived.cells`, `gd_grid.cell_bounds` |
| Take, pick, final clip, join | `gd_takes` store: `takes[]`, `picks`, `composite` |
| The picture link between two shot cards: open = a cut (montage), closed = continuous (a long take) | `prompt.shots[].join`: `"cut"` / `"continuous"` |
| The sound link beside it: open = the sound switches with the picture, closed = carried on across the cut | `prompt.shots[].sound`: `"cut"` / `"continuous"` |
| Cut together (the button when every join is a cut) / Join | the same `queueComposite`; `joinPlan().renders` says which |
| The bar under the Generate page's timeline (what is regenerated around a seam) · "auto" | `prompt.shots[].seam`: `[before, after]` in latent frames · `"auto"` · `null` (the old rule, `mask.radius` cells) |
| Seam strength | `mask.seam_denoise` |
| Face refine · How much is redone | `gd_post` `face` · `face.strength` (the share of noise, not a denoise) |
| Draft / Standard / Final | preset ids `draft` / `standard` / `final`; the names are data, not i18n |

**Units.** Every frame number counts 24 fps frames, 0-based. An anchor's `frame` is derived from its shot;
in a document of an older version `frame == -1` meant the last frame, and is still read that way.
Sources at another rate are conformed by `gd_frames.load_frames` (nearest frame in time, no blending).
`megapixels` uses 1 MP = 1024 x 1024 pixels, the same as core's `ResolutionSelector`.

## 6. Module guide

- **`gd_grid.py`** — frame counts (17k+5), latent lengths, cells, canvas sizes. Pure. `cell_bounds` and
  `cell_latent` define the cells; `seam_cells` picks the cells around cut frames; `canvas_size` mirrors
  core's megapixel arithmetic.
- **`gd_schema.py`** — the clip document. `empty`, `migrate` (older documents), `normalize` (complete and
  clamp; idempotent; hands out ids and names, see "Material" in section 5), `material(doc)` (every piece
  by id), `problems_coded` (what cannot run, as codes) and `problems` (the same as English
  sentences, used in the node's validation error), `latent_source` (`"empty" | "source" | "splice"`),
  `reference_source`, `resolved_frame`. Pure.
- **`gd_compile.py`** — adapter between the document and the vendored planner. `labels`, `_records`,
  `shot_texts` turn ids into what the model reads and add the sentences nobody typed (section 5).
  `to_timeline` builds the planner's input; `build_plan` runs it, and in the reference family runs it a second time with the task
  type derived by `_task_types` when the references add up to one. It raises when fewer references would
  be sent than were listed, and when a soundtrack is switched on for a file the probe read and found
  silent (a file the probe could not read is not checked here; it fails in the loader node).
  `ref_images`, `ref_videos`, `ref_audio`, `keyframe_files`, `guides` are the loading plan `gd_h3.emit`
  follows. `canvas` resolves the output size.
  In the base family nothing but a subject has a name in the prompt, and the model can be shown the
  first and the last frame of the clip only: a picture that asks to be shown anywhere else is held at
  its frame by a guide and not declared (`_records`, `guides`).
  The planner does more than join fields: it turns `@refN` into `<Subject N>` (numbering only subjects
  that have images; a subject with only a description is written out in place), skips shots without text
  and numbers the rest, and lifts dialogue out of a shot's text. A spoken line is a line of its own that
  starts with `@refN`, `@voice(<a described voice>)` or `@audioN`, then how it is said, a colon and the
  words (`DIALOGUE_RE`); an optional `[Language]` follows the tag. It is written back in the guide's form,
  `<who> (S1) says, <d>[English] the words</d>`, with one `(Sx)` per speaker across shots. A line that
  reads as dialogue but has no colon stays narration and gets a warning. The shots section of the Edit
  page says this in the tooltip of its heading (`edit.shotsDialogue`). Rendered and checked with a speech recogniser: the
  words came out as written. It reads the first nine subjects only, with or without
  images: a tenth `@ref10` would stay in the prompt as written, so `problems` refuses a tenth subject
  (`MAX_SUBJECTS`). A reference video is read to the clip's length and sent for at most 15 seconds
  (360 frames), the source clip included. Only a clip longer than that can be cut short by it, and then
  each video that is gets a line in `ref_warnings`; a long file in a short clip is simply read to the
  clip's length. Read `vendor/minimax_plan.py` before promising what a prompt
  will contain.
- **`gd_h3.py`** — `emit(g, doc, plan, ...)` returns `(positive, empty_av_latent)`. `track` loads and trims a
  soundtrack. `ref_video_size` bounds a reference video's decode size.
- **`gd_director.py`** — the node. `WIDGET_ORDER`, `INPUT_TYPES`, `IS_CHANGED` (hash of the document, the
  output settings, the **active** preset's params only, and `file_marks`: every file the document and
  the output settings name, with its modification time and size), `VALIDATE_INPUTS`, `run`.
- **`gd_internal.py`** — `GachaDirectorTimeMask`, `GachaDirectorFreeMemory`, `should_stage`.
- **`gd_frames.py`** — `resolve`, `load_frames`, `GachaDirectorLoadFrames`. `resolve` refuses a name that
  leads out of the folder it is looked for in (`..`, an absolute path, another drive): every loader of
  the package and the routes that read files go through it, so a document or a request cannot point
  them at any file of the machine. A folder inside `input/` or `output/` is fine.
- **`gd_presets.py`** — presets and their timing history. `params_signature` identifies a parameter set; with
  `settings.auto_reset_on_change` (default on) `normalize` drops timings whose signature no longer matches.
  `timing_for(preset, frames)` averages over the runs recorded at that clip length, together with any
  recorded without a length.
- **`gd_post.py`** — output settings and the settings of face refine. `SAVE_CODECS` lists only what core's
  `SaveVideo` can write. `denoise_for(noise, shift)` turns "start from this share of noise" into the
  denoise that gives it at a schedule shift.
- **`gd_faces.py`** — face refine without the sampling. `detect` (YuNet through kornia, which ComfyUI
  requires; frames go in with the channels in BGR order, see section 7), `main_track` (pure: the face
  that is in a shot longest, never followed across a cut, a square region per frame that is not rounded
  to whole pixels), `crop_regions` / `paste_regions` (a pair of resamplings that undo each other), and
  the three nodes. What `main_track` decides, and the constants behind it:
  - *Which face.* `_main_face` strings sightings into tracks and takes the one with the most sightings.
    A track that begins after the main one ended (the head turned away and came back) is joined to it
    when it is about where the main one was and about as large.
  - *Which shots.* A shot needs its face in `MIN_SHARE` of its frames. Left to itself, the tracker then
    takes the shots whose face (the median of the longer side of its box) is within `FACE_PX`, 24 to
    80 px; shots named by the user (`only`, from `face.shots`) are taken whatever the size. Every shot
    comes back as `{start, end, ok, why, face}` with `why` one of `""`, `"none"`, `"small"`, `"large"`,
    `"skipped"`.
  - *Which frames.* `weight` is how much of the generated region a frame takes back: 1 while the face
    is seen, also across a gap of up to `BRIDGE` frames between two sightings; over a longer gap the
    face was away, and the weight falls to 0 within `EDGE` frames on either side. `paste_regions`
    multiplies its feathered mask by it, so a head turned from the camera keeps the pixels it had.
  - The cut-out is never smaller than a fifth of the frame's short edge (`min_share`): a face of a
    dozen pixels cut out on its own is a smear with nothing around it to say what it is.
- **`gd_cuts.py`** — where a rendered clip really cuts and how picks from several takes are cut
  together. Pure: `find_cut`, `window`, `plan` (the takes of every frame of the full-length clip, the
  frames to leave out, where the shots start in what is left, the frames a render must not free),
  `describe`. `tests/test_cuts.py`.
- **`gd_splice.py`** — the two nodes around it, and what they need of frames and sound:
  `frame_changes`, `_stays`, `real_cut`, `read_audio` (PyAV), `at_rate`, `cut_audio`, `fade_ends` (four
  milliseconds either side of a join, so that it does not click). `tests/test_splice.py` runs them on
  made-up takes.
- **`gd_takes.py`** — the takes store as pure functions. Python does not use it at run time; it is the
  specification the JS mirror is checked against. `splice_plan(store, shots)` gives one piece
  `{file, start, length, take}` per shot from the picks (it refuses a shot without a pick, a take that is
  not done, and a take rendered at another clip length; a take with `frames == 0`, from before the
  length was recorded, is not checked). `single_take(plan)` is non-empty when every shot picked the same
  take: joining such a plan renders nothing and joins no two files (where that one take's shots begin
  is still looked up, `cut_of`, for the starts and the guards). `cut_frames(plan)` are the starts of the
  pieces whose take differs from the one before; `seam_frames` and `hard_cuts` divide them by the
  join. The store only knows what was recorded: a file deleted
  from `output/` is still "done".
- **`gd_routes.py`** — the four routes (`media`, `plan`, `cuts`, `alike`); `real_cuts(name, asked, total)`; `probe(name)` (frames, fps, size, `frames24`, `audio`), cached by path
  and modification time.
- **`gd_preview.py`** — registers the vendored preview under this package's node id.
- **`web/gd_director.js`** — the only file that imports from ComfyUI. Custom widgets (`GDGROUP`,
  `GDPRESET`, `GDMETRICS`), hiding of the storage widgets, the `host` object the editor works through.
- **`web/gd_editor.js`** — reads and writes of the four stores, preset actions, takes actions, the run
  tracker (`onStart`, `onProgress`, `onExecuting`, `onSuccess`, `onError`, `onReconnected`, `onPreview`; section 5 says how it tells whose
  run is whose), `pageHost` (what a page may call).
- **`web/gd_page_run.js`, `gd_page_edit.js`, `gd_page_takes.js`, `gd_page_post.js`, `gd_page_results.js`**
  — one page each (Project, Edit, Generate, Post, Output). A page re-renders from the stores; it keeps
  no copy of them. The host renders the showing page again on every event of a run, so the Edit page
  rebuilds its cards only when what they are built from has changed (`cardsKey`): a rebuild throws away
  what is being typed.
- **`web/gd_material.js`** — material as the panel shows it (section 5). Pure.
- **`web/gd_timeline.js`, `gd_filmstrip.js`, `gd_player.js`** — the canvas timeline, client-side thumbnails,
  the frame-accurate player (`offset` maps clip frame 0 to `source.start` in the file).
- **`web/gd_sequence.js`** — the picks played one after the other, without a render: the preview at the
  top of the Generate page. `load(parts)` takes `[{url, from, length, label}]`, a part without a url
  being a gap (a shot nothing is picked for). Every file has a video element of its own; the part
  playing shows its element and the next part's element is brought to its first frame beforehand,
  so a change of take is a change of which element is shown. A part is left a few milliseconds
  before the file's next frame is due (`EARLY_S`): that frame is another shot's. The same parts
  loaded again change nothing, so the page calls `load` every time it is drawn. The page builds
  the parts in `paintMonitor` (`web/gd_page_takes.js`): the final clip when `madeFile()` has one (a
  clip that was joined; `finalFile()` also answers with the one take every shot picked, which the
  monitor plays shot by shot like any other picks),
  else per shot the frames `realRange` gives for the picked take; `clipFrameOf` / `monitorFrameOf`
  map between the preview's frames and the clip's, shot by shot, which is how the preview and the
  timeline under it follow one another. It does not use `gd_cuts.plan`: where the right take cuts
  earlier than the left one (`b < a`), the preview plays the frames in between from both and is
  that many frames longer than the clip cut together will be. It is heard when the panel's sound
  switch is on (`sound` in `gd_player.js`: one switch for every player, off until the user turns it
  on, kept in the browser's storage; the clips of the Output page, which play with the browser's own
  controls, are muted or not by it as well). Each part plays the sound of its own take, so a sound link
  that carries one take's sound across a cut cannot be heard in it.
- **`web/gd_doc.js` and the three `*_doc.js`** — mirrors of the Python modules, held equal by the parity
  check. `gd_doc.js` also holds the helpers that reproduce Python's `int()`, `float()`, `str()`, truthiness
  and rounding; the other mirrors import them.
- **`web/gd_i18n.js`** — one table, `"key": ["ja", "zh", "en"]`.

## 7. ComfyUI and model behaviour that will surprise you

Measured with ComfyUI 0.39.0 and its bundled frontend unless stated otherwise.

**The model**

- **Time cells.** The video VAE encodes 17 frames at a time from frame 0, each block on its own; the
  leftover 5 frames are the *last* block. 124 frames are seven cells of 17 and one of 5; in the latent that
  is five frames per full cell and two for the last. `tests/measure_vae_cells.py` measures it. An earlier
  version of this project had the short cell first, which put every boundary 5 frames off.
- **A cell is not the smallest thing a mask can free: a latent frame is.** A cell's five latent frames
  are its first frame alone and then four times four frames (`gd_grid.latent_bounds`), the model's
  patches are one latent frame deep, and the sampler pins or frees each by itself. What a cell is, is
  the unit of the *encoder*: blocks are encoded on their own, and inside a block causally, so a latent
  frame leans on the frames of its cell before it and on nothing after. The *decoder* knows no such
  wall: it reads seven latent frames at a time (a cell and two of the next), with attention across all
  of them, and blends five frames between windows. Two things follow, both measured (section 13). A kept frame near a freed latent frame never comes back as the very same picture (about
  38 dB between two such runs), which does not show. And where a freed stretch *ends inside a cell*, the
  kept latent frames after it in that cell were encoded leaning on frames that have since been
  replaced: the one or two frames after the stretch come out 3.5 to 5 dB further from the take. A
  stretch that ends where a cell begins costs under 1 dB there; where it *begins* makes no difference.
  "Kept" means "not generated again", not "the same pixels" (the comment at the top of `gd_grid.py`
  used to promise more than was measured).
- **A noise mask is resampled evenly onto the latent, and the latent's time axis is not even.** A mask with
  one image per pixel frame leaks into the neighbouring cell (its nearest latent frame comes out about half
  free). `GachaDirectorTimeMask` therefore builds one image per *latent* frame. `tests/test_expand.py` runs the
  mask through core's `comfy.utils.reshape_mask` and requires exact zeros and ones.
- **A mask on the packed audio+video latent only reaches the video.** Each stream gets its own mask before
  `LTXVConcatAVLatent`. Concatenating an audio latent onto an AV latent fits the audio to length and
  resamples its mask to the track's own length first, so the audio mask is built at that length
  (`audio_latent` input of the mask node).
- **`denoise` is bent by the schedule shift.** With shift `s`, the built-in scheduler starts at a noise level
  of `s*d / (1 + (s-1)*d)`. At the default shift of 12, denoise 0.85 is 98.6 % noise and 0.3 is 84 %.
  Measured on the base model: 0.7 gives a different video, 0.3 keeps layout and motion, 0.15 is nearly the
  source. The panel shows the percentage next to the number. When the node's `sigmas` input is wired, its
  own scheduler is not built at all: steps, scheduler and both denoise settings (source and seam) have no
  effect and that percentage does not describe the run. The run report names what was sampled with
  ("external sigmas (N steps)", "external sampler"), and the Run page shows a note when either input is
  wired (`externalWired` in `web/gd_director.js`).
- **Editing fidelity comes from the reference, not from the latent.** With the source clip only as
  `<Video 1>` and a start from pure noise, layout, motion and camera follow the source. Adding the clip to
  the latent at denoise 0.85 gave the same render. Hence `source.as_latent` defaults to off.
- **The same seed does not reproduce.** The official template run twice gave 19-20 dB PSNR between the two
  results. Equivalence with the official templates is therefore asserted structurally (`test_expand.py`),
  not by comparing pixels. Never write a test that compares rendered frames.
- **Reference videos are cut to the target's length by core.** `gd_compile.to_timeline` gives the planner
  the same length, and soundtracks are trimmed to it.
- **The reference prompt has to say what transfers.** A motion reference written loosely reproduces the
  reference video. The wording that works is the reference guide's: the subject "whose motion comes from
  `<Video 1>`", retention `attribute_transfer`, and a scene of its own. The "Motion reference" recipe in
  `gd_page_edit.js` writes it.

**ComfyUI**

- **`VALIDATE_INPUTS` only sees widget constants,** never linked inputs. Checks that need a model or a file
  on disk happen in `run`.
- **`IS_CHANGED` must return a hash.** A boolean compares equal run after run. The timing history lives in
  the preset store and grows after every run, which is why only the active preset's params are hashed.
- **A node whose result is kept is not expanded again.** The nodes of the expansion that look at their
  files (`IS_CHANGED` of the loaders, of `GachaDirectorCutSplice`) are then never built, so they cannot
  notice a file written again under its name. The node's own `IS_CHANGED` has to carry the files
  (`gd_director.file_marks`); the panel moves the seed on after every run, which hides the difference
  there, but a run queued with the same seed from the canvas or the API would get the old clip.
- **A node may return `ui` and `expand` together.** That is how the run report reaches history.
- **Nodes of an expansion report under ids prefixed with the parent's** (`7.0.0.28` for node 7), and the
  frontend's `executing` event carries the *display* node, i.e. the parent. `isMine` in `gd_editor.js` relies
  on both. Another `SaveVideo` in the same graph is told apart by that prefix.
- **A node inside a subgraph runs under another id:** `<subgraph node id>:<node id>` (`32:10`; its
  expansion `32:10.0.0.3`). The prompt, the `executing` and preview events and history all use it. The
  panel therefore never uses `node.id` for anything the server names: `host.nodeId()` is `execId(node)`
  in `gd_director.js`, which walks from the root graph to the node's graph.
- **"Convert to subgraph" drops the node without `onRemoved`** and builds a new one inside the subgraph.
  The dropped node's editor would keep listening to the server under the old id, and it shares the new
  node's widget values (measured: it marked the new node's finished takes "missing"). `makeHost` hands the
  editor a bus that delivers events only while `node.graph` is set, `host.attached()` lets a late answer
  check the same, and `queueWithOverrides` refuses a node without a graph (its id may by then be another
  node's). The dropped node's listeners are never removed; they do nothing.
- **ComfyUI notices a changed workflow on mouse and key events only** (its change tracker looks on
  `mouseup`, `keyup` and a few canvas hooks). The panel also writes widget values at other times: when a
  queue call returns, when a run starts or ends, when the seed moves on after a batch. Until the next
  click ComfyUI's draft of the workflow, which is what a reload restores, does not have them (measured:
  a queued take gone from the list after a reload, the seed back where it was, and the next take a
  repeat of the last). `noteChange` in `gd_director.js` asks the tracker to look after every write that goes
  through `writeJson` or `setWidget` and changes a value, a quarter of a second after the last one: a drag writes on every move,
  and each look that finds a change is a step in ComfyUI's own undo history (and, with ComfyUI's
  auto-queue set to "change", queues a run, as any widget change does). It reaches the tracker through
  `app.extensionManager.workflow.activeWorkflow.changeTracker` (`captureCanvasState`, or `checkState`
  on an older frontend); on a frontend that has neither, nothing breaks and the old behaviour is back.
- **Changing workflow tabs, or reloading the page, makes new nodes and new editors.** A page keeps its
  client id over a reload, so the events of a run it queued before still arrive; the editor that
  receives them never saw the start. See "picked up late" in section 5.
- **ComfyUI interleaves nodes.** Measured order of `executing` for one take: the director node, the two
  preview nodes wired after it, the director node again (its expansion), then null. Timing therefore adds
  up stretches (`state.span`), never last minus first.
- **`execution_start` can arrive before the queue request returns** when the server is idle. Code that adds
  a record after queueing has to check `state.running` for the prompt id.
- **Never write a store back from a copy taken before an `await`.** A take can finish, be picked or be
  deleted during the wait. Every takes action re-reads the store after waiting.
- **The workflow saved inside an output file is whatever was serialized.** `queueWithOverrides` puts its
  overrides into the widgets before `graphToPrompt()` so that prompt and saved workflow agree, and puts
  the old values back afterwards — but only into a widget that still holds the override, so a write that
  landed during the wait stands.
- **A time mask does not make a run cheaper.** The model still computes the whole clip and reads every
  shot's prompt; the mask only decides which latent frames may change. `derived.live_shot_indices` is for
  display.
- **Model patches are applied upstream of the node** and need nothing from it: LoRA, the Fun ControlNet
  patch, attention patches. A patch that converts a percentage to a sigma at patch time does so before this
  node's `MiniMaxH3SigmaShift`, i.e. against the model's default shift.
- **`SaveVideo` accepts fewer codecs than a video tool would suggest.** See `gd_post.SAVE_CODECS`.
- **An animated image loads as a batch of frames.** The media listing leaves `.gif` out; an animated
  WebP or PNG is not detected and fails in the guide node.

**Face detection**

- **YuNet wants BGR.** Fed RGB it still finds a large, clear face, but it misses small ones and sees faces
  in rocks and clouds. Measured on this package's own renders (672 x 384, a 14 px face in a wide shot):
  0.9 in BGR and not found in RGB, where a rock face scored 0.7.
- **What it mistakes for a face is seen in a fifth to a third of a shot's frames; a real face, even a
  dozen pixels of one, in most of them.** Hence `MIN_SHARE = 0.4`, and hence the main face of a shot is
  the one with the most sightings (`_main_face`), not the largest: one false sighting of a rock is a
  hundred pixels, and took the shot away from the person in it. A creature's face is a face to it.
  The Post page lets the user say which shots to refine for the cases this still gets wrong.
- kornia downloads YuNet's weights (about 400 kB) into torch's hub cache the first time `detect` runs.
- **A face refine helps faces of a few dozen pixels and no others.** Measured at 85% starting noise: a
  face of 14 px gained nothing and the clothes in the region changed colour; a face of 38 px got clear
  eyes, nose and mouth with the hair, the turn of the head and the light as they were; a face of 160 px
  came back as another, more realistic face. `FACE_PX` sits between those three points; its two ends
  were not measured themselves.

**Starting noise on this model**

- **Below about 70% a second pass gives the picture back.** The schedule shift bends the scale: the
  share of noise a run starts from is `s*d / (1 + (s-1)*d)` for a denoise `d` and a shift `s` (12 by
  default), which is why the panel asks for that share and `gd_post.denoise_for` works the denoise
  out. Measured on a face region, same seed: 50% was indistinguishable from the source, 70% tidied the
  features, 85% redrew them and kept the layout, 93% changed the hair and the background around the
  face too. The default of face refine (0.85) and the hint under the control come from this.

**Where the model cuts**

- **A cut asked for at a frame lands near it, and further off the longer the clip and the more shots
  it has.** Two shots in 124 frames: within a frame (section 13). Four shots in 243 frames, eight
  draft takes, cuts asked at 61, 122, 183: the first 0 to 3 frames late, the second 4 to 8 early, the
  third 1 to 9 early; one take on the Standard preset: 2, 11 and 13 early, so it is not the turbo
  model. Three shots in 362 frames: 6 and 18 early. (Measured by finding each take's largest
  changes from frame to frame, the way `gd_splice.frame_changes` measures a change.)
- This is why two takes are joined at a cut where each really cuts, why a take's shot is shown from its
  real cut-in to its real cut-out, and why a card rests on the middle frame of its shot.
- A stretch that is rendered again is generated by the same model, which again puts a cut where it
  likes: when cuts were still repaired like seams, the cuts of one result were 1, 8 and 11 frames
  late. Hence the guards: a cell that holds a real cut is never free.
- **Saying that a shot is cut to does not move the cut.** The same four seeds with every shot after the
  first beginning "The shot cuts.", and again in the official guide's own wording ("the camera cuts
  to ..."): the second and third cuts 1 to 8 frames early, against 1 to 9 without. The compiler adds
  no such wording.
- **Shots written as one `[Shot]` stay one shot.** Three stretches of a long take and then a cut (243
  frames, draft, two seeds): one cut each, at the cut, 7 and 11 frames late, and the three stretches
  in one piece with their events in the order of the text. Four stretches as one long take, two
  seeds: no cut at all.
- **A seam between two different videos does not close.** Those two long takes, one until frame 122 and
  the other after it: sampled again from scratch, the three free cells carried on the first take and
  the jump moved to the end of them (frame 153, 25 times the usual change); from 0.3 both sides stayed
  as they were and the jump stayed at 122. A seam is worth repairing between takes that look alike,
  which is what it was built for. A shared source clip does not make two takes alike by itself: two
  seeds of one edit can light and colour a scene differently (section 13, the second pair).

**Things that look like bugs and are intended**

- The timeline draws its cell strip only when a cell can be kept (`cellsMatter` in
  `web/gd_timeline.js`: the run starts from footage, or the mask already keeps something). In a clip
  made from nothing every cell is redone; the strip was a row of identical boxes there, and a click
  on it led into a document that cannot run. Without the strip a dragged shot edge does not snap.
- A composite whose takes meet only at cuts has `mask.mode == "seam_repair"` and no free cell, and that
  is not the `seam_no_cut` problem: nothing is rendered. A seam that cannot be made (no latent frame
  of its range lies whole inside its long take: `dead` in `joinPlan`) is not a problem either; the pages say so in red and the join is made unrepaired.

- `normalize` keeps an anchor that duplicates another; `problems` then refuses two pictures on one frame.
- In the base family a cited image is always pinned (`normalize` sets it): that model is shown a picture
  through its first/last frame input, which holds the frame too. A cited picture that is not on the
  clip's first or last frame is not an error there: it is held at its frame and not declared, because
  "the first frame of shot 2" is an ordinary thing to ask for.
- A face refine run reports `start: the region of <file> its main face is in`, and its document has one
  shot and no source: the clip it works on travels in the output settings.
- "Whose face it is" on the Post page does not choose the face. The tracker takes the face that is in a
  shot longest; the subject only says whose pictures the region is generated with.
- The two players of the Post page are tied together (a frame chosen in one is shown in the other, one
  plays when the other does) and a click enlarges both at the point clicked: a face of a few dozen
  pixels cannot be judged at the size of the page.
- A reference-family document with nothing cited compiles to the three plain prompt fields, not six.
- The recipe buttons replace the material instead of adding to it. A recipe that only added could not
  promise what its label says.
- `gd_takes.py` is never imported by the node.

**Tried and removed**

- A second sampling pass ("refine") at the clip's own size: measured again later, it redraws the detail
  and makes nothing clearer. Upscale-then-resample was removed with it and is not the same case: see
  design goal 4.
- Re-rendering a single shot: it costs a whole render and starts from generated frames.
- Citing the source clip's own first and last frame automatically: on two different subjects the result
  with and without it differed no more than two runs of the same settings.
- A soft value for pinned mask cells: no interface used it, and it made "pinned" untrue.
- Planner-side trimming of over-limit references: it renumbered every later label without telling anyone.

## 8. Tests

Requirements: ComfyUI 0.39 or newer with its own Python; Node 20 or newer for the three `.mjs` checks. No GPU.

```bash
# from the ComfyUI root, with ComfyUI's Python
python custom_nodes/ComfyUI-GachaDirector/tests/test_grid.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_schema.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_widget_order.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_expand.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_splice.py

# from the package directory
python tests/test_faces.py
python tests/test_cuts.py
python tests/make_parity_fixtures.py
node --experimental-default-type=module tests/parity.mjs
node --experimental-default-type=module tests/tracker.mjs
node --experimental-default-type=module tests/material.mjs

# with ComfyUI running (nothing is rendered); needs Edge or Chrome
node --experimental-websocket tests/shot.mjs tests/ui_edit_flow.mjs --lang zh
```

| Suite | Covers |
| --- | --- |
| `test_grid.py` | frame grid, cells, seam cells, canvas sizes. Runs without ComfyUI |
| `test_schema.py` | normalize, migrate, problems, the planner adapter, presets, takes, output settings, reference limits. Runs without ComfyUI |
| `test_widget_order.py` | widget order, `IS_CHANGED` (the files a document names are part of it: `file_marks`), `VALIDATE_INPUTS`, import without ComfyUI |
| `test_expand.py` | vendored file hashes; one expansion per way of driving the model, with node kinds and wiring asserted; the mask through core's resampling. Needs ComfyUI on the path |
| `parity.mjs` | every fixture case: the JS mirror gives exactly Python's answer, and does not modify its arguments |
| `test_cuts.py` | `gd_cuts`: finding a cut (the window, also asked by the frames cuts are asked at, a busy frame, a flash, the larger of two), and the plan of a join: both takes allow a frame, neither does, no cut found, one take over several shots, a boundary inside a long take, a stretch squeezed to nothing, what a render must leave alone. Plain Python |
| `test_splice.py` | the two splice nodes on made-up takes: frames and sound stay in step, a silent take, another sample rate, a flash of three and of four blank frames, a shot lit up for five and for six frames (no change at all by this measure), ten frames of another picture and back, a take shorter or longer than the clip, sound that ends before its picture, a cell that holds a real cut is not freed, the face tracker is told the real cuts and leaves a boundary inside a long take where it is, a shot with no frames left keeps its number. The stand-in for the file reader ends files the way the reader does. Needs ComfyUI on the path and torch |
| `test_faces.py` | face refine without a detector or a model: the track (one face followed, never across a cut, a shot without a face left alone, a face that turns away and comes back, the sizes left alone and the reason given, shots named by the user), the weights around a gap, and that cutting out and putting back gives the frame back. Needs torch |
| `material.mjs` | `web/gd_material.js`: mentions survive a rename, a change of use and a removal, in every field that may hold one; a name that is the beginning of another; text that goes straight on after a name; a cut inserted or removed loses no material; the mode tags; the reference budget |
| `ui_edit_flow.mjs` | the Edit page in a real browser, driven by `shot.mjs` (a headless Edge or Chrome over its debugging port): typing `@`, picking a name with the keyboard, the `@` button of a row, changing a use, renaming, a cut and a merge, removing, text typed and not yet committed when the page is drawn again, and the prompt the server compiles. Its expected labels are the Chinese ones |
| `tracker.mjs` | whose run a preview or a timing belongs to: the run-tracker sections of `web/gd_editor.js`, cut out by their header comments and driven with made-up start, end, progress, preview and reconnect events around a `/queue` whose answers the test releases. If those sections are renamed or use a new name from the rest of the editor, it says so. It does not cover `web/gd_director.js` (`execId`, the listener guard, `noteChange`), the five-second timeout of a question, or the takes actions (`queueTakes` and `refreshTakes` are stand-ins) |

Each script prints "all passed" or the failed checks; there is no test runner and no selection flag: to run
one case, edit the script. That a flash of a few frames is not taken for a cut is the check "going
into a flash of three frames and coming out of it: neither stays" in `test_splice.py` (the real
frames), with `find_cut`'s side of it ("a flash is passed over for the cut behind it") in
`test_cuts.py`. `make_parity_fixtures.py --fuzz N --seed S --out PATH` adds random cases.

The mask checks are the last section of `test_expand.py`. Through core's resampling they cover clips of
124, 243 and 22 frames with these cells free: the second, the last, the first and last together, and all
of them; and one case of an audio track shorter than the clip. They are not exhaustive. Which cells a
seam repair frees is `gd_grid.seam_cells`, covered in `test_grid.py`.

A parity failure after a change usually means the other side was not changed (the fixtures have to be
written again first, `tests/make_parity_fixtures.py`; an input no fixture has is not compared at all). A `test_expand.py` failure naming a
socket usually means a core node changed its inputs.

Of the browser only the Edit page's flow is automated. Verify other panel changes by hand, or with a
scenario for `shot.mjs` (it can load a workflow, click, type, reload and take screenshots; see its
header): queue takes, pick, composite, refine a face, open the Output page; and load both example
workflows. Such scenarios were used while the package was written (a pool of takes made through the
panel, a join of picks from several takes, a face refine, the README's screenshots in three
languages); they are not part of the shipped directory, and neither are the scripts the numbers of
section 13 were measured with.
What the package itself has for measuring is `tests/measure_seam_range.py` and `tests/shot.mjs`.

## 9. Tools

| Script | Purpose |
| --- | --- |
| `templates/make_workflows.py` | writes `example_workflows/`; `--models KEY=FILE` overrides file names, `--out DIR`. It takes the presets from `gd_presets.empty()` and then sets the Draft preset's steps to what each example's turbo LoRA wants (8 for the base model, 4 for the reference model) |
| `tests/make_parity_fixtures.py` | writes Python's answers for the parity check |
| `tests/measure_vae_cells.py` | measures which latent frames a stretch of pixel frames lands in |
| `tests/measure_seam_range.py` | two takes, a composite and the frames generated again around the seam: the largest step left near the seam as a multiple of the takes' own, and how many dB the kept frames beside the range lost against a run with nothing generated there. The seam-range numbers in the README come from it |
| `tests/measure_seam.py` | two takes, their composite and the cut frame: PSNR per cell against each take, and the frame-to-frame jump at the cut for a plain cut and for the composite. The composite numbers in the README come from it |

## 10. Legacy parts

- `gd_schema.migrate` and `_migrate_v5` read documents of schema versions 1 to 5 (flat "plate" layout).
  Nothing in the package writes them. They can go when no saved workflow of that age matters; until then
  `test_schema.py` holds the migration.
- `gd_takes.normalize` drops takes that carry a `scope` other than `"whole"` (an older, per-shot kind).
- `gd_schema._migrate_v7` reads documents of version 7, which had no `join`: over a source clip
  (`source.video` set) every shot that does not say is marked as going on from the one before, because
  that is how such a clip's takes were joined (the seam rendered again); made from nothing, the shots
  stay cuts. It is why an old editing workflow still repairs its seams and an old text-to-video one
  is now cut together. The pieces of `source.splice` (a composite of that time, still in a history or
  sent over the API) that do not say are marked `continuous` whatever the clip is made over: every
  change of take was rendered again then, and read as cuts the cells the mask frees around them would
  be held back as holding a cut.
- `gd_schema._migrate_v6` reads documents of version 6: `@refN` in prompt text and the number in
  `audio[].subject` become ids, and anchors given by `frame` find their shots.
- i18n keys and CSS classes still say `seg` / `task` / `plate` / `takes` / `run` where the panel says shot /
  preset / source video / Generate / Project. Renaming them is cosmetic; a search for a concept has to
  try both words.

## 11. How to make common changes

**Add a field to the clip document.** `gd_schema.py` (default, `normalize`, `problems` if it can be wrong) ->
`web/gd_doc.js` (the same three places) -> a case in `tests/make_parity_fixtures.py` -> control in
`web/gd_page_edit.js` (or the page it belongs on) -> rows in `web/gd_i18n.js` (three languages) -> where
Python uses it. Forgetting the mirror shows up as a parity failure; forgetting i18n shows the raw key in the
panel. Two things that are easy to miss: `normalize` carries over only top-level keys it does not know,
so a key it has a default for must be read from the input explicitly, or every document loses its value;
and a field that should not count as a change of the clip (a note, say) has to be left out of the three
places that compare content: `IS_CHANGED` in `gd_director.py` (it hashes the whole document: the node
runs again), `contentKey` of the Edit page (the compiled prompt is built again) and `contentKey` of the
Output page (earlier results are marked out of date).

**Add a use of material** (say, a picture as a style reference). The record it becomes and its fields:
`gd_schema.py` and `web/gd_doc.js`. Then `web/gd_material.js` (`IMAGE_USES` / `VIDEO_USES` / `AUDIO_USES`,
`useOf`, `setUse`, the `add*` function) with a case in `tests/material.mjs`; `use.<name>` and
`use.<name>Hint` in `web/gd_i18n.js`; `gd_compile.py` (what the model is told: `labels`, `_unsaid`,
`_records`) with a case in `tests/test_schema.py`; `gd_h3.emit` if it is wired differently.

**Add an output setting or a face refine setting.** `gd_post.py` (`DEFAULT`, `normalize`) ->
`web/gd_post_doc.js` -> a case in `POSTS` of `tests/make_parity_fixtures.py` -> a control in
`web/gd_page_post.js` -> i18n. A face setting that changes the result also goes into `refineKey` in
`web/gd_editor.js`, or an old refine would be shown as current.

**Add a preset parameter.** `gd_presets.PARAM_KEYS`, `DEFAULT_PARAMS`, `normalize_params`,
`params_signature` -> `web/gd_presets_doc.js` -> `web/gd_page_run.js` -> use it in `gd_director.run`. A new key
changes every signature, which resets recorded timings once.

**Add a built-in preset.** `gd_presets.BUILTIN_PRESETS` and `web/gd_presets_doc.js` `BUILTIN_PRESETS` (same
order), the list of ids in `tests/test_schema.py`, a row `run.note.<id>` in `web/gd_i18n.js` (its
English column equal to the note), regenerate fixtures and example workflows, README. A
store that already holds presets keeps its own list: workflows saved before the change do not gain the
new preset. A preset whose model is `turbo` fails to run unless `model_turbo` is wired.

**Add a widget to the node.** Append to `WIDGET_ORDER`, to `INPUT_TYPES` and to the released list in
`test_widget_order.py`, never insert; give it a default; add the parameter to `GachaDirector.run` (its
signature takes no `**kwargs`, so an input it does not name fails the run with "unexpected keyword
argument"); update `templates/make_workflows.py` (its `values`) and regenerate the examples.

**Change how takes are joined.** The rule is in three places that have to agree: `gd_cuts.plan` (what
the run does), `gd_schema._free_cells` with its mirror `freeCells` in `web/gd_doc.js` (what a render
may touch), and `joinPlan` in `web/gd_editor.js` (what the pages say beforehand). Add the case to
`tests/test_cuts.py`, to `LONG_TAKES` in `tests/make_parity_fixtures.py` and to the composite cases of
`tests/test_expand.py`, then run a join through the panel (by hand, or with a scenario for
`shot.mjs`). A third kind of join would also have to be let through where the two are told apart by name:
`_norm_shots` / `normShots` and the pieces of `source.splice` turn any value they do not know into
`"cut"` (so a document saved with a new word silently loses it on a build that does not know it),
`plan_key` marks only `continuous`, and `gd_cuts.plan` does nothing at all between two shots of one
take. `sound` is normalised the same way in the same two places, and a change to what it does goes
through the sound cases of `tests/test_cuts.py` and `tests/test_splice.py` as well.

**Change what is regenerated around a seam.** The rule is `gd_grid.seam_auto` / `seam_latents` and
`gd_schema._free`, mirrored by `seamAuto` / `seamLatents` / `freeOf` in `web/gd_doc.js`; the page's
reading of it is `seamRanges` in `web/gd_editor.js`. Cases go into `SEAMS` and the grid cases of
`tests/make_parity_fixtures.py`, `tests/test_grid.py` and `tests/test_schema.py`. Then measure, do
not guess: render a seam with a given set of latent frames freed (the document key
`x_free_latents`: `gd_director.run` takes it in place of the planned latent frames, for the time
mask and for the question whether anything is sampled at all; a second key of that kind,
`x_seam_dissolve`, makes `GachaDirectorCutSplice` cross-fade a stretch instead of cutting. Neither has
a control in the panel; both reach a run because `normalize` keeps top-level keys it does not know) and `tests/measure_seam_range.py` says
how large the step at the seam still is and what it cost the frames that were kept. A number in a
tooltip of the seam strip (`SEAM_SHORT`, the 12 frames) comes from such runs. The dragging of the
ends was checked in the headless browser with a scenario for `shot.mjs`.

**Add a problem.** A problem keeps a clip from running (`VALIDATE_INPUTS` refuses the prompt). The rule
goes in `gd_schema.problems_coded` and in `web/gd_doc.js` `problemsCoded`, at the same place in the
order; the English sentence in `PROBLEM_TEXT` on both sides (a code without one raises in Python and
throws in JS); three columns of `problem.<code>` in `web/gd_i18n.js` (without them the page shows the
key, and `parity.mjs` fails); a case in `tests/test_schema.py` and a document in `PROBLEM_DOCS` of
`tests/make_parity_fixtures.py`. Judge the normalized document: lengths have been aligned by then.

**Support a new way of driving the model.** First express it as material in the document; add a field only
if it cannot be expressed. Then `gd_compile` (what the planner is told), `gd_h3.emit` (what is wired), a case
in `test_expand.py` asserting node kinds and wiring, and optionally a recipe button.

**Change panel text.** `web/gd_i18n.js` only, all three columns, in words a user of the panel would use
(design goal 6). README files quote panel text: update them, and retake the screenshots in `docs/` that
show it. `ui_edit_flow.mjs` expects some Chinese labels.

**Explain a control.** Not on the page. What a control is for is a tooltip: `tip(target, text)` in
`web/gd_ui.js`, or the `hint` argument of `labeled()` and `section()` there and of the Edit page's own
`field()` and `vfield()`, which call it. The text sits in the attribute `data-gd-tip` and one listener on the document shows it after
the pointer has rested for half a second, so a page that is drawn again loses nothing and a test
can read the attribute. Do not set `title` (the browser's own tooltip would come up as well). A
tooltip of one line is a sentence; with more, the first line says what the control is and each line
after it is one value or one way to use it (they are drawn hanging and a shade dimmer). The
register is that of a parameter reference in a DCC tool: noun phrases and plain statements,
no second person, no account of how it was found out. What stays on the page is state: a status, a
warning, a count, in one short line (`gd-hint`, `gd-badge-*`, `gd-note gd-note-bad` for what stops a
run). A setting that does nothing at the moment is dimmed and says why in its tooltip
(`gd-row-idle`), rather than a paragraph appearing beside it. A control with no words on it (the two
links between shot cards, `linkMark` in `web/gd_ui.js`, icons drawn in `ICONS` there) names itself
and its state in the first line of its tooltip.

**Take a file from the user's computer.** `importFiles(files)` in `web/gd_editor.js` posts each file
to ComfyUI's own `/upload/image` (which takes any media into `input/` and renames on a clash), reads
the media list again and returns `[{name, kind}]`. `dropZone(target, onFiles)` in `web/gd_ui.js`
makes an element take dropped files; the shell in `web/gd_modal.js` swallows a file dragged anywhere
else on the panel, so that it does not fall through to the graph behind it and open as a workflow.
A new place that takes files needs both: the drop zone, and a way to do the same with a click (the
library's import button).

**The material library** (`web/gd_library.js`) is a window of the panel, not of a page: one instance,
made in `web/gd_editor.js`, mounted in the shell's `sublayer`, opened by the button in the bar
(`onLibrary` of `createModal`) and reached by pages as `host.library()`. It lists what
`/gachadirector/media` answers, in two halves: `input/` ("Imported") and `generated` (`output/`, names
with the ` [output]` annotation, newest first, capped per kind in `gd_routes.GENERATED_SHOWN`).
Its folders are not on disk. A workflow names a file by where it is, so a file is never moved or
renamed: a folder is an entry of `{version, folders: [{id, name, root, parent}], items: {name:
folderId}}`, kept through ComfyUI's own user-data route as `gachadirector.library.json` (one list for
every workflow), and `normalizeIndex` drops what is broken (a folder in a folder of the other half,
a ring, an item of a folder that is gone). ComfyUI has an assets system with tags of its own
(`/api/assets`), but it is off unless the server is started with `--enable-assets`, so nothing here
depends on it. An item is used by dragging it: the drag carries `LIBRARY_ITEMS` (`[{name, kind}]`),
and `dropZone(target, onFiles, onItems)` hands such a drop to `onItems` (files of the computer still
go to `onFiles`). `open({pick})` is the window opened for one place (`"+ picture"`): only the kinds
that fit are listed and a click hands the name over. Keys: the shell takes every key on its way
down, so the name field of a folder listens for `gd-key`, and Escape is asked of the library by the
shell (`onEscape` -> `library.escape()`), which gives up one thing at a time: a name being typed, a
pick, the window. All of it was walked through in the headless browser with a scenario for `shot.mjs`.

**Add a control to the Edit page.** The cards are drawn again whenever `cardsKey()` changes (material
added, a use changed, a cut). Before that, `renderBody` blurs the focused field so that what was typed
is committed, and afterwards puts the caret back (`refocus`); a text field has to commit on `blur` /
`change` for this to hold, and a value that should not redraw the cards must stay out of `cardsKey`.
The compiled prompt is painted on its own (`paintCompiled`). A row of buttons goes into a `div`, not a
`label` (a click anywhere in a label presses its first button): `field()` picks by content.

**Update the vendored planner.** Replace the files in `vendor/` unmodified, update `vendor/UPSTREAM.json`
(commit, sizes, sha256) and `NOTICE`. `gd_compile.py` depends on the planner's input keys and on
`ref_image_slots`, `ref_video_segs`, `ref_audio_segs`, `ref_warnings`, `events` in its output.

**Rename a contract name (section 5).** Do not, unless the old name keeps working: add the new one, read
both, write the new one.

**Release.** `__version__` in `__init__.py`, `version` in `pyproject.toml`, `CHANGELOG.md`, regenerate the
example workflows, run section 8.

## 12. Conventions

- Comments say why, not what, and describe the code as it is: no history, no "new", no ticket numbers.
- Python: pure modules import nothing from ComfyUI at module level and are importable without it.
- JS: no framework, no markup in template strings; a page builds DOM nodes with the helpers in `gd_ui.js`.
- Sentences the panel shows go through `t()` and exist in three languages. English only, by intent:
  parameter identifiers (`seed`, `steps`, the preset parameter names), the run report, the planner's
  warnings and server-side errors. The notes of the built-in presets are data in the preset store and
  are stored in English; the Project page shows the row `run.note.<id>` instead while a note is still
  the one a built-in preset came with, and stores what the user types as typed.
- Prompts are written in English: text inserted into a prompt is not translated.
- A change to a rule that exists on both sides changes both sides and regenerates the fixtures.
- Licence: GPL-3.0 for the package; the provenance of every adapted file is in `NOTICE` and in a line at
  the top of the file. Keep both when moving code.
- This document is part of a change: update it when the code it describes changes.

## 13. Measured numbers

ComfyUI 0.39.0, MiniMax H3 `fl2va` / `ref2va`, 124-frame clips unless stated. Orders of magnitude, not
guarantees.

| What | Result |
| --- | --- |
| Official template, same seed, run twice | 19-20 dB PSNR between the two |
| This node vs the official template, same inputs | 20-23 dB (the same range); 35 dB on the multi-frame template |
| Pinned cells of a composite vs the picked take | 31-34 dB on source-locked takes, 34-36 dB on text-to-video takes (one VAE round trip) |
| Frame-to-frame change at a cut between two source-locked takes | plain cut 1.7x the clip's usual change; after seam repair 1.0x |
| Seam strength 0.3 vs 1 on that composite | both remove the jump; at 0.3 the repaired cells stay about 5 dB closer to the picked takes |
| What a seam inside a long take needs generated again (`tests/measure_seam_range.py`; one pair of takes following one source, 33 dB alike on the strip's readout; the seam on a cell boundary, strength 1) | a plain cut is 3.0x the takes' own step there, 2.4x after encoding and decoding alone. 4 / 8 / 12 / 16 frames ending on the boundary: 1.6x / 1.5x / 1.3x / 1.4x, the kept frames after them 0 to 0.5 dB further from the take. The 12 frames with two more seeds: 1.27x, 1.25x; with the takes swapped: 1.18x; at strength 0.3: 1.5x |
| ...the range ending inside the next cell instead | one frame in (5 or 13 frames freed): 2.0x and 2.1x, not closed, the kept frames 4.5 and 4.8 dB off. Mid-cell (13, 21 frames): 1.2x, 1.1x, 3.6 dB off. Through the whole next cell (25 frames; 34, the old rule): 1.1x, 1.3x, 1.6 dB off |
| ...the seam inside a cell (frame 62: 4.4x plain, 3.6x after encoding alone) | its own latent frame only (4 frames): 2.1x. To the end of its cell (12 frames): 1.3x, 0.9 dB off. The old rule (51 frames): 1.4x, 1.9 dB off |
| A pair that differs a lot at the seam: one source video, one prompt, two seeds that lit and coloured the scene differently (19 dB on the readout) | plain 2.1x, 2.0x after encoding alone. 8, 12 and 16 frames to the boundary: 2.0x, the step stays where it is. 13 frames over both sides: 1.8x. 25 and 34 frames: 1.9x, the step moved to the end of the range. Those two at strength 0.3: 1.9x and 1.8x, the step back at the seam. Nothing that was tried closed it |
| Where the model puts a hard cut the prompt asks for at a frame (8 two-shot text-to-video clips) | on the frame in 4, one frame late in 3, one frame early in 1 |
| Two such takes, one cutting a frame early and one a frame late, spliced at the asked frame | a plain splice jumps at three frames in a row (two stray frames); the composite at seam strength 1 has one cut, on the asked frame; at 0.3 the three jumps are all still there. This is why the default strength is 1 |
| A source clip four frames shorter than the clip (its last frame is held) | the render slows to a stop over about its last six frames |
| Edit with the source as reference only vs reference + latent (denoise 0.85) | 31.6 dB between the two renders |
| Reference video short edge 512 vs 256, same canvas | about 2.5x the time per step |
| Face refine of a 38 px face (864 x 480 clip, region generated at 640 x 640, 20 steps), by starting noise | 50%: no visible change; 70%: features tidied; 85%: features redrawn, hair, pose and light kept; 93%: hair and surroundings change too |
| Face refine at 85% of a 14 px face / of a 160 px face (672 x 384 clip) | no gain, and the clothes in the region changed colour / replaced by another face |
| A second pass over a whole clip at its own size, from 85% noise | layout and movement kept, detail redrawn; a 38 px face no clearer than before |
| The same clip (864 x 480) upscaled to 1344 x 768 and passed again from 85% noise; a direct render at 1344 x 768 with the same seed | layout and movement kept, face and cloth clearly sharper, every detail redrawn, 2035 s on a machine in use; another clip altogether, 1613 s |
| Naming material: `@name` in the shot / the automatic sentence / declared only (2 seeds each, draft) | the subject appeared in all six; exactly the reference in both `@name` runs, one extra animal in one automatic run, one off-colour in one declared-only run |
| Where four shots in 243 frames really cut (asked: 61, 122, 183), 8 draft takes | +0..+3, -4..-8, -1..-9 frames; one Standard take: -2, -11, -13 |
| Four 61-frame shots, each from another take (draft), joined at the frames asked for | six changes of shot instead of three: 3, 6 and 3 stray frames at the cuts |
| ...joined where the takes really cut (what the panel does) | three cuts, no stray frame, 240 of 243 frames; nothing sampled, 5 s on a server that had loaded no model |
| ...with the cuts repaired like seams (what the panel did before) | 9 of 15 cells redone; 34, 17, 0 and 39 frames of the picks left; cuts at frames 62, 130, 194; 196 s |
| A composite with one seam inside a long take and two cuts (draft) | 168 s; 241 frames, sound 10.04 s |
| The thunderstorm and the chase at the standard preset (20 steps, 864 x 480, no turbo LoRA), 2 takes each | all 12 cuts found exactly. The takes the rules were worked out on were all drafts |
| A clip in which every shot moves hard (a handheld chase, running feet with motion blur, an explosion, a whip pan), 4 draft takes | all 12 cuts found exactly; in two takes the model jumped inside a shot by as much as the cut next to it, and the cut was told from the jump by being nearer the frame asked. The smallest cut measured 0.28 (8 times the usual change: both shots blurred) |
| A clip full of flashes: a thunderstorm at night, lightning lighting the picture again and again and showing what a dark shot hid (up to 105 times the usual change), 4 draft takes | all 12 cuts found exactly, one of them a soft cut four frames after a burst of lightning. By difference of brightness, as before: 5 of 12, the others 1 to 22 frames off |
| Another clip, hard for finding cuts (a dim forge, one man in all four shots, two close-ups in a row, two or three hammer blows, bursts of sparks or the workpiece leaving the frame a take, up to 34 times the usual change), 4 draft takes | all 12 cuts found; -2..+4 frames from the frames asked |
| A long take kept as one take has it up to frame 118 and generated again from 119 (that take as the source latent, free cells 7-14), draft, 2 seeds | the kept part 38.1 dB PSNR against the take; the change where old meets new 0.9 to 1.0 times the usual; no frame at 5 times; the second halves differ (17.7 dB against the take, 24.3 dB against each other); 163 and 175 s. This is how takes that join inside a long take can be had; the panel has no single step for it |
| Two draft takes of a 15-second clip (362 frames, cuts asked at 124 and 243; the takes cut at 118 / 225 and at 126 / 229) cut together, shots 1 and 3 of one and shot 2 of the other | both cuts found in both takes; 8 frames of neither shot left out at the first cut, none at the second; 354 frames, picture and sound both 14.75 s; 3.7 s |
| Sound level across the three cuts of a clip cut together from 4 draft takes (RMS of the quarter second on either side) | +15, -9, -5 dB; across the cuts of a single take: -2, +9, +1 / +5, +5, -7 / -2, +2, -2 dB. Nothing matches the takes' loudness |
| The same clip with the sound carried on across all three cuts (one take's sound throughout) | -1, +18, -2 dB at the same frames; the +18 is an event in that take's own sound (+15 there in the take by itself), not a change of source |
| A draft take (672 x 384) and a standard take (864 x 480) of one clip, cut together | 864 x 480, 236 of 243 frames (the standard take cut 7 frames before the draft one) |
| A face refine of a 240-frame clip cut together from a 243-frame document | 240 frames out, sound 10.0 s |
| Time, one run each: 124 frames at 864 x 480 / 20 steps; 243 frames at the same; 124 frames at 1344 x 768 / 25 steps | 359 s; 983 s; 1613 s |
| Time, draft (672 x 384, turbo, 4 steps): 243 frames; 362 frames; the join above | about 121 s; 190 s; 196 s |

## 14. Known limits worth knowing before promising a feature

- Fun ControlNet and FastH3 are wired upstream by the user; the panel has no controls for them. Both routes
  were run through this node once each (canny control video; FastH3 text to video).
- A subgraph placed more than once: the panel of the director node inside it queues takes for the first
  placement `execId` finds, and cannot tell the placements' runs apart. One placement is what was
  measured (two takes and a composite queued from inside a subgraph).
- Spatial inpainting (a mask in the picture plane) is not supported by the panel; the official route for it
  is the ControlNet patch's `mask` / `source_video` inputs, upstream.
- A clip is one generation window. There is no multi-clip sequence view. Several director nodes can sit
  in one workflow, and takes and composites of one do not run the others; ComfyUI's own Run button runs
  them all in one prompt, and each node's preset records its own share of it.
- Of the browser, one flow through the Edit page is covered by an automated test, and it needs a running
  server (`ui_edit_flow.mjs`). The rest of the panel logic that is tested runs outside a browser
  (`tracker.mjs`, `material.mjs`).
- Previews are shown and timings recorded by the browser that receives the run's start and end events.
  ComfyUI sends those to the client that queued the prompt and to nobody else (`execution.py`
  `add_message`), and not at all for a prompt queued without a client id. So a run queued through the
  API or from another browser has no live preview here and is never timed. Nothing imports it either:
  `refreshTakes` asks only about the takes this workflow already lists, and the results page lists plain
  runs and composites from history when it is loaded. A run that was going when the page was reloaded
  gets its preview back once the queue has answered (measured: 8 to 18 s after the reload, on runs of
  100 s) and is not timed; takes still waiting in the queue at that moment are timed against the preset
  that is active when they start.
- The time of a cut is the model's to decide (section 7, "Where the model cuts"). Nothing in the panel
  can hold a cut to a frame.
- A clip cut together from several takes can be a few frames shorter than the document says.
- A real cut is found by how much the picture changes. A dissolve, a whip pan or two shots that look
  alike can go unfound; that join is then made at the frame asked for and may show stray frames. There
  is no way to mark a cut by hand.
- Inside a long take the panel controls the order of events, not their timing.
- Picking stretches of a long take from several takes helps only when the takes look alike, and
  sharing a source clip does not guarantee that. The strip says how alike they are at the seam; no
  number is known below which a seam cannot be closed. A seam left to itself redoes 12 to 21
  frames (section 5, `joinPlan`); the pages say how much is left and which seams cannot be made,
  and do not prevent the join.
- Nothing about a seam's sound was measured: the range was chosen on the picture alone.
- Face refine handles one face in a shot, helps only faces of a few dozen pixels, and costs about as
  much as a render of the clip at the same preset.
- When the server dies in the middle of a run, the page learns of it when the connection comes back
  (`onReconnected`); until then the takes page says "rendering". A server that hangs without dropping
  the connection is not noticed.
- The results page reads ComfyUI's in-memory history (the last 40 entries): a restart empties it. It lists
  plain runs and composites; takes are on the takes page.
- `problems` cannot see files. A file known to be silent is caught when the run is planned; a missing file
  fails in the loader node; the 15-second total for reference videos is checked when the run is planned.
- The media library lists every file of `input/`, and of generated files the newest 1000 pictures,
  400 videos and 400 sounds. A clip keeps its newest 200 takes (`gd_takes.MAX_TAKES`; a pick of a take
  that falls out goes with it), a preset its last 50 timed runs, the panel 60 steps of undo (edits of
  one kind within 0.7 s count as one). A source clip shorter than the clip is padded with
  its last frame. `vram_staging: "auto"` stages at 16 GiB of VRAM or less. The "Free VRAM" button of
  the Project page is not the node's staging: it asks ComfyUI to unload every model and free its
  memory (`/free`), whatever loaded them.
