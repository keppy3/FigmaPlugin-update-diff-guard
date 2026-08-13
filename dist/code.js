"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 420, height: 660 });
  var store = /* @__PURE__ */ new Map();
  var wrapperStore = /* @__PURE__ */ new Map();
  var scanCancelled = false;
  var swapScanCancelled = false;
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
        store.set(inst.id, { instance: inst, latestComponent: latest, source: "update" });
        await computeAndSendDiff(inst, latest, "scan-item-result");
      } catch (e) {
        store.delete(inst.id);
        post({ type: "scan-item-excluded", name: inst.name, reason: "\u6BD4\u8F03\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\uFF08\u7DE8\u96C6\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\uFF09" });
      }
      figma.commitUndo();
    }
    post({ type: scanCancelled ? "scan-cancelled" : "scan-done" });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function computeAndSendDiff(inst, latest, resultType) {
    var _a;
    const beforeWidth = inst.width;
    const beforeHeight = inst.height;
    const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const clone = inst.clone();
    clone.name = `${inst.name} (diff candidate)`;
    ((_a = findOwningPage(inst)) != null ? _a : figma.currentPage).appendChild(clone);
    clone.x = 0;
    clone.y = 0;
    clone.swapComponent(latest);
    const sizeChanged = beforeWidth !== clone.width || beforeHeight !== clone.height;
    try {
      const afterBytes = await clone.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
      post({
        type: resultType,
        id: inst.id,
        name: inst.name,
        sizeChanged,
        before: beforeBytes,
        after: afterBytes
      });
    } finally {
      clone.remove();
    }
  }
  function cleanupWrapper(id) {
    const wrapper = wrapperStore.get(id);
    if (wrapper) {
      wrapper.remove();
      wrapperStore.delete(id);
    }
  }
  async function handleApply(id, jump, removeLatest) {
    const item = store.get(id);
    if (!item) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    if (jump) jumpToNode(item.instance);
    item.instance.swapComponent(item.latestComponent);
    if (removeLatest !== false) cleanupWrapper(id);
    figma.commitUndo();
    post({ type: item.source === "swap" ? "swap-applied" : "applied", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handleApplyBulk(ids, removeLatest) {
    const succeeded = [];
    let bulkSource = "update";
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (!item) continue;
      bulkSource = item.source;
      post({
        type: item.source === "swap" ? "swap-apply-bulk-progress" : "apply-bulk-progress",
        name: item.instance.name,
        index: i + 1,
        total: ids.length
      });
      try {
        item.instance.swapComponent(item.latestComponent);
        if (removeLatest !== false) cleanupWrapper(ids[i]);
        succeeded.push(ids[i]);
      } catch (e) {
        postError(`\u66F4\u65B0\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${item.instance.name}`);
      }
    }
    figma.commitUndo();
    post({ type: bulkSource === "swap" ? "swap-apply-bulk-done" : "apply-bulk-done", ids: succeeded });
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
    const item = store.get(id);
    if (item) jumpToNode(item.instance);
    const ok = await placeLatestOne(id);
    if (!ok) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    figma.commitUndo();
    post({ type: (item == null ? void 0 : item.source) === "swap" ? "swap-latest-placed" : "latest-placed", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handlePlaceLatestBulk(ids) {
    const succeeded = [];
    let bulkSource = "update";
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      if (item) {
        bulkSource = item.source;
        post({
          type: item.source === "swap" ? "swap-place-latest-bulk-progress" : "place-latest-bulk-progress",
          name: item.instance.name,
          index: i + 1,
          total: ids.length
        });
      }
      if (await placeLatestOne(ids[i])) succeeded.push(ids[i]);
    }
    figma.commitUndo();
    post({ type: bulkSource === "swap" ? "swap-place-latest-bulk-done" : "place-latest-bulk-done", ids: succeeded });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  async function handleRemoveLatest(id) {
    var _a;
    if (!wrapperStore.has(id)) return;
    const source = (_a = store.get(id)) == null ? void 0 : _a.source;
    cleanupWrapper(id);
    figma.commitUndo();
    post({ type: source === "swap" ? "swap-latest-removed" : "latest-removed", id });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  function handleToggleLatest(id) {
    var _a;
    const wrapper = wrapperStore.get(id);
    if (!wrapper) {
      postError(`\u5BFE\u8C61\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
      return;
    }
    wrapper.visible = !wrapper.visible;
    figma.commitUndo();
    const source = (_a = store.get(id)) == null ? void 0 : _a.source;
    post({ type: source === "swap" ? "swap-latest-toggled" : "latest-toggled", id, visible: wrapper.visible });
  }
  async function handleClearMarkers() {
    const nodes = await findAllTaggedNodes();
    const count = nodes.length;
    for (const n of nodes) n.remove();
    const clearedIds = Array.from(wrapperStore.keys());
    wrapperStore.clear();
    figma.commitUndo();
    post({ type: "markers-cleared", count, ids: clearedIds });
    post({ type: "marker-count", count: 0 });
  }
  function hasComponentAncestor(node) {
    let p = node.parent;
    while (p && p.type !== "PAGE") {
      if (p.type === "COMPONENT" || p.type === "COMPONENT_SET") return true;
      p = p.parent;
    }
    return false;
  }
  function nodePath(node) {
    const parts = [];
    let p = node;
    while (p && p.type !== "DOCUMENT") {
      parts.unshift(p.name);
      p = p.parent;
    }
    return parts.join(" / ");
  }
  async function handleScanLibrary() {
    var _a;
    const components = [];
    const componentSets = [];
    const pages = figma.root.children;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      await page.loadAsync();
      post({ type: "library-scan-progress", name: page.name, index: i + 1, total: pages.length });
      const found = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
      for (const node of found) {
        if (node.type === "COMPONENT_SET") {
          if (hasComponentAncestor(node)) continue;
          if (await node.getPublishStatusAsync() === "UNPUBLISHED") continue;
          const variantProps = {};
          for (const [prop, info] of Object.entries(node.variantGroupProperties)) {
            variantProps[prop] = info.values;
          }
          componentSets.push({
            name: node.name,
            key: node.key,
            path: nodePath(node),
            variantProps,
            children: node.children.filter((c) => c.type === "COMPONENT").map((c) => {
              var _a2;
              return { key: c.key, variantProperties: (_a2 = c.variantProperties) != null ? _a2 : {} };
            })
          });
        } else if (node.type === "COMPONENT") {
          if (((_a = node.parent) == null ? void 0 : _a.type) === "COMPONENT_SET") continue;
          if (hasComponentAncestor(node)) continue;
          if (await node.getPublishStatusAsync() === "UNPUBLISHED") continue;
          components.push({ name: node.name, key: node.key, path: nodePath(node) });
        }
      }
    }
    const data = {
      libraryName: figma.root.name,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      components,
      componentSets
    };
    post({ type: "library-scan-done", data });
  }
  function variantPropsEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  }
  function resolveSwapTarget(matchName, isSet, currentVariantProperties, nameToComponent, nameToSet) {
    if (isSet) {
      const set = nameToSet.get(matchName);
      if (!set) {
        return { reason: `\u300C${matchName}\u300D\u3068\u3044\u3046\u540D\u524D\u306E\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u30BB\u30C3\u30C8\u304C\u65B0\u30E9\u30A4\u30D6\u30E9\u30EA\u306B\u898B\u3064\u304B\u308A\u307E\u305B\u3093`, category: "name" };
      }
      const current = currentVariantProperties != null ? currentVariantProperties : {};
      const child = set.children.find((c) => variantPropsEqual(c.variantProperties, current));
      if (!child) {
        const desc = Object.entries(current).map(([k, v]) => `${k}=${v}`).join(", ");
        return {
          reason: `\u300C${matchName}\u300D\u306F\u898B\u3064\u304B\u308A\u307E\u3057\u305F\u304C\u3001\u30D0\u30EA\u30A2\u30F3\u30C8\u306E\u7D44\u307F\u5408\u308F\u305B\uFF08${desc}\uFF09\u304C\u65B0\u30E9\u30A4\u30D6\u30E9\u30EA\u306B\u3042\u308A\u307E\u305B\u3093`,
          category: "variant"
        };
      }
      return { key: child.key };
    }
    const comp = nameToComponent.get(matchName);
    if (!comp) {
      return { reason: `\u300C${matchName}\u300D\u3068\u3044\u3046\u540D\u524D\u306E\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u304C\u65B0\u30E9\u30A4\u30D6\u30E9\u30EA\u306B\u898B\u3064\u304B\u308A\u307E\u305B\u3093`, category: "name" };
    }
    return { key: comp.key };
  }
  async function handleScanSwap(scope, mapping) {
    swapScanCancelled = false;
    const nameToComponent = /* @__PURE__ */ new Map();
    for (const c of mapping.components) nameToComponent.set(c.name, c);
    const nameToSet = /* @__PURE__ */ new Map();
    for (const s of mapping.componentSets) nameToSet.set(s.name, s);
    const targets = await collectTargets(scope);
    post({ type: "swap-scan-started", total: targets.length });
    for (const inst of targets) {
      if (swapScanCancelled) break;
      try {
        let main;
        try {
          main = await inst.getMainComponentAsync();
        } catch (e) {
          main = null;
        }
        if (!main) {
          post({
            type: "swap-scan-item-excluded",
            id: inst.id,
            name: inst.name,
            reason: "\u672A\u30D1\u30D6\u30EA\u30C3\u30B7\u30E5\u306E\u30ED\u30FC\u30AB\u30EB\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8",
            category: "other"
          });
          continue;
        }
        const parent = main.parent;
        const isSet = parent !== null && parent.type === "COMPONENT_SET";
        const matchName = isSet ? parent.name : main.name;
        const result = resolveSwapTarget(matchName, isSet, inst.variantProperties, nameToComponent, nameToSet);
        if ("reason" in result) {
          post({
            type: "swap-scan-item-excluded",
            id: inst.id,
            name: inst.name,
            reason: result.reason,
            category: result.category
          });
          continue;
        }
        let target;
        try {
          target = await figma.importComponentByKeyAsync(result.key);
        } catch (e) {
          post({
            type: "swap-scan-item-excluded",
            id: inst.id,
            name: inst.name,
            reason: "\u5BFE\u5FDC\u3059\u308B\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u306E\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F",
            category: "other"
          });
          continue;
        }
        if (swapScanCancelled) break;
        store.set(inst.id, { instance: inst, latestComponent: target, source: "swap" });
        await computeAndSendDiff(inst, target, "swap-scan-item-result");
      } catch (e) {
        store.delete(inst.id);
        post({
          type: "swap-scan-item-excluded",
          id: inst.id,
          name: inst.name,
          reason: "\u6BD4\u8F03\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\uFF08\u7DE8\u96C6\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\uFF09",
          category: "other"
        });
      }
      figma.commitUndo();
    }
    post({ type: swapScanCancelled ? "swap-scan-cancelled" : "swap-scan-done" });
    post({ type: "marker-count", count: (await findAllTaggedNodes()).length });
  }
  function findOwningPage(node) {
    let p = node;
    while (p.parent && p.parent.type !== "DOCUMENT") p = p.parent;
    return p.type === "PAGE" ? p : null;
  }
  function jumpToNode(node) {
    const page = findOwningPage(node);
    if (page) figma.currentPage = page;
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  async function handleJump(id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || !("type" in node)) return;
    if (node.type === "DOCUMENT" || node.type === "PAGE") return;
    jumpToNode(node);
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
        case "clear-markers":
          await handleClearMarkers();
          break;
        case "scan-library":
          await handleScanLibrary();
          break;
        case "scan-swap":
          if (msg.scope && msg.mapping) await handleScanSwap(msg.scope, msg.mapping);
          break;
        case "cancel-swap-scan":
          swapScanCancelled = true;
          break;
      }
    } catch (err) {
      postError(String(err));
    }
  };
})();
