# Changelog

## 2.1.2

Fixes, and an optional speed-up described in the guide.

### Videos you bring in

- **A clip recorded on a phone is used upright.** A video stored lying on its side with a
  rotation note was shown upright in the panel and handed to the model on its side, and
  the "source" aspect took its stored size.
- **A large source video no longer needs tens of gigabytes of memory.** Frames are brought
  to the working size a few at a time while the file is read, instead of the whole clip
  at its own size first.
- **A clip slower than 24 fps is used to its last frame, at an even pace.** One frame was
  missing at its end, so a continuation started from a repeated frame, and a 12 fps clip
  came out with its frames held unevenly. The length shown for a clip at another rate is
  now the number of frames it really gives.
- **A clip whose frames are not evenly spaced is placed by its time stamps** even when it
  averages 24 fps, instead of being read frame by frame.
- **A continuation given another file is taken from that file's end**, at the length it
  had. The start frame of the old file was kept and could lie past the end of the new one.
- **A video replaced by another of the same name and time, but another size, is measured
  again.**

### Face refine

- **A workflow opened from a face-refined clip generates takes again.** Its output settings
  still named the clip that was refined, and every take or composite queued from it was
  run as another face refine, or refused.
- **Face refine of a joined clip finds its shots.** A clip joined from several takes cuts
  where those takes cut and can be many frames shorter than the document; the refine
  looked for the shots where the document has them and could work on another shot than
  the one chosen, or find none.
- **Face refine stays on the shots it was asked for when a cut is added or removed.**
- **Face refine accepts a subject whose description names other material**, as the subject
  of the "picture + motion video" starting setup does. The run was refused.

### Prompts and shots

- **A sound reference longer than 15 seconds is used for its first 15**, the most the
  model takes, and the panel says so. Given whole, a long sound set to "Full copy" came
  out as something else, with nothing saying why. Sound references shorter than 2 seconds,
  or adding up to more than 15, are warned about.
- **A voice that is given a description is still its subject's voice.** The description
  replaced the sentence that says whose voice it is; it now goes beside it.
- **A shot with nothing written, in front of one that says something, is warned about.**
  The model is not told of such a shot, and what follows it begins the clip.
- **Shortening a clip keeps every speaker's line.** The text of shots that no longer fit
  was run into one line, which made the second speaker's line part of the first one's.
- **"Distribute prompts" keeps spoken lines.** A spoken line was split at its full stops
  and run into the narration.
- **An edit made right after an undo cannot be overwritten by a redo.**
- **Moving the playhead no longer puts back a prompt edited a moment before.**

### Takes, joining and the library

- **A take is not given up for lost when the queue cannot be asked.** An error answer from
  the server (restarting, or behind a proxy) was read as an empty queue, and every waiting
  take was marked missing for good.
- **Joining takes that only need cutting together no longer asks for the turbo model**
  when the active preset uses it and nothing is wired to `model_turbo`.
- **The media library's folders survive a failed read.** When the stored folder list could
  not be read once, the next change wrote a new list over it.
- **A file imported while the library window was closed, or reopened for another place,**
  is no longer put into that other place.
- **A batch started from a seed above 2^53 no longer repeats a seed.**
- **An edit made at the very moment a take is queued is kept**, and the take's own file
  name can no longer stay behind in the output settings.
- **The Output page still shows the joined clip after a large batch of takes.** It looked
  at the newest forty runs only, and takes alone could fill them.
- **The Output page of one director node no longer lists a run made by another** in the
  same workflow.
- **A take removed in one shot's row is no longer what another shot shows.** That shot's
  preview stayed empty.

### Other

- **A clip stops playing when its page is left or the panel is closed.** With the sound
  on it went on being heard.
- **The before / after comparison of a face refine plays one sound, not two.**
- **Both edges of a very short shot can be dragged on the timeline**, and its middle can
  be clicked. A shot narrower than the handles was all left edge.
- **A custom size close to one of the listed sizes is shown as itself.** 864 x 480 was
  shown as the first size of the list, while the clip was rendered at 864 x 480.
- **An older ComfyUI is told what is missing.** Where ComfyUI lacks one of the MiniMax H3
  nodes a run needs, the error names the node and says to update ComfyUI.
- **Guide: an optional speed-up** that is part of ComfyUI itself, the attention backend,
  and when it can be used.

## 2.1.1

- **New nodes and example workflows default to two takes per batch.** Existing workflows
  keep any explicitly saved batch size. A new preset starts with the batch size of the
  active one.
