// Gacha Director — the post page: what is done with a clip after it has been generated.
//
//   joining    Picks from several takes are joined into one clip, and the frames around
//              every join are generated again so that the join does not show. This is the
//              one place a second pass runs over generated frames; how wide and how strong
//              it is are set here.
//   a face     The region the main face is in is cut out of the final clip, generated
//              again at a size where a small face has room, and put back. Every other
//              pixel of the clip stays as it was, and the clip before it is kept.
//   watching   the preview while a clip renders
//   saving     what is written to disk, and how
//
// The joining settings are the clip's own (they are stored in its document, under `mask`),
// because they are part of what a composite was rendered from. Watching and saving are the
// output settings, which every preset and every clip of the workflow share.

import { t } from "./gd_i18n.js";
import { createPlayer, sound } from "./gd_player.js";
import { btn, checkbox, el, labeled, noisePercent, number, row, section, select, tip } from "./gd_ui.js";
import { FPS, canvasSize } from "./gd_doc.js";
import { SAVE_CODECS, SAVE_FORMATS } from "./gd_post_doc.js";
import { allPicked, cutFrames, singleTake, splicePlan } from "./gd_takes_doc.js";

export function createPostPage(host) {
  const root = host.container;
  const players = new Map();           // "before" / "after" -> player
  let more = false;                    // the fold of rarely touched face settings
  let zoom = null;                     // where both pictures are enlarged: {x, y} in percent

  // The two players are one comparison: a frame chosen in one is shown in the other, and
  // one plays when the other does.
  const unwatch = [];              // what stops the watches of the sound switch made here
  function playerFor(key) {
    let p = players.get(key);
    if (!p) {
      const other = () => players.get(key === "before" ? "after" : "before");
      p = createPlayer({
        emptyText: "",
        onFrame: (f, { source }) => {
          const o = other();
          if (source === "user" && o && o.src()) o.seek(f, { silent: true });
        },
      });
      // The two play together and have the same sound (a refine keeps the clip's): only
      // the refined one is heard. (The sound switch sets every player's own; this one is
      // set back each time, after the player's own watcher has run.)
      if (key === "before") unwatch.push(sound.watch(() => { p.video.muted = true; }));
      p.video.addEventListener("play", () => {
        const o = other();
        if (!o || !o.src() || !o.video.paused) return;
        o.video.currentTime = p.video.currentTime;
        o.video.play().catch(() => {});
      });
      p.video.addEventListener("pause", () => {
        const o = other();
        if (!o || !o.src() || o.video.paused) return;
        o.seek(p.frame(), { silent: true });
      });
      p.video.addEventListener("click", (e) => {
        const box = p.video.getBoundingClientRect();
        zoom = zoom ? null : {
          x: Math.round(((e.clientX - box.left) / box.width) * 100),
          y: Math.round(((e.clientY - box.top) / box.height) * 100),
        };
        paintZoom(p.el.closest(".gd-post-pair"));
      });
      players.set(key, p);
    }
    return p;
  }

  function paintZoom(pair) {
    if (!pair) return;
    pair.classList.toggle("gd-zoomed", !!zoom);
    pair.style.setProperty("--gd-zoom-at", zoom ? `${zoom.x}% ${zoom.y}%` : "50% 50%");
  }

  /** The face refine of the final clip: who, how much, the button, before and after. */
  function faceSection(d, takes, busy) {
    const c = host.post();
    const f = c.face;
    const fc = d.derived.frame_count;
    const set = (patch) => host.patch("face", patch);
    const sec = section(t("post.face"), t("post.faceHint"));

    const file = host.finalFile ? host.finalFile() : "";
    const r = takes.refine;
    const fresh = !!r.status && r.of === file && r.key === host.refineKey(file, f);
    const state = el("div", "gd-inline gd-post-state");
    const go = btn(t("post.faceGo"), () => host.queueFaceRefine());
    go.disabled = busy || !file || (fresh && (r.status === "queued" || r.status === "running"));
    if (!file) {
      state.appendChild(el("span", "gd-badge-blue", t("post.faceNoFinal")));
    } else {
      state.appendChild(go);
      const p = host.activePreset();
      const [w, h] = canvasSize("1:1", p.params.megapixels);
      state.appendChild(tip(el("span", "gd-hint", t("post.facePreset", p.name, w, h, p.params.steps)),
        t("post.facePresetHint")));
      if (r.status && !fresh) state.appendChild(el("span", "gd-hint", t("post.faceStale")));
      else if (r.status) {
        state.appendChild(el("span", r.status === "done" ? "gd-badge-ok"
          : r.status === "failed" || r.status === "missing" ? "gd-badge-bad" : "gd-badge-blue",
          t(`post.faceStatus.${r.status}`)));
      }
      if (r.status === "queued" || r.status === "running") {
        state.appendChild(btn(t("takes.refresh"), () => host.refreshTakes(), "gd-btn gd-ghost gd-btn-sm"));
      }
    }
    sec.appendChild(state);
    const why = fresh && r.status === "failed" && host.refineError ? host.refineError() : "";
    if (why) sec.appendChild(el("div", "gd-note gd-note-bad", why));

    const people = d.subjects.filter((s) => s.images.length);
    sec.appendChild(labeled(t("post.faceWho"), select(
      [["", t("post.faceWhoNone")], ...people.map((s) => [s.id, s.name])], f.subject,
      (v) => set({ subject: v })), d.family === "reference" ? t("post.faceWhoHint") : t("post.faceWhoHintBase")));
    // which shots: every one a face is found in, unless the user says which
    const chosen = new Set(f.shots.split(",").filter(Boolean).map(Number));
    const which = el("div", "gd-inline");
    const auto = btn(t("post.faceShotsAuto"), () => set({ shots: "" }),
      "gd-btn gd-btn-sm" + (chosen.size ? " gd-ghost" : ""));
    which.appendChild(auto);
    d.prompt.shots.forEach((_, i) => {
      const on = chosen.has(i + 1);
      which.appendChild(btn(String(i + 1), () => {
        const next = new Set(chosen);
        if (on) next.delete(i + 1); else next.add(i + 1);
        set({ shots: [...next].sort((a, b) => a - b).join(",") });
      }, "gd-btn gd-btn-sm" + (on ? "" : " gd-ghost")));
    });
    sec.appendChild(labeled(t("post.faceShots"), which, t("post.faceShotsHint")));
    const amount = el("div", "gd-inline");
    amount.appendChild(number(Math.round(f.strength * 100), (v) => set({ strength: v / 100 }),
      { min: 5, max: 95, step: 5 }));
    amount.appendChild(el("span", "gd-hint", "%"));
    // a schedule wired into the node replaces this: say so where the number is
    if ((host.externalWired ? host.externalWired() : {}).sigmas) {
      amount.appendChild(el("span", "gd-hint", t("edit.noiseExternal")));
    }
    sec.appendChild(labeled(t("post.faceStrength"), amount, t("post.faceStrengthHint")));
    const text = el("input");
    text.type = "text";
    text.value = f.text;
    text.placeholder = t("post.faceTextPh");
    text.addEventListener("change", () => set({ text: text.value }));
    sec.appendChild(labeled(t("post.faceText"), text, t("post.faceTextHint")));

    const fold = el("details", "gd-fold");
    fold.open = more;
    fold.addEventListener("toggle", () => { more = fold.open; });
    fold.appendChild(el("summary", null, t("post.faceMore")));
    fold.appendChild(labeled(t("post.facePadding"), number(f.padding, (v) => set({ padding: v }),
      { min: 1.2, max: 4, step: 0.1 }), t("post.facePaddingHint")));
    const edge = el("div", "gd-inline");
    edge.appendChild(number(Math.round(f.feather * 100), (v) => set({ feather: v / 100 }),
      { min: 2, max: 45, step: 1 }));
    edge.appendChild(el("span", "gd-hint", "%"));
    fold.appendChild(labeled(t("post.faceFeather"), edge, t("post.faceFeatherHint")));
    fold.appendChild(labeled(t("post.faceScore"), number(f.min_score, (v) => set({ min_score: v }),
      { min: 0.1, max: 0.99, step: 0.05 }), t("post.faceScoreHint")));
    sec.appendChild(fold);

    // before and after, side by side: the clip it was made from is never overwritten
    if (fresh && r.status === "done" && r.file) {
      const pair = el("div", "gd-post-pair");
      for (const [key, name, label] of [["before", file, t("post.faceBefore")], ["after", r.file, t("post.faceAfter")]]) {
        const box = el("div", "gd-post-side");
        box.appendChild(el("strong", null, label));
        const p = playerFor(key);
        box.appendChild(p.el);
        box.appendChild(el("div", "gd-hint", name));
        box.appendChild(row(btn(t("res.open"), () => window.open(host.viewUrlOutput(name), "_blank"),
          "gd-btn gd-ghost gd-btn-sm")));
        pair.appendChild(box);
        // a change of a setting draws the page again: the players stay where they were
        const url = host.viewUrlOutput(name);
        // the final clip may be a few frames short of the clip's length: cuts cost them
        const last = (host.finalFrames ? host.finalFrames() : fc) - 1;
        p.load(url, 0, last, { startFrame: p.src() === url ? p.frame() : null, silent: true });
      }
      paintZoom(pair);
      sec.appendChild(tip(pair, t("post.faceCompareHint")));
    }
    return sec;
  }

  function render() {
    const d = host.doc();
    const takes = host.takes();
    const shots = d.prompt.shots;
    const busy = !!(host.queuing && host.queuing());
    root.replaceChildren();
    const col = el("div", "gd-post");
    root.appendChild(col);

    // ---------------------------------------------------------------- joining
    const s1 = section(t("post.join"), t("post.joinHint"));
    const { plan, why } = splicePlan(takes, shots);
    const state = el("div", "gd-inline gd-post-state");
    if (!allPicked(takes, shots.length) || !plan) {
      state.appendChild(el("span", "gd-badge-blue", why ? t(why.key, ...(why.args || [])) : t("post.joinNoPicks")));
      state.appendChild(btn(t("post.toGenerate"), () => host.goPage && host.goPage("takes"), "gd-btn gd-ghost gd-btn-sm"));
    } else {
      const j = host.joinPlan ? host.joinPlan() : null;
      const cuts = j ? j.cuts : cutFrames(plan);
      const seams = j ? j.seams : [];
      const renders = j ? j.renders : true;
      const at = (list) => list.map((f) => t("post.seamAt", f, (f / FPS).toFixed(2))).join(t("post.listSep"));
      const whole = singleTake(plan);
      if (whole) {
        const take = takes.takes.find((x) => x.id === whole);
        state.appendChild(tip(el("span", "gd-badge-blue", t("takes.finalOne", take ? take.seed : "")), t("takes.outputHint")));
      }
      if (cuts.length) state.appendChild(tip(el("span", "gd-badge-blue", t("post.joinCuts", cuts.length, at(cuts))), t("takes.finalCuts")));
      if (seams.length) state.appendChild(tip(el("span", "gd-badge-blue", t("post.joinSeams", seams.length, at(seams))), t("takes.finalSeams")));
      if (j && j.carried.length) state.appendChild(tip(el("span", "gd-badge-blue", t("post.joinCarried", j.carried.length, at(j.carried))), t("takes.finalCarried")));
      const go = btn(t("takes.composite"), () => host.queueComposite());
      tip(go, renders ? t("takes.compositeHint") : whole ? t("takes.outputHint") : t("takes.assembleHint"));
      go.disabled = busy;
      state.appendChild(go);
      const c = takes.composite;
      if (c.status && c.key && c.key !== host.compositeKey(d, plan)) {
        state.appendChild(el("span", "gd-hint", t("takes.compositeStale")));
      } else if (c.status) {
        state.appendChild(el("span", c.status === "done" ? "gd-badge-ok" : c.status === "failed" || c.status === "missing"
          ? "gd-badge-bad" : "gd-badge-blue", t(`post.comp.${c.status}`)));
        if (c.status === "done") {
          state.appendChild(btn(t("post.toGenerate"), () => host.goPage && host.goPage("takes"),
            "gd-btn gd-ghost gd-btn-sm"));
        }
      }
    }
    s1.appendChild(state);

    // What a join costs each shot: the frames of its pick that stay, the rest being redone
    // with the join. A shot with nothing left is said out loud: its pick does not matter.
    const joining = host.joinPlan ? host.joinPlan() : null;
    if (joining && joining.dead.length) {
      s1.appendChild(el("div", "gd-note gd-note-bad", t("takes.finalDead", joining.dead.map((f) =>
        t("post.seamAt", f, (f / FPS).toFixed(2))).join(t("post.listSep")))));
    }
    // only a seam inside a long take renders anything again, so only then is there
    // anything to count
    const kept = joining && joining.renders ? joining.kept : null;
    if (kept) {
      const list = el("div", "gd-inline");
      kept.forEach((k, i) => list.appendChild(k.kept
        ? el("span", "gd-kept", t("post.joinKeptShot", i + 1, k.kept, k.length))
        : el("span", "gd-kept gd-kept-none", t("post.joinKeptNone", i + 1))));
      s1.appendChild(labeled(t("post.joinKept"), list, t("post.joinKeptHint")));
      const none = kept.map((k, i) => (k.kept ? 0 : i + 1)).filter(Boolean);
      if (none.length) {
        s1.appendChild(el("div", "gd-note gd-note-bad", t("post.joinKeptWarn", none.join(t("post.listSep")))));
      }
    }

    // The two things the pass around a join can be told: how wide, and how strong. At full
    // strength the frames are generated from nothing; lower keeps more of the two takes
    // that meet there. The schedule bends the number, so what it really comes to is shown.
    const wide = el("div", "gd-inline");
    for (const r of (joining ? joining.ranges : [])) {
      wide.appendChild(el("span", "gd-kept" + (r.end <= r.lo ? " gd-kept-none" : ""), r.end <= r.lo
        ? t("post.seamRangeNone", r.frame)
        : t("post.seamRangeAt", r.frame, r.frame - r.lo, r.end - r.frame)));
    }
    if (!wide.childElementCount) wide.appendChild(el("span", "gd-hint", t("post.seamRangeIdle")));
    wide.appendChild(btn(t("post.toGenerate"), () => host.goPage && host.goPage("takes"), "gd-btn gd-ghost gd-btn-sm"));
    // nothing is generated again where every change of take is a cut: the two settings
    // stay settable, and say that they are not in use
    const idle = !!(joining && !joining.renders);
    const seamRow = (label, control, hint) => {
      const r = labeled(label, control, idle ? `${hint}\n${t("post.joinNoRender")}` : hint);
      r.classList.toggle("gd-row-idle", idle);
      return r;
    };
    s1.appendChild(seamRow(t("post.seamWidth"), wide, t("post.seamWidthHint")));
    const strong = el("div", "gd-inline");
    strong.appendChild(number(d.mask.seam_denoise,
      (v) => host.patchDoc((x) => { x.mask.seam_denoise = v; }, t("h.radius")),
      { min: 0.05, max: 1, step: 0.05 }));
    const ext = host.externalWired ? host.externalWired() : {};
    const noise = noisePercent(d.mask.seam_denoise, host.run().shift_video);
    strong.appendChild(el("span", "gd-hint", ext.sigmas ? t("edit.noiseExternal")
      : t("edit.noiseLevel", noise, 100 - noise)));
    s1.appendChild(seamRow(t("post.seamStrength"), strong, t("post.seamStrengthHint")));
    col.appendChild(s1);

    // ---------------------------------------------------------------- a face
    const info = host.sourceSize ? host.sourceSize() : null;
    const [cw, ch] = canvasSize(d.clip.aspect, host.run().megapixels, info);
    root.style.setProperty("--gd-aspect", `${cw} / ${ch}`);
    col.appendChild(faceSection(d, takes, busy));

    // ---------------------------------------------------------------- watching
    const c = host.post();
    const s2 = section(t("post.preview"));
    s2.appendChild(labeled(t("run.preview"), checkbox(c.preview.enabled,
      (v) => host.patch("preview", { enabled: v })), t("run.previewHint")));
    if (c.preview.enabled) {
      s2.appendChild(labeled(t("run.previewEvery"), number(c.preview.preview_every,
        (v) => host.patch("preview", { preview_every: v }), { min: 1, max: 100 }), t("post.previewEveryHint")));
      s2.appendChild(labeled(t("run.previewMax"), number(c.preview.max_resolution,
        (v) => host.patch("preview", { max_resolution: v }), { min: 128, max: 4096, step: 64 }),
        t("post.previewMaxHint")));
    }
    col.appendChild(s2);

    // ---------------------------------------------------------------- saving
    const s3 = section(t("post.save"), t("run.outputHint"));
    s3.appendChild(labeled(t("run.autoSave"), checkbox(c.save.auto_save,
      (v) => host.patch("save", { auto_save: v })), t("post.autoSaveHint")));
    const prefix = el("input");
    prefix.type = "text";
    prefix.value = c.save.filename_prefix;
    prefix.addEventListener("change", () => host.patch("save", { filename_prefix: prefix.value }));
    s3.appendChild(labeled(t("run.prefix"), prefix, t("run.prefixHint")));
    s3.appendChild(labeled(t("post.format"), select(SAVE_FORMATS.map((v) => [v, t(`post.format.${v}`)]),
      c.save.format, (v) => host.patch("save", { format: v }))));
    s3.appendChild(labeled(t("post.codec"), select(SAVE_CODECS.map((v) => [v, t(`post.codec.${v}`)]),
      c.save.codec, (v) => host.patch("save", { codec: v })), t("post.codecHint")));
    col.appendChild(s3);
  }

  return {
    render,
    destroy() {
      for (const stop of unwatch.splice(0)) stop();
      for (const p of players.values()) p.destroy();
      players.clear();
    },
  };
}
