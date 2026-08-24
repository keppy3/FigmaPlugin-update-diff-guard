// Update Diff Guard — UI iframe (browser environment: Canvas, pixelmatch).
//
// Owns all clean/diff classification: code.ts sends raw before/after PNG
// bytes (or a sizeChanged flag) per instance; this file runs pixelmatch,
// decides which tab a row belongs in, and renders it. code.ts never needs
// to know an instance's classification — only its id.
//
// Diff rows always show Current and Latest side by side (no rendered diff
// visualization) — pixelmatch is still run for diff rows whose size
// matches, but only its pixel count is used (for the diff% badge), not its
// output image.

import pixelmatch from "pixelmatch";

type RowStatus = "clean" | "diff";

interface RowData {
  id: string;
  name: string;
  status: RowStatus;
  mainComponentName: string; // ソート用。インスタンスの表示名（オーバーライドされ得る）ではなく参照先メインコンポーネントの名前
  area: number; // ソート用。インスタンス自身のwidth * height（見た目差分の有無に関わらず安定した値）
  imageUrl?: string; // clean only: single thumbnail (Current === Latest)
  currentUrl?: string; // diff only
  latestUrl?: string; // diff only
  diffPercent?: number; // diff only, present when sizes matched
  sizeMismatch?: boolean; // diff only
}

interface ExcludedEntry {
  name: string;
  reason: string;
}

const EYE_OPEN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_CLOSED =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/><path d="M2 2l12 12"/></svg>';
const CHEVRON_SVG =
  '<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const JUMP_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M14 6V2h-4M10 14h4v-4M2 10v4h4"/></svg>';
// すべて展開/折りたたむトグルの2状態アイコン（「すべて展開」の状態＝クリックで
// 全展開する、を示す二重シェブロン下向き。展開後は上向きに切り替わる）。
const DOUBLE_CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l4 4 4-4"/><path d="M4 9l4 4 4-4"/></svg>';
const DOUBLE_CHEVRON_UP =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l4-4 4 4"/><path d="M4 7l4-4 4 4"/></svg>';

const SORT_ICON =
  '<svg class="sort-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v8M4 12l-2-2M4 12l2-2M12 12V4M12 4l2 2M12 4l-2 2"/></svg>';
const SORT_DIR_ASC =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M8 3L4 7M8 3l4 4"/></svg>';
const SORT_DIR_DESC =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M8 13l-4-4M8 13l4-4"/></svg>';
const SORT_CHECK =
  '<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 5"/></svg>';

/* ---- 並び替え ----
   5つのタブ（更新の見た目差分なし/あり、スワップの見た目差分なし/あり/
   バリアント不一致）は1つのソート状態をタブ横断で共有する（どのタブで
   変更しても他の全タブに即座に反映される）。スキャン開始時（更新/スワップ
   どちらでも）にデフォルトへリセットする（§onScanStarted/onSwapScanStarted参照）。 */
type SortKey = "default" | "mainComponentName" | "size";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}
const SORT_KEY_LABELS: Record<SortKey, string> = {
  default: "デフォルト（レイヤー順）",
  mainComponentName: "メインコンポーネント名",
  size: "コンポーネントサイズ",
};
const SORT_KEYS: SortKey[] = ["default", "mainComponentName", "size"];

type SortTab = "clean" | "diff" | "swapClean" | "swapDiff" | "swapVariant";
const sortState: SortState = { key: "default", dir: "asc" };

function compareRows(a: RowData, b: RowData, key: SortKey): number {
  if (key === "mainComponentName") return a.mainComponentName.localeCompare(b.mainComponentName, "ja");
  if (key === "size") return a.area - b.area;
  return 0; // "default" — 呼び出し側で元の配列順（＝スキャン到達順）をそのまま使う
}

// レンダリングとShift範囲選択の両方が「今画面に表示されている順序」で一致
// している必要があるため、一元化したこの関数を両方から呼ぶ。cleanIds等の
// 元配列そのものは並び替えない（「デフォルト」＝スキャン到達順という基準を
// 保持するため）。
function getSortedIds(ids: string[], rowsMap: Map<string, RowData>, sort: SortState): string[] {
  let sorted: string[];
  if (sort.key === "default") {
    sorted = ids;
  } else {
    sorted = [...ids].sort((idA, idB) => {
      const a = rowsMap.get(idA);
      const b = rowsMap.get(idB);
      if (!a || !b) return 0;
      return compareRows(a, b, sort.key);
    });
  }
  return sort.dir === "asc" ? sorted : [...sorted].reverse();
}

const EXCLUDED_GROUP_ID = "__excluded__"; // 対象外アコーディオンのdata-id。expandedIdsに同居させ、行の開閉と同じ仕組みで管理する

const rows = new Map<string, RowData>();
let cleanIds: string[] = [];
let diffIds: string[] = [];
let excluded: ExcludedEntry[] = [];
const checked: Record<string, boolean> = {};
// Present (true/false) once a Latest-preview has been placed for that row;
// the value tracks its current show/hide state. Absent = not placed yet.
const latestVisible: Record<string, boolean> = {};
let scanning = false;
let scanTotal = 0;
let scanDone = 0;
let markerCount = 0;
// Per-row accordion open/closed state, persisted across re-renders so
// toggling a preview, placing a latest instance, etc. don't collapse rows
// the user manually expanded. "すべて展開"/"すべて折りたたむ" are one-shot
// activations that stamp this map, not a passive aggregate state.
const expandedIds: Record<string, boolean> = {};
let lastClickedIndex: { tab: "clean" | "diff"; index: number } | null = null;

// ---- ライブラリスワップの結果画面用の状態（更新フローとは別に持つ） ----
// 中身（行の描画・タブ切り替え・一括操作）は更新フローとほぼ同じロジックだが、
// DOM/状態を完全に分けている。config.ts側はstore/wrapperStoreを共有し、
// sourceタグでメッセージ種別だけ振り分けている（§code.ts参照）。
interface SwapStrayItemMsg {
  id: string;
  name: string;
  path: string; // レイヤー階層パス（例: Home / Section 02 / Card01）。展開時に連番の代わりに表示する
  reason: string;
  category: "name" | "variant" | "other";
  thumbnail?: Uint8Array; // グループの最初の1件だけcode.ts側が付けてくる
}
// 名前不一致は同名・同理由のインスタンスが大量に並びがちなので、名前＋理由の組み合わせ
// でまとめて1行にする。サムネイルもグループの最初の1件分だけ（オーバーライドで
// 個体差があっても、全件分は重くなるため代表1枚に留める）。
interface SwapStrayGroup {
  name: string;
  reason: string;
  category: "name" | "variant" | "other";
  items: { id: string; path: string }[]; // グループ内の全インスタンス。展開すると1件ずつジャンプできる
  thumbnailUrl?: string;
}
const swapRows = new Map<string, RowData>();
let swapCleanIds: string[] = [];
let swapDiffIds: string[] = [];
// バリアント名不一致だが、コンポーネントセット自体は見つかったため、Figma純正の
// ライブラリスワップに倣ってデフォルトバリアントを暫定の差し替え先として提示する
// 項目。見た目差分ありタブと同じ行UI・操作（このままスワップ／比較用インスタンス
// 配置）を持つが、自動選択である旨を毎回明示するため独立したタブに分けている。
let swapVariantIds: string[] = [];
// 既にこのライブラリの最新版を参照している＝スワップしても何も変わらない項目。
// 更新フロー側の「対象外・更新なし」（§excluded）と同じ扱いで、見た目差分なし
// タブの中にアコーディオンでまとめるだけにする（チェック不可・一括対象外）。
let swapExcluded: ExcludedEntry[] = [];
const SWAP_EXCLUDED_GROUP_ID = "__swap_excluded__";
const swapStrayGroups = new Map<string, SwapStrayGroup>(); // key: `${name} ${reason}`
const swapChecked: Record<string, boolean> = {};
const swapLatestVisible: Record<string, boolean> = {};
let swapScanning = false;
let swapScanTotal = 0;
let swapScanDone = 0;
const swapExpandedIds: Record<string, boolean> = {};
let swapLastClickedIndex: { tab: "clean" | "diff" | "variant"; index: number } | null = null;
const swapViews = { paste: $("swapPasteView"), busy: $("swapBulkBusyView"), result: $("swapResultView") };

function post(msg: Record<string, unknown>): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/* ---- view switching ---- */
const views = { setup: $("setupView"), busy: $("busyView"), result: $("resultView") };

function show(name: keyof typeof views): void {
  (Object.keys(views) as Array<keyof typeof views>).forEach((k) => views[k].classList.toggle("hidden", k !== name));
  updateModeTabsDisabledState();
}

let toastTimer: number | undefined;
function showToast(msg: string, durationMs = 2600): void {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), durationMs);
}

/* ---- リセット（常設・busy中はグレーアウト） ---- */
function resetToSetup(): void {
  rows.clear();
  cleanIds = [];
  diffIds = [];
  excluded = [];
  Object.keys(checked).forEach((k) => delete checked[k]);
  Object.keys(latestVisible).forEach((k) => delete latestVisible[k]);
  Object.keys(expandedIds).forEach((k) => delete expandedIds[k]);
  markerCount = 0;
  lastClickedIndex = null;
  show("setup");
}

/* ---- 最上部モードタブ（更新／ライブラリスワップ／ライブラリスキャン） ----
   専用のヘッダーバー・リセットボタンは持たない。3機能とも同時に作業することは
   想定しておらず、store/wrapperStoreをモード間で共有している都合上、異なる
   モードのスキャンが同時に走ると同一インスタンスへの書き込みが競合しかねない
   （後勝ちで片方のスキャン結果が静かに壊れる）。そのため、いずれかのモードが
   開始画面より先に進んだ時点で他の2タブは「ロック」（グレーアウトはするが
   クリックは常に受け付け、確認モーダル経由で今のモードをリセットしてから
   切り替える）状態にする。 */
type Mode = "update" | "swap-apply" | "swap-scan";
let currentMode: Mode = "update";
const modePanes: Record<Mode, HTMLElement> = {
  update: $("updateModePane"),
  "swap-apply": $("swapApplyModePane"),
  "swap-scan": $("swapScanModePane"),
};

// そのモードがまだ「何も失うものがない」初期画面（更新のスキャン前画面／
// スワップの貼り付け画面／ライブラリスキャンの説明画面）を表示中かどうか。
// 真なら、そのタブを操作しても確認なしで即座に反映してよい。
function isAtModeStart(mode: Mode): boolean {
  if (mode === "update") return !views.setup.classList.contains("hidden");
  if (mode === "swap-apply") return !swapViews.paste.classList.contains("hidden");
  if (mode === "swap-scan") return !scanLibViews.intro.classList.contains("hidden");
  return true;
}

function updateModeTabsDisabledState(): void {
  const locked = !isAtModeStart(currentMode);
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
    const mode = btn.dataset.mode as Mode;
    btn.disabled = false; // ロック中も常にクリック可能（確認モーダル経由でのみ切り替え・リセットする）
    btn.classList.toggle("locked", locked && mode !== currentMode);
  });
}

function switchModePane(mode: Mode): void {
  currentMode = mode;
  (Object.keys(modePanes) as Mode[]).forEach((m) => modePanes[m].classList.toggle("hidden", m !== mode));
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  updateModeTabsDisabledState();
}

// リセット確認→キャンセル送信、の後にスキャン中止が非同期で完了するのを
// 待ってから切り替える必要があるケース用（§onScanFinished/onSwapScanFinished/
// onLibraryScanCancelled参照）。同一モードへの再クリック（その場でリセット
// するだけ）ならnullのまま。
let pendingSwitchAfterCancel: Mode | null = null;

function consumePendingSwitch(): void {
  if (pendingSwitchAfterCancel) {
    switchModePane(pendingSwitchAfterCancel);
    pendingSwitchAfterCancel = null;
  }
}

