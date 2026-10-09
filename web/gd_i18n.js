// Gacha Director - the panel's string table: Japanese, Chinese, English.
//
// A row is "key": ["ja", "zh", "en"]. t(key, ...args) returns the cell for the current
// language with %1, %2 ... replaced by its arguments in order. An empty cell falls back
// to the English column, then to any column that has text; an unknown key comes back as
// the key itself. The language follows the browser (zh* -> zh, ja* -> ja, anything else
// -> en) until the user picks one, which is remembered in localStorage.
//
// Japanese and Chinese are written as natural UI language, the wording an editing tool
// would use, not word for word. Identifiers of the prompt and the node stay untranslated.

const LANGS = ["ja", "zh", "en"];
const IDX = { ja: 0, zh: 1, en: 2 };
const STORE_KEY = "gachadirector.lang";

/** The browser's language mapped onto one of ours. */
function browserLang() {
  let tag = "";
  try { tag = String((typeof navigator !== "undefined" && navigator.language) || ""); }
  catch (e) { tag = ""; }
  tag = tag.toLowerCase();
  if (tag.startsWith("zh")) return "zh";
  if (tag.startsWith("ja")) return "ja";
  return "en";
}

let lang = (() => {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch (e) { /* no storage: use the browser's language */ }
  return browserLang();
})();

export function getLang() { return LANGS.includes(lang) ? lang : browserLang(); }
export function setLang(next) {
  lang = LANGS.includes(next) ? next : browserLang();
  try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* private window */ }
  return lang;
}
/** zh -> ja -> en -> zh */
export function toggleLang() {
  const order = ["zh", "ja", "en"];
  return setLang(order[(order.indexOf(getLang()) + 1) % order.length]);
}
export const LANG_LABEL = () => ({ ja: "日本語", zh: "中文", en: "EN" }[getLang()]);

