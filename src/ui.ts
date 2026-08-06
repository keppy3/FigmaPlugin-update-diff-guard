// Update Diff Guard — UI iframe (browser environment: Canvas, pixelmatch).
//
// Owns all clean/diff classification: code.ts sends raw before/after PNG
// bytes (or a sizeChanged flag) per instance; this file runs pixelmatch,
// decides which tab a row belongs in, and renders it. code.ts never needs
// to know an instance's classification — only its id.

import pixelmatch from "pixelmatch";

type RowStatus = "clean" | "diff" | "size-changed";

interface RowData {
  id: string;
  name: string;
  status: RowStatus;
  diffPercent?: number;
  imageUrl?: string; // after-image (clean) or diff-image (diff); absent for size-changed
}

interface ExcludedEntry {
  name: string;
  reason: string;
}

const rows = new Map<string, RowData>();
let cleanIds: string[] = [];
let diffIds: string[] = [];
let excluded: ExcludedEntry[] = [];
const checked: Record<string, boolean> = {};
const markedIds: Record<string, boolean> = {};
let scanning = false;
let scanTotal = 0;
let scanDone = 0;
let markerCount = 0;

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
}

function setChromeSub(text: string): void {
  $("chromeSub").textContent = text;
}

let toastTimer: number | undefined;
function showToast(msg: string): void {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
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
  sizeChanged: boolean;
  before?: Uint8Array;
  after?: Uint8Array;
}

async function processDiff(msg: ScanItemMsg): Promise<RowData> {
  if (msg.sizeChanged || !msg.before || !msg.after) {
    return { id: msg.id, name: msg.name, status: "size-changed" };
  }

  const before = await loadImageData(msg.before);
  const after = await loadImageData(msg.after);
  if (before.width !== after.width || before.height !== after.height) {
    return { id: msg.id, name: msg.name, status: "size-changed" };
  }

  const { width, height } = before;
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = width;
  diffCanvas.height = height;
  const diffCtx = diffCanvas.getContext("2d")!;
  const diffImageData = diffCtx.createImageData(width, height);

  const numDiffPixels = pixelmatch(before.data.data, after.data.data, diffImageData.data, width, height, {
    threshold: 0.1,
  });

  if (numDiffPixels === 0) {
    return { id: msg.id, name: msg.name, status: "clean", imageUrl: dataUrlFromBytes(msg.after) };
  }

  diffCtx.putImageData(diffImageData, 0, 0);
  const diffPercent = (numDiffPixels / (width * height)) * 100;
  return { id: msg.id, name: msg.name, status: "diff", diffPercent, imageUrl: diffCanvas.toDataURL("image/png") };
}

/* ---- scope radios ---- */
$("radioGroup").addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (target.name !== "scope") return;
  document.querySelectorAll(".radio-option").forEach((opt) => {
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
  Object.keys(markedIds).forEach((k) => delete markedIds[k]);
  scanning = true;
  scanTotal = total;
  scanDone = 0;

  show("result");
  $("scanProgressStrip").classList.remove("hidden");
  ($("cancelScanBtn") as HTMLButtonElement).disabled = false;
  updateScanProgress();
  renderExcludedSummary();
  renderTabs();
  setChromeSub("スキャン中…");
}

function updateScanProgress(): void {
  $("scanProgressText").textContent = `確認中… ${scanDone} / ${scanTotal}`;
  ($("scanProgressFill").style as CSSStyleDeclaration).width = scanTotal ? `${Math.round((scanDone / scanTotal) * 100)}%` : "0%";
}

function onScanExcluded(name: string, reason: string): void {
  excluded.push({ name, reason });
  scanDone++;
  updateScanProgress();
  renderExcludedSummary();
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
    show("setup");
    setChromeSub("アイドル");
    showToast("スキャンを中止しました");
  } else {
    setChromeSub("検出完了");
    renderTabs();
  }
}

