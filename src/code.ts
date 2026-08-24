// Swap & Update Diff Check — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable, one commitUndo per item so a concurrent
// user undo can't reach further back than the item in flight), individual
// + bulk update for 見た目差分なし items (also reused for "このまま更新" on
// 見た目差分あり items — the write is identical either way), and a
// per-instance "比較用インスタンスを配置" overlay comparison tool (place a
// Latest-preview directly on top of Current, toggle it show/hide, or
// remove it individually) with a name-based full-sweep cleanup utility
// ("比較用インスタンスをすべて削除").
//
// Classification (clean vs diff) happens in ui.ts, not here — this side
// only ever needs to know "which instance" via id, never "is it clean".
// See §6.4 for why: pixelmatch requires Canvas, which only the UI iframe
// has.

figma.showUI(__html__, { width: 420, height: 660 });

// ---- スワップ先ライブラリの公開コンポーネントリストの記憶（プラグイン再起動をまたいで保持） ----
// clientStorageはユーザー×プラグイン単位で永続化される（ファイルではなく
// このマシン・このFigmaアカウントに紐づく）。複数ライブラリを追加できるため、
// 貼り付けた生JSON文字列の配列（追加した順）として保存し、次回起動時に
// チップリストが空なら自動で復元する。
const SWAP_MAPPING_CACHE_KEY = "swap-mapping-cache";

(async () => {
  const cached = await figma.clientStorage.getAsync(SWAP_MAPPING_CACHE_KEY);
  if (Array.isArray(cached) && cached.length) {
    post({ type: "swap-mapping-cache-loaded", raws: cached });
  }
})();

type ScopeMode = "selection" | "page" | "all";

// "update"=コンポーネント更新（同一キーの最新publish版）、"swap"=ライブラリ
// スワップ（貼り付けられた対応表から名前/バリアントで解決した別ライブラリの
// コンポーネント）。store/wrapperStoreは両モードで共有する（同じキャンバス上の
// 話なので、比較用インスタンスの一括削除等は出所を問わず全件対象にしたい）。
// sourceは、apply/配置系のハンドラがui.ts側にどちらのモード向けメッセージを
// 送るか判定するためだけに使う。
type StoreSource = "update" | "swap";

interface StoredItem {
  instance: InstanceNode;
  // スキャン時に一度だけ解決したComponentNodeそのものではなく、そのkeyを
  // 覚えておく。適用/配置はスキャンからかなり時間が空いてから押されることも
  // 多く（ユーザーが結果を見比べている間ずっと）、その間に参照が無効化されて
  // いる可能性がある（比較画像は作れたのに実際の適用だけ失敗する原因になって
  // いた）。適用の直前に毎回importComponentWithRetryで取り直すことで、
  // Figma純正の更新機能と同じく「今その瞬間の最新」を反映する。
  latestKey: string;
  source: StoreSource;
}

const store = new Map<string, StoredItem>();
// Latest-preview wrapper frames currently placed on top of Current,
// keyed by the original instance's id. Cleaned up on apply/force-update
// so a resolved row never leaves a redundant overlay behind.
const wrapperStore = new Map<string, FrameNode>();
let scanCancelled = false;
let swapScanCancelled = false;
let libraryScanCancelled = false;

function post(msg: Record<string, unknown>): void {
  figma.ui.postMessage(msg);
}

function postError(message: string): void {
  post({ type: "error", message });
}

function walkForInstances(node: SceneNode, out: InstanceNode[]): void {
  if (node.type === "INSTANCE") {
    // Top-level instances only — nested instances are captured implicitly
    // in the parent's image diff, not compared individually.
    out.push(node);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) walkForInstances(child, out);
  }
}

async function collectTargets(scope: ScopeMode): Promise<InstanceNode[]> {
  const roots: SceneNode[] = [];
  if (scope === "selection") {
    roots.push(...figma.currentPage.selection);
  } else if (scope === "page") {
    roots.push(...figma.currentPage.children);
  } else {
    for (const page of figma.root.children) {
      await page.loadAsync();
      roots.push(...page.children);
    }
  }
  const found: InstanceNode[] = [];
  for (const root of roots) walkForInstances(root, found);
  return found;
}

// ---- Latest-preview wrapper discovery (見た目の名前で検索) -----------------
//
// 以前はsetPluginDataで内部タグを付けたノードを探索していたが、「配置した
// 複製インスタンスだけをキャンバス上でラッパーの外に出して実インスタンスとして
// 使う」というユーザーの実運用を考えると、削除対象が目に見えない内部タグに
// 依存しているのは挙動を予測しづらい（ユーザー自身がレイヤーパネルを見ても、
// 何が「すべて削除」の対象になるか分からない）。ラッパーの名前
// （§placeLatestOne）そのもので検索することで、レイヤーパネルの表示＝削除
// 対象という分かりやすい対応にする。中の複製インスタンス自体には何もタグ付け
// していないので、ユーザーがラッパーから複製を取り出して実インスタンスとして
// 使い始めた場合、そのインスタンスはこの検索に一切引っかからず「削除の呪い」
// から自然に解放される。
const LATEST_PREVIEW_NAME_PREFIX = "⚠ Latest Preview — ";

function collectMarkerFrames(node: BaseNode, out: FrameNode[]): void {
  if (node.type === "FRAME" && node.name.startsWith(LATEST_PREVIEW_NAME_PREFIX)) {
    out.push(node);
    return; // 自分たちが作ったラッパーの中身なので、これ以上潜らない
  }
  if ("children" in node) {
    for (const child of (node as unknown as ChildrenMixin).children) collectMarkerFrames(child, out);
  }
}