const S = {
  // ---------------------------------------------------------------- shell
  "app.title": ["Gacha Director", "Gacha Director", "Gacha Director"],
  "app.open": ["Gacha Director を開く", "打开 Gacha Director", "Open Gacha Director"],
  "app.close": ["閉じる", "关闭", "Close"],
  "page.run": ["プロジェクト", "项目", "Project"],
  "page.edit": ["編集", "剪辑", "Edit"],
  "page.takes": ["生成", "生成", "Generate"],
  "page.results": ["出力", "输出", "Output"],
  "modal.history": ["履歴 ▾", "历史 ▾", "History ▾"],
  "gen.library": ["素材ライブラリ", "素材库", "Media library"],
  "takes.nodeMissing": ["ノードまたは親サブグラフがミュート／バイパス中のため、実行対象外。", "节点或所在子图处于静音／旁路状态，无法执行。", "The node or its parent subgraph is muted or bypassed and cannot run."],
  "takes.queueFailedWhy": ["キュー追加失敗：%1", "排入队列失败：%1", "Queue failed: %1"],
  "takes.queueFailed": ["キュー追加失敗（詳細は ComfyUI のコンソール）。", "排入队列失败，详情见 ComfyUI 控制台。", "Queue failed; see the ComfyUI console for details."],
  "takes.otherLength": ["%1 フレームで生成（現在のクリップ長と不一致）", "生成长度 %1 帧（与当前片段不符）", "Generated at %1 frames (clip length mismatch)"],
  "takes.otherLayout": ["変更前のショット構成で生成", "按修改前的镜头划分生成", "Generated with the previous shot layout"],
  "takes.layoutChanged": [
    "%1 本のテイクは変更前のショット構成を保持。現在のカット位置・連続設定を反映するには再生成が必要。",
    "%1 条候选仍保留修改前的镜头划分。更新切点及连续设置需重新生成候选。",
    "%1 takes retain the previous shot layout. Regenerate to apply the current cut positions and continuous settings."],

  "takes.compositeStale": ["採用テイクまたはつなぎ目の設定が変更済みのため、再合成が必要。", "选用候选或接缝设置已改变，需重新合成。", "Picks or seam settings have changed; join again."],
  "takesdoc.wrongLength": [
    "ショット %1 の採用テイクは %2 フレームで、現在のクリップ長 %3 フレームと不一致。",
    "镜头 %1 的候选为 %2 帧，与当前片段的 %3 帧不符。",
    "Shot %1's take is %2 frames; the current clip is %3 frames."],
  "lib.rootInput": ["取り込み", "导入", "Imported"],
  "lib.rootOutput": ["生成", "生成", "Generated"],
  "lib.all": ["すべて", "全部", "All"],
  "lib.kind.image": ["画像", "图片", "Pictures"],
  "lib.kind.video": ["動画", "视频", "Videos"],
  "lib.kind.audio": ["音声", "声音", "Sounds"],
  "lib.unfiled": ["未分類", "未分类", "Unfiled"],
  "lib.newFolder": ["＋ 新規フォルダー", "+ 新建文件夹", "+ New folder"],
  "lib.folderName": ["新規フォルダー", "新建文件夹", "New folder"],
  "lib.folderHint": [
    "ライブラリ内の分類用フォルダー。ディスク上のファイルは移動しない。\nダブルクリック：名前変更\n素材をドラッグ：フォルダーへ移動",
    "素材库内的分类文件夹，不移动硬盘上的文件。\n双击：重命名\n拖动素材：移入文件夹",
    "Folders for sorting inside the library; files on disk are not moved.\nDouble-click: rename\nDrag items: move into a folder"],
  "lib.deleteFolder": ["フォルダーを削除", "删除文件夹", "Delete folder"],
  "lib.deleteFolderConfirm": [
    "フォルダー「%1」を削除？中の素材は未分類に戻り、ファイルは削除されない。",
    "删除文件夹「%1」？其中的素材回到未分类，文件不会被删除。",
    "Delete folder \"%1\"? Its items become unfiled; no file is deleted."],
  "lib.pickFor": ["クリックで追加：%1", "点击素材以添加：%1", "Click an item to add: %1"],
  "lib.pickCancel": ["キャンセル", "取消", "Cancel"],
  "lib.count": ["%1 件", "%1 项", "%1 items"],
  "lib.selected": ["%1 件選択 / %2 件", "已选 %1 / %2 项", "%1 of %2 selected"],
  "lib.more": ["さらに表示（残り %1）", "显示更多（剩余 %1）", "Show more (%1 left)"],
  "lib.openHint": [
    "素材の閲覧と整理。\nクリック：選択（Ctrl / Shift で複数）\nドラッグ：ショットの素材欄・共通素材欄・ソース動画欄へ追加",
    "浏览和整理素材。\n点击：选中（Ctrl / Shift 多选）\n拖动：添加到镜头的素材栏、共通素材栏或源视频栏",
    "Browse and organise material.\nClick: select (Ctrl / Shift for several)\nDrag: add to a shot's material, the shared material or the source video"],
  "lib.emptyOutput": ["生成済みの%1なし", "暂无生成的%1", "No generated %1"],

  "lib.import": ["PC から取り込む…", "从电脑导入…", "Import from this computer..."],
  "lib.importHint": [
    "選択したファイルを ComfyUI の input フォルダーへコピー。ウィンドウへのドラッグ＆ドロップにも対応。開いているフォルダーに分類される。",
    "将所选文件复制到 ComfyUI 的 input 文件夹，也可将文件拖入此窗口。导入的素材归入当前打开的文件夹。",
    "Copies the chosen files into ComfyUI's input folder. Files can also be dropped on this window. Imported items go into the open folder."],
  "lib.importing": ["%1 ファイルを取り込み中…", "正在导入 %1 个文件…", "Importing %1 file(s)..."],
  "lib.importFailed": ["取り込み失敗：%1", "导入失败：%1", "Import failed: %1"],
  "lib.emptyImport": ["input/ に%1がないため、取り込みまたはドラッグ＆ドロップで追加。", "input/ 中没有%1，可从电脑导入或拖入文件。", "No %1 in input/; import files or drag and drop them here."],

  "lib.filter": ["絞り込み", "筛选", "filter"],
  "lib.noMatch": ["一致するファイルなし", "无匹配文件", "No matching files"],
  "lib.empty": ["input/ に%1なし", "input/ 中没有%1", "No %1 in input/"],

  // ---------------------------------------------------------------- run page: presets
  "run.presets": ["プリセット", "预设", "Presets"],
  "run.add": ["+ 追加", "+ 新建", "+ Add"],
  "run.duplicate": ["複製", "复制", "Duplicate"],
  "run.delete": ["削除", "删除", "Delete"],
  "run.deleteConfirm": ["このプリセットを削除する？", "删除此预设？", "Delete this preset?"],
  "run.active": ["使用中", "当前使用", "Active"],
  "run.name": ["名前", "名称", "Name"],
  "run.note.draft": [
    "ターボモデル・4 ステップ・低解像度・縮小した参照動画。プロンプトと素材の確認用で、最終クリップの出力には不適。",
    "加速模型、4 步、低分辨率与缩小的视频参考。用于检查提示词和素材，不用于成片输出。",
    "Turbo model, 4 steps, low resolution and reduced video references. For checking prompts and material; not final clip output."],
  "run.note.standard": ["公式テンプレート設定：20 ステップ、0.4 MP。", "官方模板设置：20 步、0.4 百万像素。", "Official template settings: 20 steps at 0.4 MP."],
  "run.note.final": ["ネイティブ解像度（短辺 768 px）、25 ステップ。", "模型原生分辨率（短边 768 像素）、25 步。", "Native resolution (768 px short edge), 25 steps."],

  "run.note": ["メモ", "备注", "Note"],
  "run.nodeHint": [
    "ノード上でプリセットを選択し、主要な値を表示。詳細設定はこのパネルで編集。",
    "节点用于选择预设和显示关键读数，详细设置在此面板编辑。",
    "The node selects a preset and displays key values. Detailed settings are edited in this panel."],

  // ---------------------------------------------------------------- run page: cost
  "run.megapixelsHint": [
    "生成画面の画素数（現在 %1 × %2）。上部の解像度プリセット以外の値では「カスタム」と表示。",
    "生成画面的像素量（当前 %1 × %2）。使用上方档位以外的值时，分辨率显示为「自定义」。",
    "Output pixel count (currently %1 × %2). Values outside the resolution presets above are shown as custom."],
  "run.refEdgeNative": ["モデルの既定値（短辺 768 ピクセル）", "模型默认（短边 768 像素）", "the model's default (768 px short edge)"],
  "run.refEdgeHint": [
    "参照動画の短辺サイズの上限。参照動画を使用する場合、生成速度への影響が最も大きい設定。",
    "参考视频的短边尺寸上限。使用参考视频时，此项对生成速度的影响最大。",
    "Short-edge size limit for reference videos. This setting has the greatest effect on generation speed when reference videos are used."],
  "run.refImageHint": [
    "参照画像のサイズ。元のサイズを保持すると被写体の一致度が高まり、処理時間も増加（短辺 2048 px を超える画像のみ縮小）。",
    "参考图片的尺寸。保持原图可提高主体一致性，但耗时增加（仅缩小短边超过 2048 像素的图片）。",
    "Reference image size. Keeping the original size improves subject likeness but takes longer; images over 2048 px on the short edge are scaled down."],

  // ---------------------------------------------------------------- run page: sampling
  "run.model.main": ["標準モデル", "标准模型", "standard model"],
  "run.model.turbo": ["高速モデル（turbo）", "加速模型（turbo）", "fast model (turbo)"],
  "run.modelHint": [
    "高速モデルは model_turbo 入力を使用。同じモデルに turbo LoRA を適用し、少ないステップで下書きを生成。",
    "加速模型使用 model_turbo 输入，连接应用 turbo LoRA 的同一模型，以少量步数生成草稿。",
    "The fast model uses model_turbo. Connect the same model with a turbo LoRA applied for drafts in fewer steps."],
  "run.turboMissing": [
    "model_turbo が未接続のため、turbo LoRA を適用したモデルの接続が必要。",
    "model_turbo 未连接，需接入应用 turbo LoRA 的模型。",
    "model_turbo is not connected; connect a model with the turbo LoRA applied."],
  "run.sigmasWired": [
    "sigmas 接続中は、このプリセットのステップ数・スケジューラーと各所の変更量設定は無効。",
    "sigmas 已连接，预设的步数、调度器及各处的改动幅度设置不生效。",
    "With sigmas connected, this preset's steps, scheduler and all change amount settings are inactive."],
  "run.samplerWired": ["sampler 接続中は、このプリセットのサンプラー設定は無効。", "sampler 已连接，预设的采样器设置不生效。", "With sampler connected, this preset's sampler setting is inactive."],
  "run.stepsHint": [
    "サンプリングのステップ数。多いほど細部の精度と処理時間が増加。\n公式既定値：20\n高速モデル：4 または 8",
    "采样步数。增大可改善细节，同时增加耗时。\n官方默认：20\n加速模型：4 或 8",
    "Sampling step count.\nHigher values improve detail and take longer\nOfficial default: 20\nFast model: 4 or 8"],
  "run.cfgHint": [
    "プロンプトのガイダンス強度。\n1（公式既定値）：ネガティブプロンプト不使用\n1 超：ネガティブプロンプトを使用。各ステップの処理時間は約 2 倍",
    "提示词引导强度。\n1（官方默认）：不使用负面提示词\n大于 1：启用负面提示词，每步耗时约为两倍",
    "Prompt guidance strength.\n1 (official default): negative prompt disabled\nAbove 1: negative prompt; about twice the time per step"],
  "run.shiftVideoHint": [
    "映像のサンプリングスケジュールのシフト。\n高い値ほど同じ変更量での開始時のノイズが増加\n既定値：12。通常は変更不要\n変更量 0.5：開始時のノイズ %1%",
    "画面采样调度的偏移。\n增大可提高相同改动幅度下的起始噪声\n默认：12，一般无需调整\n改动幅度 0.5：起始噪声 %1%",
    "Video sampling schedule shift.\nHigher values increase noise for the same change amount\nDefault: 12; adjustment is rarely needed\nChange amount 0.5: %1% starting noise"],
  "run.shiftAudioHint": [
    "音声のサンプリングスケジュールのシフト。既定値は 3。通常は変更不要。",
    "声音采样调度的偏移。默认 3，一般无需调整。",
    "Audio sampling schedule shift. Default: 3; adjustment is rarely needed."],

  // ---------------------------------------------------------------- run page: takes, memory
  "run.takesCount": ["テイク数", "每批候选数", "Batch takes"],
  "run.takesHint": [
    "「生成」操作 1 回で生成するクリップ全体のテイク数。seed は順に増加し、各テイクは任意のショットで採用可能。",
    "一次生成操作的整段候选数量。seed 逐个递增，每条候选均可供任意镜头选用。",
    "Number of whole-clip takes per Generate operation. Seeds increment, and each take is available for any shot."],
  "page.post": ["仕上げ", "后期", "Post"],
  "run.picture": ["画面と速度", "画面与速度", "Picture and speed"],
  "run.size": ["解像度", "分辨率", "Resolution"],
  "run.sizeNote": ["アスペクト比 %1", "宽高比 %1", "aspect ratio %1"],
  "run.fps": ["フレームレート", "帧率", "Frame rate"],
  "run.fpsValue": ["%1 fps", "%1 帧/秒", "%1 fps"],
  "run.fpsNote": ["固定", "固定", "fixed"],
  "run.length": ["長さ", "长度", "Length"],
  "run.lengthValue": ["%1 秒", "%1 秒", "%1 s"],
  "run.lengthNote": ["%1 フレーム", "%1 帧", "%1 frames"],
  "run.time": ["所要時間の目安", "预计耗时", "Expected time"],
  "run.timeNote": ["%1 回の平均 · 前回 %2", "%1 次平均 · 上次 %2", "average of %1 · last %2"],
  "run.timeNone": ["記録なし", "无记录", "no record"],
  "run.size.small": ["小（下書き用）", "小（草稿）", "Small (draft)"],
  "run.size.standard": ["標準（公式テンプレート）", "标准（官方模板）", "Standard (official template)"],
  "run.size.medium": ["中", "中", "medium"],
  "run.size.hd": ["720p 相当", "720p 级", "720p class"],
  "run.size.native": ["ネイティブ（学習時の解像度）", "原生（训练分辨率）", "Native (training resolution)"],
  "run.size.fullhd": [
    "1080p 相当（学習時の解像度超。低速・映像の破綻リスクあり）",
    "1080p 级（超出训练分辨率，耗时增加且可能出现画面缺陷）",
    "1080p class (above training resolution; slower, with possible visual artifacts)"],
  "run.sizeCustom": ["カスタム", "自定义", "custom"],
  "run.sizeHint": [
    "現在のアスペクト比（%1）に対応する生成解像度。\n同じプリセットは縦長クリップにも自動対応\n別のサイズ：カスタムで幅と高さを指定",
    "按当前宽高比（%1）计算的生成分辨率。\n同一预设自动适配竖屏片段\n其他尺寸：在「自定义」中输入宽和高",
    "Output resolution for the current aspect ratio (%1).\nPresets adapt automatically to portrait clips\nOther sizes: enter width and height under custom"],
  "run.sizeOwn": ["カスタム…", "自定义…", "custom…"],
  "run.sizeW": ["幅", "宽", "Width"],
  "run.sizeH": ["高さ", "高", "Height"],
  "run.sizeApply": ["適用", "应用", "Apply"],
  "run.sizeOwnHint": [
    "生成画面の幅と高さ。クリップのアスペクト比も更新（704 × 704 は正方形）。",
    "生成画面的宽和高，同时更新片段宽高比（704 × 704 为正方形）。",
    "Output width and height; also updates the clip's aspect ratio (704 × 704 is square)."],
  "run.sizeMoved": [
    "幅と高さは 32 の倍数が必要なため、最も近い %1 × %2 に調整。",
    "宽和高须为 32 的倍数，按最接近的 %1 × %2 生成。",
    "Width and height must be multiples of 32; the nearest %1 × %2 will be used."],
  "run.sizeBadRange": ["幅と高さはそれぞれ %1〜%2 px の範囲が必要。", "宽和高均须在 %1–%2 像素范围内。", "Width and height must each be within %1–%2 px."],
  "run.sizeBadEmpty": ["幅と高さは整数のピクセル数で指定。", "宽和高须填写整数像素值。", "Enter width and height in whole pixels."],

  "run.steps": ["ステップ数", "步数", "Steps"],
  "run.stepsN": ["%1 ステップ", "%1 步", "%1 steps"],
  "run.model": ["モデル", "模型", "Model"],
  "run.refs": ["参照素材サイズ", "参考素材尺寸", "Reference material size"],
  "run.refsHint": [
    "モデルに渡す参照素材のサイズ。縮小すると処理が速くなり、参照できる細部は減少。最終クリップの解像度には影響なし。",
    "模型使用的参考素材尺寸。缩小可提高速度，但参考细节减少；不影响成片分辨率。",
    "Reference material size used by the model. Smaller sizes are faster but provide less detail; final clip resolution is unaffected."],
  "run.refVideo": ["参照動画サイズ", "参考视频尺寸", "Reference video size"],
  "run.refEdgePx": ["短辺 %1 ピクセル", "短边 %1 像素", "%1 px on the short edge"],
  "run.refImage": ["参照画像", "参考图片", "Reference pictures"],
  "run.refImage.match": ["生成画面と同じ画素数（高速）", "匹配生成画面的像素量（快）", "Match output pixel count (fast)"],
  "run.refImage.max": ["元のサイズを優先（高一致度・低速）", "优先保持原图尺寸（一致性高、较慢）", "Preserve source size (closer likeness, slower)"],
  "run.advanced": ["詳細", "高级", "Advanced"],
  "run.megapixels": ["画素数（MP）", "像素量（MP）", "Pixel count (MP)"],
  "run.cfg": ["ガイダンスの強さ（CFG）", "引导强度（CFG）", "Guidance (CFG)"],
  "run.sampler": ["サンプラー", "采样器", "Sampler"],
  "run.samplerHint": ["サンプリング方式。公式テンプレートは res_multistep を使用。", "采样方式。官方模板使用 res_multistep。", "Sampling method. Official templates use res_multistep."],
  "run.scheduler": ["スケジューラー", "调度器", "Scheduler"],
  "run.shiftVideo": ["スケジュールのシフト · 映像", "调度偏移 · 画面", "Schedule shift · picture"],
  "run.shiftAudio": ["スケジュールのシフト · 音声", "调度偏移 · 声音", "Schedule shift · sound"],
  "run.staging": ["VRAM の節約", "省显存", "Save VRAM"],
  "run.staging.off": ["オフ", "关", "off"],
  "run.staging.auto": ["自動（総 VRAM 容量で判定）", "自动（按总显存判断）", "Auto (based on total VRAM)"],
  "run.staging.on": ["オン", "开", "on"],
  "post.join": ["合成", "合成", "Joining"],
  "post.joinHint": [
    "ショットごとの採用テイクを最終クリップに合成。\n全ショットが同一テイク：再エンコードのみで出力\nカット：そのまま接続し、再生成なし\n長回し内のテイク変更：つなぎ目両側を再生成\n境界の設定：「編集」ページのショット間の映像リンク",
    "将各镜头选用的候选合成为成片。\n全部镜头选用同一候选：仅重新编码一次后输出\n切镜：直接剪接，不重新生成\n长镜头内切换候选：重画接缝两侧\n边界设置：「剪辑」页镜头卡片之间的画面链接",
    "Joins the picked takes into a final clip.\nAll shots use one take: output with one re-encode\nCuts: direct edit; no regeneration\nTake change within a long take: regenerate seam area\nBoundary setting: picture link between shots on Edit"],
  "post.joinNoPicks": ["未採用のショットあり", "部分镜头尚未选用候选", "Some shots have no take selected"],
  "post.toGenerate": ["「生成」ページへ", "去「生成」页", "To the Generate page"],
  "post.joinSeams": ["長回し内の再生成つなぎ目 %1：%2", "%1 处长镜头接缝需重画：%2", "%1 long-take seam(s) to regenerate: %2"],
  "post.seamAt": ["フレーム %1（%2 秒）", "第 %1 帧（%2 秒）", "frame %1 (%2 s)"],
  "post.listSep": ["、", "、", ", "],
  "post.joinKept": ["保持フレーム数", "保留帧数", "Retained frames"],
  "post.joinKeptShot": ["ショット %1：%2 / %3 フレームを保持", "镜头 %1：保留 %2 / %3 帧", "Shot %1: %2 / %3 frames retained"],
  "post.joinKeptNone": ["ショット %1：採用映像なし", "镜头 %1：候选画面未保留", "Shot %1: no retained frames"],
  "post.joinKeptHint": [
    "合成後に採用テイクのまま残るフレーム数。\n残りのフレーム：長回し内のつなぎ目とともに再生成\nカット：採用テイクの映像をそのまま使用\n処理時間：保持数に依存せず、再生成があればクリップ全体を処理",
    "合成后保留选用候选原画面的帧数。\n其余帧：随长镜头内的接缝重新生成\n切镜：直接使用选用候选的画面\n耗时：与保留数无关，有重画时处理整段",
    "Frames retained from the picked takes after joining.\nOther frames: regenerated with long-take seams\nCuts: use the picked footage directly\nTime: independent of the number of retained frames\nAny regeneration processes the whole clip"],
  "post.joinKeptWarn": [
    "ショット %1 は全体がつなぎ目の再生成範囲に入るため採用テイクが残らず、保持するには前後と同じテイクを採用するか「編集」で区間を延長。",
    "镜头 %1 全部处于接缝重画范围，候选画面不会保留；需与前段或后段选用同一候选，或在「剪辑」页延长该段。",
    "Shot %1 is entirely within seam regeneration ranges; to retain its pick, use the preceding or following take or extend the shot on Edit."],
  "takes.cardSize": ["プレビューサイズ", "候选预览尺寸", "Preview size"],
  "takes.cardList": ["リスト", "列表", "list"],
  "takes.cardSizeHint": [
    "テイクのプレビューサイズ。カードは行幅に応じて折り返し、最小値ではリスト表示。",
    "候选预览大小。卡片按行宽自动换行，最小值为列表视图。",
    "Take preview size. Cards wrap to the available width; the minimum setting uses a list."],

  "takes.viewing": ["表示中：%1", "当前预览：%1", "Viewing: %1"],
  "takes.deleteThis": ["テイク削除", "删除候选", "Delete take"],
  "takes.deleteThisHint": [
    "全ショットの候補からテイクの記録を除去。動画ファイルは出力フォルダーに保持。",
    "从所有镜头的候选池移除该候选记录，视频文件保留在输出文件夹。",
    "Removes the take record from every shot's pool. The video file remains in the output folder."],

  "takes.finalCuts": [
    "カットでテイクが替わる箇所は、各テイクの実際のカット位置で直接接続。再生成は行わず、最終クリップが数フレーム短くなる場合あり。",
    "切镜处切换候选时，按各候选实际切点直接剪接。无需重新生成，成片可能缩短几帧。",
    "Take changes at cuts use each take's actual cut position. No regeneration is needed; the final clip may be a few frames shorter."],
  "takes.finalSeams": [
    "長回し内のテイク変更では、つなぎ目両側のセルを再生成。修復には映像の近いテイクが必要（同じソース動画、または同じ先頭・最終フレーム）。",
    "长镜头内切换候选时，重新生成接缝两侧的格。接合要求候选画面相近（共用源视频或相同首尾帧）。",
    "Changing takes within a long take regenerates the cells on both sides of the seam. Repair requires visually similar takes (a shared source video or matching first and last frames)."],
  "takes.finalDead": [
    "%1 の長回しには再生成可能な 1 セル（17 フレーム）が収まらず、つなぎ目修復には区間の延長または両側で同じテイクの採用が必要。",
    "%1 所在长镜头不足以容纳一格（17 帧）重画范围，需延长该段或在两侧选用同一候选。",
    "The long take at %1 cannot hold a 17-frame cell for seam repair; extend it or pick the same take on both sides."],
  "takes.assembleHint": [
    "採用したショットを、各テイクの実際のカット位置で直接接続。モデルによる生成は行わず、数秒で完了。",
    "按各候选的实际切点剪接选用镜头。不经过模型生成，数秒完成。",
    "Edits picked shots together at each take's actual cut positions. No model generation; completes in a few seconds."],
  "takes.finalFrames": ["%1 フレーム · %2 秒（設定より %3 フレーム短縮）", "%1 帧 · %2 秒（比片段短 %3 帧）", "%1 frames · %2 s (%3 frames shorter than the clip)"],
  "takes.joinLog": ["接続記録", "接合记录", "Join log"],
  "post.joinCarried": ["音声継続 %1：%2", "%1 处声音延续：%2", "%1 cut(s) with continuous audio: %2"],
  "takes.finalCarried": ["カットで映像が別のテイクに替わっても、カット前の音声を継続。", "画面切换候选后，继续沿用切镜前的声音。", "The picture switches takes while the audio from before the cut continues."],

  "post.joinCuts": ["直接接続するカット %1：%2", "%1 处切镜直接剪接：%2", "%1 cut(s) edited directly: %2"],
  "post.joinNoRender": ["採用テイクの変更箇所がすべてカットのため無効。", "候选切换处均为切镜，此项不生效。", "Inactive: all take changes occur at cuts."],

  "takes.keptNone": ["採用映像なし", "候选画面未保留", "No retained frames"],

  "post.comp.queued": ["合成：キュー待ち", "合成排队中", "join queued"],
  "post.comp.running": ["合成中", "合成中", "joining"],
  "post.comp.done": ["合成完了", "合成完成", "joined"],
  "post.comp.failed": ["合成に失敗", "合成失败", "join failed"],
  "post.comp.missing": ["合成ファイルなし", "合成文件缺失", "Joined file missing"],
  "post.seamWidth": ["再生成範囲", "过渡范围", "Seam range"],
  "post.seamWidthHint": [
    "つなぎ目の前後で再生成する範囲。「生成」ページのタイムライン下で両端をドラッグして設定。",
    "接缝两侧重新生成的范围，在「生成」页时间线下方拖动两端设置。",
    "Range regenerated around each seam; set by dragging its ends under the timeline on the Generate page."],
  "post.seamStrength": ["つなぎ目強度", "接缝强度", "Seam strength"],
  "post.seamStrengthHint": [
    "長回し内のつなぎ目の再生成強度。\n1：つなぎ目周辺を完全に新規生成\n低い値：両テイクの映像をより多く保持\n0.3：同じソース動画を使う類似テイク間でも修復可能\n実際の強度：隣接する「開始時のノイズ」の値",
    "长镜头内接缝的重画强度。\n1：接缝附近完全重新生成\n较低值：更多保留两侧候选原画面\n0.3：共用源视频且画面相近时也可修复\n实际强度：旁边的「起始噪声」",
    "Regeneration strength for seams within a long take.\n1: fully regenerates the area around the seam\nLower values: preserve more of both takes\n0.3: can repair similar takes sharing a source video\nActual strength: the adjacent starting noise value"],
  "post.face": ["顔のリファイン", "人脸精修", "Face refine"],
  "post.faceHint": [
    "最終クリップ内の主な顔の周辺を拡大して再生成し、元の位置に合成。\n対象：各ショットで最も長く映る 1 つの顔\n効果：中・遠景の数十 px の顔\n対象外：未検出・小さすぎる顔・十分大きい顔\n範囲外の画素と元の最終クリップは保持",
    "放大重画成片中的主要人脸区域，再回贴原位。\n每个镜头：处理出现时间最长的一张脸\n有效对象：中远景中几十像素的人脸\n跳过：未检测到脸、脸过小或已足够大的镜头\n区域外像素及精修前成片保持不变",
    "Regenerates an enlarged face region in the final clip.\nTarget: one face per shot, visible for the longest time\nEffective for faces a few dozen pixels in size\nSkips shots with no face, tiny faces or large faces\nPastes back; outside pixels and original clip retained"],
  "post.faceGo": ["顔のリファイン", "人脸精修", "Refine face"],
  "post.faceNoFinal": [
    "最終クリップがないため、全ショットのテイク採用と、複数テイクの場合は先に合成が必要。",
    "暂无成片，需先为全部镜头选用候选；使用多条候选时还需完成合成。",
    "No final clip; select a take for every shot and join first if multiple takes are used."],
  "post.facePreset": ["プリセット「%1」 · %2×%3 · %4 ステップ", "预设「%1」 · %2×%3 · %4 步", "Preset \"%1\" · %2×%3 · %4 steps"],
  "post.faceStale": [
    "最終クリップまたは設定が変更済みのため、前回の精修結果は現在の内容と不一致。",
    "成片或设置已改变，上次精修结果与当前内容不符。",
    "The final clip or settings have changed; the previous refinement is out of date."],
  "post.faceStatus.queued": ["キュー待ち", "排队中", "queued"],
  "post.faceStatus.running": ["リファイン中", "精修中", "refining"],
  "post.faceStatus.done": ["完了", "精修完成", "done"],
  "post.faceStatus.failed": ["失敗。理由は下部、詳細は ComfyUI のコンソール。", "精修失败，原因见下方，详情见 ComfyUI 控制台。", "Refinement failed; reason below, details in the ComfyUI console."],
  "post.faceStatus.missing": ["ファイルなし", "文件缺失", "File missing"],
  "post.faceWho": ["顔の参照対象", "人脸参考主体", "Face reference"],
  "post.faceWhoNone": ["テキストのみ", "仅文字描述", "Text only"],
  "post.faceWhoHint": [
    "選択した人物の画像を顔の参照に使用。検出する顔の指定ではないため、別の人物が主役のショットは「対象ショット」で除外。",
    "使用所选人物的图片作为人脸参考。此项不选择检测对象，其他人物为主的镜头需在「精修镜头」中排除。",
    "Uses the selected subject's images as face references. Does not select the detected face; exclude shots led by another person under Target shots."],
  "post.faceWhoHintBase": [
    "ベースモデルでは画像参照を使用せず、選択した人物の説明文のみ使用。",
    "基础模型在此仅使用所选人物的文字描述，不使用参考图片。",
    "The base model uses only the selected character's description here, without reference images."],
  "post.faceShots": ["対象ショット", "精修镜头", "Target shots"],
  "post.faceShotsAuto": ["自動（顔が約 24〜80 ピクセルのショット）", "自动（脸约 24–80 像素的镜头）", "automatic (faces of about 24 to 80 px)"],
  "post.faceShotsHint": [
    "顔の精修を行うショット。\n自動：顔が約 24〜80 px のショット\n約 24 px 未満：合成後に細部を保持できない\n約 80 px 超：既に鮮明で、描き直すと別の顔に変化\n番号指定：顔のサイズによらず選択ショットのみ精修\n誤検出したショットは除外可能",
    "需要精修人脸的镜头。\n自动：脸约 24–80 像素的镜头\n小于约 24 像素：回贴后难以保留细节\n大于约 80 像素：已清晰，重画会改变人脸\n指定编号：只精修所选镜头，不限人脸大小\n误检镜头可从选项中排除",
    "Shots included in face refinement.\nAutomatic: faces about 24–80 px in size\nUnder about 24 px: detail lost when pasted back\nOver about 80 px: already clear; redraw replaces the face\nShot numbers: only selected shots, regardless of face size\nExclude shots with false face detections"],

  "post.faceStrength": ["描き直す強さ", "重画强度", "Strength"],
  "post.faceStrengthHint": [
    "顔の再生成に使用する開始時のノイズ量。\n70% 未満：ほぼ変化なし\n70%：目鼻立ちを軽く補正\n85%（既定）：目鼻立ちを再生成。頭の向き・髪型・照明を保持\n93% 以上：顔が最も鮮明。髪と周辺背景も変化\nこの範囲では合成範囲の輪郭が目立つ場合あり",
    "人脸重画的起始噪声比例。\n低于 70%：几乎不变\n70%：轻微调整五官\n85%（默认）：清晰重画五官，保留朝向、发型和光照\n93% 及以上：脸最清晰，头发和背景随之改变\n此档位：回贴边缘可能可见",
    "Starting noise level for face refinement.\nBelow 70%: little or no change\n70%: minor adjustments to facial features\n85% (default): redraws features; head pose/hair/light kept\n93% and above: clearest face; hair/background change\nAt this level, the pasted region's edge may show"],
  "post.faceText": ["補足説明", "补充描述", "Additional description"],
  "post.faceTextPh": ["例：freckles, green eyes（任意）", "例：freckles, green eyes（选填）", "e.g. freckles, green eyes (optional)"],
  "post.faceTextHint": ["顔の描写に追加する英語の説明文。", "补充人脸描述，使用英文。", "Additional face description, in English."],
  "post.faceMore": ["詳細設定", "更多设置", "More"],
  "post.facePadding": ["切り出し倍率", "裁切倍率", "Crop scale"],
  "post.facePaddingHint": [
    "顔の切り出し範囲の倍率（2：頭部と周辺）。小さい値では合成範囲の輪郭が目立つ場合があり、大きい値では範囲内の顔の占有率が低下。",
    "人脸裁切范围的缩放倍数（2：头部及周边）。较小值可能显露回贴边缘，较大值降低裁切画面中的人脸占比。",
    "Face crop scale (2: the head and surrounding area). Smaller values may expose the pasted region's edge; larger values reduce the face's share of the crop."],
  "post.faceFeather": ["輪郭のフェザー", "边缘羽化", "Edge feathering"],
  "post.faceFeatherHint": ["切り出し範囲の輪郭を元の映像となじませる幅。", "裁切区域边缘与原画面渐变融合的宽度。", "Width of the feathered edge blending the crop into the original frame."],
  "post.faceScore": ["検出しきい値", "检测阈值", "Detection threshold"],
  "post.faceScoreHint": [
    "顔検出の確信度のしきい値。高い値ほど確実な顔のみ採用し、顔が未検出の場合は低い値を使用。",
    "人脸检测的置信度阈值。增大仅接受更确定的人脸，未检测到脸时可调低。",
    "Face detection confidence threshold. Higher values accept only more certain detections; lower it if no face is detected."],
  "post.faceBefore": ["リファイン前", "精修前", "Before"],
  "post.faceAfter": ["リファイン後", "精修后", "After"],
  "post.faceCompareHint": [
    "左右の再生とフレーム移動を同期。クリックで両映像の同じ位置を拡大し、再クリックで解除。",
    "两侧同步播放和逐帧定位。点击画面可同时放大相同位置，再次点击还原。",
    "Synchronized playback and frame stepping. Click to magnify the same position in both views; click again to reset."],

  "res.kindRefine": ["顔のリファイン", "人脸精修", "Face refine"],

  "post.preview": ["ライブプレビュー", "实时预览", "Live preview"],
  "post.previewEveryHint": ["プレビューの更新間隔（ステップ数）。", "预览画面的刷新间隔，以步数计。", "Preview update interval, in steps."],
  "post.previewMaxHint": ["プレビュー画像の長辺（px）。最終クリップには影響なし。", "预览画面的最长边，以像素计。不影响成片。", "Preview image's longest edge, in pixels. Does not affect the final clip."],
  "post.save": ["保存", "保存", "Saving"],
  "post.autoSaveHint": [
    "動画ファイルの自動保存（既定で有効）。\n無効：映像と音声はノード出力のみ\n「生成」ページのテイク表示には保存ファイルが必要",
    "自动保存视频文件，默认开启。\n关闭：画面和声音仅经节点输出\n「生成」页的候选显示需要已保存文件",
    "Automatic video file saving; enabled by default.\nDisabled: frames and audio use node outputs only\nTake display on Generate requires saved files"],
  "post.format": ["ファイル形式", "文件格式", "File format"],
  "post.format.auto": ["自動", "自动", "auto"],
  "post.format.mp4": ["MP4", "MP4", "MP4"],
  "post.format.webm": ["WebM", "WebM", "WebM"],
  "post.format.mkv": ["MKV", "MKV", "MKV"],
  "post.codec": ["映像コーデック", "视频编码", "Video codec"],
  "post.codec.auto": ["自動", "自动", "auto"],
  "post.codec.h264": ["H.264（高互換性）", "H.264（兼容性高）", "H.264 (widely compatible)"],
  "post.codec.av1": ["AV1（小容量・新しいプレーヤーが必要）", "AV1（文件较小，需较新播放器）", "AV1 (smaller files; requires a newer player)"],
  "post.codecHint": ["標準的な保存形式：MP4＋H.264。", "常用保存组合：MP4＋H.264。", "Standard export combination: MP4 + H.264."],
  "takes.seamNow": ["つなぎ目強度 %1", "接缝强度 %1", "seam strength %1"],
  "takes.seamTune": ["「仕上げ」ページで調整", "在「后期」页调整", "Adjust on the Post page"],

  "run.perf": ["VRAM", "显存", "VRAM"],
  "run.stagingHint": [
    "生成前に常駐モデルをアンロードし、テキストエンコーダーと主モデルの VRAM 使用を分離。VRAM 不足時に有効で、処理時間は増加。",
    "生成前卸载常驻模型，避免文本编码器和主模型同时占用显存。适用于显存不足，耗时会增加。",
    "Unloads resident models before generation to avoid holding the text encoder and main model in VRAM together. Reduces VRAM pressure at the cost of speed."],
  "run.vramReading": ["VRAM を読み取り中…", "正在读取显存…", "Reading VRAM..."],
  "run.vramUnknown": ["VRAM 情報を取得できない", "无法读取显存信息", "VRAM information unavailable"],
  "run.vram": ["VRAM %1 / %2（%3%）", "显存 %1 / %2（%3%）", "VRAM %1 / %2 (%3%)"],
  "run.vramResident": ["うち常駐モデル %1", "其中常驻模型 %1", "resident models %1"],
  "run.vramFree": ["VRAM を解放", "释放显存", "Free VRAM"],
  "run.vramFreeing": ["解放中…", "释放中…", "Freeing..."],
  "run.vramFreeHint": [
    "常駐モデルをアンロードし、torch キャッシュを解放。次回実行時にモデルを再読み込み。",
    "卸载常驻模型并清空 torch 缓存。下次运行时重新加载模型。",
    "Unloads resident models and clears the torch cache. Models reload on the next run."],

  // ---------------------------------------------------------------- run page: history
  "run.history": ["所要時間の記録", "耗时记录", "Timings"],
  "run.forThisLength": ["%1 秒（%2 フレーム）のクリップ：", "%1 秒（%2 帧）的片段：", "Clips of %1 s (%2 frames):"],
  "run.runCount": ["回数", "次数", "Runs"],
  "run.lastRun": ["前回", "上次", "Last"],
  "run.avgRun": ["平均", "平均", "Average"],
  "run.historyOf": ["%1 回 · 前回 %2 · 平均 %3", "%1 次 · 上次 %2 · 平均 %3", "%1 run(s) · last %2 · avg %3"],
  "run.noHistory": ["計測記録なし", "暂无耗时记录", "No timing records"],
  "run.autoReset": ["計測自動リセット", "自动重置计时", "Auto-reset timings"],
  "run.autoResetHint": [
    "パラメーター変更時に以前の計測をリセット（既定で有効）。変更前の計測を平均から除外。",
    "参数改变时重置旧耗时记录，默认开启。避免旧参数的计时影响当前平均值。",
    "Resets earlier timings when parameters change; enabled by default. Excludes timings for previous parameters from the current average."],
  "run.historyTable": ["日時 / 所要時間 / パラメーター", "时间 / 耗时 / 参数", "When / duration / parameters"],
  "run.clearThis": ["プリセット履歴消去", "清空预设历史", "Clear preset history"],
  "run.clearAll": ["全履歴消去", "清空全部历史", "Clear all history"],
  "run.clearAllConfirm": ["全プリセットの実行履歴を消去する？", "清空所有预设的运行历史？", "Clear the run history of all presets?"],

  // ---------------------------------------------------------------- run page: output
  "run.outputHint": ["このノードの全実行に共通の設定。プリセットには含まれない。", "此节点全部运行共用的设置，不属于预设。", "Settings shared by all runs of this node. Not stored in presets."],
  "run.autoSave": ["自動保存", "自动保存", "Auto-save video"],
  "run.prefix": ["ファイル名の接頭辞", "文件名前缀", "File name prefix"],
  "run.prefixHint": [
    "保存ファイル名の接頭辞。テイクと合成にはそれぞれ専用の接尾辞を追加。",
    "保存文件名的前缀，候选与合成各自附加专用后缀。",
    "Saved file name prefix. Takes and joined clips receive separate suffixes."],
  "run.preview": ["ライブプレビュー", "实时预览", "Live preview"],
  "run.previewHint": ["生成途中の映像をノードと「生成」ページに表示。", "在节点及「生成」页显示生成过程中的画面。", "Displays generation previews on the node and the Generate page."],
  "run.previewEvery": ["更新間隔（ステップ）", "刷新间隔", "Update interval"],
  "run.previewMax": ["プレビュー長辺", "预览最长边", "Preview long edge"],

  // ---------------------------------------------------------------- edit page: clip
  "edit.timeline": ["タイムライン", "时间线", "Timeline"],
  "edit.problems": ["このクリップは実行不可", "片段无法运行", "Clip cannot run"],
  // ---------------------------------------------------------------- what cannot run
  // One row per code of PROBLEM_TEXT (gd_schema.py / gd_doc.js); %1, %2 ... are its
  // arguments in order.
  "problem.mask_no_source": [
    "部分再描画にはソース映像からの開始が必要。「詳細設定」で「ソース再描画」を有効にするか、「再描画範囲」を「クリップ全体」に変更。",
    "局部重画需要源画面起步，需在源视频更多设置启用「原画面重画」，或将「重画范围」设为「完整片段」。",
    "Partial redraw requires source frames; enable Source redraw in the source's More settings or set Redraw range to Whole clip."],
  "problem.mask_frees_nothing": [
    "描き直すセルが未選択のため、ソース動画がそのまま出力される。",
    "未选择重画的格，运行仅会复现源视频。",
    "No cells selected for redraw; the run would reproduce the source video."],
  "problem.seam_no_cut": ["「カット点周辺」にはカットフレームが少なくとも 1 つ必要。", "「切点周边」至少需要一个切点帧。", "Cut surroundings requires at least one cut frame."],
  "problem.splice_length": [
    "合成範囲 %1 フレームはクリップ長 %2 フレームと不一致のため、全ショットのテイク採用が必要。",
    "合成内容 %1 帧与片段的 %2 帧不符，需为全部镜头选用候选。",
    "Picks cover %1 frames instead of the clip's %2; select a take for every shot."],
  "problem.base_source_reference": [
    "ベースモデルは動画参照に非対応のため、ソース動画は「ソース再描画」のみに使用可能。",
    "基础模型不支持视频参考，源视频仅可用于「原画面重画」。",
    "The base model does not support video references; the source can only be used for Source redraw."],
  "problem.base_videos": [
    "ベースモデルは動画参照（%1 本）に非対応のため、参照モデルへの変更、用途を「動画の続き」に変更、または素材の除去が必要。",
    "基础模型不支持 %1 段视频参考，需切换参考模型、将用途改为「视频续写」，或移除素材。",
    "The base model does not support %1 video reference(s); switch to the reference model, set their use to \"Video continuation\", or remove them."],
  "problem.base_audio": [
    "ベースモデルは音声参照（%1 件）に非対応のため、ショットに配置して用途を「ショット内の原音」に変更するか、参照モデルに変更。",
    "基础模型不支持 %1 段声音参考，需将其放入镜头并将用途改为「镜头原声」，或切换参考模型。",
    "The base model does not support %1 audio reference(s); place them in a shot with the use \"Original audio\", or switch to the reference model."],
  "problem.ref_images": ["参照画像 %1 枚はモデルの上限 %2 枚を超過。", "参考图片共 %1 张，超过模型上限 %2 张。", "%1 reference images exceed the model limit of %2."],
  "problem.ref_videos": ["参照動画 %1 本はモデルの上限 %2 本を超過。", "参考视频共 %1 段，超过模型上限 %2 段。", "%1 reference videos exceed the model limit of %2."],
  "problem.ref_audio": ["参照音声 %1 件はモデルの上限 %2 件を超過。", "参考音频共 %1 段，超过模型上限 %2 段。", "%1 reference audio clips exceed the model limit of %2."],
  "problem.ref_audio_tracks": [
    "参照音声 %1 件（動画音声 %2 件を含む）はモデルの上限 %3 件を超過。",
    "参考音频共 %1 段（含 %2 段视频声轨），超过模型上限 %3 段。",
    "%1 audio references (including %2 video soundtracks) exceed the model limit of %3."],
  "problem.subjects": ["対象 %1 個は上限 %2 個を超過（画像なしの対象も含む）。", "主体共 %1 个，超过上限 %2 个（含无图片的主体）。", "%1 subjects exceed the limit of %2, including text-only subjects."],
  "problem.ref_files": ["参照ファイル合計 %1 個はモデルの上限 %2 個を超過。", "参考文件共 %1 个，超过模型上限 %2 个。", "%1 reference files exceed the model limit of %2."],
  "problem.two_cited": [
    "フレーム %1 に参照画像が 2 枚（%2、%3）あるが、1 フレームにつき 1 枚のみ指定可能。",
    "第 %1 帧重复指定参考图 %2 和 %3，每帧仅可指定一张。",
    "Frame %1 has two reference images (%2 and %3); only one is allowed per frame."],
  "problem.clip_past_end": [
    "フレーム %1 の動画がクリップ終端を超えるため、「取り出し長」の短縮が必要。",
    "第 %1 帧的视频超出片段结尾，需缩短「取用长度」。",
    "The video at frame %1 extends past the clip end; reduce its Extract length."],
  "problem.two_pinned": ["フレーム %1 に画像を重複指定（%2、%3）。", "第 %1 帧重复固定图片 %2 和 %3。", "Frame %1 has duplicate pinned images (%2 and %3)."],
  "problem.raw_empty": ["自由記述モードのプロンプトが未入力。", "自由文本模式的提示词为空。", "Free-text prompt is empty."],
  "problem.mention_gone": [
    "ショット %1 が削除済み素材 %2 を参照しているため、参照の削除または素材の再指定が必要。",
    "镜头 %1 引用已移除素材 %2，需删除引用或重新选择素材。",
    "Shot %1 references removed material %2; remove the reference or select another item."],
  "problem.mention_gone_other": [
    "環境音・BGM・対象の説明に削除済み素材 %1 の参照があり、削除または再指定が必要。",
    "环境声、配乐或主体描述引用了已移除素材 %1，需删除引用或重新选择素材。",
    "Ambient sound, music or a subject description references removed material %1; remove the reference or select another item."],

  "problem.mention_gone_global": [
    "全体の説明が削除済み素材 %1 を参照しているため、参照の削除または素材の再指定が必要。",
    "整体描述引用了已移除素材 %1，需删除引用或重新选择素材。",
    "The overall description references removed material %1; remove the reference or select another item."],
  "edit.clip": ["クリップ", "片段", "Clip"],
  "edit.recipes": ["開始方法", "起始方案", "Starting setup"],
  "recipe.t2v": ["テキスト → 動画", "文生视频", "Text → video"],
  "recipe.t2vHint": [
    "ベースモデルによるテキスト生成。既存素材を除去し、プロンプトと長さは保持。",
    "使用基础模型，仅以提示词生成。移除现有素材，保留提示词和长度。",
    "Prompt-only generation with the base model. Removes existing material; preserves prompts and length."],
  "recipe.i2v": ["画像 → 動画", "图生视频", "Image → video"],
  "recipe.i2vHint": ["ベースモデルによる画像からの動画生成。選択した画像を先頭フレームに使用。", "使用基础模型，将所选图片作为首帧。", "Base model generation using the selected image as the first frame."],
  "recipe.fl2v": ["先頭 + 最終フレーム", "首尾帧", "First + last frame"],
  "recipe.fl2vHint": [
    "ベースモデルの先頭・最終フレーム生成。画像は先頭、最終の順に選択。",
    "使用基础模型，依次选择首帧和尾帧图片。",
    "Base model generation from first and last frames. Select the first image, then the last."],
  "recipe.r2v": ["参照 → 動画", "参考生成", "Reference → video"],
  "recipe.r2vHint": [
    "参照モデルによる生成。選択した画像を共通素材の対象に登録し、プロンプト内で @名前 による参照が可能。",
    "使用参考模型，将所选图片设为共通主体，可在提示词中以 @名字 引用。",
    "Reference model generation. Registers the selected image as a shared subject, available as @name in prompts."],
  "recipe.motion": ["モーション参照", "动作参考", "Motion reference"],
  "recipe.motionHint": [
    "参照モデルの動作参照。画像、動画の順に選択し、外見は画像、動作は動画を参照。プロンプトには参照動画と異なるシーンを記述。",
    "使用参考模型，依次选择图片和视频。图片提供主体外观，视频提供动作；提示词描述不同于参考视频的场景。",
    "Motion reference with the reference model. Select an image for appearance, then a video for motion; describe a different scene in the prompt."],
  "recipe.edit": ["動画編集", "视频编辑", "Video edit"],
  "recipe.editHint": [
    "参照モデルによる動画編集。アスペクト比は選択動画に合わせ、長さは収まる最大の対応フレーム数に設定（上限 362 フレーム）。",
    "使用参考模型，以提示词编辑所选视频。宽高比跟随视频，长度取可容纳的最长有效值，上限 362 帧。",
    "Prompt-based editing with the reference model. Uses the selected video's aspect ratio and longest valid length that fits, up to 362 frames."],
  "recipe.continue": ["動画の続き", "视频续写", "Video continuation"],
  "recipe.continueHint": [
    "選択動画の末尾 22 フレームと音声を最初のショットの先頭に配置し、その続きを生成。",
    "将所选视频末尾 22 帧及声音置于首个镜头开头，继续生成后续内容。",
    "Places the selected video's last 22 frames and audio at the start of the first shot, then generates a continuation."],
  "edit.family": ["モデル", "模型", "Model"],
  "edit.familyHint": [
    "ノードに接続したモデルの種類。\n参照モデル：人物・動画・音声を素材として使用\nベースモデル：テキストと先頭・最終フレームから生成",
    "节点连接的模型类型。\n参考模型：使用人物、视频及声音素材\n基础模型：使用文字和首尾帧",
    "Model family connected to the node.\nReference: uses people, video and audio as material\nBase: generates from text and first/last frames"],
  "family.reference": ["参照モデル（ref2va）", "参考模型（ref2va）", "Reference model (ref2va)"],
  "family.base": ["ベースモデル（fl2va）", "基础模型（fl2va）", "Base model (fl2va)"],
  "edit.familyMismatch": [
    "model 入力の「%1」は %2 と異なる可能性があるため、接続またはモデル設定の確認が必要。",
    "model 输入的「%1」可能不是%2，需检查连线或模型设置。",
    "The model input \"%1\" may not be the %2; check the connection or model setting."],
  "edit.frames": ["長さ", "长度", "Length"],
  "edit.framesHint": [
    "クリップの長さ（秒）。入力はモデルの対応フレーム数に自動調整。\n選択値：5／10／15 秒、または直接入力\n固定フレームレート：24 fps\n推奨範囲：5〜15 秒",
    "片段长度，以秒计。输入值自动对齐有效帧数。\n可选：5／10／15 秒，或直接输入\n固定帧率：24 帧/秒\n模型适用范围：5–15 秒",
    "Clip duration, in seconds; aligned to a valid frame count.\nOptions: 5 / 10 / 15 s, or direct entry\nFixed frame rate: 24 fps\nModel's preferred range: 5–15 seconds"],
  "edit.recipesNote": ["素材を置換。プロンプトと長さは保持し、元に戻す操作も可能。", "替换现有素材，保留提示词和长度，可撤销。", "Replaces existing material; preserves prompts and length. Can be undone."],

  "edit.aspect": ["アスペクト比", "宽高比", "Aspect ratio"],
  "edit.aspectSource": ["ソースの比率", "源视频比例", "Source aspect ratio"],
  "edit.aspectHint": ["生成画面のアスペクト比。画素数は「プロジェクト」のプリセットで設定。", "生成画面的宽高比例。像素量由「项目」页的预设设置。", "Output aspect ratio. Pixel count is set by the preset on Project."],
  "edit.canvasNow": ["実際の画面 %1×%2", "实际画面 %1×%2", "actual frame %1×%2"],

  // ---------------------------------------------------------------- edit page: source clip
  "edit.source": ["ソース動画", "源视频", "Source video"],
  "edit.sourceHint": [
    "編集または続きを生成する元の動画（任意）。未指定ではゼロから生成。",
    "用于修改或续写的源视频，选填。留空时从零生成。",
    "Source video for editing or continuation; optional. Empty generates from scratch."],
  "edit.sourceVideo": ["動画ファイル", "视频文件", "Video file"],
  "edit.sourceStart": ["開始フレーム", "起始帧", "Start frame"],
  "edit.sourceStartHint": ["ソース動画の開始フレーム（24 fps 換算）。", "源视频的取用起始帧，按 24 帧/秒换算。", "Source video's start frame, counted at 24 fps."],
  "edit.sourceEmpty": ["ソース動画なし", "没有源视频", "No source video"],
  "edit.noSource": ["ソース動画なし（ゼロから生成）", "没有源视频（从零生成）", "no source video (generated from nothing)"],
  "edit.clear": ["クリア", "清除", "Clear"],
  "edit.fpsConform": ["ソース %1 fps → 24 fps に変換", "源视频 %1 帧/秒 → 换算为 24 帧/秒", "Source %1 fps → conformed to 24 fps"],
  "edit.noiseExternal": ["sigmas 接続中は無効", "sigmas 已连接，此值不生效", "Inactive: sigmas connected"],
  "edit.tailUnused": ["以降の未使用フレーム：%1", "后续未使用帧：%1", "Unused frames after this: %1"],
  "edit.useLatent": ["ソース再描画", "原画面重画", "Source redraw"],
  "edit.asLatent": ["ソースフレーム使用", "源画面起步", "Source frames"],
  "edit.asLatentHint": [
    "ソース動画にノイズを加えて描き直す設定。部分描き直しには有効化が必要。\n変更量：低いほど元の映像を保持（非線形）\n実際の強度：隣接する「開始時のノイズ」の値\n開始時のノイズ約 70% 以下：ほぼ変化なし\n約 85%：構図と動きを保持し、細部を再生成\n95% 以上：ほぼ別の映像に変化",
    "在源视频上加噪重画，部分重画时需启用。\n改动幅度：较低值保留更多原画面，非线性\n实际强度：旁边的「起始噪声」\n起始噪声约 70% 以下：几乎不变\n约 85%：保留构图和动作，重画细节\n95% 及以上：基本生成另一段画面",
    "Redraws noised source frames; required for partial redraw.\nChange amount: lower preserves more; nonlinear response\nActual strength: the adjacent starting noise value\nStarting noise at about 70% or below: little or no change\nAround 85%: preserves composition and motion; redraws detail\n95% and above: almost entirely different footage"],
  "edit.noiseLevel": ["＝ 開始時のノイズ %1%", "＝ 起始噪声 %1%", "= starts from %1% noise"],
  "role.edit": ["動画編集", "视频编辑", "Video edit"],
  "role.continue": ["動画の続き", "视频续写", "Video continuation"],
  "role.motion": ["動作・カメラ参照", "动作运镜参考", "Motion/camera reference"],
  "edit.soundtrack": ["音声も参照", "参考声轨", "Include soundtrack"],
  "edit.refNote": ["保持・変更内容", "保留与修改", "Keep/change description"],
  "edit.refNotePh": [
    "例：the motion, timing and camera are kept; only the weather changes",
    "例：the motion, timing and camera are kept; only the weather changes",
    "e.g. the motion, timing and camera are kept; only the weather changes"],
  "edit.refNoteHint": [
    "保持する要素と変更する要素を示す英語 1 文。未入力では自動生成。",
    "以一句英文说明保留和修改的内容，留空时自动生成。",
    "One English sentence specifying what to keep and change. Generated automatically if empty."],

  // ---------------------------------------------------------------- edit page: file line
  "edit.outSize": ["画面 %1×%2", "画面 %1×%2", "frame %1×%2"],
  "edit.shortWarn": [
    "ソース残り %1 フレームは必要な %2 フレームに不足し、末尾フレームで補完するため、生成結果の終端も静止。",
    "源视频剩余 %1 帧，不足所需 %2 帧，缺帧以末帧补齐，生成结果的结尾也会静止。",
    "Source has %1 frames remaining but needs %2; missing frames use the last frame, so the generated ending also stops."],
  "edit.tlSegs": ["%1 ショット", "%1 个镜头", "%1 shot(s)"],

  // ---------------------------------------------------------------- edit page: prompt
  "edit.promptMode": ["プロンプト形式", "提示词格式", "Prompt format"],
  "edit.promptModeHint": [
    "モデルに送るプロンプトの形式。\n構造化：全体の説明・ショット・素材から公式構成を作成\n自由記述：入力をそのまま送信。LoRA のトリガーワードなどに使用",
    "发送给模型的提示词格式。\n结构化：按整体描述、镜头和素材构建官方结构\n自由文本：原样发送，适合 LoRA 触发词等",
    "Prompt format sent to the model.\nStructured: layout from description, shots and material\nFree text: unchanged input, including LoRA trigger words"],
  "pmode.structured": ["構造化（公式の構成）", "结构化（官方结构）", "structured (official layout)"],
  "pmode.raw": ["自由記述", "自由文本", "free text"],
  "edit.rawPrompt": ["プロンプト（そのまま送信）", "提示词（原样发送）", "Prompt (sent as written)"],
  "edit.rawHint": [
    "入力を変更せずモデルに送信。このモードではショットの説明を使用しない。",
    "原样发送给模型，此模式不使用镜头描述。",
    "Sends the input unchanged to the model. Shot descriptions are not used in this mode."],
  "edit.globalPrompt": ["全体の説明", "整体描述", "Overall description"],
  "edit.globalHintBase": [
    "クリップ全体のスタイルとシーン。最初のショットの冒頭に追加。",
    "整段的风格和场景描述，置于首个镜头开头。",
    "Whole-clip style and scene description, placed at the start of the first shot."],
  "edit.globalHintRef": ["クリップ全体のスタイルとシーンを示す 1〜2 文。", "整段的风格和场景描述，使用 1–2 句。", "Whole-clip style and scene description, in 1–2 sentences."],
  "edit.summaryHint": ["クリップ全体の短い要約（任意）。生成タイプは自動追加。", "片段内容的简短概括，选填。生成类型自动附加。", "Short clip summary; optional. Generation type is added automatically."],
  "edit.soundscapeHint": ["クリップ全体の環境音。無音は N/A を指定。", "整段的环境声，无声视频填写 N/A。", "Ambient sound for the whole clip. Use N/A for a silent video."],
  "edit.musicHint": ["シーン外の BGM。未入力では音楽を追加しない。", "场景外的背景配乐，留空时不添加音乐。", "Background score outside the scene. Empty adds no music."],
  "edit.negative": ["ネガティブプロンプト", "负面提示词", "Negative prompt"],
  "edit.negativeOff": [
    "CFG が 1 のためネガティブプロンプトは無効で、必要な映像は肯定形で記述。",
    "CFG 为 1，负面提示词不生效，需正面描述目标画面。",
    "Negative prompt is inactive at CFG 1; describe the desired picture positively."],
  "edit.negativeOn": ["ネガティブプロンプト有効（現在の CFG：%1）。", "负面提示词已启用（当前 CFG：%1）。", "Negative prompt active (current CFG: %1)."],
  "edit.compile": ["最終プロンプト", "最终提示词", "Final prompt"],
  "edit.compiling": ["作成中…", "生成中…", "Working…"],

  // ---------------------------------------------------------------- edit page: subjects
  "edit.subjectDesc": ["説明", "描述", "Description"],
  "edit.subjectDescPh": ["a young woman in a red coat", "a young woman in a red coat", "a young woman in a red coat"],
  "edit.subjectDescHint": ["対象を説明する英語の名詞句。", "主体的英文名词短语描述。", "English noun phrase describing the subject."],
  "edit.subjectShort": ["短い呼び名", "简称", "Short name"],
  "edit.subjectShortPh": ["the woman", "the woman", "the woman"],
  "edit.subjectShortHint": ["初出以降に使用する対象の短い呼び名（ベースモデル）。", "主体在首次出现后的简称，用于基础模型。", "Short subject name used after its first mention, for the base model."],
  "kind.person": ["人物", "人物", "person"],
  "kind.animal": ["動物", "动物", "animal"],
  "kind.object": ["物体", "物体", "object"],
  "kind.environment": ["環境", "环境", "environment"],
  "kind.clothing": ["衣装", "服装", "clothing"],
  "kind.prop": ["小道具", "道具", "prop"],
  "kind.interface": ["インターフェース", "界面", "interface"],
  "kind.effect": ["エフェクト", "特效", "visual effect"],
  "kind.style": ["スタイル", "风格", "style"],
  "kind.action": ["アクション", "动作", "action"],
  "kind.expression": ["表情", "表情", "expression"],
  "kind.pose": ["ポーズ", "姿势", "pose"],

  // ---------------------------------------------------------------- edit page: references
  "edit.videoDescPh": ["用途（例：the dance to follow）", "用途，例：the dance to follow", "Purpose, e.g. the dance to follow"],
  "edit.audioDescPh": ["用途（例：the music style）", "用途，例：the music style", "Purpose, e.g. the music style"],

  // ---------------------------------------------------------------- edit page: anchors
  "edit.toPlayhead": ["再生ヘッドへ移動", "播放头定位", "Move to playhead"],
  "edit.pin": ["フレーム固定", "固定帧画面", "Pin frame"],
  "edit.cite": ["画像参照", "图片参考", "Reference image"],
  "edit.clipFrom": ["開始フレーム", "取用起始帧", "Start frame"],

  // ---------------------------------------------------------------- edit page: time mask
  "edit.mask": ["部分再描画", "局部重画", "Partial redraw"],
  "edit.maskMode": ["再描画範囲", "重画范围", "Redraw range"],
  "mask.whole_clip": ["クリップ全体", "完整片段", "Whole clip"],
  "mask.free_cells": ["選択セル", "所选格", "Selected cells"],
  "mask.seam_repair": ["カット点周辺", "切点周边", "Cut surroundings"],
  "edit.freeCells": ["再描画セル", "重画格", "Redraw cells"],
  "edit.freeCellsHint": ["描き直すセルの指定。タイムラインのセル帯で直接選択可能。", "需要重画的格，可在时间线格条上直接选择。", "Cells to redraw; can be selected directly on the timeline's cell strip."],
  "edit.cutFrames": ["カットフレーム", "切点帧", "Cut frames"],
  "edit.radius": ["片側セル数", "每侧格数", "Cells per side"],
  "edit.allFree": ["全体再描画", "整段重画", "Redraw whole clip"],
  "edit.onlySelected": ["選択ショット再描画", "选中镜头重画", "Redraw selected shot"],
  "edit.maskHint": [
    "ソース映像の一部を保持して描き直す範囲。\n条件：「ソース再描画」が有効\n選択したセルのみ再生成し、残りは保持\n選択単位：1 セル＝17 フレーム\n操作：タイムライン下部のセル帯でも指定可能",
    "保留源画面并局部重画的时间范围。\n条件：启用「原画面重画」\n选中格重新生成，其余保持原样\n选择单位：每格 17 帧\n操作：也可直接选择时间线下方的格条",
    "Time range to redraw while retaining source footage.\nRequires Source redraw\nSelected cells regenerate; the rest is retained\nSelection unit: 17 frames per cell\nAlso selectable on the cell strip below the timeline"],

  // ---------------------------------------------------------------- edit page: shots
  "edit.segments": ["ショット", "镜头", "Shots"],
  "edit.segment": ["ショット %1", "镜头 %1", "Shot %1"],
  "edit.segShort": ["ショット %1", "镜头 %1", "Shot %1"],
  "edit.segRange": [
    "%1〜%2 秒 · 長さ %3 秒（フレーム %4〜%5）",
    "%1–%2 秒 · 长 %3 秒（帧 %4–%5）",
    "%1–%2 s · %3 s long (frames %4–%5)"],
  "edit.segNavTitle": ["ショット %1 · フレーム %2–%3 · %4 フレーム · クリックで移動", "镜头 %1 · 帧 %2–%3 · 共 %4 帧 · 点击定位", "Shot %1 · frames %2–%3 · %4 frames · click to seek"],
  "edit.segPinned": ["元の映像を保持", "保持原画面", "Original footage retained"],
  "edit.segPrompt": ["ショット内容", "镜头内容", "Shot description"],
  "edit.chars": ["文字", "字", "chars"],
  "edit.shotsRaw": [
    "自由記述モードではショットの説明を送信しない。ショットの区切りは生成結果の選定に使用。",
    "自由文本模式不发送镜头描述。镜头划分仍用于选用生成结果。",
    "Free-text mode does not send shot descriptions. Shot boundaries still define ranges for take selection."],
  "edit.shotsDialogue": [
    "ショット内の出来事とセリフ。\nセリフ：1 行につき 1 発話\n素材の人物：@名前 says quietly: セリフ\n画面外の声：@voice(声の説明) says: セリフ\nコロン前：話し方／コロン後：発話内容\n英語以外：@名前／@voice(...) 直後に [Japanese] 等を指定",
    "镜头内容与台词格式。\n每句台词独占一行\n素材角色：@名字 says quietly: 台词\n画外音：@voice(声音描述) says: 台词\n冒号前为说话方式，冒号后为台词\n非英语：@名字 或 @voice(...) 后接 [Japanese] 等语言标记",
    "Shot description and dialogue format.\nOne spoken line per line\nSubject: @name says quietly: words\nOff-screen voice: @voice(voice description) says: words\nBefore colon: delivery; after colon: spoken words\nNon-English: [Japanese], etc. after @name or @voice(...)"],
  "edit.spreadPrompt": ["プロンプト配分", "提示词分配", "Distribute prompts"],
  "edit.spreadPromptHint": [
    "全ショットのプロンプトを文単位で再配分。各ショットの配分量はフレーム数に比例。",
    "汇总所有镜头的提示词，按句子重新分配，份额与各镜头帧数成正比。",
    "Pools all shot prompts and redistributes whole sentences in proportion to each shot's frame count."],
  "edit.toSegStart": ["▶ ショット先頭", "▶ 镜头起点", "▶ Shot start"],
  "edit.collapse": ["折りたたむ", "折叠", "Collapse"],
  "edit.expand": ["展開", "展开", "Expand"],
  "edit.mergePrev": ["前ショットと結合", "合并前镜头", "Merge previous shot"],

  "edit.tlLength": ["%1 秒（%2 フレーム · %3 fps）", "%1 秒（%2 帧 · %3 帧/秒）", "%1 s (%2 frames at %3 fps)"],
  "edit.tlSteps": ["%1 ステップ", "%1 步", "%1 steps"],
  "edit.tlHint": [
    "クリップの長さ・解像度・ステップ数・ショット数・生成タイプ。解像度とステップ数は「プロジェクト」の現在のプリセットを使用。",
    "片段长度、分辨率、步数、镜头数及生成类型。分辨率和步数使用「项目」页当前预设。",
    "Clip duration, resolution, steps, shot count and generation type. Resolution and steps use the active preset on Project."],
  "edit.srcName": ["ソース動画 %1", "源视频 %1", "source video %1"],
  "edit.srcInfo": ["元は %1×%2 · %3 フレーム · %4 fps", "原片 %1×%2 · %3 帧 · %4 帧/秒", "original %1×%2 · %3 frames · %4 fps"],
  "edit.srcToOut": ["→ %1 フレームを使い、%2×%3 で生成", "→ 取 %1 帧，按 %2×%3 生成", "→ %1 frames used, generated at %2×%3"],
  "edit.secondsBtn": ["%1 秒", "%1 秒", "%1 s"],
  "edit.lengthNow": ["秒 ＝ %1 フレーム（%2 fps 固定）", "秒 ＝ %1 帧（固定 %2 帧/秒）", "s = %1 frames (fixed %2 fps)"],
  "edit.common": ["共通素材", "共通素材", "Shared material"],
  "edit.commonHint": [
    "全ショットで使用できる共通素材。\nショット専用の素材：該当ショットのカードに配置\n番号とモデルへの宣言：生成時に自動追加\n素材の指定：プロンプトで @ を入力して名前を選択",
    "所有镜头均可使用的共通素材。\n镜头专用素材：放入所在镜头的卡片\n素材编号与声明：生成时自动添加\n指定素材：在提示词输入 @ 并选择名称",
    "Shared material available to every shot.\nShot-specific material: place in that shot's card\nNumbering and declarations: added automatically\nReference material: type @ in a prompt and select a name"],
  "edit.budget": [
    "参照：画像 %1/%2 · 動画 %3/%4 · 音声 %5/%6 · 合計 %7/%8",
    "参考：图片 %1/%2 · 视频 %3/%4 · 音频 %5/%6 · 合计 %7/%8",
    "Refs: images %1/%2 · video %3/%4 · audio %5/%6 · total %7/%8"],
  "edit.soundscape": ["環境音", "环境声", "Ambient sound"],
  "edit.soundscapePh": [
    "例：rain on a tin roof, distant thunder",
    "例：rain on a tin roof, distant thunder",
    "e.g. rain on a tin roof, distant thunder"],
  "edit.music": ["BGM", "配乐", "Music"],
  "edit.musicPh": ["例：slow piano", "例：slow piano", "e.g. slow piano"],
  "edit.summary": ["概要", "片段概述", "Clip summary"],
  "edit.summaryPh": ["任意", "选填", "Optional"],
  "edit.sourceUse": ["ソース用途", "源视频用途", "Source usage"],
  "role.none": ["ソース再描画", "原画面重画", "Source redraw"],
  "edit.sourceUseHint": [
    "ソース動画の使用方法。\n動画編集：スタイルと内容を変更\n動画の続き：末尾から先を生成\n動作・カメラ参照：動作とカメラワークのみ参照\nソース再描画：参照せず、元の映像から描き直す",
    "源视频的使用方式。\n视频编辑：修改风格与内容\n视频续写：从结尾继续生成\n动作运镜参考：仅参考动作与运镜\n原画面重画：不作为参考，仅在原画面上重画",
    "Source video usage.\nVideo edit: changes style and content\nVideo continuation: generates onward from the end\nMotion/camera reference: motion and camera movement only\nSource redraw: redraws source frames without a reference"],
  "edit.sourceMore": ["詳細設定", "更多设置", "More"],
  "edit.changeAmount": ["変更量", "改动幅度", "Change amount"],
  "mat.group.image": ["画像", "图片", "Pictures"],
  "mat.group.video": ["動画", "视频", "Videos"],
  "mat.group.audio": ["音", "声音", "Sounds"],
  "mat.addHint": [
    "ライブラリから選択、または PC から取り込み。この欄へのファイルのドラッグ＆ドロップにも対応。",
    "从素材库选择，或从电脑导入。也可将文件拖入此栏。",
    "Select from the library or import from this computer. Files can also be dropped here."],

  "mat.addImage": ["+ 画像", "+ 图片", "+ Picture"],
  "mat.addVideo": ["+ 動画", "+ 视频", "+ Video"],
  "mat.addAudio": ["+ 音", "+ 声音", "+ Sound"],
  "mat.addSubjectText": ["+ テキスト対象", "+ 文字主体", "+ Text subject"],
  "mat.addSubjectTextHint": [
    "画像なしで定義する人物・物。プロンプト内の @名前 は、指定した説明文に置換。",
    "以文字定义人物或物体。提示词中的 @名字 自动替换为同一段主体描述。",
    "Text-defined person or object. Each @name in a prompt is replaced with the same subject description."],
  "mat.nameHint": [
    "プロンプトで @名前 により参照する素材名。名前の変更はプロンプト内の参照にも反映。",
    "提示词中以 @名字 引用的素材名称。改名时同步更新提示词中的引用。",
    "Material name referenced as @name in prompts. Renaming updates prompt references."],
  "mat.insert": ["@%1 をプロンプトのカーソル位置に挿入", "把 @%1 插入提示词的光标处", "Insert @%1 at the cursor in the prompt"],
  "mat.more": ["詳細設定", "更多设置", "More settings"],
  "mat.remove": ["素材を除去（プロンプト内の参照は通常の文章に変換）", "移除素材（提示词中的引用转为普通文字）", "Remove material (prompt references become plain text)"],
  "mat.file": ["ファイル", "文件", "File"],
  "mat.what": ["説明・用途", "描述／用途", "Description / purpose"],
  "mat.keep": ["保持度", "保留程度", "Retention"],
  "mat.keepHint": ["参照素材の再現度。", "参考素材的还原程度。", "Degree of fidelity to the reference material."],
  "keep.fully_preserved": ["完全保持", "完整保留", "Fully preserved"],
  "keep.partially_preserved": ["一部変更可", "基本保留", "Mostly preserved"],
  "keep.attribute_transfer": ["特徴の転用", "特征迁移", "Attribute transfer"],
  "keep.weak_reference": ["弱い参照", "弱参考", "Loose reference"],
  "keep.reference": ["音色・雰囲気の参照", "音色／氛围参考", "Timbre/mood reference"],
  "keep.fully_copy": ["完全コピー", "完整复用", "Full copy"],
  "keep.partially_copy": ["部分コピー", "部分复用", "Partial copy"],
  "mat.pictures": ["対象画像", "主体图片", "Subject images"],
  "mat.picturesHint": ["同じ対象の複数画像に対応（異なる角度など）。", "同一主体可使用多张图片，例如不同角度的视图。", "Multiple images per subject, including different views."],
  "mat.morePictures": ["+ 画像追加", "+ 添加图片", "+ Add image"],
  "mat.soundtrackHint": [
    "動画の音声を参照に追加。音声参照枠を 1 件使用。",
    "将视频声轨作为声音参考，占用一个音频参考名额。",
    "Adds the video's soundtrack as an audio reference. Uses one audio reference slot."],
  "mat.atFrame": ["ショットの", "第", "frame"],
  "mat.atSeconds": ["フレーム目（%1 秒）", "帧（%1 秒）", "(%1 s in)"],
  "mat.atFrameHint": ["クリップ内のフレーム位置：%1", "片段内帧位置：%1", "Frame position in the clip: %1"],
  "mat.voiceOf": ["%1 の声", "%1 的声音", "the voice of %1"],
  "mat.clipFromHint": [
    "取り出し開始フレーム（24 fps 換算）。動画の続きには通常、末尾の短い区間を使用。",
    "取用起始帧，按 24 帧/秒换算。续写通常取视频末尾的短片段。",
    "First frame to extract, counted at 24 fps. Continuation normally uses a short section at the end."],
  "mat.clipLength": ["取り出し長", "取用长度", "Extract length"],
  "mat.framesSeconds": ["%1 フレーム（%2 秒）", "%1 帧（%2 秒）", "%1 frames (%2 s)"],
  "mat.clipLengthHint": [
    "取り出した区間をショットの先頭にそのまま配置し、その後を生成。",
    "取用片段原样置于镜头开头，继续生成后续内容。",
    "Places the extracted clip unchanged at the shot start, then generates a continuation."],
  "mat.kind.subject": ["対象", "主体", "subject"],
  "mat.kind.picture": ["画面", "画面", "frame"],
  "mat.kind.video": ["動画", "视频", "video"],
  "mat.kind.audio": ["音", "声音", "sound"],
  "mat.shared": ["共通", "共通", "shared"],
  "edit.subjectKind": ["種類", "类别", "Kind"],
  "edit.subjectKindHint": [
    "モデルに宣言する対象の分類（人物・物体・場所・スタイル等）。",
    "向模型声明的主体类别，例如人物、物体、场景或风格。",
    "Subject category declared to the model, such as person, object, place or style."],
  "edit.pinHint": ["最終クリップの指定フレームを画像に一致させる。", "将成片中的指定帧固定为此图片。", "Matches the specified frame of the final clip to this image."],
  "edit.citeHint": [
    "画像を参照として使用し、対応するショットとフレームを自動宣言。プロンプト内で @名前 による参照が可能。",
    "使用图片作为参考，自动声明对应的镜头和帧。可在提示词中以 @名字 引用。",
    "Uses the image as a reference and automatically declares its shot and frame. Available as @name in prompts."],
  "use.subject": ["対象の参照", "主体参考", "Subject reference"],
  "use.subjectHint": [
    "映像に登場する人物・物の外見参照。特定フレームへの固定は行わない。",
    "画面中人物或物体的外观参考，不固定到特定帧。",
    "Appearance reference for a person or object appearing in the video. Not pinned to a specific frame."],
  "use.first": ["先頭フレーム", "首帧", "First frame"],
  "use.firstHint": ["ショットの先頭フレームに使用する画像。", "镜头首帧使用的图片。", "Image used as the shot's first frame."],
  "use.last": ["最終フレーム", "尾帧", "Last frame"],
  "use.lastHint": ["ショットの最終フレームに使用する画像。", "镜头尾帧使用的图片。", "Image used as the shot's last frame."],
  "use.frame": ["中間フレーム", "中间帧", "Intermediate frame"],
  "use.frameHint": ["ショット内の指定フレームに使用する画像。", "镜头内部指定帧使用的图片。", "Image used at the specified frame within the shot."],
  "use.storyboard": ["絵コンテ（構図参照）", "分镜图（构图参考）", "Storyboard frame (composition reference)"],
  "use.storyboardHint": ["構図の参照画像。特定フレームへの固定は行わない。", "构图参考图片，不将指定帧固定为此图片。", "Composition reference image. No frame is pinned to it."],
  "use.motion": ["動作・カメラ参照", "动作运镜参考", "Motion/camera reference"],
  "use.motionHint": ["動画の動作とカメラワークを参照。", "参考视频中的动作和运镜。", "Motion and camera movement reference from the video."],
  "use.continue": ["動画の続き", "视频续写", "Video continuation"],
  "use.continueHint": [
    "動画の区間をショットの先頭にそのまま配置し、その続きを生成。",
    "将视频片段原样置于镜头开头，继续生成后续内容。",
    "Places a video clip unchanged at the shot start, then generates a continuation."],
  "use.voice": ["登場人物の声", "角色声音", "Character voice"],
  "use.voiceHint": ["選択した対象の発話に使用する声。", "所选主体说话时使用的声音。", "Voice used for speech by the selected subject."],
  "use.sound": ["音声参照", "声音参考", "Sound reference"],
  "use.soundHint": ["音声の音色・スタイルを参照。", "参考音频的音色或风格。", "Timbre or style reference from the audio."],
  "use.play": ["ショット内の原音", "镜头原声", "Original audio"],
  "use.playHint": ["ショットの先頭から原音をそのまま再生。", "从镜头开头原样使用此声音。", "Plays this audio unchanged from the shot start."],
  "mode.t2v": ["テキストから生成", "文生视频", "text to video"],
  "mode.i2v": ["画像から生成", "图生视频", "image to video"],
  "mode.fl2v": ["先頭・最終フレーム", "首尾帧", "first / last frame"],
  "mode.keyframes": ["キーフレーム", "关键帧", "keyframes"],
  "mode.r2v": ["参照から生成", "参考生成", "reference to video"],
  "mode.v2v": ["動画編集", "视频编辑", "Video edit"],
  "mode.rv2v": ["参照 + 動画編集", "参考 + 视频编辑", "reference + video edit"],
  "mode.continue": ["続きを生成", "续写", "continuation"],
  "edit.modeHint": [
    "ショットの素材に基づく生成タイプ。自動判定のため手動切り替えは不要。",
    "根据镜头素材自动判断的生成类型，无需手动切换。",
    "Generation type determined automatically from shot material. No manual switch is needed."],
  "edit.segCounts": ["画像 %1 · 動画 %2 · 音 %3", "图片 %1 · 视频 %2 · 声音 %3", "pictures %1 · videos %2 · sounds %3"],
  "edit.atHint": ["@ 入力で素材名を選択。", "输入 @ 可选择素材名称。", "Type @ to select a material name."],
  "edit.shotEmpty": [
    "説明と専用素材がないため独立したショットとして生成されず、前の内容が継続。",
    "镜头没有描述或专用素材，不作为独立镜头生成，内容延续前段。",
    "No shot description or dedicated material; this range continues the preceding content instead of generating a separate shot."],
  "edit.shotRawNote": [
    "自由記述モードではショットの説明は無効。「詳細」で構造化に変更可能。",
    "自由文本模式不使用镜头描述，可在「高级」中切回结构化。",
    "Shot descriptions are inactive in free-text mode; switch to structured under Advanced."],
  "edit.compileHint": [
    "自動番号と素材の宣言を含む、モデルに送信するプロンプト全文。",
    "发送给模型的完整提示词，包含自动编号和素材声明。",
    "Complete prompt sent to the model, including automatic numbering and material declarations."],
  "edit.compileClose": ["閉じる", "收起", "Close"],
  "edit.advanced": ["詳細", "高级", "Advanced"],
  "h.material": ["素材", "素材", "Material"],
  "h.rename": ["素材の名前を変更", "素材改名", "Rename material"],
  "h.use": ["素材の使い方", "素材用途", "Use of material"],
  "h.addMaterial": ["素材を追加", "添加素材", "Add material"],
  "h.removeMaterial": ["素材を外す", "移除素材", "Remove material"],

  // ---------------------------------------------------------------- edit page: cut bar
  "edit.cutInsert": ["カット点を挿入", "插入切点", "Insert cut"],
  "edit.cutDelete": ["カット点を削除", "删除切点", "Delete cut"],
  "edit.cutPrevSeg": ["前のショット", "上一个镜头", "Previous shot"],
  "edit.cutNextSeg": ["次のショット", "下一个镜头", "Next shot"],
  "edit.cutStartTitle": ["開始フレーム", "镜头起始帧", "Shot start frame"],
  "edit.cutEndTitle": ["終了フレーム（含む）", "镜头结束帧（含）", "Shot end (inclusive)"],
  "edit.cutInsertOk": ["再生ヘッド位置のフレーム %1 でショットを分割。", "在播放头所在的第 %1 帧分割镜头。", "Splits the shot at playhead frame %1."],
  "edit.cutInsertNo": [
    "フレーム %1 は既存のカット点、またはショット境界まで %2 フレーム未満のため分割不可。",
    "第 %1 帧已是切点，或距镜头边界不足 %2 帧，无法分割。",
    "Cannot split at frame %1: existing cut point or less than %2 frames from a shot boundary."],
  "edit.cutDeleteOk": [
    "ショット %1 と %2 のカット点（フレーム %3）を削除し、両ショットを結合。",
    "删除镜头 %1 与 %2 之间的切点（第 %3 帧），合并两镜头。",
    "Removes the cut between shots %1 and %2 at frame %3 and merges the shots."],
  "edit.cutDeleteNo": [
    "ショット 1 の前にカット点はないため、タイムラインの菱形または後続ショットの選択が必要。",
    "镜头 1 前无切点，需选择时间线菱形或后续镜头。",
    "No cut before shot 1; select a timeline diamond or a later shot."],
  "edit.cutStartRange": [
    "ショット %1 の開始フレーム（範囲 %2–%3）。ショット %4 の終了位置も更新。",
    "镜头 %1 起始帧，可调范围 %2–%3；同步改变镜头 %4 结束位置。",
    "Shot %1 start frame, range %2–%3. Also changes shot %4's end."],
  "edit.cutStartFirst": ["ショット 1 の開始：フレーム 0", "镜头 1 起始：第 0 帧", "Shot 1 start: frame 0"],
  "edit.cutEndRange": [
    "ショット %1 の終了フレーム（含む、範囲 %2–%3）。ショット %4 の開始位置も更新。",
    "镜头 %1 结束帧（含），可调范围 %2–%3；同步改变镜头 %4 起始位置。",
    "Shot %1 end frame, inclusive, range %2–%3. Also changes shot %4's start."],
  "edit.cutEndLast": ["最終ショットの終了：フレーム %1", "末镜头结束：第 %1 帧", "Last shot end: frame %1"],

  // ---------------------------------------------------------------- timeline
  "tl.help": [
    "タイムライン操作\nフィルムストリップをクリック：ショット選択・位置移動\n菱形／境界をクリック：カット点選択（黄色）\n境界をドラッグ：カット点移動\nCtrl＋ホイール：ズーム\nSpace：再生／一時停止\n←／→：1 フレーム移動（Shift 併用：17 フレーム）\n上部ツールバー：カット点の挿入・移動・削除\nフレーム上の画像・動画・音声：マーカー表示のみ\n素材の設定：該当ショットのカード",
    "时间线操作\n点击胶片带：选中镜头并定位\n点击菱形／分界：选中切点（黄色）\n拖动分界：移动切点\nCtrl＋滚轮：缩放\n空格：播放／暂停\n←／→：移动 1 帧（配合 Shift：17 帧）\n上方工具条：插入、移动、删除切点\n帧上图片、视频、声音：仅显示标记\n素材设置：所在镜头的卡片",
    "Timeline controls\nClick filmstrip: select shot and seek\nClick diamond/boundary: select cut point (yellow)\nDrag boundary: move cut point\nCtrl + wheel: zoom\nSpace: play/pause\nLeft/Right: step 1 frame (with Shift: 17 frames)\nToolbar above: insert, move or delete cut points\nImages, videos, audio on frames: markers only\nMaterial settings: corresponding shot card"],
  "tl.helpCells": [
    "部分描き直しのセル操作\n元の映像を描き直す区間と保持する区間を指定\n選択単位：1 セル＝17 フレーム\nセルをクリック／ドラッグ：描き直し・保持を切り替え\n境界をドラッグ：セル境界にスナップ\nAlt：スナップ解除",
    "局部重画的格条操作\n指定原画面的重画与保留区间\n选择单位：每格 17 帧\n点击／划过格条：切换重画与保留\n拖动镜头分界：吸附到格边界\nAlt：取消吸附",
    "Cell controls for partial redraw\nChoose time ranges to redraw or retain from the source\nSelection unit: 17 frames per cell\nClick/drag cell strip: toggle redraw/retain\nDrag shot boundary: snap to cell edges\nAlt: bypass snapping"],

  "tl.segLabel": ["ショット %1 · %2s", "镜头 %1 · %2s", "Shot %1 · %2s"],
  "tl.emptySeg": ["（説明なし）", "（暂无描述）", "(No description)"],
  "tl.stripFailed": ["ソース読み込み失敗：%1 · クリックで再試行", "源视频加载失败：%1 · 点击重试", "Source video load failed: %1 · click to retry"],
  "tl.stripLoading": ["ソース動画を読み込み中…", "正在读取源视频…", "Reading the source video..."],
  "tl.noPlate": ["ソース動画なし", "没有源视频", "No source video"],
  "tl.pinned": ["元のまま", "保持原样", "Kept"],
  "tl.free": ["描き直す", "重画", "Redone"],
  "tl.cell": ["セル%1", "格%1", "Cell %1"],
  "tl.segPicked": ["採用済み", "已选用", "Picked"],
  "tl.segHasTakes": ["テイクあり", "有候选", "Has takes"],
  "tl.segNoTakes": ["未生成", "无候选", "No takes"],

  // ---------------------------------------------------------------- player
  "player.loop": ["ループ", "循环", "Loop"],
  "player.sound": ["音声を再生\nパネル内の全プレーヤー共通", "播放声音\n面板里所有播放器共用", "Play sound\nShared by every player of the panel"],
  "player.playPause": ["再生 / 一時停止（スペース）", "播放 / 暂停（空格）", "Play / pause (Space)"],
  "player.toStart": ["先頭", "起点", "Start"],
  "player.prevFrame": ["前のフレーム（←）", "上一帧（←）", "Previous frame (Left arrow)"],
  "player.nextFrame": ["次のフレーム（→）", "下一帧（→）", "Next frame (Right arrow)"],
  "player.toEnd": ["末尾", "终点", "End"],
  "player.frame": ["フレーム", "帧", "Frame"],
  "player.frameOf": ["フレーム %1 / %2", "帧 %1 / %2", "Frame %1 / %2"],
  "player.loadFailed": ["動画読み込み失敗", "视频加载失败", "Video load failed"],

  // ---------------------------------------------------------------- filmstrip load errors
  // film.aborted .. film.unsupported are looked up by media error code in gd_filmstrip.js.
  "film.aborted": ["読み込み中断", "加载已中止", "Loading aborted"],
  "film.network": ["ネットワークエラー（サーバー混雑の可能性）", "网络错误，服务器可能繁忙", "Network error; the server may be busy"],
  "film.decode": ["デコード失敗", "解码失败", "Decode failed"],
  "film.unsupported": ["未対応形式またはファイルなし", "格式不支持或文件缺失", "Unsupported format or missing file"],
  "film.unknown": ["不明なエラー", "未知错误", "Unknown error"],
  "film.http": ["HTTP %1（ファイル名またはフォルダーが不正）", "HTTP %1（文件名或文件夹不正确）", "HTTP %1 (incorrect file name or folder)"],
  "film.codec": ["ブラウザー非対応のコーデック（H.264 yuv420p が必要）", "浏览器不支持此编码，需使用 H.264 yuv420p", "Browser cannot decode this codec; H.264 yuv420p required"],
  "film.noServer": ["サーバー応答なし", "服务器无响应", "Server not responding"],

  // ---------------------------------------------------------------- takes page
  "takes.liveWaiting": ["生成中…", "生成中…", "Generating…"],
  "takes.liveStep": ["生成中：ステップ %1 / %2", "生成中：第 %1 / %2 步", "Generating: step %1 of %2"],
  "takes.liveHint": [
    "生成中のクリップのプレビュー。進行に応じて更新し、必要に応じて中断可能。",
    "生成中的片段预览，随进度更新，可按需中断生成。",
    "Live clip preview, updated during generation. Generation can be interrupted as needed."],
  "takes.interrupt": ["中断", "中断", "Interrupt"],
  "takes.status": ["%1/%2 ショット採用済み", "已选用 %1/%2 个镜头", "%1/%2 shots picked"],
  "takes.generate": ["%1 テイク生成", "生成 %1 个候选", "Generate %1 take(s)"],
  "takes.generateHint": [
    "現在のプリセットでクリップ全体を %1 回生成。\n各生成結果が 1 本のテイク\nseed は 1 ずつ増加し、次回バッチと重複しない値に更新\n全テイクを任意のショットで採用可能",
    "以当前预设生成 %1 条整段候选。\n每次生成的 seed 递增 1\n排队后 seed 后移，避免下批重复\n每条候选均可供任意镜头选用",
    "Generates %1 whole-clip takes with the active preset.\nSeed increments by 1 for each take\nNode seed advances past the batch to avoid repeats\nEach take is available for any shot"],
  "takes.refresh": ["状態を更新", "刷新状态", "Refresh status"],
  "takes.clearAll": ["テイクをすべて消去", "清空全部候选", "Clear all takes"],
  "takes.clearConfirm": ["全テイクの記録と採用を消去する（生成済み動画は保持）？", "清空全部候选记录和选用状态（保留已生成的视频文件）？", "Clear all take records and picks (keep generated video files)?"],
  "takes.noStorage": [
    "gd_takes がないため操作を保存できず、ComfyUI の再起動によるノード定義の更新が必要。",
    "缺少 gd_takes 控件，操作无法保存，需重启 ComfyUI 更新节点定义。",
    "Missing gd_takes widget; page changes cannot be saved until ComfyUI restarts with the updated node definition."],
  "takes.queuedN": ["%1 テイクをキューに追加（開始 seed：%2）", "已排入 %1 条候选（起始 seed：%2）", "Queued %1 take(s) (starting seed: %2)"],
  "takes.final": ["最終クリップ", "成片", "Final clip"],
  "takes.finalNeedsPicks": ["全ショットのテイク採用が必要。", "需为全部镜头选用候选。", "Select a take for every shot."],
  "takes.composite": ["合成", "合成", "Join"],
  "takes.compositeHint": [
    "採用したショットを最終クリップに合成。\n全ショットが同一テイク：再エンコードのみで出力\n長回し内のテイク変更：つなぎ目両側を再生成\n修復はクロスディゾルブではない\nカット：再生成せず直接接続",
    "将选用镜头合成为成片。\n全部镜头选用同一候选：仅重新编码一次后输出\n长镜头内切换候选：重画接缝两侧\n修复方式为重新生成，不是交叉溶解\n切镜：直接剪接，不重新生成",
    "Joins the picked shots into a final clip.\nAll shots use one take: output with one re-encode\nTake change within a long take: regenerate seam area\nRepair uses regeneration, not a cross-dissolve\nCuts: direct edit without regeneration"],
  "takes.compositeBlocked": ["合成不可：%1", "无法合成：%1", "Cannot join: %1"],
  "takes.candidates": ["テイク", "个候选", "take(s)"],
  "takes.none": ["テイクなし", "无候选", "no takes"],
  "takes.noCandidates": ["テイクなし（上部の生成ボタンで作成可能）。", "暂无候选，可使用上方生成按钮。", "No takes; use the Generate button above."],
  "takes.pickAll": ["全ショット採用", "全部镜头选用", "Apply to all"],
  "takes.mixHint": [
    "ショット間で異なるテイクを採用する条件。\nカット：自由に選定し、そのまま接続\n長回し内：映像が近いテイクのみ接合可能\n参照条件：同じソース動画、または同じ先頭・最終フレーム",
    "不同镜头选用不同候选的接合条件。\n切镜：自由选用，直接剪接\n长镜头内：候选画面需相近\n参考条件：共用源视频或相同首尾帧",
    "Conditions for combining different takes.\nCuts: freely select takes; direct edit\nWithin a long take: takes must be visually similar\nShared source video or matching first/last frames"],
  "takes.pick": ["採用", "选用", "Pick"],
  "takes.picked": ["採用済み", "已选用", "Picked"],
  "takes.unpick": ["採用を解除", "取消选用", "Unpick"],
  "takes.queued": ["キュー待ち", "排队中", "Queued"],
  "takes.running": ["生成中", "生成中", "Generating"],
  "takes.failed": ["失敗", "失败", "Failed"],
  "takes.missing": ["ファイルなし", "文件缺失", "File missing"],
  "takes.loopSeg": ["ショットループ", "镜头循环", "Loop shot"],
  "takes.monitor": ["シーケンスプレビュー", "剪辑预览", "Sequence preview"],
  "takes.monitorHint": [
    "採用テイクをショット順に再生するシーケンスプレビュー。\n未採用のショット：プレースホルダー表示\n長回し内のテイク変更：ここではカットで切り替え\nこの切替部のつなぎ目：合成時に生成\n最終クリップあり：最終クリップを再生\n下部タイムライン：ショット選択で該当テイクへ移動",
    "按镜头顺序播放当前选用候选的剪辑预览。\n未选用的镜头：显示占位\n长镜头内切换候选：此处为硬切\n对应接缝：合成时生成\n已有成片：播放成片\n下方时间线：点击镜头定位到对应候选",
    "Sequence preview of the current picks in shot order.\nUnpicked shots: placeholders\nTake changes within a long take: hard cuts in this preview\nThese seams are generated on joining\nWith a final clip: plays the final clip\nTimeline below: click a shot to go to its takes"],
  "takes.monitorEmpty": ["テイクなし", "暂无候选", "No takes yet"],
  "takes.monitorGap": ["ショット %1 · 未採用", "镜头 %1 · 未选用", "Shot %1 · not picked"],
  "takes.monitorPart": ["ショット %1 · seed %2", "镜头 %1 · seed %2", "Shot %1 · seed %2"],

  "takes.count": ["テイク数", "每批候选数", "Batch takes"],
  "takes.countHint": ["1 回の生成で作るテイク数。「プロジェクト」ページの「テイク数」と共通。", "每批生成的候选数量，与「项目」页的「每批候选数」共用同一设置。", "Takes per batch. Shares the Batch takes setting on Project."],
  "takes.finalOne": ["同一テイク（seed %1）· そのまま出力", "同一候选（seed %1）· 直接输出", "One take (seed %1) · output as is"],
  "takes.outputHint": [
    "採用テイクをそのまま最終クリップとして出力。モデルは使わず、再エンコードのみ。",
    "将所选候选直接输出为成片。不经过模型，仅重新编码一次。",
    "Outputs the picked take as the final clip. No model pass; re-encoded once."],
  "takes.toResults": ["出力を表示", "查看输出", "View output"],

  "takes.seamRange": ["前 %1 フレーム · 後 %2 フレーム（%3 秒）", "向前 %1 帧 · 向后 %2 帧（%3 秒）", "%1 frames before · %2 after (%3 s)"],
  "takes.seamNone": ["再生成なし（直接つなぐ）", "不重新生成（直接相接）", "nothing regenerated (hard join)"],
  "takes.seamRangeHint": [
    "つなぎ目の前後で再生成する範囲。\n両端をドラッグ：latent フレームの境界にスナップ（長い線はセルの境界）\n右端がセル境界：その後の保持フレームへの影響が最小\n橙：12 フレーム未満、または右端がセル境界以外（直後の 1〜2 フレームが変化する場合あり）\nダブルクリック：自動範囲に戻す\nつなぎ目の上の三角をクリック：重なった範囲のうち、この範囲を前面に表示\n一致（dB）：この位置での 2 本のテイクの近さ。低いほど修復が難しい",
    "接缝两侧重新生成的范围。\n拖动两端：吸附到 latent 帧的边界（长线为格线）\n右端在格线上：对其后保留画面的影响最小\n橙色：短于 12 帧，或右端不在格线上（其后 1–2 帧可能变化）\n双击：恢复自动范围\n点击接缝上方的三角：范围重叠时，把这一条放到最前\n相似度（dB）：两条候选在此处的接近程度，数值越低越难修复",
    "Range regenerated around the seam.\nDrag either end: snaps to latent-frame boundaries (long lines are cell boundaries)\nRight end on a cell boundary: least effect on the kept frames after it\nAmber: under 12 frames, or right end off a cell boundary (the 1-2 frames after it may change)\nDouble-click: back to the automatic range\nClick the triangle above the seam: bring this range to the front when ranges overlap\nAlike (dB): how close the two takes are here; the lower, the harder to repair"],
  "takes.seamRangeLimited": [
    "長回しの端に達したため、実際の範囲は設定より短い。",
    "已到长镜头的边界，实际范围小于设定值。",
    "The long take ends here: less is regenerated than was set."],
  "post.seamRangeAt": ["フレーム %1：前 %2 · 後 %3", "第 %1 帧：向前 %2 帧 · 向后 %3 帧", "frame %1: %2 before · %3 after"],
  "post.seamRangeNone": ["フレーム %1：再生成なし", "第 %1 帧：不重新生成", "frame %1: nothing regenerated"],
  "post.seamRangeIdle": ["つなぎ目なし", "当前选用没有接缝", "No seams with the current picks"],
  "h.seamRange": ["つなぎ目の範囲", "过渡范围", "Seam range"],

  "takes.seamAuto": ["自動", "自动", "auto"],

  "takes.seamAlike": ["テイク間の一致 %1 dB", "两候选相似度 %1 dB", "takes alike: %1 dB"],
  "takes.seamUnlike": [
    "この位置で 2 本のテイクの差が大きい：つなぎ目の修復に失敗する場合あり。",
    "两条候选在此处差异较大：接缝修复可能失败。",
    "The two takes differ a lot here: repairing the seam may fail."],

  "takes.previewHere": ["テイクのプレビュー", "候选预览", "Take preview"],
  "takesdoc.noPick": ["ショット %1 のテイク未採用", "镜头 %1 尚未选用候选", "Shot %1 has no selected take"],
  "takesdoc.noFile": ["ショット %1 の採用テイクに出力ファイルなし", "镜头 %1 选用的候选没有输出文件", "Shot %1's selected take has no output file"],

  // ---------------------------------------------------------------- results page
  "res.none": ["生成結果なし（生成完了後に表示）。", "暂无输出，完成生成后显示。", "No results; available after generation."],
  "res.refresh": ["更新", "刷新", "Refresh"],
  "res.takesHidden": ["%1 テイクを非表示（「生成」でショットごとに確認・採用可能）。", "已隐藏 %1 条候选，可在「生成」页按镜头查看和选用。", "%1 take(s) hidden; review and select per shot on Generate."],
  "res.kindComposite": ["合成（%1 ショット・つなぎ目を再生成）", "合成（%1 个镜头，接缝重新生成）", "Joined (%1 shots; seams regenerated)"],
  "res.kindCutTogether": ["直接接続（%1 ショット・再生成なし）", "剪接（%1 个镜头，无重新生成）", "Cut together (%1 shots; no regeneration)"],

  "res.kindTake": ["テイク", "候选", "Take"],
  "res.kindRun": ["ノードから直接実行", "直接从节点运行", "Run from the node"],
  "res.seed": ["seed", "seed", "seed"],
  "res.when": ["日時", "时间", "When"],
  "res.duration": ["所要時間", "耗时", "Duration"],
  "res.stale": ["生成後にクリップが変更済み。", "片段已在生成后改变，此结果与当前内容不符。", "The clip has changed since generation; this result is out of date."],
  "res.open": ["新しいタブで開く", "在新标签页打开", "Open in a new tab"],
  "res.report": ["実行レポート", "运行报告", "Run report"],
  "res.prompt": ["送信プロンプト", "模型提示词", "Submitted prompt"],

  // ---------------------------------------------------------------- node
  "node.taskGroup": ["プリセット", "预设", "Preset"],
  "node.lastAvg": ["前回 %1 · 平均 %2 · %3 回", "上次 %1 · 平均 %2 · %3 次", "last %1 · avg %2 · %3 run(s)"],
  "node.noTiming": ["計測記録なし", "暂无耗时记录", "No timing records"],

  // ---------------------------------------------------------------- undo history labels
  "h.edit": ["編集", "编辑", "Edit"],
  "h.open": ["開く", "打开", "Open"],
  "h.importOld": ["旧ドキュメントを取り込み", "导入旧文档", "Import old document"],
  "h.legacyTask": ["旧ワークフローの設定", "旧工作流设置", "Old workflow settings"],
  "h.legacyTaskNote": ["旧形式の文書に保存された実行設定から取り込み。", "从旧版文档保存的运行设置导入。", "Imported from run settings saved in an older document."],
  "h.post": ["出力設定", "输出设置", "Output settings"],
  "h.postSection": ["出力設定 · %1", "输出设置 · %1", "Output · %1"],
  "h.task": ["プリセット", "预设", "Preset"],
  "h.taskSwitch": ["プリセットを切り替え", "切换预设", "Switch preset"],
  "h.taskNew": ["プリセットを追加", "新建预设", "New preset"],
  "h.taskDup": ["プリセットを複製", "复制预设", "Duplicate preset"],
  "h.taskRename": ["プリセット名を変更", "重命名预设", "Rename preset"],
  "h.taskProps": ["プリセットのプロパティ", "预设属性", "Preset properties"],
  "h.taskParams": ["プリセットのパラメーター", "预设参数", "Preset parameters"],
  "h.taskDelete": ["プリセットを削除", "删除预设", "Delete preset"],
  "h.newTaskName": ["新しいプリセット %1", "新预设 %1", "New preset %1"],
  "h.copySuffix": ["%1 のコピー", "%1 副本", "%1 copy"],
  "h.histSettings": ["履歴の設定", "历史设置", "History settings"],
  "h.histClear": ["履歴を消去", "清空历史", "Clear history"],
  "h.recordTime": ["所要時間を記録", "记录耗时", "Record timing"],
  "h.timeline": ["タイムライン", "时间线", "Timeline"],
  "h.nav": ["ナビゲーション", "导航", "Navigate"],
  "h.pickSeg": ["ショットを選択", "选择镜头", "Select shot"],
  "h.pick": ["テイクを採用", "选用候选", "Pick a take"],
  "h.viewTake": ["テイクを表示", "查看候选", "View take"],
  "join.pictureOff": ["映像・カット\n新しいショットとして生成。", "画面·切镜\n作为新镜头生成。", "Picture · cut\nGenerates as a new shot."],
  "join.pictureOn": [
    "映像・連続\n前のショットと同じショットとして生成し、途中にカットのない長回しを構成。",
    "画面·连续\n与上一镜头作为同一镜头生成，中间不切，组成长镜头。",
    "Picture · continuous\nGenerates one uncut long take with the preceding shot."],
  "join.soundOff": [
    "音声・映像と同時に切り替え\nカット後は新しい映像の採用テイクの音声を使用。",
    "声音·随画面切换\n切镜后使用新画面所选候选的声音。",
    "Sound · switches with picture\nAfter a cut, uses the newly selected picture take's audio."],
  "join.soundOn": [
    "音声・継続\nカット前の音声を継続。カット両側で異なるテイクを採用した場合のみ効果あり。",
    "声音·延续\n切镜后沿用切镜前的声音，仅在两侧选用不同候选时有区别。",
    "Sound · continuous\nRetains pre-cut audio; differs only across different takes."],
  "join.soundLocked": [
    "音声・固定\n長回し内では映像とともに連続し、音声のみの設定は不可。",
    "声音·锁定\n长镜头内始终随画面连续，不能单独设置。",
    "Sound · locked\nContinuous with picture in a long take; no separate setting."],
  "h.joinSound": ["ショット間の音声", "镜头间的声音衔接", "Sound between shots"],
  "run.sizeTip": [
    "クリップのアスペクト比とプリセットの画素数から算出。\nアスペクト比：「編集」で設定\nカスタム：幅と高さを直接指定",
    "由片段宽高比和预设像素量计算。\n宽高比：在「剪辑」页设置\n自定义：直接指定宽和高",
    "Calculated from clip aspect ratio and preset pixel count.\nAspect ratio: set on Edit\nCustom: enter width and height"],
  "run.fpsTip": ["モデルの固定フレームレート：24 fps。", "模型固定帧率：24 帧/秒。", "Fixed model frame rate: 24 fps."],
  "run.lengthTip": ["クリップ長は「編集」ページで設定。", "片段长度在「剪辑」页设置。", "Clip duration is set on Edit."],
  "run.timeTip": ["現在のプリセットとクリップ長での実測処理時間。", "当前预设和片段长度下的实测耗时。", "Measured run time for the current preset and clip duration."],

  "h.join": ["ショットのつなぎ方", "镜头衔接方式", "How shots join"],

  "h.insertCut": ["カット点を挿入", "插入切点", "Insert cut"],
  "h.moveCut": ["カット点を移動", "移动切点", "Move cut"],
  "h.deleteCut": ["カット点を削除", "删除切点", "Delete cut"],
  "h.spread": ["プロンプトを配分", "分配提示词", "Spread the prompt"],
  "h.recipe": ["レシピ", "配方", "Recipe"],
  "h.family": ["モデル", "模型", "Model"],
  "h.frames": ["クリップの長さ", "片段长度", "Clip length"],
  "h.aspect": ["アスペクト比", "宽高比", "Aspect ratio"],
  "h.source": ["ソース動画", "源视频", "Source video"],
  "h.promptMode": ["プロンプト形式", "提示词格式", "Prompt format"],
  "h.globalPrompt": ["全体の説明", "整体描述", "Overall description"],
  "h.summary": ["ひとことで", "一句话概括", "One-line summary"],
  "h.soundscape": ["環境音", "环境声", "Ambient sound"],
  "h.music": ["BGM", "配乐", "Music"],
  "h.negative": ["ネガティブプロンプト", "负面提示词", "Negative prompt"],
  "h.maskMode": ["描き直す範囲", "重画范围", "What is redone"],
  "h.freeCells": ["描き直すセル", "要重画的格", "Cells to redo"],
  "h.cutFrames": ["カット点のフレーム", "切点帧", "Cut frames"],
  "h.radius": ["半径", "半径", "Radius"],
  "h.allFree": ["全体を描き直す", "整段都重画", "Redo everything"],
  "h.onlySelected": ["選択中のショットだけ描き直す", "只重画选中的镜头", "Redo only the selected shot"],
  "h.collapse": ["折りたたみ", "折叠", "Collapse"],
  "h.segPrompt": ["ショット %1 の説明", "镜头 %1 的描述", "Shot %1 text"],
  "edit.budgetHint": [
    "クリップ全体の参照素材上限。共通素材と各ショットの素材を合算。",
    "片段共用的参考素材上限，共通素材与各镜头素材合并计数。",
    "Reference material limits for the whole clip. Shared and shot-specific material are counted together."],
  "takes.finalFramesHint": [
    "テイク間でカット位置が異なる場合、どちらのショットにも属さないフレームを除去。",
    "候选切点不一致时，移除不属于任一镜头的帧。",
    "When takes cut at different positions, frames belonging to neither shot are removed."],
  "post.facePresetHint": [
    "現在のプリセットで顔の周辺を再生成。処理時間はクリップ 1 本の生成と同程度。",
    "按当前预设重新生成人脸周边区域，耗时与生成一条片段相近。",
    "Regenerates the face region with the active preset. Takes about as long as generating one clip."],

};

export function t(key, ...args) {
  const row = S[key];
  if (row == null) return key;
  // The current language, else English, else whichever column has text.
  const cells = Array.isArray(row) ? row : [row];
  let s = cells[IDX[getLang()]] || cells[IDX.en] || cells.find((c) => c) || key;
  args.forEach((a, i) => { s = s.split(`%${i + 1}`).join(String(a)); });
  return s;
}