function performModeReset(resetMode: Mode, switchToMode: Mode): void {
  if (resetMode === "update") {
    if (scanning) {
      pendingSwitchAfterCancel = switchToMode !== resetMode ? switchToMode : null;
      post({ type: "cancel-scan" }); // onScanFinished(true)で戻ってきてから切り替える
      return;
    }
    resetToSetup();
  } else if (resetMode === "swap-apply") {
    if (swapScanning) {
      pendingSwitchAfterCancel = switchToMode !== resetMode ? switchToMode : null;
      post({ type: "cancel-swap-scan" });
      return;
    }
    resetSwapToPaste();
  } else if (resetMode === "swap-scan") {
    if (!$("scanLibBusyView").classList.contains("hidden")) {
      pendingSwitchAfterCancel = switchToMode !== resetMode ? switchToMode : null;
      post({ type: "cancel-library-scan" });
      return;
    }
    showScanLib("intro");
  }
  if (switchToMode !== resetMode) switchModePane(switchToMode);
}

let pendingResetMode: Mode | null = null;
let pendingResetSwitchTo: Mode | null = null;

function openResetConfirm(resetMode: Mode, switchToMode: Mode): void {
  pendingResetMode = resetMode;
  pendingResetSwitchTo = switchToMode;
  $("resetConfirmOverlay").classList.remove("hidden");
}

$("resetConfirmCancel").addEventListener("click", () => {
  $("resetConfirmOverlay").classList.add("hidden");
  pendingResetMode = null;
  pendingResetSwitchTo = null;
});

$("resetConfirmOk").addEventListener("click", () => {
  $("resetConfirmOverlay").classList.add("hidden");
  if (pendingResetMode) performModeReset(pendingResetMode, pendingResetSwitchTo ?? pendingResetMode);
  pendingResetMode = null;
  pendingResetSwitchTo = null;
});

function selectMode(mode: Mode): void {
  if (mode === currentMode) {
    // 既に初期画面ならリセットしても何も変わらないので確認不要。それ以外
    // （スキャン中・結果表示中）は誤操作で今のセッションを失わないよう確認を挟む。
    if (!isAtModeStart(mode)) openResetConfirm(mode, mode);
    return;
  }
  if (!isAtModeStart(currentMode)) {
    // 今のモードがまだ何か持っている状態から別モードへ切り替えようとした
    // ケース。3機能を横断して同時作業することは想定していない（store/
    // wrapperStoreの競合リスク）ため、ここも同じ確認モーダルに乗せる。
    openResetConfirm(currentMode, mode);
    return;
  }
  switchModePane(mode);
}

document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => selectMode(btn.dataset.mode as Mode));
});

/* ---- スキャン完了時のアラート音 ---- */
// AudioContextはユーザー操作なしで生成/再生しようとするとブラウザの自動再生
// ポリシーでブロックされる。スキャン開始ボタンのクリック（=ユーザー操作）の
// タイミングで生成・resumeしておくことで、非同期に届くスキャン完了メッセージ
// の時点では確実に再生できる状態にしておく。
let audioCtx: AudioContext | null = null;

function ensureAudioUnlocked(): void {
  if (!audioCtx) audioCtx = new AudioContext();
  else if (audioCtx.state === "suspended") void audioCtx.resume();
}

function playCompletionChime(): void {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") void audioCtx.resume();
  const ctx = audioCtx;
  const now = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * 0.12;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.22);
  });
}

/* ---- image helpers ---- */
function dataUrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

function loadImageData(bytes: Uint8Array): Promise<{ data: ImageData; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as unknown as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("2d context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ data, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

interface ScanItemMsg {
  id: string;
  name: string;
  mainComponentName: string;
  width: number;
  height: number;
  sizeChanged: boolean;
  before?: Uint8Array;
  after?: Uint8Array;
}

async function processDiff(msg: ScanItemMsg): Promise<RowData> {
  const mainComponentName = msg.mainComponentName;
  const area = msg.width * msg.height;

  if (msg.sizeChanged || !msg.before || !msg.after) {
    return {
      id: msg.id,
      name: msg.name,
      status: "diff",
      mainComponentName,
      area,
      sizeMismatch: true,
      currentUrl: msg.before ? dataUrlFromBytes(msg.before) : undefined,
      latestUrl: msg.after ? dataUrlFromBytes(msg.after) : undefined,
    };
  }

  const before = await loadImageData(msg.before);
  const after = await loadImageData(msg.after);
  if (before.width !== after.width || before.height !== after.height) {
    return {
      id: msg.id,
      name: msg.name,
      status: "diff",
      mainComponentName,
      area,
      sizeMismatch: true,
      currentUrl: dataUrlFromBytes(msg.before),
      latestUrl: dataUrlFromBytes(msg.after),
    };
  }

  const { width, height } = before;
  // Only the pixel count matters now (for the diff% badge) — the rows no
  // longer render pixelmatch's visualized output, so there's no need to
  // give it a real output buffer.
  const numDiffPixels = pixelmatch(before.data.data, after.data.data, null, width, height, { threshold: 0.1 });

  if (numDiffPixels === 0) {
    return { id: msg.id, name: msg.name, status: "clean", mainComponentName, area, imageUrl: dataUrlFromBytes(msg.after) };
  }

  const diffPercent = (numDiffPixels / (width * height)) * 100;
  return {
    id: msg.id,
    name: msg.name,
    status: "diff",
    mainComponentName,
    area,
    diffPercent,
    currentUrl: dataUrlFromBytes(msg.before),
    latestUrl: dataUrlFromBytes(msg.after),
  };
}

/* ---- scope radios ---- */
$("radioGroup").addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (target.name !== "scope") return;
  document.querySelectorAll("#radioGroup .radio-option").forEach((opt) => {
    opt.classList.toggle("active", opt.getAttribute("data-scope") === target.value);
  });
});

/* ---- スキャン開始 / キャンセル ---- */
$("scanBtn").addEventListener("click", () => {
  ensureAudioUnlocked();
  const checkedRadio = document.querySelector<HTMLInputElement>('input[name="scope"]:checked');
  post({ type: "scan", scope: checkedRadio ? checkedRadio.value : "selection" });
});

$("cancelScanBtn").addEventListener("click", (e) => {
  (e.currentTarget as HTMLButtonElement).disabled = true;
  post({ type: "cancel-scan" });
});

function onScanStarted(total: number): void {
  rows.clear();
  cleanIds = [];
  diffIds = [];
  excluded = [];
  Object.keys(checked).forEach((k) => delete checked[k]);
  Object.keys(latestVisible).forEach((k) => delete latestVisible[k]);
  Object.keys(expandedIds).forEach((k) => delete expandedIds[k]);
  sortState.key = "default";
  sortState.dir = "asc";
  setSortControlsEnabled(false);
  scanning = true;
  scanTotal = total;
  scanDone = 0;
  lastClickedIndex = null;

  show("result");
  $("scanProgressStrip").classList.remove("hidden");
  ($("cancelScanBtn") as HTMLButtonElement).disabled = false;
  updateScanProgress();
  renderTabs();
}

function updateScanProgress(): void {
  $("scanProgressText").textContent = `確認中… ${scanDone} / ${scanTotal}`;
  ($("scanProgressFill").style as CSSStyleDeclaration).width = scanTotal ? `${Math.round((scanDone / scanTotal) * 100)}%` : "0%";
}

function onScanExcluded(name: string, reason: string): void {
  excluded.push({ name, reason });
  scanDone++;
  updateScanProgress();
  // onScanStarted時点でscanning=trueのままrenderTabs()済みなので、この
  // アコーディオン自体は既にDOMにある。中身と件数表示だけを更新すれば足りる。
  const group = $("cleanList").querySelector(`[data-id="${EXCLUDED_GROUP_ID}"]`);
  group?.querySelector(".excluded-rows")?.insertAdjacentHTML("beforeend", excludedRowHtml({ name, reason }));
  const countEl = group?.querySelector(".num");
  if (countEl) countEl.textContent = `(${excluded.length})`;
}

async function onScanItemResult(msg: ScanItemMsg): Promise<void> {
  const row = await processDiff(msg);
  rows.set(row.id, row);
  if (row.status === "clean") {
    cleanIds.push(row.id);
  } else {
    diffIds.push(row.id);
  }
  checked[row.id] = true;
  scanDone++;
  updateScanProgress();
  $("cleanCount").textContent = `(${cleanIds.length})`;
  $("diffCount").textContent = `(${diffIds.length})`;
  appendResultRow(row.status === "clean" ? "clean" : "diff", row.id);
  updateFooterButtons();
  updateListToolbarToggles(row.status === "clean" ? "clean" : "diff");
}

function onScanFinished(cancelled: boolean): void {
  scanning = false;
  if (!swapScanning) setSortControlsEnabled(true);
  $("scanProgressStrip").classList.add("hidden");
  if (cancelled) {
    resetToSetup();
    showToast("スキャンを中止しました");
    consumePendingSwitch();
  } else {
    renderTabs();
  }
}

/* ---- タブ切り替え（見た目差分なし／あり） ----
   ライブラリスワップ側にも見た目は同じ .tab/.tab-panel を使う別ルート
   （data-swaptab/data-swappanel、下部で配線）を用意している。同じクラスを
   共有するので、ここは #resultView 配下だけに絞って衝突を避ける。 */
document.querySelectorAll<HTMLButtonElement>("#resultView .tab").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll("#resultView .tab").forEach((t) => t.classList.toggle("active", t === tabBtn));
    const name = tabBtn.getAttribute("data-tab");
    document.querySelectorAll("#resultView .tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.getAttribute("data-panel") !== name);
    });
  });
});

/* ---- 行の描画 ---- */
function jumpBtnHtml(id: string): string {
  return `<button class="ghost-btn" data-jump="${id}">${JUMP_ICON}ジャンプ</button>`;
}

function cleanRowHtml(id: string, justEntered: boolean): string {
  const row = rows.get(id);
  if (!row) return "";

  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${checked[id] ? "checked" : ""}>`;
  const miniThumb = `<img class="row-mini-thumb" src="${row.imageUrl || ""}" alt="">`;

  return `<details class="row${justEntered ? " enter" : ""}" data-id="${id}" ${expandedIds[id] ? "open" : ""}>
    <summary class="row-summary">
      ${checkbox}
      ${miniThumb}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="row-detail">
      <div class="preview-row">
        <div class="thumb-col"><div class="preview-frame"><img src="${row.imageUrl || ""}" alt=""></div><span class="thumb-label">Current = Latest（完全一致）</span></div>
        <div class="side-col">${jumpBtnHtml(id)}</div>
      </div>
      <div class="row-buttons"><button class="ghost-btn fill" data-individual-update="${id}">更新する</button></div>
    </div>
  </details>`;
}

function diffRowButtons(id: string): string {
  // Place-latest and the eye toggle/delete pair are mutually exclusive:
  // before placement only the place button shows, after placement it's
  // replaced by the toggle+delete pair (not shown alongside it, greyed out).
  const forceBtn = `<button class="ghost-btn fill" data-individual-force="${id}">このまま更新</button>`;
  const placed = Object.prototype.hasOwnProperty.call(latestVisible, id);
  if (!placed) {
    return `<div class="row-buttons">${forceBtn}<button class="ghost-btn warn" data-place-latest="${id}">比較用インスタンスを配置</button></div>`;
  }
  const eyeIcon = latestVisible[id] ? EYE_OPEN : EYE_CLOSED;
  return `<div class="row-buttons">${forceBtn}<button class="ghost-btn danger" data-remove-latest="${id}">比較用インスタンスを削除</button><button class="ghost-btn" data-toggle-latest="${id}">${eyeIcon}表示切替</button></div>`;
}

function diffRowHtml(id: string, justEntered: boolean): string {
  const row = rows.get(id);
  if (!row) return "";

  const latestLabel = row.sizeMismatch
    ? "Latest（サイズ不一致）"
    : `Latest（差分${(row.diffPercent ?? 0).toFixed(1)}%）`;

  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${checked[id] ? "checked" : ""}>`;
  const miniThumb = `<img class="row-mini-thumb" src="${row.currentUrl || ""}" alt="">`;

  return `<details class="row${justEntered ? " enter" : ""}" data-id="${id}" ${expandedIds[id] ? "open" : ""}>
    <summary class="row-summary">
      ${checkbox}
      ${miniThumb}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="row-detail">
      <div class="preview-row">
        <div class="thumb-col"><div class="preview-frame"><img src="${row.currentUrl || ""}" alt=""></div><span class="thumb-label">Current</span></div>
        <div class="thumb-col"><div class="preview-frame"><img src="${row.latestUrl || ""}" alt=""></div><span class="thumb-label">${latestLabel}</span></div>
        <div class="side-col">${jumpBtnHtml(id)}</div>
      </div>
      ${diffRowButtons(id)}
    </div>
  </details>`;
}

