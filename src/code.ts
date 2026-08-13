// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// Implements Spec.md's full design: streaming scan (one message per
// resolved instance, cancellable, one commitUndo per item so a concurrent
// user undo can't reach further back than the item in flight), individual
// + bulk update for 見た目差分なし items (also reused for "このまま更新" on
// 見た目差分あり items — the write is identical either way), and a
// per-instance "最新インスタンスを重ねて配置" overlay comparison tool (place a
// Latest-preview directly on top of Current, toggle it show/hide, or
// remove it individually) with a pluginData-tagged full-sweep cleanup
// utility ("配置した最新インスタンスをすべて削除").
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

  // Deliberately the simplest option available: reparent the candidate to
  // its own page and pin it at (0, 0). Two earlier attempts tried instead
  // to make it visually overlap the original — same-parent + matching x/y,
  // then that plus layoutPositioning = "ABSOLUTE" to escape Auto Layout —
  // and both introduced real bugs. The second one throws when the
  // original's parent isn't an Auto Layout frame (layoutPositioning isn't
  // safely settable there), which aborted computeAndSendDiff before the
  // cleanup below could run for *every* instance with a plain parent —
  // candidates scattered and stayed on the canvas, and every item got
  // excluded as a scan error instead of classified. A fixed absolute
  // position needs none of that cleverness: no relative-coordinate math,
  // no layout-mode-dependent property, nothing that can throw depending on
  // what kind of parent the original happens to have.
  const clone = inst.clone();
  clone.name = `${inst.name} (diff candidate)`;
  (findOwningPage(inst) ?? figma.currentPage).appendChild(clone);
  clone.x = 0;
  clone.y = 0;
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
      type: "scan-item-result",
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
// caller's choice (the confirm dialog's "配置中の最新インスタンスを削除する"
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
  post({ type: "applied", id });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

async function handleApplyBulk(ids: string[], removeLatest?: boolean): Promise<void> {
  const succeeded: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = store.get(ids[i]);
    if (!item) continue;
    post({ type: "apply-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
    try {
      item.instance.swapComponent(item.latestComponent);
      if (removeLatest !== false) cleanupWrapper(ids[i]);
      succeeded.push(ids[i]);
    } catch {
      postError(`更新に失敗しました: ${item.instance.name}`);
    }
  }
  figma.commitUndo();
  post({ type: "apply-bulk-done", ids: succeeded });
  post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
}

// ---- 最新インスタンスを重ねて配置（見た目差分あり） ------------------------------
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

// Individual "配置した最新インスタンスを削除" — removes just the named row's wrapper, as
// opposed to handleClearMarkers() which sweeps every tagged node on every
// page regardless of selection (the bulk footer button now just triggers
// that same full sweep, labeled "配置した最新インスタンスをすべて削除", rather than a
// separate selection-scoped variant — the two used to overlap in purpose).
// The row reverts to showing the "最新インスタンスを重ねて配置" button again (ui.ts
// infers this from the wrapper's absence, same as after handleClearMarkers).

async function handleRemoveLatest(id: string): Promise<void> {
  if (!wrapperStore.has(id)) return;
  cleanupWrapper(id);
  figma.commitUndo();
  post({ type: "latest-removed", id });
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

function handleJump(id: string): void {
  const item = store.get(id);
  if (!item) return;
  jumpToNode(item.instance);
}

// ---- メッセージルーティング ---------------------------------------------

interface IncomingMessage {
  type: string;
  scope?: ScopeMode;
  id?: string;
  ids?: string[];
  jump?: boolean;
  removeLatest?: boolean;
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