async function findAllMarkerFrames(): Promise<FrameNode[]> {
  const found: FrameNode[] = [];
  for (const page of figma.root.children) {
    await page.loadAsync();
    collectMarkerFrames(page, found);
  }
  return found;
}

// ---- Scan ------------------------------------------------------------
//
// Runs one instance at a time (not in parallel) so that:
//   1. results can stream to the UI as each one resolves, and
//   2. figma.commitUndo() after each item bounds how much a concurrent
//      user edit/undo during the scan can possibly disturb.
// A crash on one instance (e.g. it was deleted or reparented by the user
// while the scan was awaiting an export) is caught per-item so it can't
// abort the rest of the scan.

// importComponentByKeyAsyncは大規模ファイル・大量呼び出し時にまれに単発で
// 失敗することがある（Figma側の一時的な負荷等、原因はこちら側からは分からない）。
// 1回失敗しただけで「迷子」や「取得失敗」扱いにしてしまうと再スキャンしないと
// 復旧できないので、短い間隔を空けて数回だけ再試行してから諦める。
async function importComponentWithRetry(key: string, attempts = 3): Promise<ComponentNode> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await figma.importComponentByKeyAsync(key);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastErr;
}

// clone/insertChild/removeをインスタンス数分連続で繰り返すと、Figmaクライアント
// が長時間ノンストップで処理し続ける形になり実機で不安定になった実害があった
// （§computeAndSendDiffの変遷コメント参照）。一定件数ごとに一度イベントループへ
// 制御を返すことで、処理速度をほぼ落とさずにクライアントの応答性を保つ。
const SCAN_YIELD_EVERY = 20;
async function maybeYieldScan(counter: { value: number }): Promise<void> {
  counter.value++;
  if (counter.value >= SCAN_YIELD_EVERY) {
    counter.value = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function runScan(scope: ScopeMode): Promise<void> {
  store.clear();
  scanCancelled = false;

  const targets = await collectTargets(scope);
  post({ type: "scan-started", total: targets.length });

  const yieldCounter = { value: 0 };
  for (const inst of targets) {
    if (scanCancelled) break;

    try {
      let main: ComponentNode | null;
      try {
        main = await inst.getMainComponentAsync();
      } catch {
        main = null;
      }

      if (!main) {
        post({ type: "scan-item-excluded", name: inst.name, reason: "未パブリッシュのローカルコンポーネント" });
        continue;
      }

      let latest: ComponentNode;
      try {
        latest = await importComponentWithRetry(main.key);
      } catch {
        post({
          type: "scan-item-excluded",
          name: inst.name,
          reason: main.remote ? "最新コンポーネントの取得に失敗" : "未パブリッシュのローカルコンポーネント",
        });
        continue;
      }

      if (latest.id === main.id) {
        post({ type: "scan-item-excluded", name: inst.name, reason: "既に最新版を参照" });
        continue;
      }

      if (scanCancelled) break;

      store.set(inst.id, { instance: inst, latestKey: main.key, source: "update" });
      await computeAndSendDiff(inst, latest, "scan-item-result", main.name);
    } catch {
      // The instance (or its parent) was likely deleted/moved by the user
      // while this scan was mid-flight. Skip it and keep going rather than
      // losing the rest of the scan's progress.
      store.delete(inst.id);
      post({ type: "scan-item-excluded", name: inst.name, reason: "比較中にエラーが発生しました（編集された可能性があります）" });
    }

    figma.commitUndo();
    await maybeYieldScan(yieldCounter);
  }

  post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
}

async function computeAndSendDiff(
  inst: InstanceNode,
  latest: ComponentNode,
  resultType: string,
  mainComponentName: string
): Promise<void> {
  const beforeWidth = inst.width;
  const beforeHeight = inst.height;
  // 等倍で書き出す。2倍スケールにする明確な理由が残っておらず（当初の
  // 試作からの既定値）、pixelmatchは渡した解像度でピクセル差分を検出できる
  // ため2倍でなくても実用上問題ない。多数のインスタンスをスキャンすると
  // Before/After画像がbase64で保持され続けるため、解像度は直接メモリ使用量
  // （ひいてはFigmaクライアントのクラッシュリスク）に効いてくる。
  const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });

  // 比較用クローンの置き場所の変遷:
  //   1. ページ直下に逃がす — 軽いが、親のDay/Night等の変数モードを継承
  //      できず誤差分の原因になっていた。
  //   2. inst.resolvedVariableModesを使い捨てアンカーフレームに明示複製 —
  //      変数モードのAPI解決自体は通っていたはずだが、実機で「見た目は
  //      Figma純正の比較用インスタンス配置（＝実際の親に挿入）とは異なる
  //      誤差分」が実際に見つかった。Auto Layoutのfill containerサイジング
  //      など、変数モード以外にも実際の親階層でしか再現できない要因がある
  //      ため、近似では不十分と判断。
  //   3. 現在: 実際の親の直下・同じ位置に挿入する（比較用インスタンスを
  //      配置＝placeLatestOneと同じ考え方で、そちらは実機で正しい結果を
  //      出している）。ページ規模のスキャンで大量のインスタンスに対して
  //      繰り返すとFigmaクライアントが不安定になった実害があったため、
  //      呼び出し元のスキャンループ側で一定件数ごとにイベントループへ制御を
  //      返す形で緩和している（§runScan/handleScanSwap参照）。
  //      layoutPositioning="ABSOLUTE"は使わない（非Auto Layout親で例外に
  //      なる上、fill containerサイジングの再現も失われるため）ので、
  //      Auto Layout親では完全な重なりまでは保証しない。
  const clone = inst.clone();
  clone.name = `${inst.name} (diff candidate)`;
  const parent = inst.parent;
  if (parent && "insertChild" in parent) {
    const originalIndex = parent.children.indexOf(inst);
    parent.insertChild(originalIndex + 1, clone);
    clone.x = inst.x;
    clone.y = inst.y;
  } else {
    // 親が取得できない/挿入不可な稀なケースのみ、ページ直下に逃がす。
    (findOwningPage(inst) ?? figma.currentPage).appendChild(clone);
    clone.x = 0;
    clone.y = 0;
  }
  clone.swapComponent(latest);

  const sizeChanged = beforeWidth !== clone.width || beforeHeight !== clone.height;

  try {
    // Deliberately left visible=true: exportAsync() on a hidden node has
    // been reported to sometimes render a blank/transparent image, which
    // would make every "after" image a spurious diff. Exported even when
    // sizeChanged, so the UI can still show Current/Latest side by side
    // for that case.
    const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    post({
      type: resultType,
      id: inst.id,
      name: inst.name,
      mainComponentName,
      width: beforeWidth,
      height: beforeHeight,
      sizeChanged,
      before: beforeBytes,
      after: afterBytes,
    });
  } finally {
    // Guaranteed even if exportAsync throws above — otherwise a failed
    // export would leave this "(diff candidate)" node stranded on the
    // canvas instead of just excluding the instance from results.
    clone.remove();
  }
}