async function onRetryDiffResult(msg: ScanItemMsg): Promise<void> {
  const oldStatus = rows.get(msg.id)?.status;
  const newRow = await processDiff(msg);
  rows.set(newRow.id, newRow);

  const oldIsClean = oldStatus === "clean";
  const newIsClean = newRow.status === "clean";
  if (oldIsClean !== newIsClean) {
    if (oldIsClean) cleanIds = cleanIds.filter((x) => x !== newRow.id);
    else diffIds = diffIds.filter((x) => x !== newRow.id);
    if (newIsClean) cleanIds.push(newRow.id);
    else diffIds.push(newRow.id);
  }
  renderTabs();
  showToast("再比較しました");
}

/* ---- 除外内訳 ---- */
function renderExcludedSummary(): void {
  $("excludedSummary").textContent = scanning
    ? `対象外を確認中…（現在 ${excluded.length}件）`
    : `対象外 ${excluded.length}件を除外済み`;
  $("excludedList").innerHTML =
    excluded
      .map(
        (e) =>
          `<li><span class="ex-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span><span class="ex-reason">${escapeHtml(e.reason)}</span></li>`
      )
      .join("") || '<li class="muted">なし</li>';
}

/* ---- タブ切り替え ---- */
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tabBtn));
    const name = tabBtn.getAttribute("data-tab");
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.getAttribute("data-panel") !== name);
    });
  });
});

/* ---- 行の描画 ---- */
function jumpBtnHtml(id: string): string {
  return `<button class="ghost-btn" data-jump="${id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M14 6V2h-4M10 14h4v-4M2 10v4h4"/></svg>キャンバスでジャンプ</button>`;
}

function previewHtml(row: RowData): string {
  if (row.status === "size-changed") {
    return `<div class="preview-frame size-changed"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3"/></svg><span>サイズ変更</span></div>`;
  }
  return `<div class="preview-frame"><img src="${row.imageUrl || ""}" alt=""></div>`;
}