- **Videos added or switched to Video continuation now default to their last 22 frames,
  counted at 24 fps, matching the Starting setup shortcut.** They used to take the first
  22. When fewer than 22 frames remain in the generated clip after the shot starts, the
  tail is shortened to a valid guide length that fits. Videos shorter than the selected
  tail section start at frame 0; files with unknown frame counts also fall back to
  frame 0. Existing continuation start frames are preserved.

## 2.1.0

The panel reorganised around how a clip is thought of: shots, and what each shot is made
of. What the model needs to be told about the material is worked out from that.

### The panel

- Five pages: Project, Edit, Generate, Post, Output (the first was Run, the third Takes, the last Results).
- **The players can be heard.** A sound switch (♪) on every transport, one for the whole
  panel and off until it is turned on; the sequence preview plays each section with the
  sound of the take it comes from, and the clips of the Output page start muted or not by it.
- **Edit page, rebuilt.** One card per shot: what happens in it on the left, its pictures,
  videos and sounds on the right. Material every shot uses has a group of its own above the
  cards, with the overall description, the ambient sound, the music and the source video.
- The notes of the built-in presets are shown in the interface language while they are the
  ones the presets came with.
- Every piece of material has a name and a use picked from a short list: a picture is who
  or what is in the shot, its first or last frame, a frame in between, or a storyboard; a
  video is a movement reference or what the shot carries on from; a sound is somebody's
  voice, a sound to follow, or played as it is.
- Nothing is numbered by hand. Typing `@` in a prompt offers the material by name (the
  shot's own first); a row's `@` button inserts it at the cursor. Labels (`<Subject 1>`,
  `<Picture 2>`, `<Video 1>` ...) and the declarations that go with them are made when the
  clip is compiled, and material that belongs to a shot whose text does not name it gets a
  sentence saying it is in that shot. Renaming, changing a use or removing material keeps
  the prompts right.
- What is held on a frame moves with its shot, and stays on its frame when a cut is added
  or removed. The timeline shows it, read-only.
- A read-only tag on every shot says what kind of generation its material adds up to. There
  is no mode to switch: the model has none.
- **Project page.** The size of the picture as a width and a height for the clip being
  edited, the frame rate (24, fixed by the model), the length and the time a render is
  expected to take, at the top. Sizes of reference material are a group of their own;
  sampling parameters are folded away under plain labels.
- **Post page.** The two settings of a join (how wide and how strongly the surroundings of
  a join are redone), face refine, the live preview and what is saved.
- **Generate page.** A narrow navigator beside the shots: one numbered cell per shot in the
  colour of its state, as tall as the shot is long, with the timeline's position marked
  across it; it is as tall as the visible page. The cards of a pool wrap into rows and
  scroll down; every pool has a slider for their size, whose smallest position is a list.
  A card rests on the middle frame of its shot. The separate list of whole takes is gone:
  using a take for every shot and deleting it are under each shot's player, for the take
  it shows.
- **A preview of the edit** at the top of the Generate page: the picks played one after
  the other as they are now, without a render. A shot nothing is picked for is a labelled
  gap of its length; a change of take inside a long take is a hard switch there (the
  frames around it are generated on joining); once there is a final clip, the preview
  plays that. It moves with the timeline under it. The final clip no longer has a second
  player of its own further down the page.
- **A size of one's own** on the Project page: a width and a height typed in, next to the
  sizes on offer. One that is not a multiple of 32 is moved to the nearest that is, and the
  page says so; one outside 256 to 2048 px a side is refused with the reason.
- **Before a join, the Post page says how much of each shot's pick it keeps.** A short shot
  between two joins can be redone entirely; it is marked, on the Generate page too.
- Wording throughout in the user's terms: seconds and frames per second, "repaint over the
  original" with the share that is really repainted, "redo only part".
- **Explanations are tooltips.** A page shows names, values and state; what a control is
  for appears when the pointer rests on it for half a second. Titles no longer carry an
  explanation in brackets, and a setting that does nothing at the moment is dimmed and
  says why in its tooltip.
- **The material library is a window of the panel.** A button in the bar opens it over
  whichever page is shown; it can be moved and resized and stays open while the pages
  change. It lists what was imported (`input/`) and what was generated (`output/`), by
  kind, with a search. Folders can be made in it to sort material: they are the library's
  own, shared by every workflow, and no file is moved or renamed on disk. Items are
  dragged into folders, and onto a shot's material or the shared material to use them;
  "+ picture / video / sound" opens the same window for that place.
- **Material from this computer.** The library has an import button, and a file can be
  dropped on the library, on a shot's material, on the shared material or on the source
  video. The file is copied into ComfyUI's `input` folder. A file dropped anywhere else on
  the panel is ignored and does not reach the graph behind it.
- **The final clip is always made with the button.** Once every shot has a pick there is a
  "Join" button, also when every shot picked the same take: that take is then put out as
  the final clip, a file of its own, without a render, and the Output page lists it. (One
  take picked everywhere used to count as the final clip without anything being pressed.)
- The number of takes a press of "generate" makes can be set beside the button; it is the
  preset's own number, the one the Project page shows.
- Names of fields, options and buttons are noun phrases throughout.

### Cuts and long takes

- Between two shots the user says which it is: a montage (a cut to another shot) or a long
  take (the same shot going on, divided only so that its stretches can be described and
  picked apart). It is set between the shot cards of the Edit page, with a link that is
  open (a cut) or closed (continuous).
- **The sound has a link of its own** beside it. Open, the sound changes take with the
  picture at a cut; closed, the sound from before the cut goes on across it while the
  picture changes take. It decides only whose sound each frame of the final clip has:
  nothing is generated differently. Inside a long take the sound always goes with the
  picture. Measured on a clip cut together from four takes: the level steps at the three
  cuts are +15, -9 and -5 dB with the sound switching, and those of one take's own sound
  (-1, +18, -2 dB) with it carried on.
- **In the prompt**, shots that continue one another are written as one `[Shot]`, their
  narration in order as one paragraph; `[Shot N] At <time>` is a cut and nothing else.
  Measured: such a long take comes out in one piece, with its events in the order written.
- **In the final clip**, two takes that meet at a cut are put one after the other as they
  are, where each really cuts: the model puts a cut up to a dozen frames off the frame it
  is asked for, differently in every take, and a join at the frame asked for shows stray
  frames. Frames that belong to neither shot are left out, so the clip can come out a few
  frames short. When every join is a cut no model runs at all. Two takes that meet inside
  a long take are joined by rendering the frames around the join again; that render now
  stays inside the long take and never touches a real cut.
- **What is rendered again around such a seam is a range of its own**, shown as a bar under
  the Generate page's timeline with two ends to drag. It is counted in latent frames (four
  frames; a cell is five of them), which is the unit the mask really has, not in whole
  cells. Left to itself a seam renders from a little before it to the end of the cell it
  is in: 12 to 21 frames, where it used to be 34 to 51. Measured on a pair of takes that
  follow one source: 12 frames ending on a cell boundary brought the step at the seam from
  3.0 to 1.3 times the takes' own, and the kept frames after it came back as they would
  have anyway; ending inside a cell cost the one or two kept frames after it 3 to 5 dB. A
  seam of a workflow saved before keeps the cells it had until its bar is dragged or
  double-clicked.
