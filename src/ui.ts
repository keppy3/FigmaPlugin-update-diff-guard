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
  reason: string;
  category: "name" | "variant" | "other";
  thumbnail?: Uint8Array; // グループの最初の1件だけcode.ts側が付けてくる
}
// 迷子は同名・同理由のインスタンスが大量に並びがちなので、名前＋理由の組み合わせ
// でまとめて1行にする。サムネイルもグループの最初の1件分だけ（オーバーライドで
// 個体差があっても、全件分は重くなるため代表1枚に留める）。
interface SwapStrayGroup {
  name: string;
  reason: string;
  category: "name" | "variant" | "other";
  ids: string[]; // グループ内の全インスタンスID。展開すると1件ずつジャンプできる
  thumbnailUrl?: string;
}
const swapRows = new Map<string, RowData>();
let swapCleanIds: string[] = [];
let swapDiffIds: string[] = [];
const swapStrayGroups = new Map<string, SwapStrayGroup>(); // key: `${name} ${reason}`
const swapChecked: Record<string, boolean> = {};
const swapLatestVisible: Record<string, boolean> = {};
let swapScanning = false;
let swapScanTotal = 0;
let swapScanDone = 0;
const swapExpandedIds: Record<string, boolean> = {};
let swapLastClickedIndex: { tab: "clean" | "diff"; index: number } | null = null;
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
function showToast(msg: string): void {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
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
   専用のヘッダーバー・リセットボタンは持たない。再度アクティブなタブを
   クリックすると、そのモードの中身をリセットする（旧resetBtnの役割を兼ねる）。
   スキャン中・一括処理中は他タブへの移動もブロックする（処理を見失わないため）。 */
type Mode = "update" | "swap-apply" | "swap-scan";
let currentMode: Mode = "update";
const modePanes: Record<Mode, HTMLElement> = {
  update: $("updateModePane"),
  "swap-apply": $("swapApplyModePane"),
  "swap-scan": $("swapScanModePane"),
};

function updateModeTabsDisabledState(): void {
  const updateBusy = scanning || !views.busy.classList.contains("hidden");
  const swapBusy = swapScanning || !swapViews.busy.classList.contains("hidden");
  const anyOtherModeBusy = updateBusy || swapBusy;
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
    const mode = btn.dataset.mode as Mode;
    if (mode === "update") {
      btn.disabled = mode === currentMode
        ? !views.busy.classList.contains("hidden") && !scanning
        : anyOtherModeBusy;
    } else if (mode === "swap-apply") {
      btn.disabled = mode === currentMode
        ? !swapViews.busy.classList.contains("hidden") && !swapScanning
        : anyOtherModeBusy;
    } else {
      // swap-scan自体はブロッキング処理を持たないが、他モードが処理中なら
      // やはり移動をブロックする。
      btn.disabled = anyOtherModeBusy;
    }
  });
}

// そのモードがまだ「何も失うものがない」初期画面（更新のスキャン前画面／
// スワップの貼り付け画面／ライブラリスキャンの説明画面）を表示中かどうか。
// 真なら再クリックしても確認なしで即リセットする（実質何も起きない）。
function isAtModeStart(mode: Mode): boolean {
  if (mode === "update") return !views.setup.classList.contains("hidden");
  if (mode === "swap-apply") return !swapViews.paste.classList.contains("hidden");
  if (mode === "swap-scan") return !scanLibViews.intro.classList.contains("hidden");
  return true;
}

function performModeReset(mode: Mode): void {
  if (mode === "update") {
    if (scanning) {
      post({ type: "cancel-scan" }); // onScanFinished(true) will land us on setup
      return;
    }
    resetToSetup();
  } else if (mode === "swap-apply") {
    if (swapScanning) {
      post({ type: "cancel-swap-scan" });
      return;
    }
    resetSwapToPaste();
  } else if (mode === "swap-scan") {
    showScanLib("intro");
  }
}

let pendingResetMode: Mode | null = null;

function openResetConfirm(mode: Mode): void {
  pendingResetMode = mode;
  $("resetConfirmOverlay").classList.remove("hidden");
}

$("resetConfirmCancel").addEventListener("click", () => {
  $("resetConfirmOverlay").classList.add("hidden");
  pendingResetMode = null;
});

$("resetConfirmOk").addEventListener("click", () => {
  $("resetConfirmOverlay").classList.add("hidden");
  if (pendingResetMode) performModeReset(pendingResetMode);
  pendingResetMode = null;
});

