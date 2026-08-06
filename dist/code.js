"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 420, height: 660 });
  var store = /* @__PURE__ */ new Map();
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
  function isTaggedNode(node) {
    if (!("getPluginData" in node)) return false;
    const role = node.getPluginData(ROLE_KEY);
    return role === "marker" || role === "after-preview";
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
      await computeAndSendDiff(inst, latest, "scan-item-result");
    }
    figma.commitUndo();
    post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function computeAndSendDiff(inst, latest, messageType) {
    const beforeWidth = inst.width;
    const beforeHeight = inst.height;
    const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
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
    const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    clone.remove();
    post({
      type: messageType,
      id: inst.id,
      name: inst.name,
      sizeChanged: false,
      before: beforeBytes,
      after: afterBytes
    });
  }
  async function handleRetryDiff(id) {
    const item = store.get(id);
    if (!item) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    await computeAndSendDiff(item.instance, item.latestComponent, "retry-diff-result");
  }
  async function handleApply(id) {
    const item = store.get(id);
    if (!item) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    item.instance.swapComponent(item.latestComponent);
    figma.commitUndo();
    post({ type: "applied", id });
  }
  async function handleApplyBulk(ids) {
    const succeeded = [];
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (!item) continue;
      post({ type: "apply-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
      try {
        item.instance.swapComponent(item.latestComponent);
        succeeded.push(ids[i]);
      } catch (e) {
        postError(`\u66F4\u65B0\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${item.instance.name}`);
      }
    }
    figma.commitUndo();
    post({ type: "apply-bulk-done", ids: succeeded });
  }
  function markOne(id) {
    const item = store.get(id);
    if (!item) return false;
    const inst = item.instance;
    const latest = item.latestComponent;
    const parent = inst.parent;
    if (!parent || !("insertChild" in parent)) return false;
    const outset = 4;
    const danger = { r: 0.82, g: 0.27, b: 0.23 };
    function outlineMarker(target, label) {
      const marker2 = figma.createRectangle();
      marker2.name = `\u26A0 Diff Marker \u2014 ${label}`;
      marker2.x = target.x - outset;
      marker2.y = target.y - outset;
      marker2.resize(target.width + outset * 2, target.height + outset * 2);
      marker2.fills = [];
      marker2.strokes = [{ type: "SOLID", color: danger }];
      marker2.strokeWeight = 4;
      marker2.strokeAlign = "OUTSIDE";
      marker2.locked = true;
      marker2.setPluginData(ROLE_KEY, "marker");
      return marker2;
    }
    const originalIndex = parent.children.indexOf(inst);
    const marker = outlineMarker(inst, inst.name);
    parent.insertChild(originalIndex + 1, marker);
    const after = inst.clone();
    after.name = `\u26A0 AFTER PREVIEW\uFF08\u78BA\u8A8D\u5F8C\u306B\u524A\u9664\u3057\u3066\u304F\u3060\u3055\u3044\uFF09\u2014 ${inst.name}`;
    after.swapComponent(latest);
    after.x = inst.x + inst.width + 40;
    after.y = inst.y;
    after.setPluginData(ROLE_KEY, "after-preview");
    parent.insertChild(originalIndex + 2, after);
    const afterMarker = outlineMarker(after, `${inst.name} (After)`);
    parent.insertChild(originalIndex + 3, afterMarker);
    return true;
  }
  async function handleMark(id) {
    if (!markOne(id)) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    figma.commitUndo();
    post({ type: "marked", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handleMarkBulk(ids) {
    const succeeded = [];
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (item) post({ type: "mark-bulk-progress", name: item.instance.name, index: i + 1, total: ids.length });
      if (markOne(ids[i])) succeeded.push(ids[i]);
    }
    figma.commitUndo();
    post({ type: "mark-bulk-done", ids: succeeded });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handleClearMarkers() {
    const nodes = await findAllTaggedNodes();
    const count = nodes.length;
    for (const n of nodes) n.remove();
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
})();
