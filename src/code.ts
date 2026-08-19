// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable, one commitUndo per item so a concurrent
// user undo can't reach further back than the item in flight), individual
// + bulk update for 見た目差分なし items (also reused for "このまま更新" on
// 見た目差分あり items — the write is identical either way), and a
// per-instance "比較用インスタンスを配置" overlay comparison tool (place a
// Latest-preview directly on top of Current, toggle it show/hide, or
// remove it individually) with a pluginData-tagged full-sweep cleanup
// utility ("比較用インスタンスをすべて削除").
//
// Classification (clean vs diff) happens in ui.ts, not here — this side
// only ever needs to know "which instance" via id, never "is it clean".
// See §6.4 for why: pixelmatch requires Canvas, which only the UI iframe
// has.

figma.showUI(__html__, { width: 420, height: 660 });

// ---- スワップ先ライブラリの公開リストの記憶（プラグイン再起動をまたいで保持） ----
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
  latestComponent: ComponentNode;
  source: StoreSource;
}

const store = new Map<string, StoredItem>();
// Latest-preview wrapper frames currently placed on top of Current,
// keyed by the original instance's id. Cleaned up on apply/force-update
// so a resolved row never leaves a redundant overlay behind.
const wrapperStore = new Map<string, FrameNode>();
let scanCancelled = false;
let swapScanCancelled = false;

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

// ---- Latest-preview wrapper discovery (setPluginData-tagged) -------------

const ROLE_KEY = "update-diff-guard-role";
const ROLE_VALUE = "latest-preview";

function isTaggedNode(node: BaseNode): node is SceneNode {
  if (!("getPluginData" in node)) return false;
  return (node as SceneNode).getPluginData(ROLE_KEY) === ROLE_VALUE;
}

function collectTaggedNodes(node: BaseNode, out: SceneNode[]): void {
  if (isTaggedNode(node)) {
    out.push(node as SceneNode);
    return; // our own wrapper's contents never contain further tagged nodes
  }
  if ("children" in node) {
    for (const child of (node as unknown as ChildrenMixin).children) collectTaggedNodes(child, out);
  }
}

