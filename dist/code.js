"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 440, height: 640 });
  var instanceStore = /* @__PURE__ */ new Map();
  var latestComponentStore = /* @__PURE__ */ new Map();
  function walkForInstances(node, out) {
    if (node.type === "INSTANCE") {
      out.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) {
        walkForInstances(child, out);
      }
    }
  }
  async function collectTargets(scope) {
    const roots = [];
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
    const found = [];
    for (const root of roots) walkForInstances(root, found);
    return found;
  }
  async function handleScan(scope) {
    instanceStore.clear();
    latestComponentStore.clear();
    const targets = await collectTargets(scope);
    const rows = [];
    for (const inst of targets) {
      let main;
      try {
        main = await inst.getMainComponentAsync();
      } catch (e) {
        main = null;
      }
      if (!main) {
        rows.push({ id: inst.id, name: inst.name, status: "unpublished" });
        continue;
      }
      let latest;
      try {
        latest = await figma.importComponentByKeyAsync(main.key);
      } catch (e) {
        rows.push({
          id: inst.id,
          name: inst.name,
          status: main.remote ? "import-failed" : "unpublished"
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
  async function handleTestDiff(id) {
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
      constraint: { type: "SCALE", value: 2 }
    });
    const clone = inst.clone();
    clone.name = `${inst.name} (diff candidate)`;
    clone.x = inst.x + inst.width + 40;
    clone.y = inst.y;
    clone.visible = false;
    clone.swapComponent(latest);
    const afterWidth = clone.width;
    const afterHeight = clone.height;
    const sizeChanged = beforeWidth !== afterWidth || beforeHeight !== afterHeight;
    const afterBytes = await clone.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 }
    });
    clone.remove();
    figma.ui.postMessage({
      type: "diff-images",
      id,
      before: beforeBytes,
      after: afterBytes,
      sizeChanged
    });
  }
  async function handleApply(id) {
    const inst = instanceStore.get(id);
    const latest = latestComponentStore.get(id);
    if (!inst || !latest) {
      figma.ui.postMessage({ type: "error", message: `Instance not found for id ${id}` });
      return;
    }
    inst.swapComponent(latest);
    figma.ui.postMessage({ type: "applied", id });
  }
  async function handleJump(id) {
    const inst = instanceStore.get(id);
    if (!inst) return;
    figma.currentPage.selection = [inst];
    figma.viewport.scrollAndZoomIntoView([inst]);
  }
  figma.ui.onmessage = async (msg) => {
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
})();
