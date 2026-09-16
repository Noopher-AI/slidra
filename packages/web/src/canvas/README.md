# `packages/web/src/canvas/`

Internal modules extracted out of `../canvas.ts` ([S10]/#379). `canvas.ts` stays the public entry
point — every name in `CanvasController` and the rest of the frozen surface still comes from
`./canvas.js`, and this directory is not imported by other product code in `packages/web/src`; unit
tests do import the stateless helpers here directly (e.g. `test/canvas-gesture-geometry.test.ts`
imports `canvas/gesture-geometry.js`). Two shapes of module live
here: **stateless helpers** (pure functions and types, no dependency object) and **domain factories**
(a `create*(deps)` function that returns the handlers `mountCanvas` wires up, reachable only through
the fields its dependency interface declares). See `AGENTS.md` for how a move or a rename in this
directory's history is verified, and `.dev_docs/adr/0024-extracted-modules-take-a-named-dependency-object.md`
for why a dependency object and not a shared internals bag.

## Stateless helpers

- **`runtime-messages.ts`** — the postMessage protocol's shapes and type guards: `PlayerMessage`,
  `SelectionMessage`, and everything `isPlayerMessage`/`isSelectionMessage`/`isMeasuredItem` validate
  before `canvas.ts` or `runtime-message-handlers.ts` acts on a message. No dependency object; every
  export is a pure function or a type.
- **`gesture-geometry.ts`** — the gesture and viewport types (`MoveGesture`, `ScaleGesture`,
  `RotateGesture`, `TextboxWidthGesture`, `MarqueeGesture`, `Viewport`, `TextEditState`) plus the pure
  geometry `gestures.ts` builds on (`rectsIntersect`, `cornerPoint`, `OPPOSITE_CORNER`,
  `flattenElements`, `subtreeForcesUniformScale`). No dependency object.
- **`frame-documents.ts`** — builds the three wrapper documents the sandboxed iframes load
  (`wrapSlideDocument`, `wrapSelectionDocument`, `wrapPlayDocument`), the presentation font-face
  `<style>` block (`presentationFontFaces`/`setPresentationFonts`), and `slideDirectory`. No
  dependency object; `setPresentationFonts` owns one piece of module-level state (the font-face
  string every wrap function reads), by design (see the file's own header comment) rather than a
  parameter threaded through four call sites.
- **`project-io.ts`** — `project.json`-shaped helpers: `normalizeTemplatePaths`,
  `pageTransitionTransform`, and `fetchAssetList`. No dependency object.

## Domain factories

- **`gestures.ts`** (`GestureDeps`, 14 top-level fields) — `createGestures` owns drag-to-move, the
  four scale handles, the rotate handle, the textbox-width handles, marquee select, and the two
  host-level pointer listeners that catch a move gesture once the pointer leaves the sandboxed
  iframe. Its dependency interface reaches: the shared `activeGesture` slot, `frame`'s viewport and
  generation (read-only), `selection`, the two `overlay` fields a gesture paints (`guides`,
  `settling`), and five narrower sub-interfaces (`slide`, `editingLease`, `pendingSelection`,
  `publish`, `coords`) plus direct callbacks (`toParentClientPoint`, `postToFrame`, `postCommand`,
  `setError`, `isDestroyed`). It cannot reach table range, chart window, embed, or play-mode state.
- **`runtime-message-handlers.ts`** (`RuntimeMessageDeps`, 13 top-level fields) — `createRuntimeMessageHandlers`
  owns the `window` message listener (`onWindowMessage`) and the selection-message handler
  (`handleSelectionMessage`), including the `isScaleHandle`/`isTextboxHandle` predicates and
  `isAnyElementFullscreen`. Its dependency interface reaches `frame`, `selection`, `overlay`,
  `tableRange`, the shared `activeGesture` slot, and eight narrower sub-interfaces (`gestures`,
  `session`, `editing`, `playback`, `commands`, `table`, `host`, `publish`) — it does not import
  `gestures.ts` directly (ADR-0024): where it needs a gesture handler, the entry supplies it as a
  callback field on `gestures: RuntimeMessageGestureDeps`.
- **`play-mode.ts`** (`PlayModeDeps`, 14 top-level fields) — `createPlayMode` owns play-mode
  rendering and transitions, navigation (`next`/`previous`), preview, player focus, and frame
  rebuild, plus the standalone `buildFrame` used to construct the sandboxed iframe itself. Its
  dependency interface reaches `frame`, `selection`, the shared `activeGesture` slot, `overlay`,
  `chartWindow`, `embeds`, the mount `container`, `deck` (slide list/index), and four narrower
  sub-interfaces (`session`, `slideState`, `selectionState`, `publish`), plus two callbacks
  (`commitTextEditIfEditing`, `render`). `render()` and `selectionColors()` deliberately stay in the
  entry rather than being absorbed into this interface — they have call sites outside play mode, and
  `render` is the seam, not an invitation to inline its body here.

## What stays in the entry

`canvas.ts` keeps the closure state these factories read and write (`selection`, `overlay`, `frame`,
`tableRange`, `chartWindow`, `embeds`, `listeners`), the wiring that constructs each dependency object,
and the domains small enough — or state-owning enough — that extracting them would not have narrowed
anything: select/delete/duplicate/order, in-place text editing, the chart data window, command
posting, asset import, style and page setters, and view-mode reload/render.
