// Update Diff Guard — main thread (sandboxed, Figma Document API).
//
// This is a minimal, validation-focused build. It exists to answer the
// riskiest technical questions from Spec.md before investing in the full
// tabbed UI:
//   - Does swapComponent() on a live instance preserve overrides the way
//     Figma's own "Update" button does?
//   - Does swapComponent() preserve the node's identity (so FigJam arrow
//     connectors that reference this node survive)?
//   - Does the importComponentByKeyAsync().id === mainComponent.id check
//     reliably detect "already latest" vs "update available"?
//   - Does the exportAsync() -> pixelmatch pipeline produce a sane diff?
//
// See Spec.md for the target design; this file intentionally skips the
// tabbed UI, marking, and after-instance placement described there.

figma.showUI(__html__, { width: 440, height: 640 });

type ScopeMode = "selection" | "page" | "all";
type ScanRowStatus = "unpublished" | "up-to-date" | "has-update" | "import-failed";

interface ScanRow {
  id: string;
  name: string;
  status: ScanRowStatus;
}

// Session-only state: node references never cross the UI boundary directly,
// only their ids. The UI asks us to act on an id, and we look it up here.
const instanceStore = new Map<string, InstanceNode>();
const latestComponentStore = new Map<string, ComponentNode>();

function walkForInstances(node: SceneNode, out: InstanceNode[]): void {
  if (node.type === "INSTANCE") {
    // Top-level instances only — do not recurse into nested instances
    // (their differences are captured implicitly in the parent's image diff).
    out.push(node);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) {
      walkForInstances(child, out);
    }
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

async function handleScan(scope: ScopeMode): Promise<void> {
  instanceStore.clear();
  latestComponentStore.clear();

  const targets = await collectTargets(scope);
  const rows: ScanRow[] = [];

  for (const inst of targets) {
    let main: ComponentNode | null;
    try {
      main = await inst.getMainComponentAsync();
    } catch {
      main = null;
    }

    if (!main) {
      rows.push({ id: inst.id, name: inst.name, status: "unpublished" });
      continue;
    }

    let latest: ComponentNode;
    try {
      latest = await figma.importComponentByKeyAsync(main.key);
    } catch {
      // Local/unpublished components have no importable key; a genuine
      // network/import failure on a remote component also lands here.
      rows.push({
        id: inst.id,
        name: inst.name,
        status: main.remote ? "import-failed" : "unpublished",
      });
      continue;
    }

    instanceStore.set(inst.id, inst);

    if (latest.id === main.id) {
      rows.push({ id: inst.id, name: inst.name, status: "up-to-date" });
    } else {
      latestComponentStore.set(inst.id, latest);
      rows.push({ id: inst.id, name: inst.name, status: "has-update" });
    }
  }

  figma.ui.postMessage({ type: "scan-result", rows, total: targets.length });
}

async function handleTestDiff(id: string): Promise<void> {
  const inst = instanceStore.get(id);
  const latest = latestComponentStore.get(id);
  if (!inst || !latest) {
    figma.ui.postMessage({ type: "error", message: `Instance not found for id ${id}` });
    return;
  }

  const beforeWidth = inst.width;
  const beforeHeight = inst.height;
  const beforeBytes = await inst.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: 2 },
  });

  // clone() inserts the duplicate into the same parent, next to the
  // original, without touching the original at all.
  //
  // Deliberately left visible=true here: exportAsync() on a hidden
  // (visible=false) node has been reported to sometimes render a blank/
  // transparent image (see Figma forum), which would make every "after"
  // image a spurious diff against a real "before" image. The candidate
  // is removed immediately below anyway, so the brief on-canvas presence
  // during the export await is an acceptable trade-off for correctness.
  const clone = inst.clone();
  clone.name = `${inst.name} (diff candidate)`;
  clone.x = inst.x + inst.width + 40;
  clone.y = inst.y;
  clone.swapComponent(latest);

  const afterWidth = clone.width;
  const afterHeight = clone.height;
  const sizeChanged = beforeWidth !== afterWidth || beforeHeight !== afterHeight;

  const afterBytes = await clone.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: 2 },
  });

  // Candidate node only ever exists for the duration of this handler.
  clone.remove();

  figma.ui.postMessage({
    type: "diff-images",
    id,
    before: beforeBytes,
    after: afterBytes,
    sizeChanged,
  });
}

async function handleApply(id: string): Promise<void> {
  const inst = instanceStore.get(id);
  const latest = latestComponentStore.get(id);
  if (!inst || !latest) {
    figma.ui.postMessage({ type: "error", message: `Instance not found for id ${id}` });
    return;
  }

  // The one line that matters most for this whole project: swap in-place,
  // same node id, so anything (e.g. a FigJam arrow) that references this
  // node keeps working.
  inst.swapComponent(latest);

  figma.ui.postMessage({ type: "applied", id });
}

async function handleJump(id: string): Promise<void> {
  const inst = instanceStore.get(id);
  if (!inst) return;
  figma.currentPage.selection = [inst];
  figma.viewport.scrollAndZoomIntoView([inst]);
}

figma.ui.onmessage = async (msg: { type: string; scope?: ScopeMode; id?: string }) => {
  try {
    if (msg.type === "scan" && msg.scope) {
      await handleScan(msg.scope);
    } else if (msg.type === "test-diff" && msg.id) {
      await handleTestDiff(msg.id);
    } else if (msg.type === "apply" && msg.id) {
      await handleApply(msg.id);
    } else if (msg.type === "jump" && msg.id) {
      await handleJump(msg.id);
    }
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: String(err) });
  }
};