// ---- 更新（見た目差分なし・および「このまま更新」） -----------------------
//
// Both the plain 更新 flow (見た目差分なしタブ) and このまま更新
// (見た目差分ありタブ, ignoring a known diff) end up calling exactly this
// same code — the write itself doesn't know or care which tab the id came
// from, only ui.ts's confirmation flow differs. If that row had a
// Latest-preview wrapper placed on it, whether to also clean it up is the
// caller's choice (the confirm dialog's "配置中の比較用インスタンスを削除する"
// checkbox) rather than automatic — `removeLatest` defaults to true so
// the 見た目差分なしタブ's plain apply path (which never has a wrapper
// to begin with, and never sends this flag) behaves the same as before.

function cleanupWrapper(id: string): void {
  const wrapper = wrapperStore.get(id);
  if (wrapper) {
    wrapper.remove();
    wrapperStore.delete(id);
  }
}

async function handleApply(id: string, jump?: boolean, removeLatest?: boolean): Promise<void> {
  const item = store.get(id);
  if (!item) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  // For individual "このまま更新" only: jump before the write so the user
  // sees what they're about to affect, not just what they just affected.
  if (jump) await jumpToNode(item.instance);

  // スキャン時に解決したComponentNodeをそのまま使い回さず、適用の直前に毎回
  // キーで取り直す（§StoredItem.latestKeyのコメント参照）。
  let latest: ComponentNode;
  try {
    latest = await importComponentWithRetry(item.latestKey);
  } catch {
    postError(`最新コンポーネントの取得に失敗しました: ${item.instance.name}`);
    return;
  }

  // The one line that matters most for this whole project: swap in-place,
  // same node id, so anything (e.g. a FigJam arrow) that references this
  // node keeps working.
  item.instance.swapComponent(latest);
  if (removeLatest !== false) cleanupWrapper(id);
  figma.commitUndo();
  post({ type: item.source === "swap" ? "swap-applied" : "applied", id });
}

async function handleApplyBulk(ids: string[], removeLatest?: boolean): Promise<void> {
  const succeeded: string[] = [];
  // 一括操作は必ず1つのモードのチェック済み行から来るので、先頭のsourceで
  // 完了メッセージの種別を決めて問題ない（進捗メッセージは念のため毎回そのitem
  // 自身のsourceを見る）。
  let bulkSource: StoreSource = "update";
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (!item) continue;
    bulkSource = item.source;
    post({
      type: item.source === "swap" ? "swap-apply-bulk-progress" : "apply-bulk-progress",
      name: item.instance.name,
      index: i + 1,
      total: ids.length,
    });
    // importComponentWithRetryがキャッシュ済みキーに対してはマイクロタスクだけで
    // 解決してしまうことがあり、その場合ループ全体が1つのマクロタスク内で完結して
    // ブラウザに描画の機会を一度も与えず、プログレスバーが動いて見えない
    // （最後の状態にしか見えない）実害があった。1件ごとに明示的にイベントループへ
    // 制御を返し、進捗の各ステップが確実に1フレームは描画されるようにする。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      const latest = await importComponentWithRetry(item.latestKey);
      item.instance.swapComponent(latest);
      if (removeLatest !== false) cleanupWrapper(ids[i]);
      succeeded.push(ids[i]);
    } catch {
      postError(`更新に失敗しました: ${item.instance.name}`);
    }
  }
  figma.commitUndo();
  post({ type: bulkSource === "swap" ? "swap-apply-bulk-done" : "apply-bulk-done", ids: succeeded });
}