/* ---- 対象外（見た目差分なしタブのリストに、他の行と同じアコーディオンで同居） ---- */
function excludedRowHtml(entry: ExcludedEntry): string {
  return `<div class="excluded-row"><span class="row-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span><span class="excluded-reason">${escapeHtml(entry.reason)}</span></div>`;
}

function excludedGroupHtml(): string {
  const open = expandedIds[EXCLUDED_GROUP_ID] ? " open" : "";
  return `<details class="row" data-id="${EXCLUDED_GROUP_ID}"${open}>
    <summary class="row-summary excluded-summary">
      <span class="row-name">対象外・更新なし <span class="num">(${excluded.length})</span></span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="excluded-rows">${excluded.map(excludedRowHtml).join("")}</div>
  </details>`;
}

function emptyState(kind: "clean" | "diff"): string {
  if (scanning) return '<div class="empty-state"><span class="spinner sm"></span>確認中…</div>';
  return `<div class="empty-state">${kind === "clean" ? "見た目差分なしの項目はありません" : "見た目差分ありの項目はありません"}</div>`;
}

function renderTabs(justEnteredId?: string): void {
  $("cleanCount").textContent = `(${cleanIds.length})`;
  $("diffCount").textContent = `(${diffIds.length})`;

  const sortedCleanIds = getSortedIds(cleanIds, rows, sortState);
  const sortedDiffIds = getSortedIds(diffIds, rows, sortState);

  let cleanHtml = sortedCleanIds.length
    ? sortedCleanIds.map((id) => cleanRowHtml(id, id === justEnteredId)).join("")
    : emptyState("clean");
  if (excluded.length || scanning) cleanHtml += excludedGroupHtml();
  $("cleanList").innerHTML = cleanHtml;

  $("diffList").innerHTML = sortedDiffIds.length
    ? sortedDiffIds.map((id) => diffRowHtml(id, id === justEnteredId)).join("")
    : emptyState("diff");

  wireRowEvents();
  updateFooterButtons();
  updateListToolbarToggles("clean");
  updateListToolbarToggles("diff");
  updateSortControl("clean");
  updateSortControl("diff");
}

// 1行分の要素にだけイベントを配線する。renderTabs()の全件再描画（wireRowEvents）
// と、スキャン中の1行追加（appendResultRow）の両方から呼べるように、対象を
// 「今追加したその1行」に限定できる形にしてある。
function wireRow(row: Element): void {
  if (row instanceof HTMLDetailsElement) {
    row.addEventListener("toggle", () => {
      const id = row.getAttribute("data-id");
      if (id) expandedIds[id] = row.open;
    });
  }
  row.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      handleCheckboxClick(cb, e as MouseEvent);
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "jump", id: btn.getAttribute("data-jump") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-individual-update]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "更新中…";
      post({ type: "apply", id: btn.getAttribute("data-individual-update") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-individual-force]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-individual-force")!;
      openForceConfirm({ kind: "single", id, btn, mode: "update" });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-place-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "配置中…";
      post({ type: "place-latest", id: btn.getAttribute("data-place-latest") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-toggle-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "toggle-latest", id: btn.getAttribute("data-toggle-latest") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-remove-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "remove-latest", id: btn.getAttribute("data-remove-latest") });
    });
  });
}

function wireRowEvents(): void {
  document.querySelectorAll("#resultView .row").forEach(wireRow);
}

// スキャン中に1件見つかるたびに全件再描画すると、見つかった件数の2乗に比例
// して重くなる（N件見つかった時点までの累計作業量が1+2+...+N ≒ N²）。他の
// 行には一切触れず、新しい1行分のHTMLだけをDOMに追加する。デフォルト
// （レイヤー順）ソート＝到着順のときだけ成立する前提なので、スキャン中は
// ソート操作自体を無効化して守る（§setSortControlsEnabled）。
function appendResultRow(kind: "clean" | "diff", id: string): void {
  const listEl = $(kind === "clean" ? "cleanList" : "diffList");
  listEl.querySelector(".empty-state")?.remove();

  const html = kind === "clean" ? cleanRowHtml(id, true) : diffRowHtml(id, true);
  const excludedAnchor = kind === "clean" ? listEl.querySelector(`[data-id="${EXCLUDED_GROUP_ID}"]`) : null;
  if (excludedAnchor) {
    excludedAnchor.insertAdjacentHTML("beforebegin", html);
  } else {
    listEl.insertAdjacentHTML("beforeend", html);
  }
  const newRow = excludedAnchor ? excludedAnchor.previousElementSibling : listEl.lastElementChild;
  if (newRow) wireRow(newRow);
}

/* ---- チェックボックス: 通常クリック + Shiftで範囲選択 ---- */
function handleCheckboxClick(cb: HTMLInputElement, e: MouseEvent): void {
  const id = cb.getAttribute("data-id")!;
  const tab: "clean" | "diff" = cleanIds.includes(id) ? "clean" : "diff";
  // Shift範囲選択は「今画面に表示されている順序」（並び替え適用後）で動く
  // 必要があるので、元配列ではなく現在の並び替え結果を使う。
  const list = getSortedIds(tab === "clean" ? cleanIds : diffIds, rows, sortState);
  const index = list.indexOf(id);
  const newState = cb.checked; // click already toggled the native checkbox by the time this fires

  if (e.shiftKey && lastClickedIndex && lastClickedIndex.tab === tab) {
    const from = Math.min(lastClickedIndex.index, index);
    const to = Math.max(lastClickedIndex.index, index);
    for (let i = from; i <= to; i++) checked[list[i]] = newState;
    renderTabs();
  } else {
    checked[id] = newState;
    updateFooterButtons();
    updateListToolbarToggles(tab);
  }
  lastClickedIndex = { tab, index };
}

/* ---- すべて選択/解除・すべて展開/折りたたむ（3状態トグル1個ずつに集約） ----
   選択チェックボックスはネイティブのindeterminate仕様をそのまま使う: 一部
   選択中はindeterminate=trueで表示し、その状態でクリックすると仕様上
   checked=trueに解決される（＝全選択）。全選択中のクリックはchecked=false
   （＝全解除）、未選択中のクリックはchecked=true（＝全選択）と、ネイティブの
   トグル挙動だけで要件の3状態遷移がそのまま成立する。展開/折りたたむは
   ネイティブ相当が無いので、同じ状態遷移をボタン+アイコン差し替えで手動実装。 */
function bindListToolbar(tab: "clean" | "diff"): void {
  const list = tab === "clean" ? (): string[] => cleanIds : (): string[] => diffIds;
  $(`${tab}SelectAllToggle`).addEventListener("click", () => {
    const newState = ($(`${tab}SelectAllToggle`) as HTMLInputElement).checked;
    list().forEach((id) => (checked[id] = newState));
    renderTabs();
  });
  $(`${tab}ExpandToggle`).addEventListener("click", () => {
    const allExpanded = list().length > 0 && list().every((id) => expandedIds[id]);
    const newState = !allExpanded;
    list().forEach((id) => (expandedIds[id] = newState));
    renderTabs();
  });
}
bindListToolbar("clean");
bindListToolbar("diff");

function updateListToolbarToggles(tab: "clean" | "diff"): void {
  const list = tab === "clean" ? cleanIds : diffIds;
  const checkedCount = list.filter((id) => checked[id]).length;
  const selectToggle = $(`${tab}SelectAllToggle`) as HTMLInputElement;
  selectToggle.checked = list.length > 0 && checkedCount === list.length;
  selectToggle.indeterminate = checkedCount > 0 && checkedCount < list.length;
  selectToggle.disabled = list.length === 0;

  const allExpanded = list.length > 0 && list.every((id) => expandedIds[id]);
  const expandToggle = $(`${tab}ExpandToggle`) as HTMLButtonElement;
  expandToggle.innerHTML = allExpanded ? DOUBLE_CHEVRON_UP : DOUBLE_CHEVRON_DOWN;
  expandToggle.title = allExpanded ? "すべて折りたたむ" : "すべて展開";
  expandToggle.disabled = list.length === 0;
}

/* ---- 並び替えコントロール（5タブ共通） ---- */
let openSortMenuTab: SortTab | null = null;

function closeSortMenu(): void {
  if (!openSortMenuTab) return;
  $(`${openSortMenuTab}SortMenu`).classList.add("hidden");
  openSortMenuTab = null;
}

// ソート状態は5タブで共有なので、どのタブで変更してもレンダリング対象になり
// 得る両モードのリストを両方まとめて再描画する（それぞれの内部で5タブ分の
// updateSortControlも呼ばれる）。
function rerenderAllSortTabs(): void {
  renderTabs();
  renderSwapTabs();
}

function sortMenuItemHtml(key: SortKey): string {
  const active = sortState.key === key;
  return `<button class="sort-menu-item${active ? " active" : ""}" data-sort-key="${key}">
    <span>${SORT_KEY_LABELS[key]}</span>
    ${active ? SORT_CHECK : ""}
  </button>`;
}

function openSortMenu(tab: SortTab): void {
  const menu = $(`${tab}SortMenu`);
  menu.innerHTML = SORT_KEYS.map((key) => sortMenuItemHtml(key)).join("");
  menu.querySelectorAll<HTMLButtonElement>("[data-sort-key]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      sortState.key = btn.getAttribute("data-sort-key") as SortKey;
      closeSortMenu();
      rerenderAllSortTabs();
    });
  });
  menu.classList.remove("hidden");
  openSortMenuTab = tab;
}

function bindSortControl(tab: SortTab): void {
  $(`${tab}SortKeyBtn`).addEventListener("click", (e) => {
    e.stopPropagation();
    if (openSortMenuTab === tab) {
      closeSortMenu();
    } else {
      closeSortMenu();
      openSortMenu(tab);
    }
  });
  $(`${tab}SortDirBtn`).addEventListener("click", () => {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    rerenderAllSortTabs();
  });
}
(["clean", "diff", "swapClean", "swapDiff", "swapVariant"] as SortTab[]).forEach(bindSortControl);
document.addEventListener("click", () => closeSortMenu());

function updateSortControl(tab: SortTab): void {
  const keyBtn = $(`${tab}SortKeyBtn`);
  const caret =
    '<svg class="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
  keyBtn.innerHTML = `${SORT_ICON}<span>${SORT_KEY_LABELS[sortState.key]}</span>${caret}`;

  const dirBtn = $(`${tab}SortDirBtn`) as HTMLButtonElement;
  const isAsc = sortState.dir === "asc";
  dirBtn.innerHTML = isAsc ? SORT_DIR_ASC : SORT_DIR_DESC;
  dirBtn.title = isAsc ? "降順に切り替え" : "昇順に切り替え";

  // 開いたままレンダリングが走った場合（バックグラウンドの更新等）に備えて、
  // メニューが開いていれば選択チェックの表示も同期しておく。
  if (openSortMenuTab === tab) openSortMenu(tab);
}