- Beside the bar the page says how alike the two takes are at the seam (PSNR over eight
  frames on either side). A pair that differs a lot there may not be closed by any range:
  one such pair was not, although both takes followed the same source video.
- The Generate page shows a take's shot from where the take really cuts into it to where
  it really cuts out of it.
- A take records how the clip was divided into shots when it was rendered. After the cuts
  are moved, or a boundary is changed between montage and long take, the Generate page
  marks the takes made before and says that their cuts are still where they were.
- The Output page labels a final clip that was only cut together as such, without steps
  or seed: nothing was generated in that run.
- Where a take cuts is read from the structure of the picture, not from its brightness,
  a change has to hold for sixteen frames on either side to count, and its two sides have
  to differ more than each wobbles in itself: lightning, flashes and explosions lighting
  up a shot are no longer taken for cuts. On four takes of a thunderstorm all 12 cuts are
  found exactly; by brightness it was 5 of 12. Of two changes of about one size, the one
  nearer the frame asked for is the cut: the model sometimes jumps inside a fast shot by
  as much as a cut (a chase clip: 12 of 12). In a take that moves hard throughout, the bar
  for what is worth looking at no longer rises with the take's own motion past 0.5.
- A take shorter than the clip is refused by name when takes are cut together, instead
  of failing while it is read.
- A file written again under its name (a take, a reference picture, a source clip) is
  noticed by the node itself: the same seed run again no longer returns the clip made
  from the file as it was.
- The face refine no longer looks for a cut at a boundary inside a long take.
- The Generate page asks where takes cut in batches (more than 64 takes were never all
  answered), asks again about a take the server could not read, and asks again about all
  of them on "Refresh".
