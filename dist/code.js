"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 420, height: 660 });
  var store = /* @__PURE__ */ new Map();
  var wrapperStore = /* @__PURE__ */ new Map();
  var scanCancelled = false;
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  function postError(message) {
    post({ type: "error", message });
  }
  function walkForInstances(node, out) {
    if (node.type === "INSTANCE") {
      out.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) walkForInstances(child, out);
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
  var ROLE_KEY = "update-diff-guard-role";
  var ROLE_VALUE = "latest-preview";
  function isTaggedNode(node) {
    if (!("getPluginData" in node)) return false;
    return node.getPluginData(ROLE_KEY) === ROLE_VALUE;
  }
  function collectTaggedNodes(node, out) {
    if (isTaggedNode(node)) {
      out.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) collectTaggedNodes(child, out);
    }
  }
  async function findAllTaggedNodes() {
    const found = [];
    for (const page of figma.root.children) {
      await page.loadAsync();
      collectTaggedNodes(page, found);
    }
    return found;
  }
  async function runScan(scope) {
    store.clear();
    scanCancelled = false;
    const targets = await collectTargets(scope);
    post({ type: "scan-started", total: targets.length });
    for (const inst of targets) {
      if (scanCancelled) break;
      try {
        let main;
        try {
          main = await inst.getMainComponentAsync();
        } catch (e) {
          main = null;
        }
        if (!main) {
          post({ type: "scan-item-excluded", name: inst.name, reason: "\u672A\u30D1\u30D6\u30EA\u30C3\u30B7\u30E5\u306E\u30ED\u30FC\u30AB\u30EB\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8" });
          continue;
        }
        let latest;
        try {
          latest = await figma.importComponentByKeyAsync(main.key);
        } catch (e) {
          post({
            type: "scan-item-excluded",
            name: inst.name,
            reason: main.remote ? "\u6700\u65B0\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u306E\u53D6\u5F97\u306B\u5931\u6557" : "\u672A\u30D1\u30D6\u30EA\u30C3\u30B7\u30E5\u306E\u30ED\u30FC\u30AB\u30EB\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8"
          });
          continue;
        }
        if (latest.id === main.id) {
          post({ type: "scan-item-excluded", name: inst.name, reason: "\u65E2\u306B\u6700\u65B0\u7248\u3092\u53C2\u7167" });
          continue;
        }
        if (scanCancelled) break;
        store.set(inst.id, { instance: inst, latestComponent: latest });
        await computeAndSendDiff(inst, latest);
      } catch (e) {
        store.delete(inst.id);
        post({ type: "scan-item-excluded", name: inst.name, reason: "\u6BD4\u8F03\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\uFF08\u7DE8\u96C6\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\uFF09" });
      }
      figma.commitUndo();
    }
    post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function computeAndSendDiff(inst, latest) {
    const beforeWidth = inst.width;
    const beforeHeight = inst.height;
    const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const clone = inst.clone();
    clone.name = `${inst.name} (diff candidate)`;
    clone.x = inst.x + inst.width + 40;
    clone.y = inst.y;
    clone.swapComponent(latest);
    const sizeChanged = beforeWidth !== clone.width || beforeHeight !== clone.height;
    const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    clone.remove();
    post({
      type: "scan-item-result",
      id: inst.id,
      name: inst.name,
      sizeChanged,
      before: beforeBytes,
      after: afterBytes
    });
  }
  function cleanupWrapper(id) {
    const wrapper = wrapperStore.get(id);
    if (wrapper) {
      wrapper.remove();
      wrapperStore.delete(id);
    }
  }
  async function handleApply(id) {
    const item = store.get(id);
    if (!item) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    item.instance.swapComponent(item.latestComponent);
    cleanupWrapper(id);
    figma.commitUndo();
    post({ type: "applied", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handleApplyBulk(ids) {
    const succeeded = [];
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (!item) continue;
      post({ type: "apply-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
      try {
        item.instance.swapComponent(item.latestComponent);
        cleanupWrapper(ids[i]);
        succeeded.push(ids[i]);
      } catch (e) {
        postError(`\u66F4\u65B0\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${item.instance.name}`);
      }
    }
    figma.commitUndo();
    post({ type: "apply-bulk-done", ids: succeeded });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function placeLatestOne(id) {
    if (wrapperStore.has(id)) return true;
    const item = store.get(id);
    if (!item) return false;
    const inst = item.instance;
    const latest = item.latestComponent;
    const parent = inst.parent;
    if (!parent || !("insertChild" in parent)) return false;
    const wrapper = figma.createFrame();
    wrapper.name = `\u26A0 Latest Preview \u2014 ${inst.name}`;
    wrapper.x = inst.x;
    wrapper.y = inst.y;
    wrapper.resize(inst.width, inst.height);
    wrapper.fills = [];
    wrapper.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }];
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
  async function handlePlaceLatest(id) {
    const ok = await placeLatestOne(id);
    if (!ok) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    figma.commitUndo();
    post({ type: "latest-placed", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handlePlaceLatestBulk(ids) {
    const succeeded = [];
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (item) post({ type: "place-latest-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
      if (await placeLatestOne(ids[i])) succeeded.push(ids[i]);
    }
    figma.commitUndo();
    post({ type: "place-latest-bulk-done", ids: succeeded });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  function handleToggleLatest(id) {
    const wrapper = wrapperStore.get(id);
    if (!wrapper) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    wrapper.visible = !wrapper.visible;
    figma.commitUndo();
    post({ type: "latest-toggled", id, visible: wrapper.visible });
  }
  async function handleClearMarkers() {
    const nodes = await findAllTaggedNodes();
    const count = nodes.length;
    for (const n of nodes) n.remove();
    wrapperStore.clear();
    figma.commitUndo();
    post({ type: "markers-cleared", count });
    post({ type: "marker-count", count: 0 });
  }
  function handleJump(id) {
    const item = store.get(id);
    if (!item) return;
    const inst = item.instance;
    let node = inst;
    while (node.parent && node.parent.type !== "DOCUMENT") node = node.parent;
    if (node.type === "PAGE") figma.currentPage = node;
    figma.currentPage.selection = [inst];
    figma.viewport.scrollAndZoomIntoView([inst]);
  }
  figma.ui.onmessage = async (msg) => {
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
})();