// ---- 比較用インスタンスを配置（見た目差分あり） ------------------------------
//
// Places the Latest instance exactly on top of Current (same x/y, next
// sibling so it renders above), wrapped in a frame that carries a thick
// magenta outline. Wrapping (rather than styling the instance directly)
// keeps the instance's own appearance undistorted — important since this
// is meant to preview exactly what an update would look like — and gives
// the toggle button a single node to show/hide.

async function placeLatestOne(id: string): Promise<boolean> {
  if (wrapperStore.has(id)) return true; // already placed — don't duplicate
  const item = store.get(id);
  if (!item) return false;
  const inst = item.instance;
  const parent = inst.parent;
  if (!parent || !("insertChild" in parent)) return false;

  // スキャン時のComponentNodeを使い回さず、配置の直前に毎回キーで取り直す
  // （§StoredItem.latestKeyのコメント参照）。ここで投げた例外は呼び出し元
  // （handlePlaceLatest/handlePlaceLatestBulk）のtry節で拾われず、外側の
  // figma.ui.onmessageまで伝播してpostErrorされる — 「対象が見つかりません」
  // ではなく実際のエラー内容がそのままUIに出る。
  const latest = await importComponentWithRetry(item.latestKey);

  const wrapper = figma.createFrame();
  wrapper.name = `⚠ Latest Preview — ${inst.name}`;
  wrapper.x = inst.x;
  wrapper.y = inst.y;
  wrapper.resize(inst.width, inst.height);
  wrapper.fills = [];
  wrapper.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }]; // #FF00FF
  wrapper.strokeWeight = 20;
  wrapper.strokeAlign = "OUTSIDE";
  wrapper.locked = true;

  const originalIndex = parent.children.indexOf(inst);
  parent.insertChild(originalIndex + 1, wrapper);

  // 親がAuto Layoutだと、挿入した瞬間にwrapperがそのままフローに乗ってしまい、
  // 上で設定した手動x/yが上書きされて元インスタンスの脇に配置されてしまう。
  // wrapperはinstの現在のwidth/heightをそのままコピーした固定サイズの箱
  // （§上のresize呼び出し）でしかないので、フローから外してもFILL等のサイジング
  // 計算には一切影響しない — 安全に手動配置へ戻せる。
  const layoutParent = parent as unknown as { layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" };
  if (layoutParent.layoutMode && layoutParent.layoutMode !== "NONE") {
    wrapper.layoutPositioning = "ABSOLUTE";
    wrapper.x = inst.x;
    wrapper.y = inst.y;
  }

  const clone = inst.clone();
  clone.swapComponent(latest);
  wrapper.appendChild(clone);
  clone.x = 0;
  clone.y = 0;

  wrapperStore.set(id, wrapper);
  return true;
}

async function handlePlaceLatest(id: string): Promise<void> {
  // Individual placement (unlike bulk) jumps the canvas first, before the
  // wrapper even exists — Current's position is exactly where the wrapper
  // will land, so there's no need to wait for placement to finish.
  const item = store.get(id);
  if (item) await jumpToNode(item.instance);

  const ok = await placeLatestOne(id);
  if (!ok) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  figma.commitUndo();
  post({ type: item?.source === "swap" ? "swap-latest-placed" : "latest-placed", id });
}

async function handlePlaceLatestBulk(ids: string[]): Promise<void> {
  const succeeded: string[] = [];
  let bulkSource: StoreSource = "update";
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (item) {
      bulkSource = item.source;
      post({
        type: item.source === "swap" ? "swap-place-latest-bulk-progress" : "place-latest-bulk-progress",
        name: item.instance.name,
        index: i + 1,
        total: ids.length,
      });
    }
    // §handleApplyBulkと同じ理由でイベントループへ明示的に制御を返す。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      if (await placeLatestOne(ids[i])) succeeded.push(ids[i]);
    } catch {
      // 1件の最新コンポーネント再取得失敗で一括処理全体を止めない（§handleApplyBulk
      // と同じ考え方）。
      postError(`比較用インスタンスの配置に失敗しました: ${item?.instance.name ?? ids[i]}`);
    }
  }
  figma.commitUndo();
  post({ type: bulkSource === "swap" ? "swap-place-latest-bulk-done" : "place-latest-bulk-done", ids: succeeded });
}

// Individual "比較用インスタンスを削除" — removes just the named row's wrapper, as
// opposed to handleClearMarkers() which sweeps every tagged node on every
// page regardless of selection (the bulk footer button now just triggers
// that same full sweep, labeled "比較用インスタンスをすべて削除", rather than a
// separate selection-scoped variant — the two used to overlap in purpose).
// The row reverts to showing the "比較用インスタンスを配置" button again (ui.ts
// infers this from the wrapper's absence, same as after handleClearMarkers).

async function handleRemoveLatest(id: string): Promise<void> {
  if (!wrapperStore.has(id)) return;
  const source = store.get(id)?.source;
  cleanupWrapper(id);
  figma.commitUndo();
  post({ type: source === "swap" ? "swap-latest-removed" : "latest-removed", id });
}

function handleToggleLatest(id: string): void {
  const wrapper = wrapperStore.get(id);
  if (!wrapper) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  wrapper.visible = !wrapper.visible;
  figma.commitUndo();
  const source = store.get(id)?.source;
  post({ type: source === "swap" ? "swap-latest-toggled" : "latest-toggled", id, visible: wrapper.visible });
}

// 「すべて削除」ボタン押下時、実際に削除する前に件数を確認モーダルで見せる
// ための問い合わせ専用ハンドラ（削除はしない）。
async function handleCountMarkers(): Promise<void> {
  const nodes = await findAllMarkerFrames();
  post({ type: "marker-clear-count", count: nodes.length });
}