// ソート状態は5タブ共有の単一値なので、スキャン中（更新・スワップどちらか
// 一方でも）は変更させない。appendResultRowは「デフォルト（レイヤー順）＝
// 到着順」を前提に末尾へ直接追加するだけなので、スキャン中にソートが変わると
// 表示順が崩れる。呼び出し元（onScanStarted/Finished、onSwapScanStarted/
// Finished）は自分の対象範囲だけでなく、もう一方のスキャンも動いていないか
// 見てから判断する。
function setSortControlsEnabled(enabled: boolean): void {
  (["clean", "diff", "swapClean", "swapDiff", "swapVariant"] as SortTab[]).forEach((tab) => {
    ($(`${tab}SortKeyBtn`) as HTMLButtonElement).disabled = !enabled;
    ($(`${tab}SortDirBtn`) as HTMLButtonElement).disabled = !enabled;
  });
}

function updateFooterButtons(): void {
  const cleanChecked = cleanIds.filter((id) => checked[id]).length;
  $("updateBtnLabel").textContent = `一括更新(${cleanChecked})`;
  ($("updateBtn") as HTMLButtonElement).disabled = cleanChecked === 0;

  const placeableChecked = diffIds.filter(
    (id) => checked[id] && !Object.prototype.hasOwnProperty.call(latestVisible, id)
  ).length;
  $("placeLatestBtnLabel").textContent = `比較用インスタンスを一括配置(${placeableChecked})`;
  ($("placeLatestBtn") as HTMLButtonElement).disabled = placeableChecked === 0;

  // Unlike the other footer buttons, this isn't scoped to checked rows —
  // it's a full sweep of every tagged node on every page (same as the
  // former standalone "すべて削除", which this button absorbed), so its
  // count and enabled state come from markerCount, not the row list.
  $("clearAllLatestBtnLabel").textContent = `比較用インスタンスをすべて削除(${markerCount})`;
  ($("clearAllLatestBtn") as HTMLButtonElement).disabled = markerCount === 0;

  const forceChecked = diffIds.filter((id) => checked[id]).length;
  $("forceUpdateBtnLabel").textContent = `このまま一括更新(${forceChecked})`;
  ($("forceUpdateBtn") as HTMLButtonElement).disabled = forceChecked === 0;

  ($("cleanSelectCanvas") as HTMLButtonElement).textContent = `すべてのインスタンスを選択(${cleanChecked})`;
  ($("cleanSelectCanvas") as HTMLButtonElement).disabled = cleanChecked === 0;
  ($("diffSelectCanvas") as HTMLButtonElement).textContent = `すべてのインスタンスを選択(${forceChecked})`;
  ($("diffSelectCanvas") as HTMLButtonElement).disabled = forceChecked === 0;
}

/* ---- 一括更新 / 比較用インスタンスを一括配置 / 比較用インスタンスをすべて削除 / このまま一括更新 ---- */
function showBulkBusy(label: string): void {
  show("busy");
  $("busyLabel").textContent = label;
  $("busyStep").textContent = "";
  const fill = $("busyProgress") as HTMLElement;
  fill.style.width = "0%";
  // display:noneから表示に切り替わった直後にwidthを変更すると、その時点の
  // レイアウトがまだ確定しておらずtransitionの起点が正しくコミットされない
  // ことがある（以降の進捗更新が描画に反映されず0%のまま止まって見える）。
  // offsetWidthを読んでレイアウトを強制確定させ、以降の更新が確実に描画に
  // 反映されるようにする。
  void fill.offsetWidth;
}

function onBulkProgress(label: string, name: string, index: number, total: number): void {
  $("busyLabel").textContent = label;
  $("busyStep").textContent = `${name} (${index} / ${total})`;
  ($("busyProgress").style as CSSStyleDeclaration).width = `${Math.round((index / total) * 100)}%`;
}

$("updateBtn").addEventListener("click", () => {
  const targets = cleanIds.filter((id) => checked[id]);
  if (targets.length === 0) return;
  showBulkBusy("更新しています");
  post({ type: "apply-bulk", ids: targets });
});

$("placeLatestBtn").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id] && !Object.prototype.hasOwnProperty.call(latestVisible, id));
  if (targets.length === 0) return;
  showBulkBusy("比較用インスタンスを配置しています");
  post({ type: "place-latest-bulk", ids: targets });
});

$("clearAllLatestBtn").addEventListener("click", () => {
  post({ type: "count-markers" });
});

$("forceUpdateBtn").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets, mode: "update" });
});

// 「すべてのインスタンスを選択」— チェック済みインスタンスをFigmaキャンバス上で
// 選択する（プラグイン内チェックボックスの一括ON/OFFとは別機能）。将来的に
// 廃止される可能性があるため、他の状態には触れない自己完結した1メッセージに
// している（§code.ts handleSelectOnCanvas参照）。
$("cleanSelectCanvas").addEventListener("click", () => {
  const targets = cleanIds.filter((id) => checked[id]);
  if (targets.length === 0) return;
  post({ type: "select-on-canvas", ids: targets });
});
$("diffSelectCanvas").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id]);
  if (targets.length === 0) return;
  post({ type: "select-on-canvas", ids: targets });
});

function removeResolvedId(id: string): void {
  cleanIds = cleanIds.filter((x) => x !== id);
  diffIds = diffIds.filter((x) => x !== id);
  rows.delete(id);
  delete checked[id];
  delete latestVisible[id];
  delete expandedIds[id];
}

function onApplied(id: string): void {
  const row = rows.get(id);
  removeResolvedId(id);
  renderTabs();
  showToast(`「${row?.name ?? id}」を更新しました`);
}

function onApplyBulkDone(ids: string[]): void {
  ids.forEach(removeResolvedId);
  renderTabs();
  show("result");
  showToast(`${ids.length}件を更新しました`);
}

function onLatestPlaced(id: string): void {
  const row = rows.get(id);
  latestVisible[id] = true;
  renderTabs();
  showToast(`「${row?.name ?? id}」に比較用インスタンスを配置しました`);
}

function onLatestPlacedBulk(ids: string[]): void {
  ids.forEach((id) => {
    latestVisible[id] = true;
  });
  renderTabs();
  show("result");
  showToast(`${ids.length}件に比較用インスタンスを配置しました`);
}

function onLatestToggled(id: string, visible: boolean): void {
  latestVisible[id] = visible;
  renderTabs();
}

function onLatestRemoved(id: string): void {
  const row = rows.get(id);
  delete latestVisible[id];
  renderTabs();
  showToast(`「${row?.name ?? id}」に比較用インスタンスを削除しました`);
}

// Fires for "比較用インスタンスをすべて削除" — a full sweep of every tagged node on
// every page, regardless of which rows are currently checked (or even
// currently listed — it also catches leftovers from a previous session).
// Rows named here revert to "not placed" so the place button re-enables,
// instead of staying stuck offering a toggle/delete pair for a wrapper
// that no longer exists.
function onMarkersCleared(ids: string[] | undefined, count: number): void {
  // 全件掃除は出所（更新／スワップ）を問わないので、両モードのlatestVisible状態を
  // まとめて片付け、両方の行リストを再描画する。
  const targetIds = ids && ids.length ? ids : [...Object.keys(latestVisible), ...Object.keys(swapLatestVisible)];
  targetIds.forEach((id) => {
    delete latestVisible[id];
    delete swapLatestVisible[id];
  });
  renderTabs();
  renderSwapTabs();
  showToast(`比較用インスタンスを${count}件削除しました`);
}

/* ---- このまま更新／このままスワップの確認ダイアログ（両モード共有） ---- */
type PendingForce =
  | { kind: "single"; id: string; btn: HTMLButtonElement; mode: "update" | "swap" }
  | { kind: "bulk"; ids: string[]; mode: "update" | "swap" };
let pendingForce: PendingForce | null = null;

function targetHasPlacedLatest(target: PendingForce): boolean {
  const visibleMap = target.mode === "swap" ? swapLatestVisible : latestVisible;
  const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(visibleMap, id);
  return target.kind === "single" ? has(target.id) : target.ids.some(has);
}

function openForceConfirm(target: PendingForce): void {
  pendingForce = target;
  $("confirmBody").textContent =
    target.mode === "swap"
      ? "スワップすると現在の見た目から差異が生じます。よろしいですか？"
      : "更新すると現在の見た目から差異が生じます。よろしいですか？";

  // Only relevant (and only shown) when at least one target row currently
  // has a placed Latest preview — otherwise there's nothing to offer a
  // choice about. Defaults checked to match the previous always-delete
  // behavior for anyone who doesn't touch it.
  const removeLatestRow = $("confirmRemoveLatestRow");
  const removeLatestCheckbox = $("confirmRemoveLatest") as HTMLInputElement;
  const hasPlaced = targetHasPlacedLatest(target);
  removeLatestRow.classList.toggle("hidden", !hasPlaced);
  removeLatestCheckbox.checked = true;

  $("confirmOverlay").classList.remove("hidden");
}

$("modalCancel").addEventListener("click", () => {
  $("confirmOverlay").classList.add("hidden");
  pendingForce = null;
});

$("modalConfirm").addEventListener("click", () => {
  $("confirmOverlay").classList.add("hidden");
  if (!pendingForce) return;
  const removeLatest = (($("confirmRemoveLatest") as HTMLInputElement).checked);
  const isSwap = pendingForce.mode === "swap";
  if (pendingForce.kind === "single") {
    pendingForce.btn.disabled = true;
    pendingForce.btn.textContent = isSwap ? "スワップ中…" : "更新中…";
    // Jump straight there so the user immediately sees what they just
    // confirmed updating — code.ts does this before the write itself.
    post({ type: "apply", id: pendingForce.id, jump: true, removeLatest });
  } else if (isSwap) {
    showSwapBulkBusy("スワップしています");
    post({ type: "apply-bulk", ids: pendingForce.ids, removeLatest });
  } else {
    showBulkBusy("更新しています");
    post({ type: "apply-bulk", ids: pendingForce.ids, removeLatest });
  }
  pendingForce = null;
});

/* ---- 比較用インスタンス一括削除の確認ダイアログ ----
   件数を確認してから実行できるよう、クリック時点ではまだ削除せず「件数を
   数えるだけ」のメッセージを送り、返ってきた件数をこのモーダルで見せてから
   本当に削除するかどうかをユーザーに選んでもらう。 */
function openClearMarkersConfirm(count: number): void {
  if (count === 0) {
    showToast("削除できる比較用インスタンスはありません");
    return;
  }
  $("clearMarkersConfirmBody").textContent = `${count}件の比較用インスタンスをすべて削除します。よろしいですか？`;
  $("clearMarkersConfirmOverlay").classList.remove("hidden");
}

$("clearMarkersConfirmCancel").addEventListener("click", () => {
  $("clearMarkersConfirmOverlay").classList.add("hidden");
});

$("clearMarkersConfirmOk").addEventListener("click", () => {
  $("clearMarkersConfirmOverlay").classList.add("hidden");
  post({ type: "clear-markers" });
});

/* ---- マーカー（配置済みLatestプレビュー）件数 ---- */
// Drives only the "比較用インスタンスをすべて削除" button's label/disabled state now
// — the standalone marker-strip display + its own "すべて削除" button
// were removed since they duplicated that button's role。更新／スワップ両モードの
// フッターボタンが同じmarkerCountを参照するので、両方更新する。
function setMarkerCount(count: number): void {
  markerCount = count;
  updateFooterButtons();
  updateSwapFooterButtons();
}

/* ---- ライブラリスキャン（スワップ先ライブラリの公開コンポーネントリストの作成） ---- */
const scanLibViews = {
  intro: $("scanLibIntroView"),
  busy: $("scanLibBusyView"),
  result: $("scanLibResultView"),
};

function showScanLib(name: keyof typeof scanLibViews): void {
  (Object.keys(scanLibViews) as Array<keyof typeof scanLibViews>).forEach((k) =>
    scanLibViews[k].classList.toggle("hidden", k !== name)
  );
  updateModeTabsDisabledState();
}

interface LibraryScanData {
  libraryName: string;
  exportedAt: string;
  components: { name: string; key: string; path: string }[];
  componentSets: {
    name: string;
    key: string;
    path: string;
    variantProps: Record<string, string[]>;
    children: { key: string; variantProperties: Record<string, string> }[];
  }[];
  skipped: { name: string; path: string; reason: string }[];
  coverThumbnail?: string; // data URL。無ければチップ表示は頭文字アバターにフォールバック
}