function rowHtml(id: string, kind: "clean" | "diff", justEntered: boolean): string {
  const row = rows.get(id);
  if (!row) return "";
  const marked = kind === "diff" && markedIds[id];

  let caption: string;
  if (kind === "clean") caption = "更新後の見た目（差分なしのためBeforeと同一）";
  else if (row.status === "size-changed") caption = "サイズが変更されたため、ピクセル比較をスキップしました";
  else caption = "pixelmatchの差分画像（副産物）をそのまま表示";

  const pctBadge =
    row.status === "diff" && row.diffPercent !== undefined
      ? `<span class="diff-pct">差分 ${row.diffPercent.toFixed(1)}%</span>`
      : "";

  let rowButtons: string;
  if (kind === "clean") {
    rowButtons = `<div class="row-buttons">${jumpBtnHtml(id)}<button class="ghost-btn accent" data-individual-update="${id}">更新する</button></div>`;
  } else if (marked) {
    rowButtons = `<div class="row-buttons">${jumpBtnHtml(id)}<button class="ghost-btn" disabled>✓ マーキング済み</button></div>`;
  } else {
    rowButtons = `<div class="row-buttons">${jumpBtnHtml(id)}<button class="ghost-btn" data-retry="${id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 1 1.5 3.6M3 8V4M3 8h4"/></svg>再比較</button><button class="ghost-btn warn" data-individual-mark="${id}">マーキングする</button></div>`;
  }

  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${marked ? "disabled" : checked[id] ? "checked" : ""}>`;
  const markedPill = marked ? '<span class="marked-pill">マーキング済み</span>' : "";

  return `<details class="row${justEntered ? " enter" : ""}${marked ? " is-marked" : ""}" data-id="${id}">
    <summary class="row-summary">
      ${checkbox}
      <span class="row-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      ${markedPill}
      <span class="row-trailing"><svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg></span>
    </summary>
    <div class="row-detail">
      <div class="preview-row">${previewHtml(row)}<div style="display:flex;flex-direction:column;gap:6px;">${pctBadge}<span class="preview-caption">${caption}</span></div></div>
      ${rowButtons}
    </div>
  </details>`;
}

function emptyState(kind: "clean" | "diff"): string {
  if (scanning) return '<div class="empty-state"><span class="spinner sm"></span>確認中…</div>';
  return `<div class="empty-state">${kind === "clean" ? "見た目差分なしの項目はありません" : "見た目差分ありの項目はありません"}</div>`;
}

function renderTabs(justEnteredId?: string): void {
  $("cleanCount").textContent = `(${cleanIds.length})`;
  $("diffCount").textContent = `(${diffIds.length})`;

  $("cleanList").innerHTML = cleanIds.length
    ? cleanIds.map((id) => rowHtml(id, "clean", id === justEnteredId)).join("")
    : emptyState("clean");

  $("diffList").innerHTML = diffIds.length
    ? diffIds.map((id) => rowHtml(id, "diff", id === justEnteredId)).join("")
    : emptyState("diff");

  document.querySelectorAll<HTMLInputElement>("#resultView .row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      const id = (e.target as HTMLInputElement).getAttribute("data-id")!;
      checked[id] = (e.target as HTMLInputElement).checked;
      updateFooterButtons();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-jump]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "jump", id: btn.getAttribute("data-jump") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-retry]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      post({ type: "retry-diff", id: btn.getAttribute("data-retry") });
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
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-individual-mark]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "マーキング中…";
      post({ type: "mark", id: btn.getAttribute("data-individual-mark") });
    });
  });

  updateFooterButtons();
}

function updateFooterButtons(): void {
  const cleanChecked = cleanIds.filter((id) => checked[id]).length;
  const diffChecked = diffIds.filter((id) => checked[id] && !markedIds[id]).length;
  $("updateBtnLabel").textContent = `一括更新（${cleanChecked}件）`;
  ($("updateBtn") as HTMLButtonElement).disabled = cleanChecked === 0;
  $("markBtnLabel").textContent = `一括マーキング（${diffChecked}件）`;
  ($("markBtn") as HTMLButtonElement).disabled = diffChecked === 0;
}

/* ---- 一括更新 / 一括マーキング ---- */
function showBulkBusy(label: string): void {
  show("busy");
  $("busyLabel").textContent = label;
  $("busyStep").textContent = "";
  ($("busyProgress").style as CSSStyleDeclaration).width = "0%";
  setChromeSub(`${label}…`);
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

$("markBtn").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id] && !markedIds[id]);
  if (targets.length === 0) return;
  showBulkBusy("マーキングしています");
  post({ type: "mark-bulk", ids: targets });
});

function onApplied(id: string): void {
  const row = rows.get(id);
  cleanIds = cleanIds.filter((x) => x !== id);
  rows.delete(id);
  delete checked[id];
  renderTabs();
  showToast(`「${row?.name ?? id}」を更新しました`);
}

function onApplyBulkDone(ids: string[]): void {
  ids.forEach((id) => {
    cleanIds = cleanIds.filter((x) => x !== id);
    rows.delete(id);
    delete checked[id];
  });
  renderTabs();
  show("result");
  showToast(`${ids.length}件を更新しました`);
  setChromeSub("検出完了");
}

function onMarked(id: string): void {
  const row = rows.get(id);
  markedIds[id] = true;
  checked[id] = false;
  renderTabs();
  showToast(`「${row?.name ?? id}」をマーキングしました`);
}

function onMarkBulkDone(ids: string[]): void {
  ids.forEach((id) => {
    markedIds[id] = true;
    checked[id] = false;
  });
  renderTabs();
  show("result");
  showToast(`${ids.length}件をマーキングしました`);
  setChromeSub("検出完了");
}

/* ---- マーカー管理 ---- */
function updateMarkerStrip(): void {
  const strip = $("markerStrip");
  strip.classList.toggle("hidden", markerCount === 0);
  $("markerCount").textContent = String(markerCount);
}

function setMarkerCount(count: number): void {
  markerCount = count;
  updateMarkerStrip();
}

$("clearMarkersBtn").addEventListener("click", () => {
  post({ type: "clear-markers" });
});

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
    case "marked":
      onMarked(msg.id);
      break;
    case "mark-bulk-progress":
      onBulkProgress("マーキングしています", msg.name, msg.index, msg.total);
      break;
    case "mark-bulk-done":
      onMarkBulkDone(msg.ids);
      break;
    case "retry-diff-result":
      void onRetryDiffResult(msg);
      break;
    case "markers-cleared":
      showToast(`マーカーとAfterインスタンスを${msg.count}件削除しました`);
      break;
    case "marker-count":
      setMarkerCount(msg.count);
      break;
    case "error":
      showToast(`エラー: ${msg.message}`);
      break;
  }
};