- The document of a composite at version 7 (one still in a history, or sent over the API)
  is still joined by rendering around its joins.
- The timeline's cell strip is shown only for a clip that is repainted over footage: in a
  clip made from nothing every cell is redone and the strip said nothing.

### Face refine

- One more run over the final clip: the main face of each shot is found and followed, the
  region around it is cut out, generated again at the preset's size with the chosen
  subject's pictures as the reference, and put back with a feathered edge. No pixel outside
  the region changes, the clip keeps its sound, and the clip from before is kept.
- A shot in which no face is found is left alone, and so is a stretch in which the face is
  turned away or out of the frame. Left to itself, the run takes the shots whose face is
  about 24 to 80 px, the sizes at which it was measured to help; the user can name the
  shots instead. A run that refines nothing fails and says, shot by shot, why.
- Strength is given as the share of noise the run starts from, 85% by default: on this
  model a pass that starts from less than about 70% gives the picture back.
- Before and after play side by side, in step; a click enlarges both at the point clicked.
- Face detection is YuNet as shipped by kornia, which ComfyUI already requires: no
  dependency is added. Its weights are downloaded by kornia on first use.

### The clip document (schema 8)

- Subjects, reference videos, reference audio and anchors each have a stable `id`, a
  `name` and the `shot` they belong to (empty for shared material). Prompt text refers to
  material as `@{id}`; a voice names its subject by id.
- An anchor is placed in its shot (`at`: first, last or an offset); its frame is derived.
- A shot says how it follows the one before it (`join`: `cut` or `continuous`). Documents
  of version 7 are migrated: over a source clip their shots go on from one another, which
  keeps their takes joined the way they were; made from nothing, they stay cuts.
- A shot also says what the sound does at a cut (`sound`: `cut` or `continuous`). A
  document without it has `cut`, which is what was done before.
- Documents of version 6 are migrated: `@refN` and subject numbers become ids, anchors find
  their shots.
- The base model can be shown the first and the last frame of the clip only. A picture
  placed anywhere else is now held at its frame instead of being refused.

### Fixed

