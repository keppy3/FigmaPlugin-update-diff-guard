// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable), individual + bulk update for
// 見た目差分なし items, individual + bulk marking for 見た目差分あり items,
// and a pluginData-tagged marker/after-preview cleanup utility.
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

// ---- Marker / after-preview node discovery (setPluginData-tagged) --------

const ROLE_KEY = "update-diff-guard-role";

function isTaggedNode(node: BaseNode): node is SceneNode {
  if (!("getPluginData" in node)) return false;
  const role = (node as SceneNode).getPluginData(ROLE_KEY);
  return role === "marker" || role === "after-preview";
}

function collectTaggedNodes(node: BaseNode, out: SceneNode[]): void {
  if (isTaggedNode(node)) {
    out.push(node as SceneNode);
    return; // our own nodes never contain further tagged nodes
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

async function runScan(scope: ScopeMode): Promise<void> {
  store.clear();
  scanCancelled = false;

  const targets = await collectTargets(scope);
  post({ type: "scan-started", total: targets.length });

  for (const inst of targets) {
    if (scanCancelled) break;

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
    await computeAndSendDiff(inst, latest, "scan-item-result");
  }

  figma.commitUndo();
  post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function computeAndSendDiff(
  inst: InstanceNode,
  latest: ComponentNode,
  messageType: "scan-item-result" | "retry-diff-result"
): Promise<void> {
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

  if (sizeChanged) {
    clone.remove();
    post({ type: messageType, id: inst.id, name: inst.name, sizeChanged: true });
    return;
  }

  // Deliberately left visible=true: exportAsync() on a hidden node has
  // been reported to sometimes render a blank/transparent image, which
  // would make every "after" image a spurious diff. The candidate is
  // removed immediately below anyway.
  const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  clone.remove();

  post({
    type: messageType,
    id: inst.id,
    name: inst.name,
    sizeChanged: false,
    before: beforeBytes,
    after: afterBytes,
  });
}

async function handleRetryDiff(id: string): Promise<void> {
  const item = store.get(id);
  if (!item) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  await computeAndSendDiff(item.instance, item.latestComponent, "retry-diff-result");
}

// ---- 更新（見た目差分なし） --------------------------------------------

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
  figma.commitUndo();
  post({ type: "applied", id });
}

async function handleApplyBulk(ids: string[]): Promise<void> {
  const succeeded: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (!item) continue;
    post({ type: "apply-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
    try {
      item.instance.swapComponent(item.latestComponent);
      succeeded.push(ids[i]);
    } catch {
      postError(`更新に失敗しました: ${item.instance.name}`);
    }
  }
  figma.commitUndo();
  post({ type: "apply-bulk-done", ids: succeeded });
}

// ---- マーキング（見た目差分あり） --------------------------------------

function markOne(id: string): boolean {
  const item = store.get(id);
  if (!item) return false;
  const inst = item.instance;
  const latest = item.latestComponent;
  const parent = inst.parent;
  if (!parent || !("insertChild" in parent)) return false;

  const outset = 4;
  const danger = { r: 0.82, g: 0.27, b: 0.23 };

  function outlineMarker(target: SceneNode & LayoutMixin, label: string): RectangleNode {
    const marker = figma.createRectangle();
    marker.name = `⚠ Diff Marker — ${label}`;
    marker.x = target.x - outset;
    marker.y = target.y - outset;
    marker.resize(target.width + outset * 2, target.height + outset * 2);
    marker.fills = [];
    marker.strokes = [{ type: "SOLID", color: danger }];
    marker.strokeWeight = 4;
    marker.strokeAlign = "OUTSIDE";
    marker.locked = true;
    marker.setPluginData(ROLE_KEY, "marker");
    return marker;
  }

  const originalIndex = parent.children.indexOf(inst);

  // 1. Marker over the original instance. The original itself is never
  // touched — only new sibling nodes are created.
  const marker = outlineMarker(inst, inst.name);
  parent.insertChild(originalIndex + 1, marker);

  // 2. After-preview instance: a fresh clone, swapped to the latest
  // component, placed to the right and adjacent in the layer list.
  const after = inst.clone();
  after.name = `⚠ AFTER PREVIEW（確認後に削除してください）— ${inst.name}`;
  after.swapComponent(latest);
  after.x = inst.x + inst.width + 40;
  after.y = inst.y;
  after.setPluginData(ROLE_KEY, "after-preview");
  parent.insertChild(originalIndex + 2, after);

  // 3. Marker over the after-preview too — never a stroke on the
  // instance itself (that would distort the very appearance it's meant
  // to preview). This is what stops the after-preview from being mistaken
  // for real, adopted content.
  const afterMarker = outlineMarker(after, `${inst.name} (After)`);
  parent.insertChild(originalIndex + 3, afterMarker);

  return true;
}

async function handleMark(id: string): Promise<void> {
  if (!markOne(id)) {
    postError(`対象が見つかりません: ${id}`);
    return;
  }
  figma.commitUndo();
  post({ type: "marked", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function handleMarkBulk(ids: string[]): Promise<void> {
  const succeeded: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (item) post({ type: "mark-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
    if (markOne(ids[i])) succeeded.push(ids[i]);
  }
  figma.commitUndo();
  post({ type: "mark-bulk-done", ids: succeeded });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function handleClearMarkers(): Promise<void> {
  const nodes = await findAllTaggedNodes();
  const count = nodes.length;
  for (const n of nodes) n.remove();
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
      case "mark":
        if (msg.id) await handleMark(msg.id);
        break;
      case "mark-bulk":
        if (msg.ids) await handleMarkBulk(msg.ids);
        break;
      case "retry-diff":
        if (msg.id) await handleRetryDiff(msg.id);
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