let lastLibraryScanJson = "";

$("scanLibStartBtn").addEventListener("click", () => {
  ensureAudioUnlocked();
  showScanLib("busy");
  $("scanLibPageStep").textContent = "";
  $("scanLibCompStep").textContent = "";
  ($("scanLibPageFill").style as CSSStyleDeclaration).width = "0%";
  ($("scanLibCompFill").style as CSSStyleDeclaration).width = "0%";
  $("scanLibCompFill").classList.remove("indeterminate");
  ($("scanLibCancelBtn") as HTMLButtonElement).disabled = false;
  post({ type: "scan-library" });
});

$("scanLibCancelBtn").addEventListener("click", (e) => {
  (e.currentTarget as HTMLButtonElement).disabled = true;
  post({ type: "cancel-library-scan" });
});

function onLibraryScanCancelled(): void {
  showScanLib("intro");
  showToast("スキャンを中止しました");
  consumePendingSwitch();
}

// 上段＝スキャン済みページ数／全ページ（常に正確な分母）。下段は2フェーズ
// あり、実測でスキャン時間の9割以上を占める探索フェーズの間は分母が無い
// （ファイル全体のノード数は事前にわからない）ので、不確定進捗（伸びる
// カウンタ＋アニメーションするバー）として見せ、Publish状態を確認する
// 短いフェーズに入ったら実際の%表示に切り替える（§code.ts handleScanLibrary
// 参照）。
function onLibraryScanPageGauge(pagesCompleted: number, totalPages: number): void {
  $("scanLibPageStep").textContent = `スキャン済みページ ${pagesCompleted} / ${totalPages}`;
  ($("scanLibPageFill").style as CSSStyleDeclaration).width = totalPages
    ? `${Math.round((pagesCompleted / totalPages) * 100)}%`
    : "0%";
}

function onLibraryScanWalkProgress(pagesCompleted: number, totalPages: number, nodesVisited: number): void {
  onLibraryScanPageGauge(pagesCompleted, totalPages);
  $("scanLibCompStep").textContent = `ノードを探索中… (${nodesVisited.toLocaleString()}件確認)`;
  $("scanLibCompFill").classList.add("indeterminate");
}

function onLibraryScanProgress(pagesCompleted: number, totalPages: number, pageScanned: number, pageTotal: number): void {
  onLibraryScanPageGauge(pagesCompleted, totalPages);
  $("scanLibCompFill").classList.remove("indeterminate");
  $("scanLibCompStep").textContent = `スキャン済みのメインコンポーネント ${pageScanned} / ${pageTotal}`;
  ($("scanLibCompFill").style as CSSStyleDeclaration).width = pageTotal ? `${Math.round((pageScanned / pageTotal) * 100)}%` : "0%";
}

function onLibraryScanDone(data: LibraryScanData, coverThumbnail?: Uint8Array): void {
  // 単体コンポーネントとコンポーネントセットは、スワップ対象の「差し替え単位」
  // としては同格なので合算した1つの数字だけ見せる（内訳はJSONプレビューで見れる）。
  $("scanLibComponentCount").textContent = String(data.components.length + data.componentSets.length);
  // カバー画像はcode.ts側からバイト列で来る（btoa等の変換はUI iframe側でしかできない
  // ため）。data URLに変換してからJSONに埋め込み、コピーした対応表にそのまま含める。
  if (coverThumbnail) data.coverThumbnail = dataUrlFromBytes(coverThumbnail);
  lastLibraryScanJson = JSON.stringify(data, null, 2);
  $("scanLibJsonPreview").textContent = lastLibraryScanJson;
  showScanLib("result");
  // Figma内部で「エラーあり」判定されたコンポーネントセット（バリアント重複等）は
  // スキャン全体を止めずに個別スキップされる。件数を黙って減らすとAnalyticsの
  // 公開コンポーネント数と食い違う原因になるため、スキップがあれば明示する。
  if (data.skipped.length > 0) {
    showToast(
      `${data.skipped.length}件のコンポーネントをスキップしました（Figma側でエラーが検出されているため。詳細はJSONのskippedを参照）`,
      6000
    );
  }
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("clipboard API unavailable"));
}

$("scanLibCopyBtn").addEventListener("click", () => {
  copyToClipboard(lastLibraryScanJson)
    .then(() => showToast("クリップボードにコピーしました"))
    .catch(() => {
      // Figmaプラグインのiframeサンドボックスでnavigator.clipboardが使えない
      // 場合のフォールバック（非表示textarea + 旧execCommand('copy')）。
      const ta = document.createElement("textarea");
      ta.value = lastLibraryScanJson;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("クリップボードにコピーしました");
      } catch {
        showToast("コピーに失敗しました。手動で選択してコピーしてください");
      } finally {
        document.body.removeChild(ta);
      }
    });
});

/* ---- ライブラリスワップ: 複数ライブラリのチップ管理 ----
   スワップ先ライブラリの公開コンポーネントリストを複数追加できる。＋ボタンで貼り付け
   フォームを開き、有効なJSONなら「追加」でチップに変わる。名前が衝突した
   場合は先に追加した方を優先する（§code.ts handleScanSwap参照）。 */
$("swapPasteInfoBtn").addEventListener("click", () => $("swapPasteInfoOverlay").classList.remove("hidden"));
$("swapPasteInfoClose").addEventListener("click", () => $("swapPasteInfoOverlay").classList.add("hidden"));
$("swapPasteInfoOverlay").addEventListener("click", (e) => {
  if (e.target === $("swapPasteInfoOverlay")) $("swapPasteInfoOverlay").classList.add("hidden");
});

$("swapRadioGroup").addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (target.name !== "swapscope") return;
  document.querySelectorAll("#swapRadioGroup .radio-option").forEach((opt) => {
    opt.classList.toggle("active", opt.getAttribute("data-scope") === target.value);
  });
});

interface LibraryChipEntry {
  raw: string; // クリップボードに保存する生JSON文字列（貼り付けられたまま）
  data: LibraryScanData;
}
let addedLibraries: LibraryChipEntry[] = [];

// カバー画像が無いライブラリの頭文字アバターの背景色。名前から決定的に選ぶ
// （同じ名前なら毎回同じ色になり、再読み込みでちらつかない）。
const LIBRARY_AVATAR_COLORS = ["#0c8ce9", "#a3690a", "#17915c", "#d1453b", "#7c5cff", "#0aa3a3"];
function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return LIBRARY_AVATAR_COLORS[Math.abs(hash) % LIBRARY_AVATAR_COLORS.length];
}

function libraryChipHtml(entry: LibraryChipEntry, index: number): string {
  const count = entry.data.components.length + entry.data.componentSets.length;
  const coverInner = entry.data.coverThumbnail
    ? `<img src="${entry.data.coverThumbnail}" alt="">`
    : escapeHtml(entry.data.libraryName.slice(0, 2));
  const coverStyle = entry.data.coverThumbnail ? "" : ` style="background:${avatarColorFor(entry.data.libraryName)};"`;
  return `<div class="library-chip">
    <span class="cover"${coverStyle}>${coverInner}</span>
    <div class="info">
      <div class="lib-name" title="${escapeHtml(entry.data.libraryName)}">${escapeHtml(entry.data.libraryName)}</div>
      <div class="lib-meta">コンポーネント${count}</div>
    </div>
    <button class="remove-btn" data-remove-library="${index}" title="削除">✕</button>
  </div>`;
}

function updateSwapScanButtonState(): void {
  ($("swapScanBtn") as HTMLButtonElement).disabled = addedLibraries.length === 0;
}

function saveSwapMappingCache(): void {
  post({ type: "save-swap-mapping-cache", raws: addedLibraries.map((e) => e.raw) });
}

function renderLibraryChips(): void {
  $("swapLibraryChipList").innerHTML = addedLibraries.map((e, i) => libraryChipHtml(e, i)).join("");
  document.querySelectorAll<HTMLButtonElement>("#swapLibraryChipList [data-remove-library]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-remove-library"));
      addedLibraries.splice(idx, 1);
      renderLibraryChips();
      saveSwapMappingCache();
    });
  });
  $("swapCollisionNote").classList.toggle("hidden", addedLibraries.length < 2);
  updateSwapScanButtonState();
}

/* ---- ＋ライブラリを追加（貼り付けフォームの開閉） ---- */
let pendingAddLibrary: LibraryScanData | null = null;
let pendingAddLibraryRaw = "";

function closeAddLibraryForm(): void {
  $("swapAddLibraryForm").classList.add("hidden");
  $("swapAddLibraryBtn").classList.remove("hidden");
}

function validateAddLibraryPaste(): void {
  const raw = ($("swapAddLibraryTextarea") as HTMLTextAreaElement).value.trim();
  const statusEl = $("swapAddLibraryStatus");
  const confirmBtn = $("swapAddLibraryConfirm") as HTMLButtonElement;
  pendingAddLibrary = null;
  pendingAddLibraryRaw = "";

  if (!raw) {
    statusEl.textContent = "⚠ スワップ先ライブラリの公開コンポーネントリストを貼り付けてください";
    statusEl.className = "paste-status error";
    confirmBtn.disabled = true;
    return;
  }
  let parsed: LibraryScanData | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.components) || !Array.isArray(parsed.componentSets)) {
    statusEl.textContent = "⚠ スワップ先ライブラリの公開コンポーネントリストの形式が正しくありません";
    statusEl.className = "paste-status error";
    confirmBtn.disabled = true;
    return;
  }
  if (addedLibraries.some((e) => e.data.libraryName === parsed!.libraryName)) {
    statusEl.textContent = `⚠ 「${parsed.libraryName}」は既に追加されています`;
    statusEl.className = "paste-status error";
    confirmBtn.disabled = true;
    return;
  }
  statusEl.textContent = "";
  statusEl.className = "paste-status";
  confirmBtn.disabled = false;
  pendingAddLibrary = parsed;
  pendingAddLibraryRaw = raw;
}

$("swapAddLibraryTextarea").addEventListener("input", validateAddLibraryPaste);

$("swapAddLibraryBtn").addEventListener("click", () => {
  ($("swapAddLibraryTextarea") as HTMLTextAreaElement).value = "";
  validateAddLibraryPaste();
  $("swapAddLibraryForm").classList.remove("hidden");
  $("swapAddLibraryBtn").classList.add("hidden");
  ($("swapAddLibraryTextarea") as HTMLTextAreaElement).focus();
});

$("swapAddLibraryCancel").addEventListener("click", closeAddLibraryForm);

$("swapAddLibraryConfirm").addEventListener("click", () => {
  if (!pendingAddLibrary) return;
  addedLibraries.push({ raw: pendingAddLibraryRaw, data: pendingAddLibrary });
  pendingAddLibrary = null;
  pendingAddLibraryRaw = "";
  renderLibraryChips();
  saveSwapMappingCache();
  closeAddLibraryForm();
});

// 前回追加していたライブラリをキャッシュから復元する。チップリストが空の
// ときだけ埋める — 起動直後に自分で追加し始めていた場合は上書きしない。
function onSwapMappingCacheLoaded(raws: string[]): void {
  if (addedLibraries.length > 0) return;
  const restored: LibraryChipEntry[] = [];
  for (const raw of raws) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.components) && Array.isArray(parsed.componentSets)) {
        restored.push({ raw, data: parsed });
      }
    } catch {
      // 壊れたキャッシュ内容は無視する
    }
  }
  if (restored.length === 0) return;
  addedLibraries = restored;
  renderLibraryChips();
}

$("swapScanBtn").addEventListener("click", () => {
  if (addedLibraries.length === 0) return;
  ensureAudioUnlocked();
  const checkedRadio = document.querySelector<HTMLInputElement>('input[name="swapscope"]:checked');
  post({
    type: "scan-swap",
    scope: checkedRadio ? checkedRadio.value : "selection",
    mappings: addedLibraries.map((e) => e.data),
  });
});