- A key typed into a field of the panel never reached the field's own key listeners.
- A take that repeated an earlier one exactly ended as "file missing" (it was served from
  ComfyUI's cache, which reports no output for the nodes of an expansion). Takes of one
  batch now carry a token in their file name.
- The preview area no longer holds 300 pixels of nothing when there is no source video.
- A media name that leads out of its folder (`..`, an absolute path) is refused by every loader
  of the package and by the routes that read files.
- A subject's pictures written as one name or as entries with a `file` are counted among the
  files whose change makes the node run again (they were skipped, so a picture replaced under
  its name could return the earlier result).
- A face refine made before a boundary was changed between a cut and a continuing shot is no
  longer shown as matching the clip.
- The face refine's report names the shots in which no face was found, like the others it
  left alone.

### Tests

- `tests/test_faces.py`, `tests/test_cuts.py`, `tests/test_splice.py`,
  `tests/material.mjs`, and a flow through the Edit page in a headless browser
  (`tests/shot.mjs`, `tests/ui_edit_flow.mjs`).

## 2.0.0

A general director console for MiniMax H3. Version 1 could do one thing — edit a source
clip with the reference model; version 2 covers every documented way of driving the model
through one clip document.

### The clip document (schema 6)

- No task modes. A clip stores a model family (`reference` for ref2va, `base` for fl2va)
  and material with a role: a source clip, subjects, reference videos and audio, anchors.
  Text to video, image to video, first/last frame, multi-keyframe, continuation, reference
  to video, motion reference and video editing are combinations of those.
- Anchors: an image, a short clip or audio held at any frame (`MiniMaxH3AddGuide`), with
  separate switches for pinning it and for citing it in the prompt. A clip anchor can be a
  rendered file, so a clip is continued straight from an earlier result.
- Subjects: `@ref1` in a prompt names the first subject; subjects with images become
  `<Subject N>`.
- The source clip is a reference video by default (an edit source, a continuation source
  or a motion reference, and the prompt's task type follows). It can also be the starting
  latent, for low-strength re-rendering or for re-rendering only some cells.
- Structured prompts in both official formats (three-field and six-section), or free
  text sent as written.
- Clip length and aspect ratio belong to the clip; documents from version 1 are migrated.
- Reference limits are errors: over-limit material is never dropped silently. That includes
  a tenth subject, with or without a picture: the planner numbers nine.
- A reference video is sent for at most 15 seconds, the source clip included.

### Time cells

- The cell grid follows the video VAE as measured: 17-frame cells from frame 0, and the
  5-frame cell last. Version 1 had the short cell first, which put every boundary 5 frames
  off.
- Time masks are built per latent frame, so a pinned cell next to a free one is untouched;
  the audio mask is built at the length of the track it goes on.

### Run presets (version 2)

- A megapixel budget instead of a width and a height, so one preset serves any aspect.
- `ref_video_edge` caps the size of reference videos, which dominate step time.
- `model` selects the node's new optional `model_turbo` input for few-step drafts.
- Timings are kept per clip length, against the preset a run was queued with. A timing is
  the node's own share of a run: loaders, nodes wired after it and other director nodes in
  the same workflow are not counted. A composite is not timed: it is another job than a
  render of the clip.
- Built-in presets follow the official templates: Draft, Standard, Final.

### Takes

- A candidate is always a whole-clip render; per-segment re-rolls are gone.
- A take or a composite runs its own node and the outputs wired after it, not every output
  node of the workflow: another director node in the same graph is left alone.
- One take picked for every shot is the final clip as it stands; a composite is only
  rendered when picks span takes, and only the cuts where the take changes are repaired.
- The seam repair has its own width and strength.
- A composite keeps the picked takes' sound outside the repaired cells.
- A take remembers the clip length it was rendered at, and a composite the picks and seam
  settings it was rendered from, so neither is shown as current when it is not.
- The render in progress is shown on the takes page and can be interrupted there. Only
  this clip's own runs are shown and timed: a render queued from elsewhere is told apart
  by the clip's id, even when its workflow has a node with the same node id.
- Takes and the final clip are shown at the clip's own aspect, uncropped.
- When the server refuses a take or a composite (a loader naming a file that is not there,
  say), the takes page shows the server's own reason.

### Node and graph

- The node is an output node and reports on its own run: loaders and this node are a
  complete workflow.
- New optional input `model_turbo`. The `upscale_model` input is gone.
- The expansion uses core nodes only, plus this package's frame loader, time mask and
  preview: `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo`, `MiniMaxH3AddGuide`,
  `LTXVSeparateAVLatent` / `LTXVConcatAVLatent`, `SetLatentNoiseMask`.
- The node works inside a subgraph: the panel knows it by the id ComfyUI runs it under.
- Sources at any frame rate are conformed to 24 fps when loaded.
- Negative prompt and CFG are available for presets that use them; cfg 1 samples with
  `BasicGuider`, as the official templates do.
- Model patches (LoRA, Fun ControlNet, FastH3 attention patches) are wired in front of the
  node and need nothing from it.
- With a sampler or a schedule wired into the node, the run report names them and the
  panel says which preset settings no longer apply.

### Removed

- The second sampling pass ("refine") and the upscale-then-resample stage. Feeding a
  finished render back into the sampler costs quality every time; the seam repair of a
  composite is the one place it is still done.
- The post-processing page and its unconnected face, mask and deblur stages.
- Citing the source clip's own first and last frame automatically: measured on two
  subjects, it changed nothing. Any image can still be cited at any frame as an anchor.
- The soft value for pinned mask cells.

### Panel

- Four pages: Run, Edit, Takes, Results.
- The shots section says how a spoken line is written (`@ref1 says quietly: the words`,
  `@voice(a described voice) says: the words`); the planner turns it into the guide's
  dialogue form.
- "Start over as" buttons set a clip up for one kind of job. "Edit a video" takes the
  video's length and aspect.
- The source clip can be picked from earlier renders as well as from the input folder; the
  panel says when part of the source is left over, or when it is shorter than the clip.
- The edit page shows what the model will read: a button compiles the prompt on the
  server with the same code a run uses.
- The denoise fields show the noise level they really start from.
- The live preview and the timings follow the runs queued from this page, and of those only
  this clip's own: a run of another workflow that holds a node with the same id is left out.
  A render that is going when the page is reloaded, or when the workflow tab is left and
  come back to, gets its preview back.
- When the connection to ComfyUI comes back after a crash or a restart, the takes page no
  longer says a render is going, and the takes that were running are settled.
- What the panel writes when no key or mouse is involved (a queued take, how it ended, the
  seed moved on after a batch) is in the workflow ComfyUI restores after a reload.
- English, Japanese and Chinese, including the list of what keeps a clip from running;
  the language follows the browser.

## 1.1.0

- Removed the dependency on other custom-node packages; the prompt planner and the live
  preview are bundled (see NOTICE).

## 1.0.0

- First version: one node for source-locked video editing with the reference model.
