# Update Diff Guard (dev / validation build)

This is a stripped-down build whose only goal is to validate the riskiest
assumptions in [Spec.md](Spec.md) directly inside Figma, before investing in
the full tabbed UI:

- Does `swapComponent()` on a live instance preserve overrides the way
  Figma's own "Update" button does?
- Does `swapComponent()` preserve the node's identity (so a FigJam arrow
  connector that references this node survives)?
- Does comparing `importComponentByKeyAsync(key).id` against the instance's
  current `mainComponent.id` reliably detect "already latest" vs "update
  available"?
- Does `exportAsync()` → `pixelmatch` produce a usable Before/After/Diff
  image set?

The UI here is intentionally plain (flat list, no tabs/accordion/marking) —
see Spec.md for the intended final design.

## Setup

```bash
npm install
npm run build
```

`npm run watch` rebuilds on save.

## Load into Figma

1. Open Figma desktop app.
2. Menu → Plugins → Development → **Import plugin from manifest…**
3. Select `manifest.json` in this folder.
4. Menu → Plugins → Development → **Update Diff Guard (dev)** to run it.

Figma reads `dist/code.js` and `dist/ui.html` — rebuild after any source
change and re-run the plugin (no reimport needed).

## What to check while testing

1. Select a frame containing an instance of a component whose library has a
   newer published version, then **Scan**.
2. Click **差分テスト** (test diff) on a "更新あり" row — confirm the
   Before/After/Diff thumbnails look right and the diff % matches what you'd
   expect from the override you changed (e.g. a toggled switch).
3. If the instance has a FigJam arrow connected to it, click
   **適用（in-place swap）** and confirm the arrow is still attached
   afterward (this is the constraint the whole project exists for — see
   Spec.md §1).
4. Undo (Ctrl+Z) and confirm the instance and any test artifacts are fully
   reverted.
