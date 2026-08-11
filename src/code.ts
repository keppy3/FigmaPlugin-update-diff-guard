// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable, one commitUndo per item so a concurrent
// user undo can't reach further back than the item in flight), individual
// + bulk update for 見た目差分なし items (also reused for "構わず更新" on
// 見た目差分あり items — the write is identical either way), and a
// per-instance "最新インスタンス配置" overlay comparison tool (place a
// Latest-preview directly on top of Current, toggle it show/hide) with a
// pluginData-tagged cleanup utility.
//
// Classification (clean vs diff) happens in ui.ts, not here — this side
// only ever needs to know "which instance" via id, never "is it clean".
// See §6.4 for why: pixelmatch requires Canvas, which only the UI iframe
// has.

figma.showUI(__html__, { width: 420, height: 660 });

type ScopeMode = "selection" | "page" | "all";

interface StoredItem {
  instance: InstanceNode;
  latestComponent: ComponentNode;
}

const store = new Map<string, StoredItem>();
// Latest-preview wrapper frames currently placed on top of Current,
// keyed by the original instance's id. Cleaned up on apply/force-update
// so a resolved row never leaves a redundant overlay behind.
const wrapperStore = new Map<string, FrameNode>();
let scanCancelled = false;

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
        latest = await figma.importComponentByKeyAsync(main.key);
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

      store.set(inst.id, { instance: inst, latestComponent: latest });
      await computeAndSendDiff(inst, latest);
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

async function computeAndSendDiff(inst: InstanceNode, latest: ComponentNode): Promise<void> {
  const beforeWidth = inst.width;
  const beforeHeight = inst.height;
  const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });

  // clone() inserts the duplicate into the same parent, next to the
  // original, without touching the original at all.
  const clone = inst.clone();
  clone.name = `${inst.name} (diff candidate)`;
  clone.x = inst.x + inst.width + 40;
  clone.y = inst.y;
  clone.swapComponent(latest);

  const sizeChanged = beforeWidth !== clone.width || beforeHeight !== clone.height;

  // Deliberately left visible=true: exportAsync() on a hidden node has
  // been reported to sometimes render a blank/transparent image, which
  // would make every "after" image a spurious diff. The candidate is
  // removed immediately below anyway. Exported even when sizeChanged, so
  // the UI can still show Current/Latest side by side for that case.
  const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  clone.remove();

  post({
    type: "scan-item-result",
    id: inst.id,
    name: inst.name,
    sizeChanged,
    before: beforeBytes,
    after: afterBytes,
  });
}

// ---- 更新（見た目差分なし・および「構わず更新」） -----------------------
//
// Both the plain 更新 flow (見た目差分なしタブ) and 構わず更新
// (見た目差分ありタブ, ignoring a known diff) end up calling exactly this
// same code — the write itself doesn't know or care which tab the id came
// from, only ui.ts's confirmation flow differs. If that row had a
// Latest-preview wrapper placed on it, it's now redundant (Current itself
// just became Latest), so it's cleaned up here too.

function cleanupWrapper(id: string): void {
  const wrapper = wrapperStore.get(id);
  if (wrapper) {
    wrapper.remove();
    wrapperStore.delete(id);
  }
}

async function handleApply(id: string): Promise<void> {
  const item = store.get(id);
  if (!item) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  // The one line that matters most for this whole project: swap in-place,
  // same node id, so anything (e.g. a FigJam arrow) that references this
  // node keeps working.
  item.instance.swapComponent(item.latestComponent);
  cleanupWrapper(id);
  figma.commitUndo();
  post({ type: "applied", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function handleApplyBulk(ids: string[]): Promise<void> {
  const succeeded: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (!item) continue;
    post({ type: "apply-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
    try {
      item.instance.swapComponent(item.latestComponent);
      cleanupWrapper(ids[i]);
      succeeded.push(ids[i]);
    } catch {
      postError(`更新に失敗しました: ${item.instance.name}`);
    }
  }
  figma.commitUndo();
  post({ type: "apply-bulk-done", ids: succeeded });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

// ---- 最新インスタンス配置（見た目差分あり） ------------------------------
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
  const ok = await placeLatestOne(id);
  if (!ok) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  figma.commitUndo();
  post({ type: "latest-placed", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function handlePlaceLatestBulk(ids: string[]): Promise<void> {
  const succeeded: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (item) post({ type: "place-latest-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
    if (await placeLatestOne(ids[i])) succeeded.push(ids[i]);
  }
  figma.commitUndo();
  post({ type: "place-latest-bulk-done", ids: succeeded });
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
  post({ type: "latest-toggled", id, visible: wrapper.visible });
}

async function handleClearMarkers(): Promise<void> {
  const nodes = await findAllTaggedNodes();
  const count = nodes.length;
  for (const n of nodes) n.remove();
  wrapperStore.clear();
  figma.commitUndo();
  post({ type: "markers-cleared", count });
  post({ type: "marker-count", count: 0 });
}

// ---- キャンバスでジャンプ -----------------------------------------------

function handleJump(id: string): void {
  const item = store.get(id);
  if (!item) return;
  const inst = item.instance;
  let node: BaseNode = inst;
  while (node.parent && node.parent.type !== "DOCUMENT") node = node.parent;
  if (node.type === "PAGE") figma.currentPage = node as PageNode;
  figma.currentPage.selection = [inst];
  figma.viewport.scrollAndZoomIntoView([inst]);
}

// ---- メッセージルーティング ---------------------------------------------

interface IncomingMessage {
  type: string;
  scope?: ScopeMode;
  id?: string;
  ids?: string[];
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
        if (msg.id) await handleApply(msg.id);
        break;
      case "apply-bulk":
        if (msg.ids) await handleApplyBulk(msg.ids);
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
      case "jump":
        if (msg.id) handleJump(msg.id);
        break;
      case "clear-markers":
        await handleClearMarkers();
        break;
    }
  } catch (err) {
    postError(String(err));
  }
};
