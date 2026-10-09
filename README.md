# Gacha Director

**A director's console for MiniMax H3.** A ComfyUI custom node: one node on the canvas opens a tabbed panel for text-to-video, image-to-video, first/last-frame generation, multi-keyframe generation, continuation, reference generation and video editing.

Gacha in the name refers to random card draws in games: generate N takes at once, pick one per shot, then join them into a final clip, like a 10-pull.

English | [日本語](README_JA.md) | [中文](README_ZH.md)

![A generated clip of four shots: one shot is swapped for another take, the other three stay as they are](docs/hero.webp)

The full feature reel (70 s) and a promo made with the panel (15 s) are attached to the [latest release](https://github.com/excifroge/ComfyUI-GachaDirector/releases/latest).

> [!NOTE]
> **AI-Friendly**: [AGENTS.md](AGENTS.md) at the repository root is a handoff document for your AI. Give it to your own AI so it can explain the project and make changes.

<details>
<summary>Contents</summary>

- [What it solves](#what-it-solves)
- [Supported uses](#supported-uses)
  - [Sample clips](#sample-clips)
- [Installation](#installation)
- [Quick start](#quick-start)
  - [A complete example: turning live-action footage into a snowy scene](#a-complete-example-turning-live-action-footage-into-a-snowy-scene)
- [Node](#node)
- [Panel](#panel)
  - [Project page](#project-page)
  - [Edit page](#edit-page)
  - [Generate page](#generate-page)
  - [Post page](#post-page)
  - [Output page](#output-page)
- [Time cells](#time-cells)
- [How prompts are assembled](#how-prompts-are-assembled)
- [Connections upstream of the node](#connections-upstream-of-the-node)
- [Measurements](#measurements)
- [Known limitations](#known-limitations)
- [Development and testing](#development-and-testing)
- [Credits and license](#credits-and-license)

</details>

![The Edit page: one card per shot, with the shot description on the left and its pictures, videos and sounds on the right; two links between cards set how picture and sound follow the preceding shot](docs/en/edit-shots.jpg)

## What it solves

MiniMax H3 provides a set of official templates, each with a different node graph. Switching uses means switching graphs; comparing seeds, finding out how long a set of settings takes, or taking a section from each of two results all require you to build the setup yourself.

Gacha Director brings these into one node, organized around five things:

- **A tabbed workbench.** Like an editing application, its pages follow the workflow: Project → Edit → Generate → Post → Output.
- **Material organized by shot.** Each shot has a card containing what happens in it and the pictures, videos and sounds it uses. Material is numbered and declared to the model automatically during generation; you do not have to write those declarations in the prompt.
- **Run presets that record their cost.** A preset is a named answer to "how much am I willing to spend on this run?" Three are built in: `Draft` (draft), `Standard` (standard) and `Final` (final). Each records its measured run times separately for each clip length.
- **Takes → picks → final clip.** Queue N whole-clip takes at once, pick one for each shot, then click "Join" to produce the final clip. If every shot uses the same take, it is output as the final clip without regenerating it. Where takes change at a cut, they are spliced without generating anything again; where they change within one long take, only the seam is regenerated.
- **You decide whether to cut or keep the shot continuous.** On the Edit page, set whether one shot cuts to another or carries on as the same shot. Both the instructions sent to the model and the way the final clip is joined follow that choice. At each cut, separately choose whether sound switches with the picture or continues from the take used before the cut.

The panel uses everyday terms: resolution is width × height, length is seconds, and a picture is "the first frame of this shot." The panel calculates what the model needs: labels, declarations, a pixel budget and denoise adjusted for the schedule.

The node does not reimplement any sampling logic. At run time it expands into a set of ComfyUI core nodes; the core conditioning nodes, sampler and VAE do the actual work.

## Supported uses

H3's various "modes" are combinations of a few mechanisms. Gacha Director has you add material to shots and choose a **use** for each item rather than select a mode. The material determines the use. A read-only tag on each shot card ("text to video", "first / last frame", "reference to video"…) shows what the current material adds up to.

| What you add (material · use) | Resulting use | Model | Core nodes in the expansion |
|---|---|---|---|
| Text only | Text-to-video | fl2va | `MiniMaxH3ImageToVideo` |
| A picture for the first shot · "First frame" | Image-to-video | fl2va | Same as above, connected to `first_frame` |
| Add a picture for the last shot · "Last frame" | First/last-frame generation | fl2va | Same as above, connected to `first_frame` / `last_frame` |
| Last frame only | Last-frame generation | fl2va | Same as above, connected to `last_frame` |
| A picture · "Intermediate frame", or the first/last frame of an intermediate shot | Multi-keyframe generation | Either | A chain of `MiniMaxH3AddGuide` nodes |
| A video · "Video continuation" | Continuation | Either | `MiniMaxH3AddGuide` |
| A picture · "Subject reference" | Reference generation | ref2va | `MiniMaxH3ReferenceToVideo` |
| A video · "Motion/camera reference"; sound · "Character voice" or "Sound reference" | Motion, camera, voice and music references | ref2va | Same as above |
| Sound · "Original audio" | Put an audio clip into the final clip as it is | Either | `MiniMaxH3AddGuide` |
| Dialogue on its own line in a shot description (`@name says: …`) | Dialogue: the character speaks these words | Either | No extra nodes; dialogue is written into the prompt |
| Source video · "Video edit" | Video editing (the official approach) | ref2va | Same as above; the source video is `<Video 1>` |
| Source video · "Video continuation" | Continue from the end of this reference segment | ref2va | Same as above |
| Source video · "Source redraw" | Low-strength re-rendering / re-rendering only part of the clip | Either | `VAEEncode` + `LTXVConcatAVLatent`; add `SetLatentNoiseMask` when re-rendering only part |

These can be combined: for example, a source video to edit, plus a subject and a last-frame picture, is a valid clip setup.

In the Edit page's "Clip" section, the buttons after "Starting setup" provide shortcuts to these combinations. Selecting one replaces the existing material with what that use requires and keeps the prompt (a mention of material that was replaced becomes its plain name). The clip length and aspect ratio are also kept, except that "Video edit" follows the source video's aspect ratio and sets the clip to the longest valid length that fits within the source (up to 362 frames). For example, a 120-frame source gives a 107-frame clip, leaving 13 frames unused; a note above the timeline shows how many remain. To cover the whole source, change the length to 124; see the source video section on the [Edit page](#edit-page) for the trade-off. This can be undone.

### Sample clips

Each row shows one final clip for a different use, rendered with the `Standard` preset (standard model, 20 steps, 864×480), with 6 frames sampled at equal intervals. All use seed 7. Each use was rendered once, with no selection among results.

![Sample clips for different uses: text-to-video, image-to-video, first/last-frame generation, subject reference, reference-based continuation and ControlNet](docs/modes.jpg)

The same six clips playing side by side (reduced to 12 fps):

![Animation of the six sample clips](docs/modes.webp)

"Reference-based continuation" and "ControlNet" use the source video from [the example below](#a-complete-example-turning-live-action-footage-into-a-snowy-scene): continuation carries on from its last frame; ControlNet uses its contours, with the visuals determined by the prompt. The video-editing sample is in that example.

## Installation

Requires ComfyUI **0.39 or newer** (for `MiniMaxH3AddGuide`, H3 noise masks and H3 support in `LTXVConcatAVLatent`).

1. Place this repository in `ComfyUI/custom_nodes/ComfyUI-GachaDirector`.
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/excifroge/ComfyUI-GachaDirector
   ```
2. Restart ComfyUI. `Gacha Director v2.1.0: 10 nodes registered` in the log confirms installation.

There are no extra pip dependencies or dependencies on other custom-node packages. Prepare the model files as described in the [official ComfyUI tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3). The first time face refinement is used, the kornia bundled with ComfyUI automatically downloads about 400 KB of face detector weights.

## Quick start

`example_workflows/` contains two workflows with the same nodes and connections, different models, and a starter prompt in each:

| Workflow | Model | Suitable for |
|---|---|---|
| `GachaDirector_Base.json` | fl2va | Text-to-video, image-to-video, first/last-frame generation, multi-keyframe generation, continuation |
| `GachaDirector_Reference.json` | ref2va | Reference generation, video editing, multi-keyframe generation, continuation |

Open either one, point the four loaders and the acceleration LoRA loader to your own model files, then:

1. Click **Open Gacha Director** on the node.
2. On the **Edit** page, write what happens in each shot. Add material with "+ Picture / + Video / + Sound" on the right of its card, or use the buttons after "Starting setup" in "Clip".
3. Select a preset on the **Project** page (`Draft` / `Standard` / `Final`). It shows the frame size and how long that preset takes to run.
4. Click "Generate N take(s)" on the **Generate** page (set N under "Batch takes" on the Project page), or use ComfyUI's own run button to render one clip.

> [!IMPORTANT]
> The `Draft` preset uses the fast model, connected to the node's `model_turbo` input. The example workflows already connect the model through an acceleration LoRA. If you do not have that LoRA, delete its loader node (leave `model_turbo` unconnected) and either avoid `Draft` or change `Draft`'s model setting to "standard model".

### A complete example: turning live-action footage into a snowy scene

The source video is 124 frames of live-action footage: two people talking on a bridge in the open movie *Tears of Steel*. The goal is to change the season to a snowy winter while keeping the people, action and camera work unchanged.

1. Open `GachaDirector_Reference.json` and click **Open Gacha Director** on the node.
2. In "Clip" on the **Edit** page, click "Video edit" after "Starting setup" and select the source video. The clip length becomes 124 frames and the aspect ratio follows the source. "Source usage" defaults to "Video edit", and "Source redraw" is off; leave both as they are.
3. Fill in four text fields. Describe the desired changes in the shot and what to retain under "Keep/change description" for the source video:

   | Field | Content |
   |---|---|
   | Overall description | `The target video is live-action film footage in heavy snowfall.` |
   | Shot description | `The scene of <Video 1> now takes place in deep winter: thick snow is falling, the trees are bare and white, snow lies on the bridge railing, the street and the rooftops, and the light is cold and blue. The two people, their clothes, their movements and the camera are the same as in <Video 1>.` |
   | "Keep/change description" under the source video's "More" | `the people, their motion and timing, the camera and the composition of <Video 1> are kept; only the season and the weather change` |
   | Ambient sound | `Muffled winter air, soft wind, snow hissing on stone.` |

   A source video used for editing is `<Video 1>` in the prompt; you can write that directly. "Clip summary" can be left empty: the task type and the opening sentence "The target video is an edited version of `<Video 1>`" are added automatically.
4. Click "Final prompt" to see the text actually sent to the model:

   ```text
   subject_definitions:
   <Video 1> is the source video for the target video edit.

   summary: [video editing] The target video is an edited version of <Video 1>.

   retention_analysis:
   <Video 1> (motion and camera work): fully_preserved - the people, their motion and timing, the camera and the composition of <Video 1> are kept; only the season and the weather change.

   detailed_description: The target video is live-action film footage in heavy snowfall. [Shot 1] The scene of <Video 1> now takes place in deep winter: thick snow is falling, the trees are bare and white, snow lies on the bridge railing, the street and the rooftops, and the light is cold and blue. The two people, their clothes, their movements and the camera are the same as in <Video 1>.

   overall_soundscape: Muffled winter air, soft wind, snow hissing on stone.

   non_diegetic_music: N/A
   ```

5. On the **Project** page, first select `Draft` to check the direction (4 steps, about 2.5 minutes), then switch to `Standard` if it is right (20 steps, 864×480, about 12.5 minutes). These times were measured on a single GPU with 24 GB of VRAM.

![Video-editing example. Top: source video; bottom: final clip from the Standard preset](docs/example-edit.jpg)

The same comparison in motion (left: source video; right: final clip):

![Animation of the editing example: source video on the left, final clip on the right](docs/example-edit.webp)

## Node

![The node on the canvas with its loaders](docs/en/node.jpg)

**Inputs**

| Name | Type | Description |
|---|---|---|
| `model` | MODEL | The H3 diffusion model. Connect ref2va for the reference model, fl2va for the base model. |
| `clip` | CLIP | `CLIPLoader` with type `minimax`. |
| `vae` | VAE | H3 video VAE. |
| `audio_vae` | VAE | H3 audio VAE. |
| `model_turbo` | MODEL, optional | The same model with an acceleration LoRA, or a distilled model. Used when the preset's model is set to "fast model (turbo)". |
| `sampler` | SAMPLER, optional | When connected, overrides the preset's sampler. |
| `sigmas` | SIGMAS, optional | When connected, overrides the preset's scheduler and step count. |

The node shows only four things: the preset selector, `seed` (with ComfyUI's built-in "control after generate"), read-only metrics (frame size, frame count, steps and measured run time for this preset at this clip length), and the button that opens the panel (with the UI language switch beside it). Everything else is in the panel.

**Outputs**: `frames`, `audio`, `fps`, `frame_count`, `source_frames`, `latent`, `positive`, `model`, `prompt` (the prompt actually sent to the model), `run_report` (a summary of this run).

## Panel

Pages show only names and values. Explanations are in tooltips: hover over a parameter, button or heading for half a second to see them.

### Project page

![The Project page: presets on the left; resolution, frame rate, length and expected time at the top right](docs/en/project.jpg)

The preset list is on the left. Each entry shows the frame size it produces for the current clip, its step count and model. The selected preset is on the right, with four numbers at the top: **Resolution** (width × height), **Frame rate** (24 fps, "fixed"), **Length** and **Expected time** (the measured average for this preset at this length).

| Setting | Description |
|---|---|
| Resolution | A set of sizes, shown as the actual width × height at the current clip's aspect ratio. A preset stores a pixel budget rather than width and height: the aspect ratio belongs to the clip, so the same preset works for landscape and portrait. "Standard (official template)" is the official template size (864×480 at 16:9); "Native (training resolution)" is the training size (1344×768). |
| Resolution · "custom…" | Enter width and height directly, for example for a square frame. The model accepts only multiples of 32; other values show the nearest size that will be used (720 × 720 becomes 736 × 736). Width or height outside 256 to 2048 pixels is flagged in red and cannot be applied. A custom size also changes this clip's aspect ratio to match; choosing another size from the list afterwards keeps that ratio. |
| Steps | 20 is the official default; the fast model uses 4 or 8. |
| Model | "standard model", or "fast model (turbo)" (the node's `model_turbo` input). |
| Batch takes | How many takes one press of Generate queues. |
| Reference material size | How far reference videos are scaled down, and whether reference pictures are scaled down. This affects the reference model's speed, not the final clip's resolution. Reference videos take part in every step, making this the biggest factor in speed when a clip has one. |
| Advanced | Pixel count (MP), Guidance (CFG), Sampler, Scheduler, Schedule shift · picture / Schedule shift · sound (default 12 / 3), and Save VRAM. Official defaults are CFG 1, `res_multistep` / `simple`. |

The preset's timing history is below. For takes, run time is recorded against the preset and clip length **at queue time** (at execution start, if the page was reloaded while the take was waiting); runs launched with ComfyUI's own run button use those **at execution start**. If preset parameters change during a run, that run's timing is not recorded. By default, changing parameters clears the old records, since they no longer describe those settings. What is timed is this node's own share of a run: a loader reading a model from disk, nodes wired after it and other director nodes in the same workflow are not counted. Joining and face refinement are not timed: they are different jobs from generating a clip (measured on the same clip and preset: about 128 seconds for joining, about 100 seconds for a take), and recording them would skew the preset's timings.

> [!NOTE]
> `Draft` and `Final` do not produce the same clip. Changing the frame size changes the noise, so the same seed gives different results. Use `Draft` to judge whether the prompt and material are going in the right direction, rather than to choose a seed.

### Edit page

![The upper part of the Edit page: preview, timeline and clip settings](docs/en/edit-timeline.jpg)

The preview, timeline and playback controls are at the top. A line above the timeline shows the clip length (seconds, frames and frame rate), frame size, step count, shot count and the generation type determined by the current material. Below are the clip, shared material and shots, in that order.

**Clip**

- **Model**: Reference model (ref2va) or Base model (fl2va). The reference model accepts people, videos and sounds as reference material; the base model's conditioning inputs are text and the first and last frames of the whole clip. Material held on frames (in-between pictures, videos set to "Video continuation", and audio played as it is) is added separately and works with either model. The page explains when material does not match the model.
- **Length**: Press 5 / 10 / 15 seconds, or enter a number of seconds; it snaps to a length the model can use (so what you typed may change a little; the frame count is shown beside it). The core node gives a trained range of roughly 5 to 15 seconds (124 to 362 frames). Longer values are accepted, but fall outside the range the model was trained on.
- **Aspect ratio**: "Source aspect ratio", or specify a ratio.

![Shared material on the Edit page: overall description, ambient sound, and pictures, videos and sounds available to every shot](docs/en/edit-shared.jpg)

**Shared material**: put material available to every shot here. On the left are Overall description (the style and scene of the whole clip), Ambient sound, Music and Clip summary; on the right are shared pictures, reference videos and sounds. The source video is at the bottom. Material that appears in only one shot belongs in that shot's card. The reference model accepts up to 9 pictures, 3 videos, 3 audio clips and 12 files in total per clip; a line at the top of this section shows the current usage.

**Shots**: divide the clip into sections, each with a card. On the left, describe what happens in that shot; on the right, add its pictures, videos and sounds. These correspond to `[Shot 1]`, `[Shot 2] At 00:02.833, …` in the prompt and are not generated separately. Shots with neither text nor their own subjects or references are omitted from the prompt; only those included in the prompt count toward its numbering. A navigation strip to the left of the cards is divided in proportion to shot length; click a section to jump to that shot.

Each material item has three things: a thumbnail, a name and a **use**. Its use determines what it means to the model:

| Material | Use | Meaning |
|---|---|---|
| Picture | Subject reference | The person or thing in the picture appears in the video. It defines appearance without fixing a particular frame. Subjects with pictures are shown to the reference model; the base model has no reference-image channel and uses only their text descriptions. |
| | First frame / Last frame | The shot opens on / ends on this picture. |
| | Intermediate frame | The specified frame within the shot becomes this picture. |
| | Storyboard frame (composition reference) | Shows the composition to the model without fixing a frame to the picture (reference model). |
| Video | Motion/camera reference | Follows the video's movement and camera work (reference model). |
| | Video continuation | Holds a short stretch of this video (5 / 22 / 39… frames, with optional sound) at the start of the shot; the model generates onward from it. At the start of the first shot, this provides continuation. |
| Sound | Character voice | The selected subject speaks with this voice (reference model). |
| | Sound reference | Follows its timbre or musical style (reference model). |
| | Original audio | This sound plays as it is from the start of the shot in the final clip. |

The small triangle on the right of a material row opens "More settings": subject kind, description, short name and multiple pictures; how closely material is kept ("Fully preserved", "Mostly preserved", "Attribute transfer", "Loose reference"); which stretch of a video to take; and so on.

**Media library.** The "Media library" button at the right of the top bar opens a floating window from any page. It can be moved and resized, stays in place when switching pages, and remembers its position and size in the browser.

![The media library window: Imported and Generated categories, type filters and custom folders; material can be dragged onto a shot's material area](docs/en/library.jpg)

- **Two categories**: *Imported* lists files in ComfyUI's `input` folder; *Generated* lists generated files in `output`, newest first. Both can be filtered by "Pictures" / "Videos" / "Sounds" and searched by file name.
- **Folders**: create folders and subfolders on the left. Double-click to rename; drag items onto a folder to file them, or onto "Unfiled" to remove them from it. These are virtual folders for organising the library: files on disk are neither moved nor renamed, so other workflows can still find them. The organisation is stored in ComfyUI's user data and shared across workflows.
- **Using material**: drag items from the window onto a shot card's material area (adds them to that shot) or shared material (available to every shot). Hold Ctrl or Shift to select and drag several items together. The "+ Picture", "+ Video" and "+ Sound" buttons open the same window filtered to suitable types; click an item to add it.
- **Importing from your computer**: click "Import from this computer..." or drop files into the window. Imported items go into the open folder. Files can also be dropped directly onto a shot's material area, shared material or the source video area (a dropped video becomes the source). Files are copied to `input` through the same upload path as ComfyUI's own uploader; ComfyUI renames new files when names collide. Dropping elsewhere on the panel does nothing and does not pass the files through to the ComfyUI canvas behind it.

The media library for "Video continuation" also lists generated final clips, so continuation can use a previous result directly. The "Video continuation" recipe places the selected video's last 22 frames at the start of the first shot. The new clip's first 22 frames are held to the previous clip's tail (very close, but not pixel-identical), so a 124-frame clip contains 102 frames (4.25 seconds) of new content. Trim the overlapping 22 frames when joining the clips.

![Typing @ in a prompt opens a list of material you can name](docs/en/edit-mention.jpg)

**Montage or long take: separate links for picture and sound.** Two chain icons between each pair of shot cards set how the lower shot follows the one above. The left controls picture, the right controls sound. Linked icons are bright; unlinked icons are dim. Click to toggle.

Picture:

- *Unlinked = cut (montage)*: cuts to another shot. It becomes a new `[Shot N] At <time>` section in the prompt.
- *Linked = continuous (long take)*: continues the same shot without a cut; the sections only let you describe and pick them separately. Consecutive sections become one `[Shot]` in the prompt, with their descriptions joined into a paragraph in order (dialogue stays on separate lines). The official prompt format has times for cuts, but no notation for when something happens within a shot. Events within a long take therefore follow the order of the text; the model decides their exact timing.

Sound (only meaningful at cuts):

- *Unlinked = switches with picture*: after a cut, uses the sound from the take picked for the new picture. This is the default.
- *Linked = continuous*: after a cut, keeps using the sound from the take used before the cut, even when the picture switches takes. With several consecutive sound links enabled, sound continues from the earliest take.
- When picture is linked (a long take), sound always continues with it. The sound link is shown as linked and locked.

Sound links do not affect generation: each take still contains picture and sound for the whole clip. They only decide which take supplies the sound for each frame of the final clip, so the difference is audible only when **different** takes are picked on either side of a cut. They do not change the picture's cut frame.

A new boundary defaults to a cut in a clip generated from scratch, and to continuous in a clip with a source video (the source is already continuous there). On the timeline, a cut is a solid diamond; a section boundary within a long take is a hollow diamond with a horizontal line. In the left navigation strip, a section that continues the previous one has a dashed boundary with it.

Older workflows do not have these two settings. When one is opened, the shots of a clip with a source video are treated as one long take (such clips always had their takes joined by regenerating the seam, so nothing changes for them), and the shots of a clip generated from scratch as cuts. Sound always switches with picture, as before.

![The two links between shot cards on the Edit page: picture on the left, sound on the right](docs/en/edit-join.jpg)

**No manual numbering.** Material labels (`<Subject 1>`, `<Picture 2>`, `<Video 1>`…) and declarations such as "this picture is the first frame of shot N" are added automatically during generation. To say who does what, type `@` in the prompt and pick a material name from the list (the shot's own material comes first; Up/Down and Enter also work), or click the `@` button on a material row to insert its name at the cursor. Renaming, changing a use or removing material updates the prompts too. Subjects, reference videos and sound references belonging to a shot but not named in its description get an automatic sentence, such as "it appears in this shot". First/last-frame pictures already have their own declarations; a character's voice is declared with its subject. "Final prompt" shows the assembled text and refreshes when the content changes.

Material held on frames follows its shot: after dragging a boundary, "First frame" is still that shot's first frame; when inserting or deleting a boundary, the material stays on its original frame. Its timeline markers are read-only.

**Source video** (optional, at the bottom of shared material): the source plate for the whole clip. Select it from the input directory or use a generated final clip. "Source usage" has four choices:

- *Video edit* (reference model, default): the official video-editing approach; the model sees it as `<Video 1>`.
- *Video continuation* / *Motion/camera reference*: also sent as `<Video 1>`, with a different role. The reference is the part of the source video beginning at the start frame and matching the clip's length. To continue from another part, change the start frame under "More".
- *Source redraw*: used only as the starting frames.

"Source redraw", under "More" (the base model has no reference channel, so this is its only use for a source video): starts from the original video's frames, adds noise and generates over them. The percentage beside "Change amount" is the calculated share of starting noise (see [Measurements](#measurements)); to keep the original composition, it must be well below 100%. This is required to redo only part of the clip.

If the source video, counted from the start frame, is shorter than the clip, its last frame is held for the missing part. The final clip also comes to a stop at the end (in a test with 4 frames missing, the final clip gradually stopped over its last roughly 6 frames).

> [!NOTE]
> Video editing does not require "Source redraw". In tests, using the source video only to edit it and starting from scratch already followed its composition, movement and camera work. Adding repainting over the original (Change amount: 0.85) produced almost the same clip, only more slowly.

**Partial redraw** (shown only with "Source redraw" enabled): choose which [cells](#time-cells) to regenerate; the rest are kept as they are. The sound in those cells is kept too, when the source has a sound track.

**Dialogue**: H3 generates visuals and sound together, so characters can speak. Write each spoken line on its own line in the shot description:

```text
@girl pulls down her scarf and looks straight at the camera.
@girl says quietly: I have been looking for you.
```

`@girl` is the subject named girl, with or without pictures. For a voice that does not belong to a subject, write `@voice(a warm elderly male voice) says cheerfully: Good morning!`. Before the colon is the delivery; after it are the spoken words. English is the default; for another language, add a tag such as `[Japanese]` immediately after `@girl` or `@voice(…)`. The model receives the official guide's format: `<Subject 1> (S1) says quietly, <d>[English] I have been looking for you.</d>` (`<Subject 1>` when the subject has pictures; a text-only subject appears there as its description or short name). The same speaker keeps the same `(S1)` across shots. Writing `@girl says "…"` (without a colon) is not treated as dialogue; "Final prompt" shows a reminder. To have a subject speak in a specific voice, add an audio clip, choose "Character voice" and select that subject. The audio becomes its voice reference; the words still come from the prompt.

**Advanced** (collapsed at the bottom of the page):

- *Prompt format*: "structured (official layout)" (assembled in the official format; see [How prompts are assembled](#how-prompts-are-assembled)) or "free text" (sent as written, for LoRA trigger words or a complete prompt you write yourself; shot descriptions are not sent and material names are not replaced).
- *Negative prompt*: used only when the preset's Guidance (CFG) is not 1. The official templates all use CFG 1, with no negative branch.

### Generate page

![The Generate page: sequence preview at the top, followed by the generation button, final clip and the first shot's take pool](docs/en/generate.jpg)

![The Generate page: a pick for each shot, independently adjustable card sizes, and navigation on the left divided by shot length](docs/en/generate-shots.jpg)

At the top is **Sequence preview**: it plays the picked section of each shot in order, without using the model. Unpicked shots show "Shot N · not picked" for their duration. Take changes within a long take are hard cuts in the preview; transitions are generated when joining. When a final clip is available ("Join" has completed and neither the picks nor seam settings have changed since), the preview plays that final clip. It is linked to the timeline below: the red playhead follows playback, dragging on the time ruler seeks the preview, and clicking a shot on the timeline scrolls to that shot's takes. Sound is off by default: the ♪ button on a transport is the sound switch, shared by every player in the panel. With it on, each section of the preview plays the sound of the take it comes from.

![The seam range strip below the Generate page timeline: where takes change within a long take, a bar with draggable ends marks the range to regenerate](docs/en/generate-seam.jpg)

**Seam range strip.** When consecutive sections of a long take use different takes, a strip appears below the timeline with a bar at the seam. Joining regenerates the range marked by that bar; the rest of the picture comes from the picked takes.

- The default is **auto**: starts a little before the seam and ends at the end of the cell containing it. It targets at least 12 frames; the actual range is 12 to 21 frames, depending on where in its cell the seam falls. When the seam is exactly on a cell boundary, only the preceding 12 frames are regenerated; none from the following take are redrawn. Near the start of the clip or a long-take boundary, the range can be shorter. See [Time cells](#time-cells) for why it ends on a cell boundary.
- Drag either end of the bar to set the range. The ends snap to the fine lines on the strip: latent-frame boundaries, five per cell, with intervals of 1 frame and four groups of 4 frames. Longer lines mark cell boundaries. The readout beside the bar shows how many frames are regenerated before and after the seam.
- Amber indicates a range that may be less reliable: under 12 frames, or with its right end off a cell boundary (the next 1–2 retained frames can show measurable changes). Amber is a warning; joining is still allowed.
- Double-click the bar to restore the automatic range. The range stays within the long take; the tooltip explains when a boundary shortens it.
- "takes alike: N dB" beside the bar measures how close the two takes are over 8 frames on each side of the seam (PSNR on reduced-size frames). A red reading, below about 22 dB, indicates a large difference here and possible seam repair failure. This is only an advisory threshold and has not been calibrated (see [Measurements](#measurements)).
- If two seam ranges overlap, click the small triangle above a seam to bring its bar to the front.
- Seams already present in older workflows keep the previous range, one whole cell on each side, until dragged or double-clicked.

1. **Generate N take(s)**: queues N whole-clip generations with incrementing seeds. Set N in "Batch takes" beside the button; it is the same setting as in the preset on Project. A live preview appears at the top during generation; interrupt it immediately if it is going wrong. Only this node and the output nodes wired after it run; other director nodes and unrelated save nodes in the workflow are left alone.
2. **Pick**: each shot has a section, with a player on the left and every take's version of that shot on the right. Pick one per shot. Click a card to play it on the left. Below the player, "Apply to all" applies the take you are viewing to all shots, or you can delete it (a take is one generation of the whole clip, so deleting it removes it from every shot's pool; its file stays in the output directory). Cards wrap to fit the row; scroll down within the pool when there are more. Each shot has its own "Preview size" slider to the right of its heading; the minimum switches to a list. Cards and the player show the shot from that take's actual cut-in to its actual cut-out, rather than trimming at the requested frame numbers (the model's cuts can be several frames off; see [Measurements](#measurements)). A stationary card shows the middle of the shot; hovering plays it from the start. A narrow navigation strip on the left has one section per shot, with height proportional to shot length. Colors show status ("Picked" / "Has takes" / "No takes"); a red line marks the position on the timeline above. The strip scales with the window height; click a section to jump to that shot.
3. **Final clip**: after every shot has a pick, this section shows "Join". Click it to produce the final clip as a separate file, listed on Output; afterwards, "View output" appears here. What the button does depends on the picks:
   - Every shot uses the same take → outputs that take directly as the final clip, without using the model. It is re-encoded once, taking two or three seconds.
   - Takes change only at cuts → the sections are spliced without passing through the model, taking a few seconds. Joins follow each take's **actual** cut frame, not the requested frame number. When the earlier shot's take cuts before the later shot's take does, the frames in between belong to neither shot and are removed, so the final clip may be a few frames shorter than the document; the other way round, there are frames on which both takes agree, the join is made there and the length stays. Afterwards, this section shows the actual length; "Join log" records how each cut was handled. By default, sound switches to the new take on the same frame as picture. At cuts with sound linked, it continues from the take used before the cut (the join log says `the sound stays with …`).
   - Takes change within a long take → regenerates a short range around the seam, set in the strip described above. The rest, including sound, comes from the picked takes without being generated again, passing only through one encode/decode round trip (see [Known limitations](#known-limitations)). The regenerated range stays within that long take and does not touch any take's actual cuts. Set the regeneration strength on the [Post page](#post-page). Cuts in the same job are still spliced directly.

> [!NOTE]
> Takes have no "regenerate only this shot" operation. The model must compute the whole clip each time. Recomputing one shot costs as much as generating another take and uses generated frames as the starting point for another generation. To try again, generate another take. (Redoing only a few cells of a **source video** is a separate operation: "Partial redraw" on the Edit page.)

Shots separated by hard cuts can freely mix takes. Within a long take, the two takes must look alike at the seam; the strip's similarity reading measures this. Takes sharing a source video, or the same first, last and in-between frames, usually move alike and can be joined; seam regeneration can smooth the jump. This is not guaranteed: in one measured pair sharing a source video, the seeds gave the same scene very different lighting and colour, and none of the tested ranges and strengths joined them smoothly. Unconstrained text-to-video takes are different videos. Regenerating the seam cannot connect them, and the picture still jumps at some frame (see [Measurements](#measurements)).

Takes record the clip length they were generated at: changing the length makes old takes unpickable. Takes also record how the clip was divided into shots at the time (where the cuts are, which shots form one long take). After the division changes, old takes can still be picked, but the Generate page marks them and says so: the cuts in them are still where they were then and will not move. For takes that follow the current division, generate again. A joined clip records which picks it used: changing the picks means the old joined clip is no longer shown as the final clip.

### Post page

What you can do after a final clip is ready, and how to view and save it.

![The Post page: how the final clip is joined, and seam settings](docs/en/post-join.jpg)

**Joining**: joins the picked take for each shot into one clip. This section lists cuts to splice directly, seams within long takes to regenerate, and cuts where sound continues from the preceding take. Click "Join" here to run it; without seams to regenerate, the model is not used. When seams need regeneration, "Retained frames" shows how many frames in each shot will still come from its picked take. The remaining frames are within the regenerated ranges and will be replaced by new frames. A short section between two seams within a long take may be covered entirely; it is flagged in red as "No retained frames". A long take too short to contain the required range has an unrepairable seam, also flagged in red. The two settings below apply only to seams within long takes (both are grayed out when all take changes are at cuts):

- *Seam range*: lists the number of frames regenerated before and after each seam. Set the range by dragging its ends in the strip below the [Generate page](#generate-page) timeline; it is read-only here.
- *Seam strength*: 1 (default) regenerates the range from scratch. Lower values retain more of the original frames from the two takes. When redrawing two whole cells, 0.3 also smoothed the seam in one similar pair; with the automatic 12-frame range, 0.3 worked less well than 1 (see [Measurements](#measurements)). The calculated share of starting noise appears beside it. (With an external schedule connected to the node's `sigmas` input, strength has no effect.)

![The Post page: face refinement before and after, side by side, both zoomed in on the face](docs/en/post-face.jpg)

**Face refine**: a face that is small in the frame gets few pixels and can blur or break down. This step crops the region around the main face in the final clip, regenerates it at a size where the face has enough room, then pastes it back. No pixels outside that region change. Sound comes from the final clip, and the clip before refinement is kept as it was. The two versions play side by side, with synchronized playback and frame stepping. Click either picture to zoom both into that position (as in the screenshot); click again to reset.

- *Face reference*: choosing a person from the material uses their pictures as references for regeneration (reference model).
- *Target shots*: defaults to "automatic (faces of about 24 to 80 px)". Smaller faces have too few pixels to retain detail when pasted back; larger faces are already clear, and regeneration only replaces them with another face. Click shot numbers to refine only those shots, regardless of face size. Shots without a detected face are left alone. If no shot qualifies, the run fails and the page explains why each shot was skipped.
- *Strength*: 85% by default. Below 70%, this model reconstructs almost the original picture, so the value is much higher than intuition suggests (see [Measurements](#measurements)).
- Longer stretches where no face is found (the person turns away or leaves the frame) are not pasted back; a gap of a few frames is bridged, and processing resumes when the face returns.
- Only one face per shot is processed: the one present longest. Different shots may select different people. "Face reference" only supplies reference pictures for regeneration and does not select the detected face. In clips with several people, use "Target shots" to keep only shots where that person is the main subject.
- Uses the active preset: the face region is generated as a square with the preset's pixel budget (`Standard` gives 640×640). Refinement takes about as long as generating a clip.

**Live preview** and **Saving** (file name prefix, file format, video codec) apply to every run of this node and do not belong to a preset.

### Output page

Reads this clip's run results from ComfyUI's history (the most recent 40 entries): clips from direct runs, joined final clips and face refinement results, each with its run report and the prompt sent to the model at the time. A final clip whose takes were only cut together, with nothing generated again, is labeled "Cut together (N shots; no regeneration)" and shows no steps or seed (that run generated no picture). Takes are not listed here; they are on the Generate page. After the clip's content (material, prompt or regenerated ranges) changes, old results are marked "The clip has changed since generation; this result is out of date.". Face refinement results are not marked here; the Post page says whether the last one still matches the clip. Changing only the preset or seed does not count. For joined final clips, regenerated ranges are not compared here; the Generate page marks a joined clip as stale when seam settings or picks change.

## Time cells

H3's video VAE independently encodes blocks of 17 frames from frame 0, with the remaining 5 frames at the end. A 124-frame clip therefore has 7 cells of 17 frames (0–16, 17–33…102–118), plus 1 final cell of 5 frames (119–123).

A cell contains 5 latent frames: its first video frame occupies one, and the following 16 frames are grouped in sets of 4. The short final cell contains 1 + 4 video frames, or two latent frames. Masks operate on latent frames, so **the smallest unit that can be kept or regenerated independently is one latent frame (4 video frames; the first one in each cell holds only 1), not a cell**.

Cells matter during encoding. Each cell is encoded independently and causally: later latent frames depend on earlier pictures in that cell, not on subsequent cells. This gives a measured rule (see [Measurements](#measurements)): **a regenerated range is best ended on a cell boundary**. If it ends inside a cell, the retained latent frames that follow in that cell were encoded from earlier pictures that have now been replaced, so they no longer match. In the tested pair of takes, the next 1–2 frames were 3–5 dB further from the original take, and a range extending only 1 frame into the next cell failed to close the seam. The range's starting point does not have this restriction. Decoding has no cell boundaries: the decoder reads 7 latent frames at once and blends 5 frames between adjacent windows. "Retained" therefore means "not regenerated", not "pixel-identical". Near a regenerated range, retained frames from two runs matched at only about 38 dB; the difference was not visible.

The timeline's cell strip, used for "Selected cells", selects whole cells. It appears only with "Source redraw", because only then can cells be "Kept" (every cell is redrawn when generating from scratch). Seam ranges within long takes are selected by latent frame; see the strip on the [Generate page](#generate-page). Montage cuts have no relation to cells: nothing is regenerated there.

## How prompts are assembled

Structured mode follows MiniMax's two official prompt-writing guides:

- **Base model**: three fields, `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`. With a first frame, last frame or both, the official fixed image-alignment sentence is prepended.
- **Reference model, with material to declare**: six sections, `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`. The task types at the start of `summary` (`reference generation`, `video editing`, `video continuation`, `keyframe completion`, `audio reuse`, `audio reference`) are derived from the material's actual roles. You write the following sentence or two yourself ("Clip summary" in the panel). When a source video is used for editing or continuation, the official opening sentence is added automatically, so the field can be left empty. If it is still empty after automatic additions, "Final prompt" shows a reminder.
- **Reference model, without any material to declare**: the same three fields as the base model.

This is the format's structure: empty fields are omitted, except that empty music is written as `non_diegetic_music: N/A`. For example, leaving Ambient sound empty removes `overall_soundscape`; "Final prompt" reminds you that the official guide lists it as required.

**Numbering is automatic.** Subjects with pictures become `<Subject 1>`, `<Subject 2>`… in list order. Their pictures take the first `<Picture N>` numbers, followed by declared first, last and in-between frames and storyboard frames in chronological order. Videos follow list order (a source video used for editing, continuation or motion is `<Video 1>`). Audio lists enabled reference-video soundtracks first, then standalone audio. `@name` in your prompt is replaced with the corresponding label; text-only subjects do not use a number, and `@name` is replaced directly with their description. In the base model, only subjects can be named, and the model can only "see" the whole clip's first and last frames. Pictures elsewhere are held at their frames but do not appear in the prompt.

The bundled upstream planner handles this part (see [NOTICE](NOTICE)).

Official reference limits are 9 pictures, 3 videos (no more than 15 seconds in total), 3 audio clips (including reference-video soundtracks) and 12 files in total. There can be at most 9 subjects, including those without pictures. Excess counts are reported on the page and reject the run. Durations are known only after reading the files and are checked in "Final prompt" and when the run starts. Each reference video (including the source video) is read only up to the clip's length and sent for at most 15 seconds; longer segments are shortened with a warning. If the segments actually sent total more than 15 seconds, the run is rejected. It is rejected rather than silently dropping a reference, because dropping one would shift every subsequent label.

## Connections upstream of the node

The node loads no models. An upstream loader reads the diffusion model and passes it through the `MODEL` input. Anything that patches the model therefore goes upstream of `model` / `model_turbo`; the panel does not need to know about it:

- **LoRA, acceleration LoRA**: `LoraLoaderModelOnly`.
- **Fun ControlNet Union** (the official approach to structural control / local re-rendering): `ModelPatchLoader` + `Apply MiniMax H3 Fun ControlNet`; connect its output to `model` (also connect it on the `model_turbo` branch if using `Draft`). Prepare the control video at 24 fps, starting at the clip's first frame. The patch adapts it to the clip's length and frame size.
- **FastH3** (FastVideo's 8-step distilled model): `UNETLoader` → `ModelAttentionBackend` → `BlockSparseAttention`, connected to `model`. Set the preset to 8 steps and schedule shift to 10 / 3.

## Measurements

These numbers come from development tests (ComfyUI 0.39.0). They illustrate behavior, not guaranteed performance.

How these were measured: PSNR between two videos is calculated per frame, then averaged; "frame-to-frame change" is the mean absolute pixel difference between adjacent frames. The long-take seam measurements use `tests/measure_seam.py` (given two takes, the joined clip and the seam frame); cell independence uses `tests/measure_vae_cells.py`. Unless stated otherwise, these use draft settings (acceleration LoRA, around 672×384, 124 frames). Each number comes from one run; no statistics across multiple seeds were collected.

**"Change amount" is not linear.** The model's schedule has a shift. With the panel's own schedule, shift s and denoise d give a starting noise fraction of s·d / (1 + (s−1)·d). With external `sigmas` connected, Change amount has no effect; the starting level is determined by the sigma you supply. The panel then hides this percentage, and the run report says `external sigmas`:

| Change amount (shift 12) | Starting noise |
|---|---|
| 0.85 | 98.6% |
| 0.70 | 96.6% |
| 0.30 | 83.7% |
| 0.15 | 67.9% |
| 0.05 | 38.7% |

To keep most of the original clip, set Change amount much lower than intuition suggests. The panel displays this percentage beside it; face refinement's "Strength" takes this percentage directly. In tests with the base model, 0.7 produced a completely different clip; 0.3 preserved composition and movement while regenerating details; 0.15 was almost identical to the original.

**The same seed does not guarantee the same clip.** Running the official template twice without changes gave a per-frame PSNR of only 19–20 dB between the results. The difference between Gacha Director and the official template was of the same order. To keep a result, keep its file.

**Seam regeneration within a long take (takes sharing a source video).** Two takes sharing a source video were spliced at a cell edge. With a direct hard cut, frame-to-frame change at the seam was 1.7 times the usual level; regenerating the seam brought it back to the usual level. Cells kept without regeneration differ from the picked takes by 31–34 dB (the loss from one VAE encode/decode round trip). Lowering strength from 1 to 0.3 still smoothed the seam while keeping the regenerated cells closer to the picked takes.

**The model misses cut times, so clips are spliced at their actual cuts.** A cut in the prompt is a time (`[Shot 2] At 00:02.833`), which the model does not execute frame by frame. Of 8 two-shot, 124-frame text-to-video clips, 4 had the hard cut at the requested frame, 3 were 1 frame late and 1 was 1 frame early. More shots and longer clips produce larger offsets: 8 draft takes with four shots and 243 frames (about 10 seconds) requested cuts at frames 61, 122 and 183. The first cut was 0–3 frames late, the second 4–8 frames early and the third 1–9 frames early. One `Standard` run of the same clip cut 2, 11 and 13 frames early, so this is not a draft-preset issue. A three-shot, 362-frame (15-second) draft cut 6 and 18 frames early. Starting each shot after a cut with "The shot cuts.", or writing it the way the official examples do ("the camera cuts to …"), did not bring the cuts nearer (the first four seeds of those 8, once each): the second and third cuts were still 1–8 frames early, against 1–9 without. The panel therefore adds no such wording for you.

Four of those 8 takes were picked, one for each of the four shots, and joined in three ways:

| Method | Result |
|---|---|
| Splice directly at the requested frame numbers | 6 switches instead of 3: 3, 6 and 3 frames from other shots were mixed in at the cuts |
| Splice at each take's actual cuts (the panel's current approach) | Exactly 3 hard cuts, with no stray frames; 240-frame final clip, removing 3 frames belonging to neither side; no model pass, 5 seconds on a cold server |
| Regenerate the seams (the panel's previous approach) | 3 switches, but 9 of 15 cells were regenerated; only 34, 17, 0 and 39 frames remained from the four picked takes; cuts moved to frames 62, 130 and 194; 196 seconds |

How actual cuts are found: what is compared is not brightness but where light and dark lie in the picture. Each frame is first stripped of its overall brightness and has its contrast largely evened out (a very dark or flat picture is not stretched), then is measured against the frame before: about 0 for the same picture, about 1 for two unrelated ones. Lightning or an explosion lighting up a shot then counts for little, and a change of shot for a lot. A cut measures 0.28–1.21, which is 4–800 times the clip's usual frame-to-frame change (the panel's threshold is 5 times; in a clip that moves hard throughout, the usual change is itself large and a cut may be less than 5 times it, so the threshold never rises above 0.5). In addition, on each side of the cut, at least 6 of the 8 frames next to it and at least 6 of the 8 frames beyond those must look unlike the other side. This rules out flashes and bursts of light of up to about half a second: after them the picture goes back to what it was, and after a cut it does not. Last, the 4 frames before the cut and the 4 after it are compared as two groups: the groups must differ from each other at least twice as much as the frames within each group differ among themselves, which flickering light and movement that keeps going do not. (Near the ends of a clip, or next to a very short shot set in the clip, the frames that exist are counted.)

Three harder subjects were measured as well, 4 draft takes each. A dim forge (the same man in all four shots, two close-ups in a row, and in every take two or three hammer blows, bursts of sparks or the workpiece leaving the frame, the largest 34 times the usual change): all 12 cuts were found, between 2 frames early and 4 frames late. A thunderstorm at night (lightning lights the picture up again and again, and in a dark shot shows things that were not visible before; the largest flash is 105 times the usual change): all 12 cuts were found, including one where a burst of lightning ended just before a soft cut. Found by difference in brightness, as an earlier version did, only 5 of those 12 were exact and the rest were 1 to 22 frames off. A fast action clip (a handheld chase, a close-up of running feet with motion blur, an explosion, a whip pan): all 12 cuts were found. In shots like these the model sometimes jumps inside a shot, where no cut was asked for, and such a jump measures as much as a cut. Of two changes of about the same size (within 15% of each other), the one nearer the requested frame is taken; this came up twice, with the cuts 1 and 4 frames from the requested frame and the jumps 7 and 17. All of the above are draft-size takes; the thunderstorm and the action clip were then rendered at the Standard preset, 2 takes each, and all 12 of their cuts were found as well.

If the model produces a dissolve or whip pan rather than a hard cut, the cut may not be found, and that join uses the requested frame number.

**Long takes stay uncut.** A four-section, 243-frame clip had its first three sections set to one long take and the fourth to a cut (draft preset, two seeds). Both results cut only at the start of the fourth section (7 and 11 frames later than requested); the first three formed one uninterrupted shot, with actions following the text order. Two results with all four sections set to one long take had no cuts at all. Combining consecutive sections into one `[Shot]` therefore works; the panel cannot control the exact second at which each section occurs.

**Switching takes within a long take works only when they are similar.** The two single-long-take results above are different videos (text-to-video, different seeds). The first half used the first take and the second half the second, with a seam at frame 122. At strength 1, the three regenerated cells continued the first take's picture, pushing the jump to the end of that range (frame 153, with frame-to-frame change 25 times the usual level). At strength 0.3, both sides stayed as they were and the jump remained at frame 122. Neither connected the takes. This step helps only when the takes are already similar.

**Seam range: how many frames to regenerate, and where to stop.** Measured with `tests/measure_seam_range.py` on one similar pair: two seeds of the edited clip in the [complete example](#a-complete-example-turning-live-action-footage-into-a-snowy-scene), draft settings, 124 frames, with a similarity reading of about 33 dB in the strip. The first 68 frames use the first take, the rest the second. Only the regenerated range changes; strength is always 1. "Jump" is the largest frame-to-frame change near the seam in the joined clip, divided by the two takes' own change at that frame. The takes' own motion is around 1×; a value clearly above 1 indicates a seam jump. "Retained-frame penalty" is how much further the retained frame immediately after the range is from the picked take, compared with the same frame after one encode/decode round trip with no regeneration. Frame 68 is exactly on a cell boundary.

| Regenerated frames | Frame count | Jump | Retained-frame penalty |
|---|---|---|---|
| None, direct hard cut | 0 | 3.0× | – |
| None, one encode/decode round trip | 0 | 2.4× | – |
| 64–67 | 4 | 1.6× | 0.4 dB |
| 60–67 | 8 | 1.5× | 0.5 dB |
| 56–67 (automatic range) | 12 | 1.3× | 0.0 dB |
| 52–67 | 16 | 1.4× | 0.1 dB |
| 64–68 (1 frame into the next cell) | 5 | 2.0× | 4.5 dB |
| 56–68 (1 frame into the next cell) | 13 | 2.1× | 4.8 dB |
| 60–72 (ends inside a cell) | 13 | 1.2× | 3.6 dB |
| 56–76 (ends inside a cell) | 21 | 1.1× | 3.6 dB |
| 60–84 (through the end of the next cell) | 25 | 1.1× | 1.6 dB |
| 51–84 (previous method: one whole cell per side) | 34 | 1.3× | 1.6 dB |

What this table shows:

- Ranges ending on a cell boundary (the four rows ending at 67) impose almost no penalty on subsequent retained frames (0–0.5 dB); ending inside a cell costs 3.6 dB. Extending only 1 frame into the next cell leaves the jump (2×). Regenerating the whole next cell as well (60–84) gives the smallest jump, at a penalty of 1.6 dB, and replaces 17 more frames of the second take.
- 4 and 8 frames help, but less than 12; 16 is no better. The automatic range's target of "at least 12 frames, ending on a cell boundary" comes from this table. The automatic-range row was also run with two other seeds (1.27× and 1.25×; penalties 0.4 and 0.1 dB), then once with the two takes swapped (1.18×, 0.5 dB).
- Over the same 12 frames, strength 0.3 gives 1.5×, worse than strength 1.
- With the seam inside a cell at frame 62 (hard cut: 4.4×; encode/decode only: 3.6×), regenerating just its group of 4 frames (60–63) gives 2.1×; 56–67 (12 frames, through the cell's end) gives 1.3× with a 0.9 dB penalty; the previous method (34–84, 51 frames) gives 1.4× with a 1.9 dB penalty. With the seam at frame 70, just inside a cell, 64–84 (21 frames) gives 1.3× with a 1.6 dB penalty.

These results all concern this one pair of takes. Each number is from one run unless stated otherwise. 12 frames is the current default approach, not a measured universal minimum. Sound at the seam was not measured.

**For one dissimilar pair, none of the tested ranges and strengths closed the seam.** Another pair also shared one source video and one prompt, with two seeds, but had more movement and very different lighting and colour between seeds. Its similarity reading in the strip was about 19 dB. The seam was again at frame 68: a hard cut gave 2.1×; encode/decode only gave 2.0×. Ranges of 8, 12 and 16 frames ending on a cell boundary all gave 2.0×, with the jump staying in place. A 13-frame range across both sides gave 1.8×; 25 and 34 frames gave 1.9×, moving the jump to the range's end (frame 85). At strength 0.3, 25 and 34 frames gave 1.9× and 1.8×, with the jump staying at the seam. This is why the strip shows similarity. The red threshold, 22 dB, was merely placed between these two measured points and has not been calibrated: all that is currently known is that this pair at about 33 dB joined smoothly, and this pair at about 19 dB did not.

**Dialogue is spoken as written.** Two draft generations were tested: an elderly baker speaks one line in a text-to-video clip; one character speaks one line in each of two shots in a reference-generation clip. Local speech recognition transcribed the final clips' audio. All three lines matched the prompt exactly, and the second shot's line fell within that shot's time interval. A voice reference was tried twice (a higher voice and a deep voice, each given to the same character). The lines were still spoken word for word, without copying the reference audio's words. The fundamental frequency of the speech followed the reference (reference 232 Hz → result 235 Hz; reference 131 Hz → result 142 Hz; three renders without a reference were at 157–198 Hz). How similar the timbre sounds could not be measured here.

**Reference-video size determines speed.** With the same frame size and step count, a reference video with a short edge of 512 took about 15 seconds per step; at 256, about 6 seconds.

**Face refinement helps faces tens of pixels across, but not smaller or larger ones.** A full-body wide shot at 864×480 (`Standard` preset, 124 frames, face about 38 pixels across, with a stretch where the person turns away) was refined once at each of four strengths using the same preset:

| Strength | Result |
|---|---|
| 50% | Almost no difference from before refinement |
| 70% | The blurred facial features became a little more coherent |
| 85% | Eyes, nose and mouth became clear, including a clean profile during the turn; hairstyle, head orientation and lighting stayed the same |
| 93% | Clearest face, but the hair and background around it also changed |

Another draft final clip at 672×384 contained two other face sizes. A face about 14 pixels across in a wide shot gained no visible facial detail at 85%, while other things in the region (clothing color) changed. A face about 160 pixels across in a close-up showed no difference at 50%, and was replaced by a different, more realistic face at 85%. Automatic mode therefore handles only faces about 24–80 pixels across. The bounds of 24 and 80 were not tested point by point; they were chosen between the three measured cases: no benefit at 14 pixels, benefit at 38, harm at 160. Run time: the 124-frame clip took 359 seconds to generate; the four refinements each took 349–370 seconds.

**Generating the whole clip again: no benefit at the same size; enlarging helps but costs a lot.** The same wide shot at 864×480 was tested once in each case, with 85% starting noise. Generating it again at its original size (394 seconds) kept composition and movement but replaced the details; the face stayed just as blurred. Enlarging it to 1344×768 before another generation (2035 seconds, while the machine was also doing other work) kept composition and movement and made face and clothing detail visibly clearer. Every detail was regenerated, however, and differed from the original. For comparison, generating directly at 1344×768 with the same seed (1613 seconds) produced a different clip with a completely different composition. In this comparison, generating small, picking, then enlarging and regenerating was the only approach that retained the composition, at the cost of another generation at the larger size.

**Face detection.** The detector is kornia's YuNet. Feeding it RGB frames failed to find small faces in wide shots, while snow-covered rocks and clouds were detected as faces (score 0.7). Switching to the BGR order it was trained on gave a score of 0.9 for a 14-pixel face in the same frames. Across 8 draft takes with 4 shots each, faces in close-ups were detected in 89–93% of frames. Small faces in wide shots were found in more than 98% of frames in 4 takes, and 2–48% in the other 4. In the two shots without human faces (a dragon), the detector treated the dragon's head as a face in 0–36% of frames. A shot qualifies only when the same face is seen in at least four tenths of its frames. Neither of those two shots qualified in any of the 8 takes, so none was processed by mistake.

**The model recognizes material without a mention; naming it is most reliable.** A subject belonging only to shot 2 (one dog picture) was tested with three approaches and two seeds each (draft preset): explicitly name it with `@name` in the shot description; omit the mention and let the panel add "it appears in this shot"; or neither name it nor assign it to a shot, declaring it only at the start. A dog appeared in shot 2 in all six clips. Both explicit-mention results had a black-and-white dog matching the reference. Both automatic-sentence results had that dog too, but one also had a second animal. Of the declaration-only results, one got the coat color right and one did not. Two runs per approach cannot establish rates; they only show that all three work. Name material when you want the model to distinguish who does what.


## Known limitations

- **Held to a frame does not mean pixel-identical.** Pictures held on frames are conditioning constraints; cells kept without regeneration pass through one VAE encode/decode round trip. They are close to the original, but not copies of it.
- **The model decides cut timing.** Short two-shot clips are mostly accurate to within a frame; with more shots and longer clips, offsets can exceed ten frames (see [Measurements](#measurements)). Cuts that must hit an exact time, such as a music cue, currently require generating more takes and choosing one, or generating sections in separate nodes and splicing them in an editing application.
- **Cutting takes together may shorten the clip by a few frames.** At a cut where the earlier shot's take cuts before the later shot's take does, the frames in between belong to neither shot and are removed. The Generate page shows the final clip's actual length; subsequent face refinement uses that length.
- **The sound of a clip cut together steps in level at the cuts.** Each shot keeps the sound of the take picked for it, and the model's takes differ in overall loudness. Measured on a 10-second clip cut together from 4 takes: the level changed by +15, −9 and −5 dB across its three cuts, all caused by switching sound sources. The panel does no loudness matching (shots are meant to differ in level, and levelling them shot by shot would flatten the sound). If it matters, there are two options: link sound at those cuts so the whole clip uses one take's sound without switching sources (with all three linked in the same clip, the changes were −1, +18 and −2 dB; the +18 came from a sound event in that take itself, measuring +15 at the same position when listening to that take on its own), or replace the soundtrack with one continuous track in an editor. Continued sound comes from another take and may not match lip movements or action timing, so it suits ambience and music, not dialogue.
- **Cut detection relies on a sudden visual change.** Dissolves, whip pans or shots that look alike may prevent detection of the actual cut. That join then uses the requested frame number and may include a few frames from another shot. A burst of lightning or an explosion's flash right next to a cut may still move the cut that is found by a few frames (it did not in the 12 cuts measured), and a hard cut between two frames with nothing in them (plain black to plain white) is not seen. "Join log" records `no cut found`. There is currently no manual cut override.
- **Timing within a long take cannot be controlled.** The official prompt format has no notation for times within a shot; the panel guarantees only the order.
- **Switching takes within a long take helps only when they look alike at the seam.** Sharing a source video or the same first/last frames usually achieves this, but does not guarantee it (see [Measurements](#measurements)). Regenerating a seam cannot connect dissimilar takes; use the same take for every section of that long take instead. To change only the later part, similar takes can be made by hand: on the Edit page pick the chosen take as the source video (the file list includes generated clips), set "Source usage" to "Source redraw", then under "Partial redraw" set "Redraw range" to "Selected cells" and give the range after the boundary (for instance `f122-242`, or click the cell strip on the timeline), leave everything else as it is, and generate takes as usual. Measured (draft, two seeds, redone from frame 119): the first 119 frames match the take they came from (one encode and decode, PSNR 38 dB), the frame-to-frame change where old meets new is 1.0 times the usual (no jump), the later part is new and different for each seed, and no cut appears; 163–175 seconds a take (about 2 minutes from nothing). The new take's first part is the take it came from, so pick the new take for every section of that long take; afterwards clear the source video and set "Redraw range" back to "Whole clip" to go back to generating from nothing. The panel does not do this in one step. An automatic range regenerates 12 to 21 frames per seam. A very short section within a long take may be regenerated entirely if the range is dragged wide, or an old workflow keeps the previous method of one whole cell per side (34 to 51 frames).
- **Seam ranges are based only on picture.** Sound at the seam has not been measured. The strip's red similarity threshold, about 22 dB, lies between two measured points and has not been calibrated; it does not mean that takes below it cannot be joined.
- **Fun ControlNet and FastH3 are not integrated into the panel.** See the connections above.
- **There is no whole-clip refinement button.** Generating again at the same size adds no benefit. Enlarging before another generation helps, but costs as much as generating a new clip at the larger size (see [Measurements](#measurements)). You can do this manually: select the final clip as the source video, set "Source usage" to "Source redraw", set Change amount to 0.32 (85% starting noise) under "More", switch to a larger-size preset and generate again.
- **Face refinement has a narrow useful range.** It helps only faces tens of pixels across in medium or wide shots (see [Measurements](#measurements)), takes about as long as generating another clip, and depends strongly on starting noise: too little changes nothing; too much changes the background around the face as well.
- **Face refinement handles one face per shot** (the one present longest) without recognizing identity. Choosing "Face reference" regenerates the face in every processed shot from that person's reference pictures. A face must be detected in at least four tenths of the shot's frames to qualify; lower coverage is usually a false detection. The detector can treat animal or monster faces as faces too; exclude those shots under "Target shots".
- One node represents one clip (a 5 to 15 second generation window). For longer content, use continuation: add a video in the next node, choose "Video continuation" and select the file saved by the previous node.
- The Output page reads ComfyUI's own history. Restarting ComfyUI clears the history and therefore the list; the files remain in the output directory.
- Live preview and preset timings follow only runs queued from this browser page. A run queued from another browser or through the API has no live preview here and is not timed; its final clip is saved as usual, and a plain run is listed on the Output page. If the page is reloaded or the workflow tab is switched during generation, the preview comes back shortly afterwards (measured: within roughly ten-odd seconds), but that run is not timed.
- Tested in one environment only: Windows 11 with one 24 GB graphics card. Other systems and cards with less memory have not been tried.

## Development and testing

```bash
# from the ComfyUI root, with ComfyUI's own Python
python custom_nodes/ComfyUI-GachaDirector/tests/test_grid.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_schema.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_widget_order.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_expand.py
python custom_nodes/ComfyUI-GachaDirector/tests/test_splice.py
```

The panel must display cells, frame sizes and problems without requesting the server, so the document rules have a JavaScript mirror. Parity tests ensure the two agree. The other checks cover face tracking and crop/paste, cut planning when splicing takes (`test_cuts.py`; `test_splice.py` above checks how the splice nodes handle frames and sound), how the panel decides whether a generation in progress belongs to this clip, and the relationship between material and prompts (the last three commands require Node 20 or newer; run all commands below from the node package directory):

```bash
python tests/test_faces.py
python tests/test_cuts.py
python tests/make_parity_fixtures.py
node --experimental-default-type=module tests/parity.mjs
node --experimental-default-type=module tests/tracker.mjs
node --experimental-default-type=module tests/material.mjs
```

The Edit page also has a flow test in a real browser (typing `@`, choosing names with the keyboard, changing uses, renaming, inserting and merging boundaries, removing material and viewing the final prompt). It uses headless Edge or Chrome, requires ComfyUI to be running, and generates nothing:

```bash
node --experimental-websocket tests/shot.mjs tests/ui_edit_flow.mjs --lang zh
```

The example workflows are generated: `python templates/make_workflows.py`.

`tests/measure_vae_cells.py` and `tests/measure_seam.py` are measurement scripts, not tests; they produce the numbers in [Measurements](#measurements). The former needs the H3 video VAE file (runs on CPU); the latter needs only three video files.

## Credits and license

Gacha Director builds on the Director projects for MiniMax H3 that came before it. Thank you to their authors:

| Project | License | What this package takes from it |
|---|---|---|
| [ComfyUI-MiniMaxH3-Director](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director) by seesee75 and contributors | GPL-3.0 | The prompt planner and the live preview, bundled unmodified in `vendor/`; the frame-rate conform and the sizing of reference videos |
| [ComfyUI-MiniMax-H3-Motion-Director](https://github.com/j955229/ComfyUI-MiniMax-H3-Motion-Director) by its contributors | GPL-3.0 | The launcher on the node, the full-page overlay and the tab header. Ideas: staged pages, a material library, a shot track drawn as a filmstrip of the source clip |
| [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) by AIMixer | Apache-2.0 | Parts of the timeline: frame/pixel mapping, the ruler, the cut marker |
| [ComfyUI-MiniMaxH3-Director](https://github.com/Thefrizzy1/ComfyUI-MiniMaxH3-Director) by the_frizzy1 | Apache-2.0 | The extension scaffold, DOM helpers and the memory hand-off. Idea: a pure compiler module in front of the conditioning nodes |
| LTX Director by WhatDreamsCost | GPL-3.0 | The lineage the prompt planner comes from |

The frame-grid and megapixel arithmetic restates that of [ComfyUI](https://github.com/Comfy-Org/ComfyUI) (GPL-3.0). Which file comes from which project, and at which commit, is listed in [NOTICE](NOTICE).

**License: GPL-3.0.** The package contains GPL-3.0 code, so the whole package is distributed under that license; the Apache-2.0 parts keep their own license texts in `LICENSES/`.

The screenshots and sample clips use footage from two open movies: *Sintel* (© Blender Foundation, CC BY 3.0, durian.blender.org) and *Tears of Steel* ((CC) Blender Foundation, CC BY 3.0, mango.blender.org; visuals only, without its audio). The rest was generated with MiniMax H3. Each README uses panel screenshots in its own language.