/* ---- ライブラリスワップ: スキャン結果画面（✅️/⚠️/🧭タブ） ----
   更新フローと見た目・操作は揃えつつ、DOM/状態は完全に分けている
   （code.ts側はstore/wrapperStoreを共有し、sourceタグでどちらのモード向け
   メッセージかだけを振り分けている）。 */
function showSwap(name: keyof typeof swapViews): void {
  (Object.keys(swapViews) as Array<keyof typeof swapViews>).forEach((k) =>
    swapViews[k].classList.toggle("hidden", k !== name)
  );
  updateModeTabsDisabledState();
}

function resetSwapToPaste(): void {
  swapRows.clear();
  swapCleanIds = [];
  swapDiffIds = [];
  swapVariantIds = [];
  swapExcluded = [];
  swapStrayGroups.clear();
  Object.keys(swapChecked).forEach((k) => delete swapChecked[k]);
  Object.keys(swapLatestVisible).forEach((k) => delete swapLatestVisible[k]);
  Object.keys(swapExpandedIds).forEach((k) => delete swapExpandedIds[k]);
  swapLastClickedIndex = null;
  showSwap("paste");
}

$("swapCancelScanBtn").addEventListener("click", (e) => {
  (e.currentTarget as HTMLButtonElement).disabled = true;
  post({ type: "cancel-swap-scan" });
});

function onSwapScanStarted(total: number): void {
  swapRows.clear();
  swapCleanIds = [];
  swapDiffIds = [];
  swapVariantIds = [];
  swapExcluded = [];
  swapStrayGroups.clear();
  Object.keys(swapChecked).forEach((k) => delete swapChecked[k]);
  Object.keys(swapLatestVisible).forEach((k) => delete swapLatestVisible[k]);
  Object.keys(swapExpandedIds).forEach((k) => delete swapExpandedIds[k]);
  sortState.key = "default";
  sortState.dir = "asc";
  setSortControlsEnabled(false);
  swapScanning = true;
  swapScanTotal = total;
  swapScanDone = 0;
  swapLastClickedIndex = null;

  showSwap("result");
  $("swapScanProgressStrip").classList.remove("hidden");
  ($("swapCancelScanBtn") as HTMLButtonElement).disabled = false;
  updateSwapScanProgress();
  renderSwapTabs();
}

function updateSwapScanProgress(): void {
  $("swapScanProgressText").textContent = `確認中… ${swapScanDone} / ${swapScanTotal}`;
  ($("swapScanProgressFill").style as CSSStyleDeclaration).width = swapScanTotal
    ? `${Math.round((swapScanDone / swapScanTotal) * 100)}%`
    : "0%";
}

function onSwapScanExcluded(msg: SwapStrayItemMsg): void {
  const key = `${msg.name} ${msg.reason}`;
  const existing = swapStrayGroups.get(key);
  if (existing) {
    existing.items.push({ id: msg.id, path: msg.path });
  } else {
    swapStrayGroups.set(key, {
      name: msg.name,
      reason: msg.reason,
      category: msg.category,
      items: [{ id: msg.id, path: msg.path }],
      thumbnailUrl: msg.thumbnail ? dataUrlFromBytes(msg.thumbnail) : undefined,
    });
  }
  swapScanDone++;
  updateSwapScanProgress();
  renderSwapTabs();
}

function onSwapScanAlreadyLatest(name: string): void {
  swapExcluded.push({ name, reason: "既に最新版を参照" });
  swapScanDone++;
  updateSwapScanProgress();
  // §onScanExcludedと同じ理由（onSwapScanStarted時点でこのアコーディオンは
  // 既にDOMにある）。
  const group = $("swapCleanList").querySelector(`[data-id="${SWAP_EXCLUDED_GROUP_ID}"]`);
  group?.querySelector(".excluded-rows")?.insertAdjacentHTML("beforeend", swapExcludedRowHtml({ name, reason: "既に最新版を参照" }));
  const countEl = group?.querySelector(".num");
  if (countEl) countEl.textContent = `(${swapExcluded.length})`;
}

async function onSwapScanItemResult(msg: ScanItemMsg): Promise<void> {
  const row = await processDiff(msg);
  swapRows.set(row.id, row);
  if (row.status === "clean") {
    swapCleanIds.push(row.id);
  } else {
    swapDiffIds.push(row.id);
  }
  swapChecked[row.id] = true;
  swapScanDone++;
  updateSwapScanProgress();
  $("swapCleanCount").textContent = `(${swapCleanIds.length})`;
  $("swapDiffCount").textContent = `(${swapDiffIds.length})`;
  appendSwapResultRow(row.status === "clean" ? "clean" : "diff", row.id);
  updateSwapFooterButtons();
  updateSwapListToolbarToggles(row.status === "clean" ? "clean" : "diff");
}

// バリアント不一致タブ: デフォルトバリアントへの自動フォールバックは常に明示
// 確認を求めたいので、ピクセル完全一致（processDiffの"clean"判定）でも
// 見た目差分ありタブ相当の2枚並び表示に揃える（同じ画像を両側に出す）。
async function onSwapScanItemVariantResult(msg: ScanItemMsg): Promise<void> {
  const row = await processDiff(msg);
  swapRows.set(
    row.id,
    row.status === "clean"
      ? {
          id: row.id,
          name: row.name,
          status: "diff",
          mainComponentName: row.mainComponentName,
          area: row.area,
          diffPercent: 0,
          currentUrl: row.imageUrl,
          latestUrl: row.imageUrl,
        }
      : row
  );
  swapVariantIds.push(row.id);
  swapChecked[row.id] = true;
  swapScanDone++;
  updateSwapScanProgress();
  renderSwapTabs(row.id);
}

function onSwapScanFinished(cancelled: boolean): void {
  swapScanning = false;
  if (!scanning) setSortControlsEnabled(true);
  $("swapScanProgressStrip").classList.add("hidden");
  if (cancelled) {
    resetSwapToPaste();
    showToast("スキャンを中止しました");
    consumePendingSwitch();
  } else {
    renderSwapTabs();
  }
  updateModeTabsDisabledState();
}

/* ---- ライブラリスワップ: タブ切り替え（見た目差分なし／あり／迷子） ---- */
document.querySelectorAll<HTMLButtonElement>("#swapResultView .tab").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll("#swapResultView .tab").forEach((t) => t.classList.toggle("active", t === tabBtn));
    const name = tabBtn.getAttribute("data-swaptab");
    document.querySelectorAll("#swapResultView .tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.getAttribute("data-swappanel") !== name);
    });
  });
});

/* ---- ライブラリスワップ: 対象外・スワップなし（見た目差分なしタブに同居） ---- */
function swapExcludedRowHtml(entry: ExcludedEntry): string {
  return `<div class="excluded-row"><span class="row-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span><span class="excluded-reason">${escapeHtml(entry.reason)}</span></div>`;
}

function swapExcludedGroupHtml(): string {
  const open = swapExpandedIds[SWAP_EXCLUDED_GROUP_ID] ? " open" : "";
  return `<details class="row" data-id="${SWAP_EXCLUDED_GROUP_ID}"${open}>
    <summary class="row-summary excluded-summary">
      <span class="row-name">対象外・スワップなし <span class="num">(${swapExcluded.length})</span></span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="excluded-rows">${swapExcluded.map(swapExcludedRowHtml).join("")}</div>
  </details>`;
}

/* ---- ライブラリスワップ: 行の描画 ---- */
function swapCleanRowHtml(id: string, justEntered: boolean): string {
  const row = swapRows.get(id);
  if (!row) return "";
  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${swapChecked[id] ? "checked" : ""}>`;
  const miniThumb = `<img class="row-mini-thumb" src="${row.imageUrl || ""}" alt="">`;
  return `<details class="row${justEntered ? " enter" : ""}" data-id="${id}" ${swapExpandedIds[id] ? "open" : ""}>
    <summary class="row-summary">
      ${checkbox}
      ${miniThumb}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="row-detail">
      <div class="preview-row">
        <div class="thumb-col"><div class="preview-frame"><img src="${row.imageUrl || ""}" alt=""></div><span class="thumb-label">Current = スワップ後（完全一致）</span></div>
        <div class="side-col">${jumpBtnHtml(id)}</div>
      </div>
      <div class="row-buttons"><button class="ghost-btn fill" data-swap-individual-update="${id}">スワップする</button></div>
    </div>
  </details>`;
}

function swapDiffRowButtons(id: string): string {
  const forceBtn = `<button class="ghost-btn fill" data-swap-individual-force="${id}">このままスワップ</button>`;
  const placed = Object.prototype.hasOwnProperty.call(swapLatestVisible, id);
  if (!placed) {
    return `<div class="row-buttons">${forceBtn}<button class="ghost-btn warn" data-swap-place-latest="${id}">比較用インスタンスを配置</button></div>`;
  }
  const eyeIcon = swapLatestVisible[id] ? EYE_OPEN : EYE_CLOSED;
  return `<div class="row-buttons">${forceBtn}<button class="ghost-btn danger" data-swap-remove-latest="${id}">比較用インスタンスを削除</button><button class="ghost-btn" data-swap-toggle-latest="${id}">${eyeIcon}表示切替</button></div>`;
}

function swapDiffRowHtml(id: string, justEntered: boolean): string {
  const row = swapRows.get(id);
  if (!row) return "";
  const latestLabel = row.sizeMismatch
    ? "スワップ後（サイズ不一致）"
    : `スワップ後（差分${(row.diffPercent ?? 0).toFixed(1)}%）`;
  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${swapChecked[id] ? "checked" : ""}>`;
  const miniThumb = `<img class="row-mini-thumb" src="${row.currentUrl || ""}" alt="">`;
  return `<details class="row${justEntered ? " enter" : ""}" data-id="${id}" ${swapExpandedIds[id] ? "open" : ""}>
    <summary class="row-summary">
      ${checkbox}
      ${miniThumb}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="row-detail">
      <div class="preview-row">
        <div class="thumb-col"><div class="preview-frame"><img src="${row.currentUrl || ""}" alt=""></div><span class="thumb-label">Current</span></div>
        <div class="thumb-col"><div class="preview-frame"><img src="${row.latestUrl || ""}" alt=""></div><span class="thumb-label">${latestLabel}</span></div>
        <div class="side-col">${jumpBtnHtml(id)}</div>
      </div>
      ${swapDiffRowButtons(id)}
    </div>
  </details>`;
}

/* ---- ライブラリスワップ: バリアント不一致タブ ----
   コンポーネントセット名は一致するがバリアントの組み合わせが無いケース。
   Figma純正のライブラリスワップに倣い、そのセットのデフォルトバリアントを
   暫定の差し替え先として提示する。自動選択である旨を毎回明示するため、行の
   ボタン構成は見た目差分ありタブ（swapDiffRowButtons）をそのまま流用しつつ、
   説明文を追加している。 */
