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
  imageUrl?: string; // after-image (clean) or diff-image (diff)
  currentUrl?: string; // size-changed only: before/current image
  latestUrl?: string; // size-changed only: after/latest image
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
let allExpanded: Record<"clean" | "diff", boolean> = { clean: false, diff: false };
let lastClickedIndex: { tab: "clean" | "diff"; index: number } | null = null;

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
const resetBtn = $("resetBtn") as HTMLButtonElement;

function show(name: keyof typeof views): void {
  (Object.keys(views) as Array<keyof typeof views>).forEach((k) => views[k].classList.toggle("hidden", k !== name));
  // Reset is disabled only while a full-screen bulk operation is running —
  // individual row actions are lightweight and don't block navigation.
  resetBtn.disabled = name === "busy";
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

/* ---- リセット（常設・busy中はグレーアウト） ---- */
function resetToSetup(): void {
  rows.clear();
  cleanIds = [];
  diffIds = [];
  excluded = [];
  Object.keys(checked).forEach((k) => delete checked[k]);
  Object.keys(markedIds).forEach((k) => delete markedIds[k]);
  markerCount = 0;
  lastClickedIndex = null;
  show("setup");
  setChromeSub("アイドル");
}

resetBtn.addEventListener("click", () => {
  if (resetBtn.disabled) return;
  if (scanning) {
    post({ type: "cancel-scan" }); // onScanFinished(true) will land us on setup
  } else {
    resetToSetup();
  }
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
      status: "size-changed",
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
      status: "size-changed",
      currentUrl: dataUrlFromBytes(msg.before),
      latestUrl: dataUrlFromBytes(msg.after),
    };
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
  lastClickedIndex = null;

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
    resetToSetup();
    showToast("スキャンを中止しました");
  } else {
    setChromeSub("検出完了");
    renderTabs();
  }
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
    return `<div class="size-compare">
      <div class="size-compare-item"><div class="preview-frame"><img src="${row.currentUrl || ""}" alt=""></div><span class="size-compare-label">Current</span></div>
      <div class="size-compare-item"><div class="preview-frame"><img src="${row.latestUrl || ""}" alt=""></div><span class="size-compare-label">Latest</span></div>
    </div>`;
  }
  return `<div class="preview-frame"><img src="${row.imageUrl || ""}" alt=""></div>`;
}

