// Update Diff Guard — UI iframe (browser environment: Canvas, pixelmatch).
// Deliberately plain styling; this build exists to validate the core
// logic (see code.ts header comment), not to match the polished mockup.

import pixelmatch from "pixelmatch";

type ScanRowStatus = "unpublished" | "up-to-date" | "has-update" | "import-failed";

interface ScanRow {
  id: string;
  name: string;
  status: ScanRowStatus;
}

const state: { rows: ScanRow[] } = { rows: [] };

function post(msg: Record<string, unknown>): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function statusLabel(status: ScanRowStatus): string {
  switch (status) {
    case "unpublished":
      return "対象外（未パブリッシュ）";
    case "import-failed":
      return "インポート失敗";
    case "up-to-date":
      return "更新なし";
    case "has-update":
      return "更新あり";
  }
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function renderRows(): void {
  const counts: Record<ScanRowStatus, number> = {
    unpublished: 0,
    "up-to-date": 0,
    "has-update": 0,
    "import-failed": 0,
  };
  for (const row of state.rows) counts[row.status]++;
  setStatus(
    `検出 ${state.rows.length}件 — 更新あり ${counts["has-update"]} / 更新なし ${counts["up-to-date"]} / 対象外 ${
      counts.unpublished + counts["import-failed"]
    }`
  );

  const list = document.getElementById("rowList");
  if (!list) return;
  list.innerHTML = "";

  for (const row of state.rows) {
    if (row.status !== "has-update") continue; // only actionable rows matter for this validation build
    const rowEl = document.createElement("div");
    rowEl.className = "row";
    rowEl.id = `row-${row.id}`;
    rowEl.innerHTML = `
      <div class="row-head">
        <span class="row-name">${escapeHtml(row.name)}</span>
        <span class="badge has-update">${statusLabel(row.status)}</span>
      </div>
      <div class="row-actions">
        <button class="btn" data-action="jump" data-id="${row.id}">キャンバスでジャンプ</button>
        <button class="btn" data-action="test-diff" data-id="${row.id}">差分テスト</button>
        <button class="btn primary" data-action="apply" data-id="${row.id}">適用（in-place swap）</button>
        <button class="btn warn" data-action="mark" data-id="${row.id}">マーキング</button>
      </div>
      <div class="row-result" id="result-${row.id}"></div>
    `;
    list.appendChild(rowEl);
  }

  const skipped = state.rows.filter((r) => r.status !== "has-update");
  const skipList = document.getElementById("skipList");
  if (skipList) {
    skipList.innerHTML = skipped.length
      ? skipped.map((r) => `<li>${escapeHtml(r.name)} — ${statusLabel(r.status)}</li>`).join("")
      : '<li class="muted">なし</li>';
  }
}

function setRowResult(id: string, html: string): void {
  const el = document.getElementById(`result-${id}`);
  if (el) el.innerHTML = html;
}

function appendRowNote(id: string, html: string): void {
  const el = document.getElementById(`result-${id}`);
  if (el) el.innerHTML += html;
}

function dataUrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

function loadImageData(bytes: Uint8Array): Promise<{ data: ImageData; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
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

async function handleDiffImages(msg: {
  id: string;
  before: Uint8Array;
  after: Uint8Array;
  sizeChanged: boolean;
}): Promise<void> {
  const beforeUrl = dataUrlFromBytes(msg.before);
  const afterUrl = dataUrlFromBytes(msg.after);
  const thumbs = (extra: string) => `
    <div class="thumbs">
      <figure><img src="${beforeUrl}"><figcaption>Before</figcaption></figure>
      <figure><img src="${afterUrl}"><figcaption>After</figcaption></figure>
      ${extra}
    </div>`;

  if (msg.sizeChanged) {
    setRowResult(msg.id, `${thumbs("")}<div class="diff-note warn">サイズが変更されました（ピクセル比較はスキップ）</div>`);
    return;
  }

  const before = await loadImageData(msg.before);
  const after = await loadImageData(msg.after);

  if (before.width !== after.width || before.height !== after.height) {
    setRowResult(msg.id, `${thumbs("")}<div class="diff-note warn">画像サイズが一致しません（ピクセル比較はスキップ）</div>`);
    return;
  }

  const { width, height } = before;
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = width;
  diffCanvas.height = height;
  const diffCtx = diffCanvas.getContext("2d");
  if (!diffCtx) return;
  const diffImageData = diffCtx.createImageData(width, height);

  const numDiffPixels = pixelmatch(before.data.data, after.data.data, diffImageData.data, width, height, {
    threshold: 0.1,
  });
  diffCtx.putImageData(diffImageData, 0, 0);

  const diffPercent = ((numDiffPixels / (width * height)) * 100).toFixed(2);
  const diffUrl = diffCanvas.toDataURL("image/png");
  const isClean = numDiffPixels === 0;
  const diffFigure = `<figure><img src="${diffUrl}"><figcaption>Diff</figcaption></figure>`;

  setRowResult(
    msg.id,
    `${thumbs(diffFigure)}<div class="diff-note ${isClean ? "ok" : "warn"}">${
      isClean ? "差分なし" : `差分あり — ${diffPercent}% (${numDiffPixels}px)`
    }</div>`
  );
}

document.getElementById("scanBtn")?.addEventListener("click", () => {
  const checked = document.querySelector<HTMLInputElement>('input[name="scope"]:checked');
  const scope = checked ? checked.value : "selection";
  setStatus("Scan中…");
  post({ type: "scan", scope });
});

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>("button[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");
  if (!id) return;

  if (action === "test-diff") {
    setRowResult(id, '<span class="muted">比較中…</span>');
    post({ type: "test-diff", id });
  } else if (action === "apply") {
    btn.setAttribute("disabled", "true");
    post({ type: "apply", id });
  } else if (action === "mark") {
    btn.setAttribute("disabled", "true");
    post({ type: "mark", id });
  } else if (action === "jump") {
    post({ type: "jump", id });
  }
});

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;

  if (msg.type === "scan-result") {
    state.rows = msg.rows;
    renderRows();
  } else if (msg.type === "diff-images") {
    void handleDiffImages(msg);
  } else if (msg.type === "applied") {
    const el = document.getElementById(`row-${msg.id}`);
    if (el) el.classList.add("applied");
    setRowResult(
      msg.id,
      '<div class="diff-note ok">適用しました。Figma上でオーバーライド・矢印コネクタの状態を確認してください。</div>'
    );
  } else if (msg.type === "marked") {
    const el = document.getElementById(`row-${msg.id}`);
    if (el) el.classList.add("marked");
    appendRowNote(
      msg.id,
      '<div class="diff-note warn">マーキングしました（矩形マーカー＋Afterインスタンスを配置）。元インスタンスは未変更です。Figma上でレイヤーの並びと矢印コネクタの状態を確認してください。</div>'
    );
  } else if (msg.type === "error") {
    setStatus(`エラー: ${msg.message}`);
  }
};
