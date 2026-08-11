// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable, one commitUndo per item so a concurrent
// user undo can't reach further back than the item in flight), individual
// + bulk update for 見た目差分なし items (also reused for "構わず更新" on
// 見た目差分あり items — the write is identical either way), individual +
// bulk marking, and a pluginData-tagged marker/after-preview cleanup
// utility.
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
//
// Runs one instance at a time (not in parallel) so that:
//   1. results can stream to the UI as each one resolves, and
//   2. figma.commitUndo() after each item bounds how much a concurrent
//      user edit/undo during the scan can possibly disturb — see the
//      "editing the file mid-scan" discussion this was written for.
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
// from, only ui.ts's confirmation flow differs.

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
//
// Current (red) marks the untouched original; Latest (green) marks the
// after-preview. Labels make the red/green meaning legible without
// requiring the viewer to already know this plugin's conventions.

let labelFontCache: FontName | null = null;

async function ensureLabelFont(): Promise<FontName> {
  if (labelFontCache) return labelFontCache;
  const preferred: FontName = { family: "Inter", style: "Bold" };
  try {
    await figma.loadFontAsync(preferred);
    labelFontCache = preferred;
  } catch {
    const fallback: FontName = { family: "Roboto", style: "Bold" };
    await figma.loadFontAsync(fallback);
    labelFontCache = fallback;
  }
  return labelFontCache;
}

async function markOne(id: string): Promise<boolean> {
  const item = store.get(id);
  if (!item) return false;
  const inst = item.instance;
  const latest = item.latestComponent;
  const parent = inst.parent;
  if (!parent || !("insertChild" in parent)) return false;

  const font = await ensureLabelFont();
  const outset = 4;
  const red: RGB = { r: 0.82, g: 0.27, b: 0.23 };
  const green: RGB = { r: 0.11, g: 0.6, b: 0.32 };

  function outlineMarker(target: { x: number; y: number; width: number; height: number }, color: RGB, name: string): RectangleNode {
    const marker = figma.createRectangle();
    marker.name = name;
    marker.x = target.x - outset;
    marker.y = target.y - outset;
    marker.resize(target.width + outset * 2, target.height + outset * 2);
    marker.fills = [];
    marker.strokes = [{ type: "SOLID", color }];
    marker.strokeWeight = 4;
    marker.strokeAlign = "OUTSIDE";
    marker.locked = true;
    marker.setPluginData(ROLE_KEY, "marker");
    return marker;
  }

  function labelBelow(target: { x: number; y: number; width: number; height: number }, text: string, color: RGB): TextNode {
    const label = figma.createText();
    label.fontName = font;
    label.fontSize = 11;
    label.characters = text;
    label.fills = [{ type: "SOLID", color }];
    label.textAlignHorizontal = "CENTER";
    label.locked = true;
    label.name = `⚠ ${text} label`;
    label.setPluginData(ROLE_KEY, "marker");
    // textAutoResize defaults to WIDTH_AND_HEIGHT, so .width here already
    // reflects the natural size of "Current"/"Latest" — no manual resize.
    label.x = target.x + (target.width - label.width) / 2;
    label.y = target.y + target.height + outset + 4;
    return label;
  }

  const originalIndex = parent.children.indexOf(inst);

  // 1-2. Red marker + "Current" label over the original. The original
  // itself is never touched — only new sibling nodes are created.
  const marker = outlineMarker(inst, red, `⚠ Diff Marker — ${inst.name}`);
  parent.insertChild(originalIndex + 1, marker);
  const currentLabel = labelBelow(inst, "Current", red);
  parent.insertChild(originalIndex + 2, currentLabel);

  // 3. After-preview instance: a fresh clone, swapped to the latest
  // component, placed to the right and adjacent in the layer list.
  const after = inst.clone();
  after.name = `⚠ AFTER PREVIEW（確認後に削除してください）— ${inst.name}`;
  after.swapComponent(latest);
  after.x = inst.x + inst.width + 40;
  after.y = inst.y;
  after.setPluginData(ROLE_KEY, "after-preview");
  parent.insertChild(originalIndex + 3, after);

  // 4-5. Green marker + "Latest" label over the after-preview. Never a
  // stroke on the instance itself (that would distort the very appearance
  // it's meant to preview) — always a separate overlaid node.
  const afterMarker = outlineMarker(after, green, `⚠ Diff Marker — ${inst.name} (After)`);
  parent.insertChild(originalIndex + 4, afterMarker);
  const latestLabel = labelBelow(after, "Latest", green);
  parent.insertChild(originalIndex + 5, latestLabel);

  return true;
}

async function handleMark(id: string): Promise<void> {
  const ok = await markOne(id);
  if (!ok) {
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
    if (await markOne(ids[i])) succeeded.push(ids[i]);
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