function rowHtml(id: string, kind: "clean" | "diff", justEntered: boolean): string {
  const row = rows.get(id);
  if (!row) return "";
  const marked = kind === "diff" && markedIds[id];

  let caption: string;
  if (kind === "clean") caption = "更新後の見た目（差分なしのためBeforeと同一）";
  else if (row.status === "size-changed") caption = "サイズが変更されたため、CurrentとLatestをそのまま並べて表示しています（ピクセル比較はスキップ）";
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
    rowButtons = `<div class="row-buttons">${jumpBtnHtml(id)}<button class="ghost-btn danger" data-individual-force="${id}">構わず更新</button><button class="ghost-btn warn" data-individual-mark="${id}">マーキングする</button></div>`;
  }

  const checkbox = `<input type="checkbox" class="row-check" data-id="${id}" ${marked ? "disabled" : checked[id] ? "checked" : ""}>`;
  const markedPill = marked ? '<span class="marked-pill">マーキング済み</span>' : "";

  return `<details class="row${justEntered ? " enter" : ""}${marked ? " is-marked" : ""}" data-id="${id}" ${allExpanded[kind] ? "open" : ""}>
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

  wireRowEvents();
  updateFooterButtons();
  updateExpandToggleLabels();
}

function wireRowEvents(): void {
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
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-individual-mark]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "マーキング中…";
      post({ type: "mark", id: btn.getAttribute("data-individual-mark") });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#resultView [data-individual-force]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-individual-force")!;
      openForceConfirm({ kind: "single", id, btn });
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
    for (let i = from; i <= to; i++) {
      const rid = list[i];
      if (markedIds[rid]) continue; // マーキング済みは対象外
      checked[rid] = newState;
    }
    renderTabs();
  } else {
    checked[id] = newState;
    updateFooterButtons();
  }
  lastClickedIndex = { tab, index };
}

/* ---- すべて選択・すべて解除・すべて展開/折りたたみ ---- */
function selectableIds(tab: "clean" | "diff"): string[] {
  const list = tab === "clean" ? cleanIds : diffIds;
  return list.filter((id) => !markedIds[id]);
}

function bindListToolbar(tab: "clean" | "diff"): void {
  $(`${tab}SelectAll`).addEventListener("click", () => {
    selectableIds(tab).forEach((id) => (checked[id] = true));
    renderTabs();
  });
  $(`${tab}SelectNone`).addEventListener("click", () => {
    selectableIds(tab).forEach((id) => (checked[id] = false));
    renderTabs();
  });
  $(`${tab}ExpandToggle`).addEventListener("click", () => {
    allExpanded[tab] = !allExpanded[tab];
    const list = document.getElementById(tab === "clean" ? "cleanList" : "diffList")!;
    list.querySelectorAll("details").forEach((d) => {
      (d as HTMLDetailsElement).open = allExpanded[tab];
    });
    updateExpandToggleLabels();
  });
}
bindListToolbar("clean");
bindListToolbar("diff");

function updateExpandToggleLabels(): void {
  $("cleanExpandToggle").textContent = allExpanded.clean ? "すべて折りたたむ" : "すべて展開";
  $("diffExpandToggle").textContent = allExpanded.diff ? "すべて折りたたむ" : "すべて展開";
}

function updateFooterButtons(): void {
  const cleanChecked = cleanIds.filter((id) => checked[id]).length;
  const diffChecked = diffIds.filter((id) => checked[id] && !markedIds[id]).length;
  $("updateBtnLabel").textContent = `一括更新（${cleanChecked}件）`;
  ($("updateBtn") as HTMLButtonElement).disabled = cleanChecked === 0;
  $("markBtnLabel").textContent = `一括マーキング（${diffChecked}件）`;
  ($("markBtn") as HTMLButtonElement).disabled = diffChecked === 0;
  $("forceUpdateBtnLabel").textContent = `一括で構わず更新（${diffChecked}件）`;
  ($("forceUpdateBtn") as HTMLButtonElement).disabled = diffChecked === 0;
}

/* ---- 一括更新 / 一括マーキング / 一括で構わず更新 ---- */
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

$("forceUpdateBtn").addEventListener("click", () => {
  const targets = diffIds.filter((id) => checked[id] && !markedIds[id]);
  if (targets.length === 0) return;
  openForceConfirm({ kind: "bulk", ids: targets });
});

function removeResolvedId(id: string): void {
  cleanIds = cleanIds.filter((x) => x !== id);
  diffIds = diffIds.filter((x) => x !== id);
  rows.delete(id);
  delete checked[id];
  delete markedIds[id];
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

/* ---- 構わず更新の確認ダイアログ ---- */
type PendingForce = { kind: "single"; id: string; btn: HTMLButtonElement } | { kind: "bulk"; ids: string[] };
let pendingForce: PendingForce | null = null;

function openForceConfirm(target: PendingForce): void {
  pendingForce = target;
  const count = target.kind === "single" ? 1 : target.ids.length;
  $("confirmBody").textContent =
    `${count}件のインスタンスは見た目に差分が確認されていますが、そのまま更新します。続行しますか？（Ctrl+Zでいつでも元に戻せます）`;
  $("confirmOverlay").classList.remove("hidden");
}

$("modalCancel").addEventListener("click", () => {
  $("confirmOverlay").classList.add("hidden");
  pendingForce = null;
});

$("modalConfirm").addEventListener("click", () => {
  $("confirmOverlay").classList.add("hidden");
  if (!pendingForce) return;
  if (pendingForce.kind === "single") {
    pendingForce.btn.disabled = true;
    pendingForce.btn.textContent = "更新中…";
    post({ type: "apply", id: pendingForce.id });
  } else {
    showBulkBusy("更新しています");
    post({ type: "apply-bulk", ids: pendingForce.ids });
  }
  pendingForce = null;
});

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