function swapVariantRowHtml(id: string, justEntered: boolean): string {
  const row = swapRows.get(id);
  if (!row) return "";
  const latestLabel = row.sizeMismatch
    ? "デフォルトバリアント（サイズ不一致）"
    : `デフォルトバリアント（差分${(row.diffPercent ?? 0).toFixed(1)}%）`;
  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${swapChecked[id] ? "checked" : ""}>`;
  const miniThumb = `<img class="row-mini-thumb" src="${row.currentUrl || ""}" alt="">`;
  return `<details class="row${justEntered ? " enter" : ""}" data-id="${id}" ${swapExpandedIds[id] ? "open" : ""}>
    <summary class="row-summary">
      ${checkbox}
      ${miniThumb}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="row-detail">
      <div class="variant-note">このコンポーネントセットの既定バリアントに差し替えます。見た目を確認してから実行してください。</div>
      <div class="preview-row">
        <div class="thumb-col"><div class="preview-frame"><img src="${row.currentUrl || ""}" alt=""></div><span class="thumb-label">Current</span></div>
        <div class="thumb-col"><div class="preview-frame"><img src="${row.latestUrl || ""}" alt=""></div><span class="thumb-label">${latestLabel}</span></div>
        <div class="side-col">${jumpBtnHtml(id)}</div>
      </div>
      ${swapDiffRowButtons(id)}
    </div>
  </details>`;
}

/* ---- ライブラリスワップ: 名前不一致タブ ----
   同名・同理由のインスタンスは1行にまとめ、件数とグループ代表1件分の
   サムネイル（あれば）だけを表示する。オーバーライドで個体差があっても
   全件分のサムネイルは持たない（§code.ts参照）。
   1件のグループも含め常にアコーディオンで統一し、開くと全インスタンスへ
   階層パス付きで個別ジャンプできる。理由文はカテゴリ見出しで意味を持つので
   行には出さない — ただし「その他」だけは行ごとに理由が異なる（未パブリッシュ／
   比較中エラー等）ため、行にも理由文を残す。 */
function swapStrayRowHtml(key: string, group: SwapStrayGroup): string {
  const thumb = group.thumbnailUrl ? `<img src="${group.thumbnailUrl}" alt="">` : "";
  const nameHtml = `<div class="row-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}${
    group.items.length > 1 ? ` <span class="stray-count">×${group.items.length}</span>` : ""
  }</div>`;
  const reasonHtml = group.category === "other" ? `<div class="stray-reason">${escapeHtml(group.reason)}</div>` : "";

  const pathRows = group.items
    .map(
      (item) =>
        `<div class="stray-path-row"><span class="stray-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span><button class="ghost-btn" data-jump="${item.id}">${JUMP_ICON}ジャンプ</button></div>`
    )
    .join("");

  return `<details class="row" data-id="stray:${escapeHtml(key)}" ${swapExpandedIds[`stray:${key}`] ? "open" : ""}>
    <summary class="stray-row">
      <div class="stray-thumb">${thumb}</div>
      <div style="flex:1; min-width:0;">
        ${nameHtml}
        ${reasonHtml}
      </div>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="stray-instance-list">${pathRows}</div>
  </details>`;
}

function renderSwapStray(): void {
  const entries = Array.from(swapStrayGroups.entries());
  const byVariant = entries.filter(([, g]) => g.category === "variant");
  const byName = entries.filter(([, g]) => g.category === "name");
  const byOther = entries.filter(([, g]) => g.category === "other");
  const sumCount = (gs: [string, SwapStrayGroup][]): number => gs.reduce((sum, [, g]) => sum + g.items.length, 0);
  const rows = (gs: [string, SwapStrayGroup][]): string => gs.map(([key, g]) => swapStrayRowHtml(key, g)).join("");
  let html = "";
  if (byVariant.length) {
    html += `<div class="stray-group-head">バリアント名が一致しません (${sumCount(byVariant)})</div>`;
    html += rows(byVariant);
  }
  if (byName.length) {
    html += `<div class="stray-group-head">コンポーネント名が一致しません (${sumCount(byName)})</div>`;
    html += rows(byName);
  }
  if (byOther.length) {
    html += `<div class="stray-group-head">その他 (${sumCount(byOther)})</div>`;
    html += rows(byOther);
  }
  $("swapStrayList").innerHTML = html || '<div class="empty-state">名前不一致の項目はありません</div>';
}

function swapEmptyState(kind: "clean" | "diff" | "variant"): string {
  if (swapScanning) return '<div class="empty-state"><span class="spinner sm"></span>確認中…</div>';
  if (kind === "clean") return '<div class="empty-state">見た目差分なしの項目はありません</div>';
  if (kind === "diff") return '<div class="empty-state">見た目差分ありの項目はありません</div>';
  return '<div class="empty-state">バリアント不一致の項目はありません</div>';
}

function renderSwapTabs(justEnteredId?: string): void {
  $("swapCleanCount").textContent = `(${swapCleanIds.length})`;
  $("swapDiffCount").textContent = `(${swapDiffIds.length})`;
  $("swapVariantCount").textContent = `(${swapVariantIds.length})`;
  $("swapStrayCount").textContent = `(${Array.from(swapStrayGroups.values()).reduce((sum, g) => sum + g.items.length, 0)})`;

  const sortedSwapCleanIds = getSortedIds(swapCleanIds, swapRows, sortState);
  const sortedSwapDiffIds = getSortedIds(swapDiffIds, swapRows, sortState);
  const sortedSwapVariantIds = getSortedIds(swapVariantIds, swapRows, sortState);

  let swapCleanHtml = sortedSwapCleanIds.length
    ? sortedSwapCleanIds.map((id) => swapCleanRowHtml(id, id === justEnteredId)).join("")
    : swapEmptyState("clean");
  if (swapExcluded.length || swapScanning) swapCleanHtml += swapExcludedGroupHtml();
  $("swapCleanList").innerHTML = swapCleanHtml;

  $("swapDiffList").innerHTML = sortedSwapDiffIds.length
    ? sortedSwapDiffIds.map((id) => swapDiffRowHtml(id, id === justEnteredId)).join("")
    : swapEmptyState("diff");

  $("swapVariantList").innerHTML = sortedSwapVariantIds.length
    ? sortedSwapVariantIds.map((id) => swapVariantRowHtml(id, id === justEnteredId)).join("")
    : swapEmptyState("variant");

  renderSwapStray();

  wireSwapRowEvents();
  updateSwapFooterButtons();
  updateSwapListToolbarToggles("clean");
  updateSwapListToolbarToggles("diff");
  updateSwapListToolbarToggles("variant");
  updateSortControl("swapClean");
  updateSortControl("swapDiff");
  updateSortControl("swapVariant");
}

// §wireRowと同じ理由（全件再描画とスキャン中の1行追加の両方から呼べるように、
// 対象を1行分に限定できる形にしてある）。
function wireSwapRow(row: Element): void {
  if (row instanceof HTMLDetailsElement) {
    row.addEventListener("toggle", () => {
      const id = row.getAttribute("data-id");
      if (id) swapExpandedIds[id] = row.open;
    });
  }
  row.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      handleSwapCheckboxClick(cb, e as MouseEvent);
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "jump", id: btn.getAttribute("data-jump") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-swap-individual-update]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "スワップ中…";
      post({ type: "apply", id: btn.getAttribute("data-swap-individual-update") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-swap-individual-force]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-swap-individual-force")!;
      openForceConfirm({ kind: "single", id, btn, mode: "swap" });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-swap-place-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "配置中…";
      post({ type: "place-latest", id: btn.getAttribute("data-swap-place-latest") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-swap-toggle-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "toggle-latest", id: btn.getAttribute("data-swap-toggle-latest") });
    });
  });
  row.querySelectorAll<HTMLButtonElement>("[data-swap-remove-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "remove-latest", id: btn.getAttribute("data-swap-remove-latest") });
    });
  });
}

function wireSwapRowEvents(): void {
  document.querySelectorAll("#swapResultView .row").forEach(wireSwapRow);
}

// §appendResultRowと同じ理由・同じ前提（デフォルトソート＝到着順のときだけ
// 成立、スキャン中はsetSortControlsEnabledでソート操作自体を無効化して守る）。
function appendSwapResultRow(kind: "clean" | "diff", id: string): void {
  const listEl = $(kind === "clean" ? "swapCleanList" : "swapDiffList");
  listEl.querySelector(".empty-state")?.remove();

  const html = kind === "clean" ? swapCleanRowHtml(id, true) : swapDiffRowHtml(id, true);
  const excludedAnchor = kind === "clean" ? listEl.querySelector(`[data-id="${SWAP_EXCLUDED_GROUP_ID}"]`) : null;
  if (excludedAnchor) {
    excludedAnchor.insertAdjacentHTML("beforebegin", html);
  } else {
    listEl.insertAdjacentHTML("beforeend", html);
  }
  const newRow = excludedAnchor ? excludedAnchor.previousElementSibling : listEl.lastElementChild;
  if (newRow) wireSwapRow(newRow);
}

/* ---- ライブラリスワップ: チェックボックス（Shift範囲選択） ---- */
function handleSwapCheckboxClick(cb: HTMLInputElement, e: MouseEvent): void {
  const id = cb.getAttribute("data-id")!;
  const tab: "clean" | "diff" | "variant" = swapCleanIds.includes(id) ? "clean" : swapDiffIds.includes(id) ? "diff" : "variant";
  const rawList = tab === "clean" ? swapCleanIds : tab === "diff" ? swapDiffIds : swapVariantIds;
  // Shift範囲選択は表示中の並び替え結果に合わせる（§handleCheckboxClickと同じ理由）。
  const list = getSortedIds(rawList, swapRows, sortState);
  const index = list.indexOf(id);
  const newState = cb.checked;

  if (e.shiftKey && swapLastClickedIndex && swapLastClickedIndex.tab === tab) {
    const from = Math.min(swapLastClickedIndex.index, index);
    const to = Math.max(swapLastClickedIndex.index, index);
    for (let i = from; i <= to; i++) swapChecked[list[i]] = newState;
    renderSwapTabs();
  } else {
    swapChecked[id] = newState;
    updateSwapFooterButtons();
    updateSwapListToolbarToggles(tab);
  }
  swapLastClickedIndex = { tab, index };
}

/* ---- ライブラリスワップ: すべて選択・すべて解除・すべて展開・すべて折りたたむ ---- */
function bindSwapListToolbar(tab: "clean" | "diff" | "variant"): void {
  const list =
    tab === "clean" ? (): string[] => swapCleanIds : tab === "diff" ? (): string[] => swapDiffIds : (): string[] => swapVariantIds;
  const prefix = tab === "clean" ? "swapClean" : tab === "diff" ? "swapDiff" : "swapVariant";
  $(`${prefix}SelectAllToggle`).addEventListener("click", () => {
    const newState = ($(`${prefix}SelectAllToggle`) as HTMLInputElement).checked;
    list().forEach((id) => (swapChecked[id] = newState));
    renderSwapTabs();
  });
  $(`${prefix}ExpandToggle`).addEventListener("click", () => {
    const allExpanded = list().length > 0 && list().every((id) => swapExpandedIds[id]);
    const newState = !allExpanded;
    list().forEach((id) => (swapExpandedIds[id] = newState));
    renderSwapTabs();
  });
}
bindSwapListToolbar("clean");
bindSwapListToolbar("diff");
bindSwapListToolbar("variant");

function updateSwapListToolbarToggles(tab: "clean" | "diff" | "variant"): void {
  const list = tab === "clean" ? swapCleanIds : tab === "diff" ? swapDiffIds : swapVariantIds;
  const prefix = tab === "clean" ? "swapClean" : tab === "diff" ? "swapDiff" : "swapVariant";
  const checkedCount = list.filter((id) => swapChecked[id]).length;
  const selectToggle = $(`${prefix}SelectAllToggle`) as HTMLInputElement;
  selectToggle.checked = list.length > 0 && checkedCount === list.length;
  selectToggle.indeterminate = checkedCount > 0 && checkedCount < list.length;
  selectToggle.disabled = list.length === 0;

  const allExpanded = list.length > 0 && list.every((id) => swapExpandedIds[id]);
  const expandToggle = $(`${prefix}ExpandToggle`) as HTMLButtonElement;
  expandToggle.innerHTML = allExpanded ? DOUBLE_CHEVRON_UP : DOUBLE_CHEVRON_DOWN;
  expandToggle.title = allExpanded ? "すべて折りたたむ" : "すべて展開";
  expandToggle.disabled = list.length === 0;
}