async function handleClearMarkers(): Promise<void> {
  const nodes = await findAllMarkerFrames();
  const count = nodes.length;
  for (const n of nodes) n.remove();
  // Rows whose wrapper we just deleted need to revert to the "not placed"
  // state (place button re-enabled, eye button greyed out again) rather
  // than staying stuck showing a toggle for a wrapper that no longer
  // exists. Only handled for plugin-initiated deletion (this action) —
  // detecting a wrapper deleted manually via the canvas is out of scope.
  const clearedIds = Array.from(wrapperStore.keys());
  wrapperStore.clear();
  figma.commitUndo();
  post({ type: "markers-cleared", count, ids: clearedIds });
}

// ---- ライブラリスキャン（スワップ先ライブラリの公開コンポーネントリストの作成） -------------
//
// 実行するファイル自体が「スワップ先の新しいライブラリ」であるという前提で、
// 全ページを走査してComponent/ComponentSetを収集し、name/key/バリアント構成
// をまとめたJSONを作る。Component/ComponentSetの実体をインポートするのは
// ここでは一切行わない（importComponentByKeyAsyncは大量呼び出し時に不安定と
// いう報告があるため、実際にマッチした分だけスワップ実行側で都度インポート
// する設計。§Spec.md参照）。

interface LibraryComponentEntry {
  name: string;
  key: string;
  path: string; // デバッグ用: ページ名からのレイヤーパス（何を数えてしまっているか調査するため。§診断参照）
}

interface LibraryComponentSetEntry {
  name: string;
  key: string;
  path: string; // デバッグ用: 同上
  variantProps: Record<string, string[]>;
  children: { key: string; variantProperties: Record<string, string> }[];
  defaultVariantKey: string; // Figma標準のライブラリスワップに寄せた「デフォルトバリアントへの差し替え」用（§resolveSwapTarget参照）
}

interface LibraryScanData {
  libraryName: string;
  exportedAt: string;
  components: LibraryComponentEntry[];
  componentSets: LibraryComponentSetEntry[];
  skipped: { name: string; path: string; reason: string }[];
  coverThumbnail?: string; // data URL。ui.ts側でbytesから変換して埋め込む（§handleScanLibrary参照）
}

// デバッグ用: 「ページ名 / 親フレーム名 / ... / ノード名」の形でレイヤーパスを
// 組み立てる。想定外に大量カウントされている原因を、名前だけでなく所在（どの
// ページ・どの階層にあるか）まで見えるようにして調査するためのもの。
function nodePath(node: BaseNode): string {
  const parts: string[] = [];
  let p: BaseNode | null = node;
  while (p && p.type !== "DOCUMENT") {
    parts.unshift(p.name);
    p = p.parent;
  }
  return parts.join(" / ");
}

