"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 420, height: 660 });
  var SWAP_MAPPING_CACHE_KEY = "swap-mapping-cache";
  (async () => {
    const cached = await figma.clientStorage.getAsync(SWAP_MAPPING_CACHE_KEY);
    if (Array.isArray(cached) && cached.length) {
      post({ type: "swap-mapping-cache-loaded", raws: cached });
    }
  })();
  var store = /* @__PURE__ */ new Map();
  var wrapperStore = /* @__PURE__ */ new Map();
  var scanCancelled = false;
  var swapScanCancelled = false;
  var libraryScanCancelled = false;
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
  async function importComponentWithRetry(key, attempts = 3) {
    let lastErr;
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
          latest = await importComponentWithRetry(main.key);
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
  var variableCollectionCache = /* @__PURE__ */ new Map();
  async function getCachedVariableCollection(id) {
    var _a;
    if (variableCollectionCache.has(id)) return (_a = variableCollectionCache.get(id)) != null ? _a : null;
    let collection = null;
    try {
      collection = await figma.variables.getVariableCollectionByIdAsync(id);
    } catch (e) {
      collection = null;
    }
    variableCollectionCache.set(id, collection);
    return collection;
  }
  async function computeAndSendDiff(inst, latest, resultType) {
    var _a;
    const beforeWidth = inst.width;
    const beforeHeight = inst.height;
    const beforeBytes = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const anchor = figma.createFrame();
    anchor.name = "Update Diff Guard \u2014 diff sandbox";
    anchor.fills = [];
    anchor.clipsContent = false;
    ((_a = findOwningPage(inst)) != null ? _a : figma.currentPage).appendChild(anchor);
    anchor.x = 0;
    anchor.y = 0;
    const resolvedModes = inst.resolvedVariableModes;
    for (const collectionId of Object.keys(resolvedModes)) {
      const collection = await getCachedVariableCollection(collectionId);
      if (collection) anchor.setExplicitVariableModeForCollection(collection, resolvedModes[collectionId]);
    }
    const clone = inst.clone();
    clone.name = `${inst.name} (diff candidate)`;
    anchor.appendChild(clone);
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
      anchor.remove();
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
    libraryScanCancelled = false;
    const components = [];
    const componentSets = [];
    const BATCH_SIZE = 30;
    const pages = figma.root.children;
    const totalPages = pages.length;
    let pagesCompleted = 0;
    post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned: 0, pageTotal: 0 });
    let nodesVisited = 0;
    let sinceYield = 0;
    const YIELD_EVERY = 250;
    async function walk(node, out) {
      if (libraryScanCancelled) return;
      nodesVisited++;
      sinceYield++;
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        post({ type: "library-scan-walk-progress", pagesCompleted, totalPages, nodesVisited });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        out.push(node);
        return;
      }
      if (node.type === "INSTANCE") return;
      if ("children" in node) {
        for (const child of node.children) {
          if (libraryScanCancelled) return;
          await walk(child, out);
        }
      }
    }
    for (const page of pages) {
      if (libraryScanCancelled) break;
      await page.loadAsync();
      const candidates = [];
      for (const child of page.children) {
        if (libraryScanCancelled) break;
        await walk(child, candidates);
      }
      if (libraryScanCancelled) break;
      let pageScanned = 0;
      post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned, pageTotal: candidates.length });
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        if (libraryScanCancelled) break;
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const statuses = await Promise.all(batch.map((node) => node.getPublishStatusAsync()));
        batch.forEach((node, idx) => {
          if (statuses[idx] === "UNPUBLISHED") return;
          if (node.type === "COMPONENT_SET") {
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
                var _a;
                return { key: c.key, variantProperties: (_a = c.variantProperties) != null ? _a : {} };
              }),
              defaultVariantKey: node.defaultVariant.key
            });
          } else if (node.type === "COMPONENT") {
            components.push({ name: node.name, key: node.key, path: nodePath(node) });
          }
        });
        pageScanned += batch.length;
        post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned, pageTotal: candidates.length });
      }
      if (libraryScanCancelled) break;
      pagesCompleted++;
      post({ type: "library-scan-progress", pagesCompleted, totalPages, pageScanned: candidates.length, pageTotal: candidates.length });
    }
    if (libraryScanCancelled) {
      post({ type: "library-scan-cancelled" });
      return;
    }
    const data = {
      libraryName: figma.root.name,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      components,
      componentSets
    };
    let coverThumbnail;
    try {
      const thumbNode = await figma.getFileThumbnailNodeAsync();
      if (thumbNode) {
        coverThumbnail = await thumbNode.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 64 } });
      }
    } catch (e) {
    }
    post({ type: "library-scan-done", data, coverThumbnail });
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
        return { reason: "\u540D\u524D\u304C\u4E00\u81F4\u3059\u308B\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093", category: "name" };
      }
      const current = currentVariantProperties != null ? currentVariantProperties : {};
      const child = set.children.find((c) => variantPropsEqual(c.variantProperties, current));
      if (!child) {
        if (set.defaultVariantKey) {
          return { key: set.defaultVariantKey, variantFallback: true };
        }
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
      return { reason: "\u540D\u524D\u304C\u4E00\u81F4\u3059\u308B\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093", category: "name" };
    }
    return { key: comp.key };
  }
  async function handleScanSwap(scope, mappings) {
    swapScanCancelled = false;
    const nameToComponent = /* @__PURE__ */ new Map();
    const nameToSet = /* @__PURE__ */ new Map();
    for (const mapping of mappings) {
      for (const c of mapping.components) {
        if (!nameToComponent.has(c.name)) nameToComponent.set(c.name, c);
      }
      for (const s of mapping.componentSets) {
        if (!nameToSet.has(s.name)) nameToSet.set(s.name, s);
      }
    }
    const swapStrayThumbnailSent = /* @__PURE__ */ new Set();
    async function postSwapExcluded(inst, reason, category) {
      const groupKey = `${inst.name} ${reason}`;
      let thumbnail;
      if (!swapStrayThumbnailSent.has(groupKey)) {
        swapStrayThumbnailSent.add(groupKey);
        try {
          thumbnail = await inst.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
        } catch (e) {
        }
      }
      post({ type: "swap-scan-item-excluded", id: inst.id, name: inst.name, path: nodePath(inst), reason, category, thumbnail });
    }
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
          await postSwapExcluded(inst, "\u672A\u30D1\u30D6\u30EA\u30C3\u30B7\u30E5\u306E\u30ED\u30FC\u30AB\u30EB\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8", "other");
          continue;
        }
        const parent = main.parent;
        const isSet = parent !== null && parent.type === "COMPONENT_SET";
        const matchName = isSet ? parent.name : main.name;
        const result = resolveSwapTarget(matchName, isSet, inst.variantProperties, nameToComponent, nameToSet);
        if ("reason" in result) {
          await postSwapExcluded(inst, result.reason, result.category);
          continue;
        }
        let target;
        try {
          target = await importComponentWithRetry(result.key);
        } catch (e) {
          await postSwapExcluded(inst, "\u5BFE\u5FDC\u3059\u308B\u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u306E\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F", "other");
          continue;
        }
        if (target.key === main.key) {
          post({ type: "swap-scan-item-already-latest", name: inst.name });
          continue;
        }
        if (swapScanCancelled) break;
        store.set(inst.id, { instance: inst, latestComponent: target, source: "swap" });
        const resultType = "variantFallback" in result ? "swap-scan-item-variant-result" : "swap-scan-item-result";
        await computeAndSendDiff(inst, target, resultType);
      } catch (e) {
        store.delete(inst.id);
        await postSwapExcluded(inst, "\u6BD4\u8F03\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\uFF08\u7DE8\u96C6\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\uFF09", "other");
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
  async function handleSelectOnCanvas(ids) {
    const nodes = [];
    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "type" in node && node.type !== "DOCUMENT" && node.type !== "PAGE") nodes.push(node);
    }
    if (!nodes.length) return;
    const onCurrentPage = nodes.filter((n) => {
      var _a;
      return ((_a = findOwningPage(n)) == null ? void 0 : _a.id) === figma.currentPage.id;
    });
    if (onCurrentPage.length) {
      figma.currentPage.selection = onCurrentPage;
      figma.viewport.scrollAndZoomIntoView(onCurrentPage);
      return;
    }
    const firstPage = findOwningPage(nodes[0]);
    if (!firstPage) return;
    figma.currentPage = firstPage;
    const onFirstPage = nodes.filter((n) => {
      var _a;
      return ((_a = findOwningPage(n)) == null ? void 0 : _a.id) === firstPage.id;
    });
    figma.currentPage.selection = onFirstPage;
    figma.viewport.scrollAndZoomIntoView(onFirstPage);
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
        case "select-on-canvas":
          if (msg.ids) await handleSelectOnCanvas(msg.ids);
          break;
        case "clear-markers":
          await handleClearMarkers();
          break;
        case "scan-library":
          await handleScanLibrary();
          break;
        case "cancel-library-scan":
          libraryScanCancelled = true;
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
})();