function updateSwapFooterButtons(): void {
  const cleanChecked = swapCleanIds.filter((id) => swapChecked[id]).length;
  $("swapBulkBtnLabel").textContent = `一括スワップ(${cleanChecked})`;
  ($("swapBulkBtn") as HTMLButtonElement).disabled = cleanChecked === 0;

  const placeableChecked = swapDiffIds.filter(
    (id) => swapChecked[id] && !Object.prototype.hasOwnProperty.call(swapLatestVisible, id)
  ).length;
  $("swapPlaceBulkBtnLabel").textContent = `比較用インスタンスを一括配置(${placeableChecked})`;
  ($("swapPlaceBulkBtn") as HTMLButtonElement).disabled = placeableChecked === 0;

  // 更新フロー側と同じ全件スイープのmarkerCountを共有して使う（比較用インスタンスの
  // 削除は出所を問わない全件掃除のため。§code.ts参照）。
  $("swapClearAllBtnLabel").textContent = `比較用インスタンスをすべて削除(${markerCount})`;
  ($("swapClearAllBtn") as HTMLButtonElement).disabled = markerCount === 0;

  const forceChecked = swapDiffIds.filter((id) => swapChecked[id]).length;
  $("swapForceBulkBtnLabel").textContent = `このまま一括スワップ(${forceChecked})`;
  ($("swapForceBulkBtn") as HTMLButtonElement).disabled = forceChecked === 0;

  ($("swapCleanSelectCanvas") as HTMLButtonElement).textContent = `すべてのインスタンスを選択(${cleanChecked})`;
  ($("swapCleanSelectCanvas") as HTMLButtonElement).disabled = cleanChecked === 0;
  ($("swapDiffSelectCanvas") as HTMLButtonElement).textContent = `すべてのインスタンスを選択(${forceChecked})`;
  ($("swapDiffSelectCanvas") as HTMLButtonElement).disabled = forceChecked === 0;

  // バリアント不一致タブ — 見た目差分ありタブと同じボタン構成（フッターも
  // 独立して持たせている。§ui.html swapVariantタブパネル参照）。
  const variantChecked = swapVariantIds.filter((id) => swapChecked[id]).length;
  $("swapVariantForceBulkBtnLabel").textContent = `このまま一括スワップ(${variantChecked})`;
  ($("swapVariantForceBulkBtn") as HTMLButtonElement).disabled = variantChecked === 0;

  const variantPlaceableChecked = swapVariantIds.filter(
    (id) => swapChecked[id] && !Object.prototype.hasOwnProperty.call(swapLatestVisible, id)
  ).length;
  $("swapVariantPlaceBulkBtnLabel").textContent = `比較用インスタンスを一括配置(${variantPlaceableChecked})`;
  ($("swapVariantPlaceBulkBtn") as HTMLButtonElement).disabled = variantPlaceableChecked === 0;

  $("swapVariantClearAllBtnLabel").textContent = `比較用インスタンスをすべて削除(${markerCount})`;
  ($("swapVariantClearAllBtn") as HTMLButtonElement).disabled = markerCount === 0;

  ($("swapVariantSelectCanvas") as HTMLButtonElement).textContent = `すべてのインスタンスを選択(${variantChecked})`;
  ($("swapVariantSelectCanvas") as HTMLButtonElement).disabled = variantChecked === 0;
}

/* ---- ライブラリスワップ: 一括スワップ / 比較用インスタンスを一括配置 / このまま一括スワップ ---- */
function showSwapBulkBusy(label: string): void {
  showSwap("busy");
  $("swapBulkBusyLabel").textContent = label;
  $("swapBulkBusyStep").textContent = "";
  const fill = $("swapBulkBusyProgress") as HTMLElement;
  fill.style.width = "0%";
  // §showBulkBusyと同じ理由でレイアウトを強制確定させる。
  void fill.offsetWidth;
}

function onSwapBulkProgress(label: string, name: string, index: number, total: number): void {
  $("swapBulkBusyLabel").textContent = label;
  $("swapBulkBusyStep").textContent = `${name} (${index} / ${total})`;
  ($("swapBulkBusyProgress").style as CSSStyleDeclaration).width = `${Math.round((index / total) * 100)}%`;
}

$("swapBulkBtn").addEventListener("click", () => {
  const targets = swapCleanIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  showSwapBulkBusy("スワップしています");
  post({ type: "apply-bulk", ids: targets });
});

$("swapPlaceBulkBtn").addEventListener("click", () => {
  const targets = swapDiffIds.filter(
    (id) => swapChecked[id] && !Object.prototype.hasOwnProperty.call(swapLatestVisible, id)
  );
  if (targets.length === 0) return;
  showSwapBulkBusy("比較用インスタンスを配置しています");
  post({ type: "place-latest-bulk", ids: targets });
});

$("swapClearAllBtn").addEventListener("click", () => {
  post({ type: "count-markers" });
});

$("swapForceBulkBtn").addEventListener("click", () => {
  const targets = swapDiffIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets, mode: "swap" });
});

$("swapCleanSelectCanvas").addEventListener("click", () => {
  const targets = swapCleanIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  post({ type: "select-on-canvas", ids: targets });
});
$("swapDiffSelectCanvas").addEventListener("click", () => {
  const targets = swapDiffIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  post({ type: "select-on-canvas", ids: targets });
});

$("swapVariantForceBulkBtn").addEventListener("click", () => {
  const targets = swapVariantIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets, mode: "swap" });
});

$("swapVariantPlaceBulkBtn").addEventListener("click", () => {
  const targets = swapVariantIds.filter(
    (id) => swapChecked[id] && !Object.prototype.hasOwnProperty.call(swapLatestVisible, id)
  );
  if (targets.length === 0) return;
  showSwapBulkBusy("比較用インスタンスを配置しています");
  post({ type: "place-latest-bulk", ids: targets });
});

$("swapVariantClearAllBtn").addEventListener("click", () => {
  post({ type: "count-markers" });
});

$("swapVariantSelectCanvas").addEventListener("click", () => {
  const targets = swapVariantIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  post({ type: "select-on-canvas", ids: targets });
});

function removeSwapResolvedId(id: string): void {
  swapCleanIds = swapCleanIds.filter((x) => x !== id);
  swapDiffIds = swapDiffIds.filter((x) => x !== id);
  swapVariantIds = swapVariantIds.filter((x) => x !== id);
  swapRows.delete(id);
  delete swapChecked[id];
  delete swapLatestVisible[id];
  delete swapExpandedIds[id];
}

function onSwapApplied(id: string): void {
  const row = swapRows.get(id);
  removeSwapResolvedId(id);
  renderSwapTabs();
  showToast(`「${row?.name ?? id}」をスワップしました`);
}

function onSwapApplyBulkDone(ids: string[]): void {
  ids.forEach(removeSwapResolvedId);
  renderSwapTabs();
  showSwap("result");
  showToast(`${ids.length}件をスワップしました`);
}

function onSwapLatestPlaced(id: string): void {
  const row = swapRows.get(id);
  swapLatestVisible[id] = true;
  renderSwapTabs();
  showToast(`「${row?.name ?? id}」に比較用インスタンスを配置しました`);
}

function onSwapLatestPlacedBulk(ids: string[]): void {
  ids.forEach((id) => {
    swapLatestVisible[id] = true;
  });
  renderSwapTabs();
  showSwap("result");
  showToast(`${ids.length}件に比較用インスタンスを配置しました`);
}

function onSwapLatestToggled(id: string, visible: boolean): void {
  swapLatestVisible[id] = visible;
  renderSwapTabs();
}

function onSwapLatestRemoved(id: string): void {
  const row = swapRows.get(id);
  delete swapLatestVisible[id];
  renderSwapTabs();
  showToast(`「${row?.name ?? id}」に比較用インスタンスを削除しました`);
}

/* ---- メッセージルーティング ---- */
window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;

  switch (msg.type) {
    case "scan-started":
      onScanStarted(msg.total);
      break;
    case "scan-item-excluded":
      onScanExcluded(msg.name, msg.reason);
      break;
    case "scan-item-result":
      void onScanItemResult(msg);
      break;
    case "scan-done":
      onScanFinished(false);
      playCompletionChime();
      break;
    case "scan-cancelled":
      onScanFinished(true);
      break;
    case "applied":
      onApplied(msg.id);
      break;
    case "apply-bulk-progress":
      onBulkProgress("更新しています", msg.name, msg.index, msg.total);
      break;
    case "apply-bulk-done":
      onApplyBulkDone(msg.ids);
      break;
    case "latest-placed":
      onLatestPlaced(msg.id);
      break;
    case "place-latest-bulk-progress":
      onBulkProgress("比較用インスタンスを配置しています", msg.name, msg.index, msg.total);
      break;
    case "place-latest-bulk-done":
      onLatestPlacedBulk(msg.ids);
      break;
    case "latest-toggled":
      onLatestToggled(msg.id, msg.visible);
      break;
    case "latest-removed":
      onLatestRemoved(msg.id);
      break;
    case "markers-cleared":
      onMarkersCleared(msg.ids, msg.count);
      break;
    case "marker-count":
      setMarkerCount(msg.count);
      break;
    case "marker-clear-count":
      openClearMarkersConfirm(msg.count);
      break;
    case "library-scan-progress":
      onLibraryScanProgress(msg.pagesCompleted, msg.totalPages, msg.pageScanned, msg.pageTotal);
      break;
    case "library-scan-walk-progress":
      onLibraryScanWalkProgress(msg.pagesCompleted, msg.totalPages, msg.nodesVisited);
      break;
    case "library-scan-done":
      onLibraryScanDone(msg.data, msg.coverThumbnail);
      playCompletionChime();
      break;
    case "library-scan-cancelled":
      onLibraryScanCancelled();
      break;
    case "swap-scan-started":
      onSwapScanStarted(msg.total);
      break;
    case "swap-scan-item-excluded":
      onSwapScanExcluded({ id: msg.id, name: msg.name, path: msg.path, reason: msg.reason, category: msg.category, thumbnail: msg.thumbnail });
      break;
    case "swap-scan-item-already-latest":
      onSwapScanAlreadyLatest(msg.name);
      break;
    case "swap-scan-item-result":
      void onSwapScanItemResult(msg);
      break;
    case "swap-scan-item-variant-result":
      void onSwapScanItemVariantResult(msg);
      break;
    case "swap-scan-done":
      onSwapScanFinished(false);
      playCompletionChime();
      break;
    case "swap-scan-cancelled":
      onSwapScanFinished(true);
      break;
    case "swap-applied":
      onSwapApplied(msg.id);
      break;
    case "swap-apply-bulk-progress":
      onSwapBulkProgress("スワップしています", msg.name, msg.index, msg.total);
      break;
    case "swap-apply-bulk-done":
      onSwapApplyBulkDone(msg.ids);
      break;
    case "swap-latest-placed":
      onSwapLatestPlaced(msg.id);
      break;
    case "swap-place-latest-bulk-progress":
      onSwapBulkProgress("比較用インスタンスを配置しています", msg.name, msg.index, msg.total);
      break;
    case "swap-place-latest-bulk-done":
      onSwapLatestPlacedBulk(msg.ids);
      break;
    case "swap-latest-toggled":
      onSwapLatestToggled(msg.id, msg.visible);
      break;
    case "swap-latest-removed":
      onSwapLatestRemoved(msg.id);
      break;
    case "swap-mapping-cache-loaded":
      onSwapMappingCacheLoaded(msg.raws);
      break;
    case "error":
      // 「更新中…」「配置中…」等、行ボタンを直接disabled/textContent操作している
      // 箇所は、成功時のメッセージが来て初めてrenderTabs()等で正しい状態に
      // 再描画される作りだった。失敗時（code.ts側で例外）はその再描画が来ず、
      // ボタンが永久にロード中表示のまま固まる実害があった。エラー時は両モードの
      // 結果表示を再描画して必ず正しい状態に戻す（一括処理中でbusyビューに
      // いた場合は結果表示に戻す）。エラー内容を読む/報告する時間を確保する
      // ため、通常のトーストより長めに表示する。
      showToast(`エラー: ${msg.message}`, 6000);
      if (!views.busy.classList.contains("hidden")) show("result");
      else renderTabs();
      if (!swapViews.busy.classList.contains("hidden")) showSwap("result");
      else renderSwapTabs();
      // ライブラリスキャンは中断されると再開できず、キャンセルボタンも既に
      // 終了したスキャンに対しては効かなくなる（code.ts側のループが例外で
      // 止まっているため）。busyビューに留まり続けるフリーズ状態を防ぐため、
      // やり直せるようintroビューへ戻す。
      if (!scanLibViews.busy.classList.contains("hidden")) showScanLib("intro");
      break;
  }
};