async function handleScanLibrary(): Promise<void> {
  libraryScanCancelled = false;
  const components: LibraryComponentEntry[] = [];
  const componentSets: LibraryComponentSetEntry[] = [];
  // Figma自体が内部検証エラー（バリアント重複など）を抱えていると判断した
  // コンポーネントセットは、variantGroupProperties等へのアクセスで例外を
  // 投げる。1件のノード単体の異常でスキャン全体を巻き込まないよう個別に
  // スキップし、最終的にユーザーへその件数と理由を報告する（黙って件数が
  // 減っているとAnalyticsの公開コンポーネント数と食い違う原因になるため）。
  const skipped: { name: string; path: string; reason: string }[] = [];

  // Figmaには「このファイルにPublish済みコンポーネントが何件あるか」を事前に
  // 一発で返すAPIが無い（Web版Analyticsのような集計は取れない）ので、ファイル
  // 全体を分母にした単一の%は組めない。実測すると、探索フェーズ（後述）が
  // スキャン時間の9割以上を占めることがわかった — つまり「今のページの
  // コンポーネント候補数」という分母自体が判明する頃には、ほぼ処理が終わって
  // いる。分母は正確でも、それが判明するタイミングが遅すぎてゲージとして
  // 意味を成していなかった。
  //
  //   上段 = スキャン済みページ数 / 全ページ数（figma.root.children.lengthで
  //          最初から判明済み・そのまま維持）
  //   下段 = 探索フェーズの間は「これまでに確認したノード数」という伸びる
  //          カウンタ（分母は不明なので不確定進捗として表示）。候補が
  //          確定してPublish状態を確認するフェーズに入ったら、従来通り
  //          確認済み/このページの候補数という実際の%表示に切り替わる。
  const BATCH_SIZE = 30;
  const pages = figma.root.children;
  const totalPages = pages.length;
  let pagesCompleted = 0;

  // pages.lengthは同期で確定済みなので、ループに入る前に一度送っておく。
  post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned: 0, pageTotal: 0 });

  // Figma純正のfindAllWithCriteria単発呼び出しは完全に同期・ノンストップで、
  // 呼び出し中は一切進捗を出せずキャンセルも効かない。代わりに自前でノードを
  // 1つずつ再帰的に訪問し、一定件数ごとに一度setTimeout(0)でイベントループに
  // 制御を返す。これにより (a) 訪問済みノード数を都度UIに送れる、(b) 巨大な
  // ページの途中でもキャンセルが効くようになる、の両方が同時に手に入る。
  // Component/ComponentSetに当たった時点でそれ以上潜らない（内部のバリアント
  // や入れ子アイコン用ComponentSet等を独立資産として二重に数えないため —
  // 以前のhasComponentAncestorフィルタと同じ効果を、探索しないことで実現）。
  // Instanceの内部も潜らない（本物のComponent/ComponentSet定義がInstance内に
  // 現れることは無く、必ずNested Instanceとして表現されるため、潜っても
  // 絶対に見つからない — 無駄な探索を削るだけの最適化）。
  let nodesVisited = 0;
  let sinceYield = 0;
  const YIELD_EVERY = 250;

  async function walk(node: SceneNode, out: (ComponentNode | ComponentSetNode)[]): Promise<void> {
    if (libraryScanCancelled) return;
    nodesVisited++;
    sinceYield++;
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      post({ type: "library-scan-walk-progress", pagesCompleted, totalPages, nodesVisited });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      out.push(node);
      return;
    }
    if (node.type === "INSTANCE") return;
    if ("children" in node) {
      for (const child of (node as unknown as ChildrenMixin).children) {
        if (libraryScanCancelled) return;
        await walk(child as SceneNode, out);
      }
    }
  }

  for (const page of pages) {
    if (libraryScanCancelled) break;

    await page.loadAsync();
    const candidates: (ComponentNode | ComponentSetNode)[] = [];
    for (const child of page.children) {
      if (libraryScanCancelled) break;
      await walk(child, candidates);
    }
    if (libraryScanCancelled) break;

    let pageScanned = 0;
    post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned, pageTotal: candidates.length });

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      if (libraryScanCancelled) break;

      const batch = candidates.slice(i, i + BATCH_SIZE);
      const statuses = await Promise.all(batch.map((node) => node.getPublishStatusAsync()));

      batch.forEach((node, idx) => {
        // Publish対象のコンポーネントを組み立てるための未公開ベースコンポーネント
        // （そのファイル内でしか使わないローカル部品）を除外する。CURRENT/CHANGEDは
        // 公開済み（CHANGEDは公開後にローカルで変更がある状態）なので対象に含める。
        if (statuses[idx] === "UNPUBLISHED") return;

        try {
          if (node.type === "COMPONENT_SET") {
            // variantGroupPropertiesは、そのコンポーネントセット自体がFigma内部の
            // 検証エラーを抱えている（例:バリアントの重複等、Figma上で赤い警告が
            // 出ている状態）場合に例外を投げる。1件のノード単体の異常でスキャン
            // 全体を巻き込まないよう、ここだけ個別に握りつぶしてスキップする。
            const variantProps: Record<string, string[]> = {};
            for (const [prop, info] of Object.entries(node.variantGroupProperties)) {
              variantProps[prop] = info.values;
            }
            componentSets.push({
              name: node.name,
              key: node.key,
              path: nodePath(node),
              variantProps,
              children: node.children
                .filter((c): c is ComponentNode => c.type === "COMPONENT")
                .map((c) => ({ key: c.key, variantProperties: c.variantProperties ?? {} })),
              defaultVariantKey: node.defaultVariant.key,
            });
          } else if (node.type === "COMPONENT") {
            components.push({ name: node.name, key: node.key, path: nodePath(node) });
          }
        } catch (err) {
          skipped.push({ name: node.name, path: nodePath(node), reason: String(err) });
        }
      });

      pageScanned += batch.length;
      post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned, pageTotal: candidates.length });
    }

    if (libraryScanCancelled) break;

    pagesCompleted++;
    post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned: candidates.length, pageTotal: candidates.length });
  }

  if (libraryScanCancelled) {
    post({ type: "library-scan-cancelled" });
    return;
  }

  const data: LibraryScanData = {
    libraryName: figma.root.name,
    exportedAt: new Date().toISOString(),
    components,
    componentSets,
    skipped,
  };

  // このファイルに「ファイルのサムネイル」として明示的に指定されたノードが
  // あれば、その実画像をカバーアートとしてui.ts側に渡す（Figmaのファイル
  // ブラウザに出る自動生成サムネイルそのものはPlugin APIから取得できないので、
  // 代替としてこれを使う。指定がなければnullが返り、カバーなしになる）。
  let coverThumbnail: Uint8Array | undefined;
  try {
    const thumbNode = await figma.getFileThumbnailNodeAsync();
    if (thumbNode) {
      coverThumbnail = await thumbNode.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 64 } });
    }
  } catch {
    // カバー画像は無くても致命的ではないので、取得失敗時は単に付けない
  }

  post({ type: "library-scan-done", data, coverThumbnail });
}

// ---- ライブラリスワップ（貼り付けられた対応表との名前/バリアントマッチング） ----
//
// Figma純正の「Swap library」機能は名前のみでコンポーネント/スタイルを
// マッチングし、見つからなければそのまま元のライブラリに繋がったまま残す
// （help.figma.comで確認済み）。ここでもそれに倣い、名前一致（＋バリアント
// セットの場合はプロパティの組み合わせ一致）だけで解決する。実機確認の結果、
// Figma純正のライブラリスワップはセット名が一致してバリアントの組み合わせが
// 見つからない場合、そのセットの「デフォルトバリアント」へ差し替えることが
// わかった。ここでも同じ考え方に寄せ、一致しないものを一律「迷子」にはせず、
// デフォルトバリアントを暫定の差し替え先として提示する（variantFallback:
// true）。ただし自動選択である以上、必ず見た目差分あり同様のプレビュー確認を
// 経てから明示的に実行してもらう（§ui.ts バリアント不一致タブ参照）。
// 完全に名前が一致しない場合のみ、一切書き換えず「迷子」として除外する。