function selectMode(mode: Mode): void {
  if (mode === currentMode) {
    // 既に初期画面ならリセットしても何も変わらないので確認不要。それ以外
    // （スキャン中・結果表示中）は誤操作で今のセッションを失わないよう確認を挟む。
    if (!isAtModeStart(mode)) openResetConfirm(mode);
    return;
  }
  currentMode = mode;
  (Object.keys(modePanes) as Mode[]).forEach((m) => modePanes[m].classList.toggle("hidden", m !== mode));
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => selectMode(btn.dataset.mode as Mode));
});

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
  sizeChanged: boolean;
  before?: Uint8Array;
  after?: Uint8Array;
}

async function processDiff(msg: ScanItemMsg): Promise<RowData> {
  if (msg.sizeChanged || !msg.before || !msg.after) {
    return {
      id: msg.id,
      name: msg.name,
      status: "diff",
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
    return { id: msg.id, name: msg.name, status: "clean", imageUrl: dataUrlFromBytes(msg.after) };
  }

  const diffPercent = (numDiffPixels / (width * height)) * 100;
  return {
    id: msg.id,
    name: msg.name,
    status: "diff",
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
  renderTabs();
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
  renderTabs(row.id);
}

function onScanFinished(cancelled: boolean): void {
  scanning = false;
  $("scanProgressStrip").classList.add("hidden");
  if (cancelled) {
    resetToSetup();
    showToast("スキャンを中止しました");
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
      <div class="row-buttons"><button class="ghost-btn accent" data-individual-update="${id}">更新する</button></div>
    </div>
  </details>`;
}

function diffRowButtons(id: string): string {
  // Place-latest and the eye toggle/delete pair are mutually exclusive:
  // before placement only the place button shows, after placement it's
  // replaced by the toggle+delete pair (not shown alongside it, greyed out).
  const forceBtn = `<button class="ghost-btn accent" data-individual-force="${id}">このまま更新</button>`;
  const placed = Object.prototype.hasOwnProperty.call(latestVisible, id);
  if (!placed) {
    return `<div class="row-buttons">${forceBtn}<button class="ghost-btn warn" data-place-latest="${id}">比較用インスタンスを配置</button></div>`;
  }
  const eyeIcon = latestVisible[id] ? EYE_OPEN : EYE_CLOSED;
  return `<div class="row-buttons">${forceBtn}<button class="ghost-btn danger" data-remove-latest="${id}">比較用インスタンスを削除</button><button class="ghost-btn" data-toggle-latest="${id}">${eyeIcon}表示/非表示</button></div>`;
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

  let cleanHtml = cleanIds.length
    ? cleanIds.map((id) => cleanRowHtml(id, id === justEnteredId)).join("")
    : emptyState("clean");
  if (excluded.length || scanning) cleanHtml += excludedGroupHtml();
  $("cleanList").innerHTML = cleanHtml;

  $("diffList").innerHTML = diffIds.length
    ? diffIds.map((id) => diffRowHtml(id, id === justEnteredId)).join("")
    : emptyState("diff");

  wireRowEvents();
  updateFooterButtons();
}

function wireRowEvents(): void {
  document.querySelectorAll<HTMLDetailsElement>("#resultView .row").forEach((details) => {
    details.addEventListener("toggle", () => {
      const id = details.getAttribute("data-id");
      if (id) expandedIds[id] = details.open;
    });
  });
  document.querySelectorAll<HTMLInputElement>("#resultView .row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      handleCheckboxClick(cb, e as MouseEvent);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-jump]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "jump", id: btn.getAttribute("data-jump") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-individual-update]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "更新中…";
      post({ type: "apply", id: btn.getAttribute("data-individual-update") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-individual-force]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-individual-force")!;
      openForceConfirm({ kind: "single", id, btn, mode: "update" });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-place-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "配置中…";
      post({ type: "place-latest", id: btn.getAttribute("data-place-latest") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-toggle-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "toggle-latest", id: btn.getAttribute("data-toggle-latest") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-remove-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "remove-latest", id: btn.getAttribute("data-remove-latest") });
    });
  });
}

/* ---- チェックボックス: 通常クリック + Shiftで範囲選択 ---- */
function handleCheckboxClick(cb: HTMLInputElement, e: MouseEvent): void {
  const id = cb.getAttribute("data-id")!;
  const tab: "clean" | "diff" = cleanIds.includes(id) ? "clean" : "diff";
  const list = tab === "clean" ? cleanIds : diffIds;
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
  }
  lastClickedIndex = { tab, index };
}

/* ---- すべて選択・すべて解除・すべて展開・すべて折りたたむ ---- */
function bindListToolbar(tab: "clean" | "diff"): void {
  const list = tab === "clean" ? (): string[] => cleanIds : (): string[] => diffIds;
  $(`${tab}SelectAll`).addEventListener("click", () => {
    list().forEach((id) => (checked[id] = true));
    renderTabs();
  });
  $(`${tab}SelectNone`).addEventListener("click", () => {
    list().forEach((id) => (checked[id] = false));
    renderTabs();
  });
  // These are one-shot activations ("expand everything right now"), not a
  // toggle reflecting some tracked aggregate state — so they always do the
  // same thing regardless of the current mix of open/closed rows.
  $(`${tab}ExpandAll`).addEventListener("click", () => {
    list().forEach((id) => (expandedIds[id] = true));
    renderTabs();
  });
  $(`${tab}CollapseAll`).addEventListener("click", () => {
    list().forEach((id) => (expandedIds[id] = false));
    renderTabs();
  });
}
bindListToolbar("clean");
bindListToolbar("diff");

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
}

/* ---- 一括更新 / 比較用インスタンスを一括配置 / 比較用インスタンスをすべて削除 / このまま一括更新 ---- */
function showBulkBusy(label: string): void {
  show("busy");
  $("busyLabel").textContent = label;
  $("busyStep").textContent = "";
  ($("busyProgress").style as CSSStyleDeclaration).width = "0%";
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
  post({ type: "clear-markers" });
});

$("forceUpdateBtn").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets, mode: "update" });
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

/* ---- ライブラリスキャン（スワップ先ライブラリの公開リストの作成） ---- */
const scanLibViews = {
  intro: $("scanLibIntroView"),
  busy: $("scanLibBusyView"),
  result: $("scanLibResultView"),
};

function showScanLib(name: keyof typeof scanLibViews): void {
  (Object.keys(scanLibViews) as Array<keyof typeof scanLibViews>).forEach((k) =>
    scanLibViews[k].classList.toggle("hidden", k !== name)
  );
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
  coverThumbnail?: string; // data URL。無ければチップ表示は頭文字アバターにフォールバック
}

let lastLibraryScanJson = "";

$("scanLibStartBtn").addEventListener("click", () => {
  showScanLib("busy");
  $("scanLibBusyStep").textContent = "";
  ($("scanLibBusyFill").style as CSSStyleDeclaration).width = "0%";
  post({ type: "scan-library" });
});

function onLibraryScanProgress(name: string, index: number, total: number): void {
  $("scanLibBusyStep").textContent = `${name} (${index} / ${total})`;
  ($("scanLibBusyFill").style as CSSStyleDeclaration).width = `${Math.round((index / total) * 100)}%`;
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
   スワップ先ライブラリの公開リストを複数追加できる。＋ボタンで貼り付け
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
    statusEl.textContent = "⚠ スワップ先ライブラリの公開リストを貼り付けてください";
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
    statusEl.textContent = "⚠ スワップ先ライブラリの公開リストの形式が正しくありません";
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
  swapStrayGroups.clear();
  Object.keys(swapChecked).forEach((k) => delete swapChecked[k]);
  Object.keys(swapLatestVisible).forEach((k) => delete swapLatestVisible[k]);
  Object.keys(swapExpandedIds).forEach((k) => delete swapExpandedIds[k]);
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
    existing.ids.push(msg.id);
  } else {
    swapStrayGroups.set(key, {
      name: msg.name,
      reason: msg.reason,
      category: msg.category,
      ids: [msg.id],
      thumbnailUrl: msg.thumbnail ? dataUrlFromBytes(msg.thumbnail) : undefined,
    });
  }
  swapScanDone++;
  updateSwapScanProgress();
  renderSwapTabs();
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
  renderSwapTabs(row.id);
}

function onSwapScanFinished(cancelled: boolean): void {
  swapScanning = false;
  $("swapScanProgressStrip").classList.add("hidden");
  if (cancelled) {
    resetSwapToPaste();
    showToast("スキャンを中止しました");
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
      <div class="row-buttons"><button class="ghost-btn accent" data-swap-individual-update="${id}">スワップする</button></div>
    </div>
  </details>`;
}

function swapDiffRowButtons(id: string): string {
  const forceBtn = `<button class="ghost-btn accent" data-swap-individual-force="${id}">このままスワップ</button>`;
  const placed = Object.prototype.hasOwnProperty.call(swapLatestVisible, id);
  if (!placed) {
    return `<div class="row-buttons">${forceBtn}<button class="ghost-btn warn" data-swap-place-latest="${id}">比較用インスタンスを配置</button></div>`;
  }
  const eyeIcon = swapLatestVisible[id] ? EYE_OPEN : EYE_CLOSED;
  return `<div class="row-buttons">${forceBtn}<button class="ghost-btn danger" data-swap-remove-latest="${id}">比較用インスタンスを削除</button><button class="ghost-btn" data-swap-toggle-latest="${id}">${eyeIcon}表示/非表示</button></div>`;
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

/* ---- ライブラリスワップ: 迷子タブ（🧭）----
   同名・同理由のインスタンスは1行にまとめ、件数とグループ代表1件分の
   サムネイル（あれば）だけを表示する。オーバーライドで個体差があっても
   全件分のサムネイルは持たない（§code.ts参照）。 */
// 1件しかないグループはジャンプボタン付きの単純な行のまま。複数件ある
// グループだけ展開可能にし、開くと全インスタンスに個別ジャンプできる
// （サムネイルは代表1枚のみ。個々のインスタンスの見た目までは出さない）。
function swapStrayRowHtml(key: string, group: SwapStrayGroup): string {
  const thumb = group.thumbnailUrl ? `<img src="${group.thumbnailUrl}" alt="">` : "";
  const nameHtml = `<div class="row-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}${
    group.ids.length > 1 ? ` <span class="stray-count">×${group.ids.length}</span>` : ""
  }</div>`;

  if (group.ids.length <= 1) {
    return `<div class="stray-row">
      <div class="stray-thumb">${thumb}</div>
      <div style="flex:1; min-width:0;">
        ${nameHtml}
        <div class="stray-reason">${escapeHtml(group.reason)}</div>
      </div>
      <button class="ghost-btn" data-jump="${group.ids[0]}">${JUMP_ICON}ジャンプ</button>
    </div>`;
  }

  const instanceRows = group.ids
    .map(
      (id, i) =>
        `<div class="stray-instance-row"><span class="stray-instance-index">${i + 1}</span><button class="ghost-btn" data-jump="${id}">${JUMP_ICON}ジャンプ</button></div>`
    )
    .join("");

  return `<details class="row" data-id="stray:${escapeHtml(key)}" ${swapExpandedIds[`stray:${key}`] ? "open" : ""}>
    <summary class="stray-row">
      <div class="stray-thumb">${thumb}</div>
      <div style="flex:1; min-width:0;">
        ${nameHtml}
        <div class="stray-reason">${escapeHtml(group.reason)}</div>
      </div>
      <span class="row-trailing">${CHEVRON_SVG}</span>
    </summary>
    <div class="stray-instance-list">${instanceRows}</div>
  </details>`;
}

function renderSwapStray(): void {
  const entries = Array.from(swapStrayGroups.entries());
  const byName = entries.filter(([, g]) => g.category === "name");
  const byVariant = entries.filter(([, g]) => g.category === "variant");
  const byOther = entries.filter(([, g]) => g.category === "other");
  const sumCount = (gs: [string, SwapStrayGroup][]): number => gs.reduce((sum, [, g]) => sum + g.ids.length, 0);
  const rows = (gs: [string, SwapStrayGroup][]): string => gs.map(([key, g]) => swapStrayRowHtml(key, g)).join("");
  let html = "";
  if (byName.length) {
    html += `<div class="stray-group-head">名前が一致しません (${sumCount(byName)})</div>`;
    html += rows(byName);
  }
  if (byVariant.length) {
    html += `<div class="stray-group-head">バリアントの組み合わせが一致しません (${sumCount(byVariant)})</div>`;
    html += rows(byVariant);
  }
  if (byOther.length) {
    html += `<div class="stray-group-head">その他 (${sumCount(byOther)})</div>`;
    html += rows(byOther);
  }
  $("swapStrayList").innerHTML = html || '<div class="empty-state">該当なしの項目はありません</div>';
}

function swapEmptyState(kind: "clean" | "diff"): string {
  if (swapScanning) return '<div class="empty-state"><span class="spinner sm"></span>確認中…</div>';
  return `<div class="empty-state">${kind === "clean" ? "見た目差分なしの項目はありません" : "見た目差分ありの項目はありません"}</div>`;
}

function renderSwapTabs(justEnteredId?: string): void {
  $("swapCleanCount").textContent = `(${swapCleanIds.length})`;
  $("swapDiffCount").textContent = `(${swapDiffIds.length})`;
  $("swapStrayCount").textContent = `(${Array.from(swapStrayGroups.values()).reduce((sum, g) => sum + g.ids.length, 0)})`;

  $("swapCleanList").innerHTML = swapCleanIds.length
    ? swapCleanIds.map((id) => swapCleanRowHtml(id, id === justEnteredId)).join("")
    : swapEmptyState("clean");

  $("swapDiffList").innerHTML = swapDiffIds.length
    ? swapDiffIds.map((id) => swapDiffRowHtml(id, id === justEnteredId)).join("")
    : swapEmptyState("diff");

  renderSwapStray();

  wireSwapRowEvents();
  updateSwapFooterButtons();
}

function wireSwapRowEvents(): void {
  document.querySelectorAll<HTMLDetailsElement>("#swapResultView .row").forEach((details) => {
    details.addEventListener("toggle", () => {
      const id = details.getAttribute("data-id");
      if (id) swapExpandedIds[id] = details.open;
    });
  });
  document.querySelectorAll<HTMLInputElement>("#swapResultView .row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      handleSwapCheckboxClick(cb, e as MouseEvent);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-jump]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "jump", id: btn.getAttribute("data-jump") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-swap-individual-update]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "スワップ中…";
      post({ type: "apply", id: btn.getAttribute("data-swap-individual-update") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-swap-individual-force]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-swap-individual-force")!;
      openForceConfirm({ kind: "single", id, btn, mode: "swap" });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-swap-place-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "配置中…";
      post({ type: "place-latest", id: btn.getAttribute("data-swap-place-latest") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-swap-toggle-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "toggle-latest", id: btn.getAttribute("data-swap-toggle-latest") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#swapResultView [data-swap-remove-latest]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "remove-latest", id: btn.getAttribute("data-swap-remove-latest") });
    });
  });
}

/* ---- ライブラリスワップ: チェックボックス（Shift範囲選択） ---- */
function handleSwapCheckboxClick(cb: HTMLInputElement, e: MouseEvent): void {
  const id = cb.getAttribute("data-id")!;
  const tab: "clean" | "diff" = swapCleanIds.includes(id) ? "clean" : "diff";
  const list = tab === "clean" ? swapCleanIds : swapDiffIds;
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
  }
  swapLastClickedIndex = { tab, index };
}

/* ---- ライブラリスワップ: すべて選択・すべて解除・すべて展開・すべて折りたたむ ---- */
function bindSwapListToolbar(tab: "clean" | "diff"): void {
  const list = tab === "clean" ? (): string[] => swapCleanIds : (): string[] => swapDiffIds;
  const prefix = tab === "clean" ? "swapClean" : "swapDiff";
  $(`${prefix}SelectAll`).addEventListener("click", () => {
    list().forEach((id) => (swapChecked[id] = true));
    renderSwapTabs();
  });
  $(`${prefix}SelectNone`).addEventListener("click", () => {
    list().forEach((id) => (swapChecked[id] = false));
    renderSwapTabs();
  });
  $(`${prefix}ExpandAll`).addEventListener("click", () => {
    list().forEach((id) => (swapExpandedIds[id] = true));
    renderSwapTabs();
  });
  $(`${prefix}CollapseAll`).addEventListener("click", () => {
    list().forEach((id) => (swapExpandedIds[id] = false));
    renderSwapTabs();
  });
}
bindSwapListToolbar("clean");
bindSwapListToolbar("diff");

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
}

/* ---- ライブラリスワップ: 一括スワップ / 比較用インスタンスを一括配置 / このまま一括スワップ ---- */
function showSwapBulkBusy(label: string): void {
  showSwap("busy");
  $("swapBulkBusyLabel").textContent = label;
  $("swapBulkBusyStep").textContent = "";
  ($("swapBulkBusyProgress").style as CSSStyleDeclaration).width = "0%";
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
  post({ type: "clear-markers" });
});

$("swapForceBulkBtn").addEventListener("click", () => {
  const targets = swapDiffIds.filter((id) => swapChecked[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets, mode: "swap" });
});

function removeSwapResolvedId(id: string): void {
  swapCleanIds = swapCleanIds.filter((x) => x !== id);
  swapDiffIds = swapDiffIds.filter((x) => x !== id);
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
    case "library-scan-progress":
      onLibraryScanProgress(msg.name, msg.index, msg.total);
      break;
    case "library-scan-done":
      onLibraryScanDone(msg.data, msg.coverThumbnail);
      break;
    case "swap-scan-started":
      onSwapScanStarted(msg.total);
      break;
    case "swap-scan-item-excluded":
      onSwapScanExcluded({ id: msg.id, name: msg.name, reason: msg.reason, category: msg.category, thumbnail: msg.thumbnail });
      break;
    case "swap-scan-item-result":
      void onSwapScanItemResult(msg);
      break;
    case "swap-scan-done":
      onSwapScanFinished(false);
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
      showToast(`エラー: ${msg.message}`);
      break;
  }
};