async function findAllTaggedNodes(): Promise<SceneNode[]> {
  const found: SceneNode[] = [];
  for (const page of figma.root.children) {
    await page.loadAsync();
    collectTaggedNodes(page, found);
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

async function runScan(scope: ScopeMode): Promise<void> {
  store.clear();
  scanCancelled = false;

  const targets = await collectTargets(scope);
  post({ type: "scan-started", total: targets.length });

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

      store.set(inst.id, { instance: inst, latestComponent: latest, source: "update" });
      await computeAndSendDiff(inst, latest, "scan-item-result");
    } catch {
      // The instance (or its parent) was likely deleted/moved by the user
      // while this scan was mid-flight. Skip it and keep going rather than
      // losing the rest of the scan's progress.
      store.delete(inst.id);
      post({ type: "scan-item-excluded", name: inst.name, reason: "比較中にエラーが発生しました（編集された可能性があります）" });
    }

    figma.commitUndo();
  }

  post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function computeAndSendDiff(inst: InstanceNode, latest: ComponentNode, resultType: string): Promise<void> {
  const beforeWidth = inst.width;
  const beforeHeight = inst.height;
  const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });

  // 比較用クローンは実際の親の直下・同じ位置に挿入する（比較用インスタンスを
  // 配置＝placeLatestOneと同じ考え方）。かつて「ページ直下に逃がす」方式に
  // 変えたのは、同一親+一致するx/yを試したときAuto Layout親でレイアウトが
  // 動いて見えた／layoutPositioning="ABSOLUTE"を足したら非Auto Layout親で
  // 例外、という2つの実害があったため。ただし実際の親から切り離すと、親や
  // インスタンス自身に設定された変数モード（Day/Night・画面サイズ等）が継承
  // されず、それが原因の誤差分／見逃しが起きていた。要件（実アピアランスの
  // 再現）と処理速度を優先し、レイアウトが一瞬動いて見えることは許容した上で
  // 実際の親に戻す。layoutPositioning="ABSOLUTE"は使わない（非Auto Layout親
  // で例外になるため）ので、Auto Layout親では完全な重なりまでは保証しない。
  const clone = inst.clone();
  clone.name = `${inst.name} (diff candidate)`;
  const parent = inst.parent;
  if (parent && "insertChild" in parent) {
    const originalIndex = parent.children.indexOf(inst);
    parent.insertChild(originalIndex + 1, clone);
    clone.x = inst.x;
    clone.y = inst.y;
  } else {
    // 親が取得できない/挿入不可な稀なケースのみ、従来通りページ直下に逃がす。
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
    const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    post({
      type: resultType,
      id: inst.id,
      name: inst.name,
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
  if (jump) jumpToNode(item.instance);
  // The one line that matters most for this whole project: swap in-place,
  // same node id, so anything (e.g. a FigJam arrow) that references this
  // node keeps working.
  item.instance.swapComponent(item.latestComponent);
  if (removeLatest !== false) cleanupWrapper(id);
  figma.commitUndo();
  post({ type: item.source === "swap" ? "swap-applied" : "applied", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
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
    try {
      item.instance.swapComponent(item.latestComponent);
      if (removeLatest !== false) cleanupWrapper(ids[i]);
      succeeded.push(ids[i]);
    } catch {
      postError(`更新に失敗しました: ${item.instance.name}`);
    }
  }
  figma.commitUndo();
  post({ type: bulkSource === "swap" ? "swap-apply-bulk-done" : "apply-bulk-done", ids: succeeded });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
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
  const latest = item.latestComponent;
  const parent = inst.parent;
  if (!parent || !("insertChild" in parent)) return false;

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
  wrapper.setPluginData(ROLE_KEY, ROLE_VALUE);

  const originalIndex = parent.children.indexOf(inst);
  parent.insertChild(originalIndex + 1, wrapper);

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
  if (item) jumpToNode(item.instance);

  const ok = await placeLatestOne(id);
  if (!ok) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  figma.commitUndo();
  post({ type: item?.source === "swap" ? "swap-latest-placed" : "latest-placed", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
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
    if (await placeLatestOne(ids[i])) succeeded.push(ids[i]);
  }
  figma.commitUndo();
  post({ type: bulkSource === "swap" ? "swap-place-latest-bulk-done" : "place-latest-bulk-done", ids: succeeded });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
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
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
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

async function handleClearMarkers(): Promise<void> {
  const nodes = await findAllTaggedNodes();
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
  post({ type: "marker-count", count: 0 });
}

// ---- ライブラリスキャン（スワップ先ライブラリの公開リストの作成） -------------
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
  coverThumbnail?: string; // data URL。ui.ts側でbytesから変換して埋め込む（§handleScanLibrary参照）
}

// 別のコンポーネント（またはコンポーネントセット）の内部に埋め込まれている
// Component/ComponentSetかどうかを判定する。例えば「Button」コンポーネント
// の内部でアイコン切り替え用に小さなComponentSetが使われているようなケース。
// これは実在するノードなのでfindAllWithCriteriaは律儀に拾ってしまうが、
// 独立して公開されるライブラリ資産ではなく、あくまで親コンポーネントの実装
// 詳細なので、トップレベルの資産としては数えない（Analyticsの「Total
// components」とも一致しなくなるため）。
function hasComponentAncestor(node: BaseNode): boolean {
  let p = node.parent;
  while (p && p.type !== "PAGE") {
    if (p.type === "COMPONENT" || p.type === "COMPONENT_SET") return true;
    p = p.parent;
  }
  return false;
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
  const components: LibraryComponentEntry[] = [];
  const componentSets: LibraryComponentSetEntry[] = [];

  // フェーズ1: 全ページを読み込み、対象候補（同期フィルタ済み）を先に集めきる。
  // ここで初めて本当の合計数がわかる。以前はページ数を分母にしていたが、
  // ライブラリファイルはページ数が少ない（1ページに全部、等）ことが多く、
  // その場合プログレスバーがほぼ一瞬で100%に達したあと、実際に時間のかかる
  // フェーズ2（ノードごとに非同期のgetPublishStatusAsync）の間ずっと止まって
  // 見えるのが実害だった。findAllWithCriteria自体は同期なので、この集計
  // フェーズは軽い。
  const candidates: (ComponentNode | ComponentSetNode)[] = [];
  for (const page of figma.root.children) {
    await page.loadAsync();
    const found = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    for (const node of found) {
      if (node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET") continue; // セット側でchildrenとして拾い済み
      if (hasComponentAncestor(node)) continue; // 他コンポーネントの内部実装
      candidates.push(node);
    }
  }

  // フェーズ2: 候補をバッチに分け、バッチごとにgetPublishStatusAsyncをまとめて
  // 待ちつつ進捗を送る。全件を一度にPromise.allすると（それ自体は速いが）
  // 完了するまで一切進捗が出せないので、体感の滑らかさのためにバッチ分割する。
  const BATCH_SIZE = 30;
  let processed = 0;
  post({ type: "library-scan-progress", name: "コンポーネントを確認中", index: 0, total: candidates.length });
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const statuses = await Promise.all(batch.map((node) => node.getPublishStatusAsync()));

    batch.forEach((node, idx) => {
      // Publish対象のコンポーネントを組み立てるための未公開ベースコンポーネント
      // （そのファイル内でしか使わないローカル部品）を除外する。CURRENT/CHANGEDは
      // 公開済み（CHANGEDは公開後にローカルで変更がある状態）なので対象に含める。
      if (statuses[idx] === "UNPUBLISHED") return;

      if (node.type === "COMPONENT_SET") {
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
    });

    processed += batch.length;
    post({ type: "library-scan-progress", name: "コンポーネントを確認中", index: processed, total: candidates.length });
  }

  const data: LibraryScanData = {
    libraryName: figma.root.name,
    exportedAt: new Date().toISOString(),
    components,
    componentSets,
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
        thumbnail = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
      } catch {
        // サムネイル取得に失敗しても除外自体は続行する（見た目確認ができないだけ）
      }
    }
    post({ type: "swap-scan-item-excluded", id: inst.id, name: inst.name, path: nodePath(inst), reason, category, thumbnail });
  }

  const targets = await collectTargets(scope);
  post({ type: "swap-scan-started", total: targets.length });

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

      if (swapScanCancelled) break;

      store.set(inst.id, { instance: inst, latestComponent: target, source: "swap" });
      const resultType = "variantFallback" in result ? "swap-scan-item-variant-result" : "swap-scan-item-result";
      await computeAndSendDiff(inst, target, resultType);
    } catch {
      store.delete(inst.id);
      await postSwapExcluded(inst, "比較中にエラーが発生しました（編集された可能性があります）", "other");
    }

    figma.commitUndo();
  }

  post({ type: swapScanCancelled ? "swap-scan-cancelled" : "swap-scan-done" });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

// ---- キャンバスでジャンプ -----------------------------------------------

function findOwningPage(node: BaseNode): PageNode | null {
  let p: BaseNode = node;
  while (p.parent && p.parent.type !== "DOCUMENT") p = p.parent;
  return p.type === "PAGE" ? (p as PageNode) : null;
}

function jumpToNode(node: SceneNode): void {
  const page = findOwningPage(node);
  if (page) figma.currentPage = page;
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
  jumpToNode(node as SceneNode);
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
  figma.currentPage = firstPage;
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
      case "clear-markers":
        await handleClearMarkers();
        break;
      case "scan-library":
        await handleScanLibrary();
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