type SwapMatchResult =
  | { key: string }
  | { key: string; variantFallback: true }
  | { reason: string; category: "name" | "variant" };

function variantPropsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

function resolveSwapTarget(
  matchName: string,
  isSet: boolean,
  currentVariantProperties: Record<string, string> | null,
  nameToComponent: Map<string, LibraryComponentEntry>,
  nameToSet: Map<string, LibraryComponentSetEntry>
): SwapMatchResult {
  if (isSet) {
    const set = nameToSet.get(matchName);
    if (!set) {
      return { reason: "名前が一致するコンポーネントが見つかりません", category: "name" };
    }
    const current = currentVariantProperties ?? {};
    const child = set.children.find((c) => variantPropsEqual(c.variantProperties, current));
    if (!child) {
      // 古いキャッシュ済みJSON（defaultVariantKeyが無い版でスキャンした対応表）
      // との後方互換として、無ければ従来通り「迷子」に落とす。
      if (set.defaultVariantKey) {
        return { key: set.defaultVariantKey, variantFallback: true };
      }
      const desc = Object.entries(current)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return {
        reason: `「${matchName}」は見つかりましたが、バリアントの組み合わせ（${desc}）が新ライブラリにありません`,
        category: "variant",
      };
    }
    return { key: child.key };
  }
  const comp = nameToComponent.get(matchName);
  if (!comp) {
    return { reason: "名前が一致するコンポーネントが見つかりません", category: "name" };
  }
  return { key: comp.key };
}

async function handleScanSwap(scope: ScopeMode, mappings: LibraryScanData[]): Promise<void> {
  // runScan（更新モード）はstore.clear()から始まるが、こちらは無かった —
  // 別モードへの切り替え時にui.ts側の表示はリセットされてもcode.ts側のstore
  // には前のスキャンのエントリが残り得た（同じidが再度マッチすれば上書きされて
  // 実害は無いが、マッチしなかった分は不要になったエントリとしてメモリに
  // 残り続ける）。スキャンごとに必ずクリーンな状態から始める。
  store.clear();
  swapScanCancelled = false;

  // 複数ライブラリを一度に追加できる。名前が衝突した場合は「先に追加した方」が
  // 優先されるよう、既にキーが入っていたら上書きしない（mappingsは追加順の配列）。
  const nameToComponent = new Map<string, LibraryComponentEntry>();
  const nameToSet = new Map<string, LibraryComponentSetEntry>();
  for (const mapping of mappings) {
    for (const c of mapping.components) {
      if (!nameToComponent.has(c.name)) nameToComponent.set(c.name, c);
    }
    for (const s of mapping.componentSets) {
      if (!nameToSet.has(s.name)) nameToSet.set(s.name, s);
    }
  }

  // 迷子は同名・同理由のインスタンスが大量に並びがち（ui.ts側で名前＋理由単位に
  // まとめて表示する）。サムネイルもグループにつき1回だけ取得すれば十分なので、
  // 既にサムネイルを送った組み合わせはスキップする（クローンもスワップも伴わない
  // ただのexportAsyncなので、差分計算に比べて軽く、安全＝キャンバスに何も残さない）。
  const swapStrayThumbnailSent = new Set<string>();

  async function postSwapExcluded(
    inst: InstanceNode,
    reason: string,
    category: "name" | "variant" | "other"
  ): Promise<void> {
    const groupKey = `${inst.name} ${reason}`;
    let thumbnail: Uint8Array | undefined;
    if (!swapStrayThumbnailSent.has(groupKey)) {
      swapStrayThumbnailSent.add(groupKey);
      try {
        thumbnail = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
      } catch {
        // サムネイル取得に失敗しても除外自体は続行する（見た目確認ができないだけ）
      }
    }
    post({ type: "swap-scan-item-excluded", id: inst.id, name: inst.name, path: nodePath(inst), reason, category, thumbnail });
  }

  const targets = await collectTargets(scope);
  post({ type: "swap-scan-started", total: targets.length });

  const yieldCounter = { value: 0 };
  for (const inst of targets) {
    if (swapScanCancelled) break;

    try {
      let main: ComponentNode | null;
      try {
        main = await inst.getMainComponentAsync();
      } catch {
        main = null;
      }

      if (!main) {
        await postSwapExcluded(inst, "未パブリッシュのローカルコンポーネント", "other");
        continue;
      }

      const parent = main.parent;
      const isSet = parent !== null && parent.type === "COMPONENT_SET";
      const matchName = isSet ? (parent as ComponentSetNode).name : main.name;

      const result = resolveSwapTarget(matchName, isSet, inst.variantProperties, nameToComponent, nameToSet);
      if ("reason" in result) {
        await postSwapExcluded(inst, result.reason, result.category);
        continue;
      }

      let target: ComponentNode;
      try {
        target = await importComponentWithRetry(result.key);
      } catch {
        await postSwapExcluded(inst, "対応するコンポーネントの取得に失敗しました", "other");
        continue;
      }

      // 既にこのキーを参照している＝スワップしても何も変わらない。更新フロー側の
      // 「既に最新版を参照」（§runScan）と同じ扱いにする — 見た目差分なしタブの
      // チェック対象には含めず、対象外・スワップなしとして別枠で見せるだけにする。
      if (target.key === main.key) {
        post({ type: "swap-scan-item-already-latest", name: inst.name });
        continue;
      }

      if (swapScanCancelled) break;

      store.set(inst.id, { instance: inst, latestKey: result.key, source: "swap" });
      const resultType = "variantFallback" in result ? "swap-scan-item-variant-result" : "swap-scan-item-result";
      await computeAndSendDiff(inst, target, resultType, matchName);
    } catch {
      store.delete(inst.id);
      await postSwapExcluded(inst, "比較中にエラーが発生しました（編集された可能性があります）", "other");
    }

    figma.commitUndo();
    await maybeYieldScan(yieldCounter);
  }

  post({ type: swapScanCancelled ? "swap-scan-cancelled" : "swap-scan-done" });
}

// ---- キャンバスでジャンプ -----------------------------------------------

function findOwningPage(node: BaseNode): PageNode | null {
  let p: BaseNode = node;
  while (p.parent && p.parent.type !== "DOCUMENT") p = p.parent;
  return p.type === "PAGE" ? (p as PageNode) : null;
}

async function jumpToNode(node: SceneNode): Promise<void> {
  const page = findOwningPage(node);
  // manifestを"documentAccess":"dynamic-page"にした都合上、figma.currentPage
  // への直接代入（同期セッター）はもう使えない（例外を投げる）。読み取りは
  // 問題ないので、変更にだけこちらを使う。
  if (page) await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

// storeに載っていない（＝マッチしなかった「迷子」）インスタンスにもジャンプできる
// よう、storeを経由せずノードIDから直接引く。マッチ済みのインスタンスに対しても
// 同じように動く（storeに入っているinstanceと同一ノードを指すため）。
async function handleJump(id: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("type" in node)) return;
  if (node.type === "DOCUMENT" || node.type === "PAGE") return;
  await jumpToNode(node as SceneNode);
}

// ---- キャンバス上で複数選択（「すべてのインスタンスを選択」） -------------------
//
// 意図的に他のハンドラから独立させた小さな機能。UIのチェックボックス選択とは
// 無関係で、渡されたidをそのままfigma.currentPage.selectionに反映するだけ。
// 将来的に不要と判断されたら、この関数とメッセージ種別を消すだけで撤去できる
// ようにしている（store/wrapperStore等、他の状態には一切触れない）。
async function handleSelectOnCanvas(ids: string[]): Promise<void> {
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && "type" in node && node.type !== "DOCUMENT" && node.type !== "PAGE") nodes.push(node as SceneNode);
  }
  if (!nodes.length) return;

  const onCurrentPage = nodes.filter((n) => findOwningPage(n)?.id === figma.currentPage.id);
  if (onCurrentPage.length) {
    figma.currentPage.selection = onCurrentPage;
    figma.viewport.scrollAndZoomIntoView(onCurrentPage);
    return;
  }

  // 現在のページに対象が無ければ、対象を含む最初のページへ一回だけ移動する。
  const firstPage = findOwningPage(nodes[0]);
  if (!firstPage) return;
  await figma.setCurrentPageAsync(firstPage);
  const onFirstPage = nodes.filter((n) => findOwningPage(n)?.id === firstPage.id);
  figma.currentPage.selection = onFirstPage;
  figma.viewport.scrollAndZoomIntoView(onFirstPage);
}

// ---- メッセージルーティング ---------------------------------------------

interface IncomingMessage {
  type: string;
  scope?: ScopeMode;
  id?: string;
  ids?: string[];
  jump?: boolean;
  removeLatest?: boolean;
  mappings?: LibraryScanData[];
  raws?: string[];
}

figma.ui.onmessage = async (msg: IncomingMessage) => {
  try {
    switch (msg.type) {
      case "scan":
        if (msg.scope) await runScan(msg.scope);
        break;
      case "cancel-scan":
        scanCancelled = true;
        break;
      case "apply":
        if (msg.id) await handleApply(msg.id, msg.jump, msg.removeLatest);
        break;
      case "apply-bulk":
        if (msg.ids) await handleApplyBulk(msg.ids, msg.removeLatest);
        break;
      case "place-latest":
        if (msg.id) await handlePlaceLatest(msg.id);
        break;
      case "place-latest-bulk":
        if (msg.ids) await handlePlaceLatestBulk(msg.ids);
        break;
      case "toggle-latest":
        if (msg.id) handleToggleLatest(msg.id);
        break;
      case "remove-latest":
        if (msg.id) await handleRemoveLatest(msg.id);
        break;
      case "jump":
        if (msg.id) await handleJump(msg.id);
        break;
      case "select-on-canvas":
        if (msg.ids) await handleSelectOnCanvas(msg.ids);
        break;
      case "count-markers":
        await handleCountMarkers();
        break;
      case "clear-markers":
        await handleClearMarkers();
        break;
      case "scan-library":
        await handleScanLibrary();
        break;
      case "cancel-library-scan":
        libraryScanCancelled = true;
        break;
      case "scan-swap":
        if (msg.scope && msg.mappings) await handleScanSwap(msg.scope, msg.mappings);
        break;
      case "cancel-swap-scan":
        swapScanCancelled = true;
        break;
      case "save-swap-mapping-cache":
        if (Array.isArray(msg.raws)) await figma.clientStorage.setAsync(SWAP_MAPPING_CACHE_KEY, msg.raws);
        break;
    }
  } catch (err) {
    postError(String(err));
  }
};
