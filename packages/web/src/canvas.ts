/**
 * The canvas: a vanilla DOM module. React hands it a container element and
 * never touches what ends up inside it (ADR-0001) — the 投影片 is the
 * artifact loaded from the presentation file, not something React computes
 * from state.
 *
 * `reload()` is the seam future tickets hook into: #5's change-push handler
 * calls it directly when the watched file changes on disk, redrawing the
 * slide without React re-rendering anything.
 *
 * A `.comot` is meant to be opened by people other than its author (ADR-0003
 * — that's the point of it being a single shareable file). Slide markup is
 * therefore untrusted: a legal SVG can carry `onload`/`onerror` handlers or
 * an active `<foreignObject>`, and if it were injected with `innerHTML` into
 * this document it would run as first-party script, able to call
 * `/api/files/*` and exfiltrate the presentation. It is rendered inside a
 * sandboxed iframe instead, fed via `srcdoc`, which puts it in an opaque
 * origin — not a construct that is blocked from reaching the app, but one
 * that has nowhere to reach the app from. See the comment on the iframe's
 * `sandbox` attribute below before changing it.
 *
 * 播放模式 (ticket #28) reuses the same posture with one deliberate
 * loosening: the play iframe gets `allow-scripts` so the player runtime can
 * run, but never `allow-same-origin` (ADR-0010) — the pair together would
 * let the iframe script itself free of its own sandbox. Because the
 * `sandbox` attribute cannot be changed on a live iframe, entering or
 * leaving play mode destroys the current iframe and builds a fresh one.
 *
 * 元素選取 (ticket #56, ADR-0011) extends the same loosening to view mode:
 * a zero-token sandbox delivers no clicks to the parent at all (no script,
 * no `allow-same-origin`, nothing bubbles out), so the view-mode iframe now
 * also carries `allow-scripts` — with the same `allow-same-origin` ban —
 * and gets its own injected script (selection-runtime.js) whose only job is
 * reporting which element was clicked and drawing a selection box over it.
 * The zero-token posture stays untouched for the overview thumbnails
 * (overview.ts): this loosening is cut in exactly one place, the main
 * canvas.
 *
 * Since #72 that runtime resolves a click to the OUTERMOST id-carrying
 * ancestor — an element's `<g>` container, or the whole group when the
 * element sits inside one (ADR-0012). Nothing changes on this side of the
 * seam: the `{ id, name }` arriving over postMessage has always been the
 * resolved node's own `id` and `data-comot-name`, and after conversion
 * that node is the container.
 *
 * NOOP-91 (direct manipulation) extends the same runtime with drag-to-move
 * and marquee select. The runtime (selection-runtime.js) only ever reports
 * raw client-px coordinates and paints whatever transform/guide/marquee
 * string this module hands it — matrix decompose and snapping happen here,
 * using this package's own `geometry.ts` (F8, NOOP-289 — the web bundle no
 * longer depends on core at all), because the runtime is an unbundled
 * `?raw` script that cannot import anything. Bounding-box geometry is the
 * one exception (決定 G1): the runtime measures real rendered geometry
 * (`getBBox()`/`getCTM()`) itself and reports it up, since there is no
 * bundled font-metrics engine here any more to compute one from the parsed
 * model. See docs on the postMessage protocol below (`SelectionMessage`).
 */
import playerRuntimeSource from "./player-runtime.js?raw";
import selectionRuntimeSource from "./selection-runtime.js?raw";
import type { EmbedProvider } from "./embed.js";
import { computePlayerPlan, renderHideStyle, renderPlanScript, stageEmbedsFor, stageMediaFor, type StageEmbedEntry } from "./player-plan.js";
import { fetchSlideEffectPlan, invalidateSlideEffectPlans } from "./effects.js";
import type { Effect, PageTransitionEffect, SlideTransition } from "./effects.js";
import {
  decomposeMatrix,
  formatTransform,
  snapTranslation,
  composeMatrices,
  applyMatrixToPoint,
  invertMatrix,
  type Matrix,
  type Rect,
  type TransformParts,
  type SnapCandidate,
  type SnapGuide,
} from "./geometry.js";
import {
  parseSlide,
  type PageStyle,
  type SlideElement,
  type SlideModel,
} from "./slide-dom.js";
import { INITIAL_PASTE_OFFSET_STATE, clipboardWritten, nextPasteOffset, type PasteOffsetState } from "./paste-offset.js";
import { classifyClipboardText } from "./clipboard/payload.js";
import { pasteCommandFor, type CellRangeProvider, type ClipboardTarget } from "./clipboard/dispatch.js";
import { tabTarget, cellsInRange, normalizeRange, isCellInRange, type CellRange } from "./table-overlay.js";
import { readChartModel, type ChartModel } from "./chart-model.js";

export type CanvasMode = "view" | "play" | "preview";

/**
 * A `selection-runtime.js` wheel/pointer/keyboard event, already validated
 * and — for every variant that carries a `point` — converted from the
 * iframe's own client coordinates into this parent document's client
 * coordinates (`toParentClientPoint` below). This is a pure relay: canvas.ts
 * does zero zoom/pan geometry itself (Dev-Leader 裁決 NOOP-83 §2 決定 2) —
 * `point`/`deltaX`/`deltaY` are handed to `subscribeStageInput`'s listener
 * (Stage.tsx) in exactly the shape its existing local `handleWheel`/
 * `handleMouseDown` math already expects from a real DOM `WheelEvent`/
 * `MouseEvent` — Stage.tsx runs that same math unmodified against this
 * event's `point`/`deltaX`/`deltaY`. Only emitted for on-slide input; the
 * gutter (留白) area's own DOM listeners keep calling that math directly.
 */
export type StageInputEvent =
  | { type: "wheel-zoom"; point: { x: number; y: number }; deltaY: number }
  | { type: "wheel-pan"; deltaX: number; deltaY: number }
  | { type: "pan-start"; point: { x: number; y: number } }
  | { type: "pan-move"; point: { x: number; y: number } }
  | { type: "pan-end" }
  | { type: "space-down" }
  | { type: "space-up" };

/**
 * The elements the author currently has selected in view mode (NOOP-91
 * §4.8). Purely a front-end concept — never written to the presentation,
 * never affects a command's semantics beyond supplying `elementIds`.
 */
export interface CanvasSelection {
  /** Selected in order; length 0 means nothing is selected. */
  ids: string[];
  /** `ids[i]`'s `data-comot-name`; `null` when the element carries none. */
  names: (string | null)[];
  /**
   * Group ids entered via double-click, outermost first; [] = top level.
   * Purely a front-end scoping concept — selection-runtime.js owns it (it
   * changes what a click inside the sandboxed iframe hits) and mirrors it
   * up over postMessage; no command is ever sent for it.
   */
  groupPath: string[];
  /**
   * `ids[i]`'s parsed `SlideElement`, straight off `currentSlideModel` (NOOP-143 §1
   * decision 2/3) — `null` when the id is not found in the current model (a
   * reload raced the selection). Parallel to `ids`/`names`, same length.
   * The style panel reads current values off these and computes its own
   * summary (`summarizeSelection` in style-attrs.ts); this module does not
   * do that aggregation itself.
   */
  elements: (SlideElement | null)[];
}

/**
 * High-frequency overlay geometry (NOOP-90/T2 §4.6/§8 決定 1): name/group
 * labels, snap guides, and the element context menu are painted by the
 * PARENT document now (`shell/stage-overlays/`), not inside the sandboxed
 * iframe — everything here is already converted into THIS document's
 * client px (`toParentClientPoint`'s own space), ready to use as a `left`/
 * `top` CSS value once an overlay component subtracts its own positioned
 * ancestor's `getBoundingClientRect()`. Delivered through `subscribeOverlay`
 * rather than `CanvasState`/`subscribe` because it can update many times a
 * second during a drag — routing it through React state on every frame
 * would force a re-render storm for something no component needs to
 * `useState` over.
 */
export interface OverlayState {
  /** One rect per still-resolvable selected id, parent-document client px. */
  boxes: Rect[];
  /** The union of every `boxes[]` entry; `null` when nothing is selected. */
  union: Rect | null;
  /** `null` when nothing is selected; `"N elements"` for a multi-selection (no path); the single selected element's own name/id and ancestor-chain names (outermost first) otherwise — F9 (群組) reads `path` for its "Group 2 › Group 1" drill-in label. */
  label: { text: string; path: string[] } | null;
  /** Snap guide lines from the in-progress move gesture, parent-document client px; empty between drags. */
  guides: { orientation: "v" | "h"; position: number }[];
  /** `true` while a move/scale/rotate/textbox-width gesture is in progress — the context bar hides itself during a drag (the selection box and label stay). */
  dragging: boolean;
  /**
   * [E2.T7]: whether at least one currently-selected id has an effect
   * targeting it (parsed straight off the current slide markup, tolerating
   * a parse failure as "no animations" — same posture the GUI table gives
   * a broken effect list in view mode: no cards, no badges, no error
   * toast). ContextBar's Edit animation entry (next to Edit style, `spark`
   * icon) renders only when this is true; `hasAnimation = ids.some(...)`
   * so a multi-selection with only some animated members still shows it.
   */
  hasAnimation: boolean;
  /**
   * [E2.T7]/D9: one entry per element that has at least one effect on the
   * CURRENT slide (not just the selection) — the stage's numbered
   * animation badges. `n` is 1-based: the position of that target's first
   * effect entry in the file, matching Animate › Object's own card order.
   * Measured on demand via a `measure`/`measured` round trip, deliberately
   * kept out of the high-frequency `bounds` channel (see
   * selection-runtime.js's `reportMeasured`) — empty whenever the slide has
   * no effects, or outside view mode.
   */
  badges: { target: string; n: number; rect: Rect }[];
}

/**
 * The open chart data window's target and its live `ChartModel` (E2.T12
 * plan §2.8/§3.6/§4.5) — `null` means no window is open. Re-derived fresh
 * off `currentSlideMarkup` (`readChartModel`) after every render(), so a
 * committed edit's normalized result (e.g. `formatSvgNumber` rounding)
 * always reflects back into the open window instead of the window quietly
 * drifting from the file. A separate channel from `CanvasState`/
 * `subscribeOverlay` for the same reason those are already split apart:
 * this fires on a cadence (every reload) and shape neither one matches.
 */
export interface ChartWindowState {
  id: string;
  slidePath: string;
  model: ChartModel;
}

export interface CanvasState {
  /** Slide virtual paths, in project.json's own order. */
  slides: string[];
  /** Currently selected index; -1 when the presentation has no slides. */
  currentIndex: number;
  mode: CanvasMode;
  /** Only meaningful while mode === "play". */
  playerHasFocus: boolean;
  /** Set when the current slide's effect list cannot be run, or the last direct-manipulation command failed; cleared on the next successful render/command. */
  error: string | null;
  /** The elements currently selected in view mode. Never written to the presentation. */
  selection: CanvasSelection;
  /**
   * Bumped every time the sandboxed iframe reports a `dragenter` (T3/
   * NOOP-142) — a one-shot edge signal, not a level. The iframe's own
   * `dragover`/`drop`/`dragleave` never reach the parent document (they
   * are captured by the iframe's document instead), so App.tsx cannot use
   * native DOM events to know a drag has entered the slide area; this
   * counter is that missing signal. A listener reacts to the counter
   * *changing*, never to its absolute value.
   */
  dragSignal: number;
  /**
   * #200 §4.4: the current slide's Page style, straight off
   * `currentSlideModel.pageStyle` — `null` while there is no current slide
   * (`currentIndex === -1`), never a fabricated `{background: null, accent:
   * null}` for that case (Style › Page is disabled entirely then, §4.6).
   */
  pageStyle: PageStyle | null;
}

/**
 * Mirrors the server's `AssetImportData` (`packages/cli/src/commands/asset-import.ts`)
 * without importing the CLI package into the browser bundle — this module
 * only knows the wire shape `POST /api/asset` sends back on success.
 */
export interface ImportedAsset {
  /** Virtual path, e.g. "assets/photo.png" — relative to the presentation root, not the slide (`slides/`, so callers must prefix `../`). */
  path: string;
  mimeType: string;
  kind: "image" | "video" | "audio";
}

export type ImportAssetResult = { ok: true; message: string; data: ImportedAsset } | { ok: false; message: string };

export interface CanvasController {
  reload: () => Promise<void>;
  /**
   * Throws when the index is out of range — that is a programming error,
   * not user input. `selectAfter` ([E2.T8]): re-selects these element ids
   * once the newly navigated page has actually loaded — Pinned context's
   * own row click needs this (jump to a different slide, then select the
   * comment's target); calling the separate `selectElement` right after
   * this promise resolves would race the iframe's own navigation and be
   * silently dropped (see this function's own implementation comment).
   */
  showSlide: (index: number, selectAfter?: readonly string[]) => Promise<void>;
  /** No-op (and no throw) when already on the last slide. */
  next: () => Promise<void>;
  /** No-op (and no throw) when already on the first slide. */
  previous: () => Promise<void>;
  /** Returns an unsubscribe function. The listener is called once immediately with the current state. */
  subscribe: (listener: (state: CanvasState) => void) => () => void;
  destroy: () => void;
  /** Rebuilds the iframe with `allow-scripts` and enters play mode on the current slide. */
  play: () => Promise<void>;
  /** Rebuilds the iframe back to view mode's `allow-scripts` sandbox (ADR-0011). */
  exitPlay: () => Promise<void>;
  /**
   * [E2.T7]/D8: plays `effectIndices` (a specific card's own effect-list
   * positions) or, when `null`, the whole slide's steps in sequence (the
   * panel's Preview button) — via the play runtime, not a second animation
   * engine. Returns to view mode on its own once the runtime reports
   * completion; the promise itself resolves once the preview has STARTED
   * rendering, not once it finishes. No-op outside view mode.
   */
  previewEffects: (effectIndices: number[] | null) => Promise<void>;
  /** Ends Preview immediately (Esc / click-away) and restores the selection Preview was entered with. No-op outside preview mode. */
  exitPreview: () => void;
  /** Sends focus to the player iframe. Safe to call outside play mode (no-op). */
  focusPlayer: () => void;
  /**
   * Asks the player runtime to advance/retreat one step, for when the
   * arrow key was pressed while focus sat outside the player iframe and
   * the runtime's own keydown listener never saw it (#68). Safe to call
   * outside play mode (no-op). See the runtime's `message` handler for
   * the transient-activation limit this path carries.
   */
  stepPlayer: (direction: "advance" | "retreat") => void;
  /**
   * Opens `elementId` for in-place text editing (NOOP-91/#70 US1, T5) — the
   * same entry point double-clicking an existing text box on the canvas
   * uses. No-op (no throw) when `elementId` does not name an existing,
   * unlocked text box, the canvas is not in view mode, or the box's font
   * cannot be resolved (`CanvasState.error` is set in that last case).
   * Resolves once editing has actually started (or the attempt has been
   * abandoned) — never once the edit itself is committed.
   */
  beginTextEdit: (elementId: string) => Promise<void>;
  /**
   * Sends a whitelisted command (NOOP-141's Ribbon 常用 buttons). The only
   * general-purpose write entry point this controller exposes — it forwards
   * to the module's own `postCommand`, the front end's one write path
   * (§4.9), so callers never open a second `fetch("/api/command")`. Failure
   * is surfaced through `CanvasState.error`, never thrown and never
   * swallowed; the write itself, on success, arrives back over
   * `/api/events` and drives `reload()` on its own (no optimistic preview
   * here).
   */
  runCommand: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; message: string; data?: unknown }>;
  /**
   * Uploads one file's raw bytes to `POST /api/asset` (T3/NOOP-142 — the
   * human asset-import path: file picker, drag/drop, clipboard paste).
   * Separate from `runCommand` because the transport is different (raw
   * bytes, not JSON `{name, input}`) — the whitelist and command-dispatch
   * machinery `runCommand` wraps do not apply here at all, `asset import`
   * is deliberately not on `/api/command`'s whitelist. Same failure
   * posture as `runCommand`: never thrown, surfaced through
   * `CanvasState.error`, and a success clears any stale error.
   */
  importAsset: (file: File) => Promise<ImportAssetResult>;
  /**
   * [E2.T17] plan §4.3/D5 — the URL-source counterpart of `importAsset`,
   * for the Image/Video/Audio panels' URL text field. Same transport family
   * as `importAsset` (`POST /api/asset`, same 409-freeze gate, same
   * `CanvasState.error` failure posture), just a different header instead
   * of a raw-bytes body.
   */
  importAssetFromUrl: (url: string) => Promise<ImportAssetResult>;
  /**
   * Surfaces `message` through the same `CanvasState.error` → `[role=alert]`
   * channel `runCommand`/`importAsset` already use (決定 7), for a front-end
   * validation failure that never reaches the network — e.g. App.tsx
   * rejecting a multi-file drop before calling `importAsset` at all. Never
   * used for a real command/import failure; those already report through
   * their own call.
   */
  reportError: (message: string) => void;
  /**
   * 樣式面板 (NOOP-143 §1 decision 4): sends `element style set` for the
   * current selection's every id in one call, with the given attr/value.
   * Returns `false` when the command failed — the message is already in
   * `CanvasState.error` by the time this resolves, matching `postCommand`'s
   * own error-surfacing contract; the caller reverts whatever it painted.
   */
  setStyle: (attr: string, value: string) => Promise<boolean>;
  /**
   * 樣式面板 (#200 §4.1): the Text section's Align field. Sends `textbox
   * align` once per currently-selected text box, sequentially (that command
   * names a single element, unlike `element style set`'s list form) — for
   * the common single-selection case this is one command, one undo step;
   * a multi-box selection costs one undo step per box. Same failure
   * contract as `setStyle`.
   */
  setTextAlign: (align: "left" | "center" | "right") => Promise<boolean>;
  /**
   * 樣式面板 (#200 §4.3/§4.4): Style › Page's Background/Accent fields.
   * Sends `slide style set` for the current slide. Same failure contract as
   * `setStyle`. No-op (returns `false`) when there is no current slide.
   */
  setPageStyle: (update: { background?: string; accent?: string }) => Promise<boolean>;
  /**
   * 樣式面板 (#200 §4.3): Style › Page's Width/Height/preset/swap controls.
   * Sends `presentation canvas set` — never occupies an undo step (the
   * command's own contract), unlike every other style-panel write. Same
   * failure contract as `setStyle` otherwise.
   */
  setCanvasSize: (width: number, height: number) => Promise<boolean>;
  /**
   * A live getter, not a snapshot: entering/leaving play mode destroys and
   * rebuilds the iframe (the `sandbox` attribute cannot change on a live
   * element), so a caller holding onto a stale reference would be a bug.
   * #29's fullscreen target is the play chrome container in App.tsx (which
   * holds both this iframe and the play controls), not this getter —
   * fullscreening the iframe itself left the parent document's own
   * controls unreachable to a real click once the iframe sat alone in the
   * browser's fullscreen top layer (see
   * ADR-0010, docs/adr/). This getter remains the
   * live reference to the current iframe for whatever else needs one, and
   * the "never cache it" rule above still applies to any such caller.
   */
  readonly frameElement: HTMLIFrameElement;
  /**
   * Stage.tsx's on-slide wheel/pointer/Space relay (NOOP-83 §2 決定 2/§4).
   * Fires only for `StageInputEvent`s the runtime reported that already
   * passed validation and (where relevant) coordinate conversion — see
   * that type's own doc comment. Returns an unsubscribe function, same
   * shape as `subscribe`.
   */
  subscribeStageInput: (listener: (event: StageInputEvent) => void) => () => void;
  /**
   * Tells `selection-runtime.js` whether 抓取模式 (the ✋ toggle or a
   * temporary Space-hold) is active — while true, the runtime hands every
   * pointer to the pan relay above instead of starting a selection/drag
   * gesture (§4.2). Re-sent automatically on the runtime's own
   * "runtime-ready" report (§2.1(c)), so toggling ✋ on and then changing
   * slides does not silently drop back to normal selection.
   */
  setStageHandMode: (hand: boolean) => void;
  /**
   * 05-INTERACTIONS.feature「抓取模式」's first "那麼": clears the current
   * selection the same way `handleSelectionMessage`'s own "clear" case
   * does (id/name/groupPath reset, notify, push the empty selection back
   * to the runtime) — extracted here so Stage.tsx's `handleToggleHand` can
   * call it directly instead of leaving the no-op gap NOOP-81 left behind.
   * No-op while `mode !== "view"`.
   */
  clearSelection: () => void;
  /**
   * [E2.T8] §4.7: selects a single element by id on the current slide,
   * clearing `groupPath` — Pinned context's own row click (jump to the
   * slide via `showSlide`, then this, then open the comment). No-op when
   * `id` does not resolve on the current slide, or outside view mode.
   */
  selectElement: (id: string) => void;
  /**
   * Overlay geometry: name/group labels and snap guides (NOOP-90/T2 §4.6). See `OverlayState`'s own doc comment
   * for why this is a separate channel from `subscribe`/`CanvasState`.
   */
  subscribeOverlay: (listener: (state: OverlayState) => void) => () => void;
  /**
   * [E2.T17] third-party embeds (YouTube). A separate channel from
   * `subscribeOverlay` because its consumer must stay mounted in play
   * mode, where `OverlayLayer` is not.
   */
  subscribeEmbeds: (listener: (state: EmbedState) => void) => () => void;
  /** Re-converts the stored embed geometry against the frame's rect right now — for a layout change (play mode, fullscreen) that the runtime has no way to report. */
  refreshEmbeds: () => void;
  /**
   * [E2.T17] "play/pause this embed", forwarded from a `family="media"`
   * effect. A transient event channel (same shape as `subscribeStageInput`,
   * not `subscribeEmbeds`): there is no "current command" for a late
   * subscriber to be caught up on.
   */
  subscribeEmbedCommand: (listener: (command: EmbedCommand) => void) => () => void;
  /**
   * Table cell hit reports (click/dblclick/contextmenu, E2.T14 §4.5) and
   * the reply to `requestTableCells`. Returns an unsubscribe function, same
   * shape as `subscribe`/`subscribeOverlay` — a transient event channel,
   * not a snapshot: nothing is replayed to a listener that subscribes
   * after an event already fired.
   */
  subscribeTable: (listener: (event: TableRuntimeEvent) => void) => () => void;
  /** Asks the runtime for `id`'s current per-cell rects + its own box (`table-cells` command) — the reply arrives on `subscribeTable` as a `{type: "cells"}` event. No-op (silently) outside view mode. */
  requestTableCells: (id: string) => void;
  /** A column-width drag's live preview (`preview-table-cols` command, 決定 13: never re-wraps text) — `cols` is the FULL column-width array with the dragged column's candidate width substituted in. No-op outside view mode. */
  previewTableCols: (id: string, cols: readonly number[]) => void;
  /**
   * The cell range currently active inside a selected table (E2.T14r2, plan
   * §4.1) — `null` when no range is active. Owned here (not `App.tsx`'s
   * React state, not `TableOverlay`'s local state) because the three
   * consumers (`TableOverlay`, `TableSection`, and the keyboard decision
   * function below) sit under different subtrees, and every piece of data
   * `handleTableRangeKey` needs — the selected `TableModel`, `slidePath`,
   * `runCommand` — already lives in this module. The listener is called
   * once immediately with the current value, same contract as `subscribe`/
   * `subscribeOverlay`.
   */
  subscribeTableRange: (listener: (value: { tableId: string; range: CellRange } | null) => void) => () => void;
  /** Sets or clears the active cell range. `null` clears it. Also tells the runtime (`table-range` command) so its own keyboard relay knows whether Delete/Tab/⌘B/Esc belong to the range or to the ordinary stage-key path. */
  setTableRange: (value: { tableId: string; range: CellRange } | null) => void;
  /**
   * The single decision function for every cell-range keyboard shortcut
   * (Tab/⇧Tab, Esc, Delete/Backspace, ⌘B) — both the iframe relay
   * (`selection-runtime.js`'s "table-key") and `App.tsx`'s capture-phase
   * `document` keydown listener call this same function, so the two input
   * paths (focus inside the iframe vs. focus in the parent document) can
   * never drift apart. Returns whether the key was handled — the caller is
   * responsible for `preventDefault`/`stopPropagation`. A `false` return
   * means the event should fall through to whatever handling already
   * exists for it (nothing here changes that path's behaviour).
   */
  handleTableRangeKey: (key: string, modifiers: { meta: boolean; ctrl: boolean; shift: boolean }) => boolean;
  /**
   * Re-emits the current overlay state with the frame's *current*
   * position/scale (issue 198 review). The runtime reports bounds in its own
   * iframe client px, which a zoom/pan of the parent's `.stage` transform
   * never changes — only the parent-side conversion goes stale. Stage.tsx
   * calls this after every zoomPan change so labels/context bar/context menu
   * follow the slide instead of waiting for the next selection change.
   */
  refreshOverlay: () => void;
  /** ⌘A (§4.1): selects every top-level element on the current slide, clearing `groupPath`. No-op on an empty slide. No-op outside view mode. */
  selectAll: () => void;
  /** [E2.T7]: selects exactly `ids` (a stage animation badge click) — ids that no longer resolve are dropped; a no-op if none resolve. No-op outside view mode. */
  selectElements: (ids: readonly string[]) => void;
  /** Delete/Backspace, or the context bar's Delete (§4.4): sends `element delete` for the current selection, then clears it. No-op (not an error) with no selection. */
  deleteSelection: () => Promise<void>;
  /** ⌘D, or the context bar's Duplicate (§4.4): sends `element duplicate` with the prototype's own +3%/+4% offset, selecting the new copy on success. No-op with no selection. */
  duplicateSelection: () => Promise<void>;
  /** ⌘]/⌘[/⌘⇧]/⌘⇧[, the Arrange menu's Order column, or the context bar's four Order buttons (§4.4): sends `element order` for the current selection. No-op with no selection. */
  orderSelection: (direction: "up" | "down" | "front" | "back") => Promise<void>;
  /** Arrange menu's Align column (§3.9): sends `element align`. No-op below the command's own ≥2-target minimum. */
  alignSelection: (direction: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => Promise<void>;
  /** Arrange menu's Distribute column (§3.9): sends `element distribute`. No-op below the command's own ≥3-target minimum. */
  distributeSelection: (axis: "horizontal" | "vertical") => Promise<void>;
  /** ⌘C, or the ContextBar Copy button (F8, NOOP-289 決定 (d)): sends `element copy`, resets the paste-offset run (`paste-offset.ts`'s `clipboardWritten`) on success. Never mutates the presentation. Returns the `svg` the caller should write via `navigator.clipboard.writeText`, or `null` with no selection or on command failure. */
  copySelection: () => Promise<string | null>;
  /** ⌘X, or the ContextBar Cut button: sends `element cut` (replaces the former local-serialize + `element delete` pair) — awaited, since (計畫 §3.8/A0) there is no synchronous ClipboardEvent to race against a mutation here. `null` with no selection or on command failure. */
  cutSelection: () => Promise<string | null>;
  /** ⌘V, or the ContextBar Paste button (計畫 §4.3): routes `text` — a co-motion elements payload, or plain text with a cell range selected — to the matching command; silent no-op for anything else (including plain text with nothing selected). The window `paste` event's own image-file branch (App.tsx) is untouched and independent of this. */
  pasteFromText: (text: string) => Promise<void>;
  /**
   * The Text insert panel's Insert action (NOOP-65 §3.8/A11): sends
   * `textbox add` for the current slide, selecting the new box on success
   * (already whitelisted in `SELECT_AFTER_COMMAND`, same as `element
   * insert`). No-op outside view mode.
   */
  insertTextBox: (input: {
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    fontWeight: number;
    align: "left" | "center" | "right";
  }) => Promise<void>;
  /** Closes the element context menu without acting on it (click-outside, Esc, or opening another floating layer — §4.5). No-op when already closed. */
  /**
   * E2.T12 plan §3.6/§4.5: the chart data window's own state — a
   * double-click on a chart (selection-runtime.js's "dblclick-chart") opens
   * it, `ChartWindow.tsx`'s own Esc listener or a slide change closes it.
   * `null` means closed. Separate from `subscribeOverlay` — see
   * `ChartWindowState`'s own doc comment.
   */
  subscribeChartWindow: (listener: (state: ChartWindowState | null) => void) => () => void;
  /** [F8, NOOP-289]: closes the chart data window (Esc). There is no local preview to discard any more (decision (c) — every control commits straight to a `chart *` command and waits for SSE), so this just clears `chartWindowTarget`. */
  closeChartWindow: () => void;
  /**
   * ⌘Z/⇧⌘Z relayed from inside the iframe (#198's "stage-key" `z`). The
   * controller never POSTs /api/undo|redo itself — App.tsx registers its own
   * `runUndoRedo` here so the document-level shortcut and the relayed one
   * share the single fetch path (and its editingFrozen gate). A relayed ⌘Z
   * before any handler is registered is dropped.
   */
  setUndoRedoHandler: (handler: ((kind: "undo" | "redo") => void) | null) => void;
}

interface ProjectJson {
  name: string;
  slides: string[];
  /**
   * Fonts embedded in the container (ticket #71's `FontEntry`, minimal
   * subset). Only present in the wire payload when the presentation
   * declares any — used by the textbox-width handle's live preview to
   * fetch and parse the exact font bytes `wrapText` needs (§4.4).
   */
  fonts?: { file: string; family: string }[];
}

/**
 * Turns a page transition's `effect` into the transform its start (enter)
 * or end (exit) state holds, alongside the animated `opacity` (§4.6's
 * keyframe table — values transcribed verbatim from the prototype).
 * `"none"`/`"fade"` never move the frame, only fade it.
 */
function pageTransitionTransform(effect: PageTransitionEffect, phase: "enter-start" | "exit-end"): string {
  if (effect === "slide") return phase === "enter-start" ? "translateX(8%)" : "translateX(-8%)";
  if (effect === "zoom") return phase === "enter-start" ? "scale(1.06)" : "scale(0.94)";
  return "none";
}

/** One third-party embed to render over the stage, in parent client px. */
export interface EmbedItem {
  id: string;
  provider: EmbedProvider;
  /** The player URL — already canonicalised by `embed.ts` at insert time. */
  url: string;
  rect: Rect;
}

/**
 * [E2.T17] `subscribeEmbeds`'s payload. `interactive` is false in view
 * mode: the author is editing a slide there, and a player that swallowed
 * clicks would make its own element unselectable — exactly the reasoning
 * behind `.media-overlay-el`'s `pointer-events:none`. In play mode the
 * audience is watching, so the player takes its own clicks.
 */
export interface EmbedState {
  items: EmbedItem[];
  interactive: boolean;
}

/** [E2.T17] One "drive this embedded player" instruction, already validated against the current slide's embeds. */
export interface EmbedCommand {
  id: string;
  command: "play" | "pause";
}

/** Message shapes the runtime sends (C4 in the design doc). */
interface PlayerMessage {
  source: "comot-player";
  // [E2.T7]/D8: "preview-done" — the runtime's own signal that Preview has
  // finished playing every effect it was asked to; only ever sent while
  // `mode === "preview"`.
  // [E2.T11]: "exit-play" — Escape pressed inside the play iframe
  // (player-runtime.js's own keydown), forwarded here since the runtime
  // has no notion of whether the document is currently fullscreen.
  // [E2.T17]: "embed-boxes" — where each third-party embed placeholder
  // currently sits on screen, so the parent's embed overlay can stay
  // aligned. The <iframe> itself can only live in the parent document
  // (ADR-0011); see packages/core/src/embed.ts.
  // [E2.T17]: "embed-command" — a `family="media"` effect landed on a
  // third-party embed. The runtime has no <video> to drive (the player is
  // a cross-origin iframe in THIS document), so it forwards the intent and
  // the parent speaks the provider's own protocol.
  event:
    | "ready"
    | "focus"
    | "advance-past-end"
    | "retreat-past-start"
    | "error"
    | "preview-done"
    | "exit-play"
    | "embed-boxes"
    | "embed-command";
  hasFocus?: boolean;
  message?: string;
  items?: unknown;
  id?: unknown;
  command?: unknown;
}

/** Read directly rather than through a container ref (unlike App.tsx's `isCanvasAreaFullscreen`): this module has no reference to the "well" element `toggleFullscreen()` requests fullscreen on, and the app only ever fullscreens that one element while playing — so "is anything fullscreen at all" answers the same question. */
function isAnyElementFullscreen(): boolean {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
}

function isPlayerMessage(data: unknown): data is PlayerMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "comot-player" &&
    typeof (data as { event?: unknown }).event === "string"
  );
}

/**
 * Message shapes selection-runtime.js sends (ADR-0011/#56, extended by
 * NOOP-91 §4.1 for direct manipulation). Every field below is untrusted —
 * the slide running inside the sandboxed iframe can forge any of them — so
 * every handler below validates shape and finiteness before using a value,
 * never trusting a NaN/Infinity/wrong-type field into a command input.
 */
interface SelectionMessage {
  source: "comot-selection";
  event:
    | "select"
    | "clear"
    | "viewport"
    | "gesture-start"
    | "gesture-move"
    | "gesture-end"
    | "group-path"
    | "drag-enter"
    | "dblclick-textbox"
    // E2.T12 plan §3.6: a plain (non-textbox) double-click resolved to a
    // chart container — opens its data window, no in-iframe edit state.
    | "dblclick-chart"
    | "text-edit-input"
    | "text-edit-commit"
    | "text-edit-denied"
    // NOOP-83 §4: stage navigation relay (Dev-Leader 裁決核准的擴大範圍).
    // `point` on these four is always in the RUNTIME's own iframe-local
    // client coordinates, converted to this parent document's client
    // coordinates by `toParentClientPoint` before ever reaching
    // `subscribeStageInput`'s listener — never trusted as parent-space
    // as-is.
    | "stage-wheel"
    | "stage-pan-start"
    | "stage-pan-move"
    | "stage-pan-end"
    | "stage-space"
    // NOOP-90/T2 §4.6: precise per-selected-element bounding boxes plus
    // each one's ancestor chain, replacing the old host-computed "guides"
    // approach (ADR-0011 amend) — the runtime measures with
    // `getBoundingClientRect()`, this side only converts coordinate spaces.
    | "bounds"
    // NOOP-90/T2 §4.5: right-click on an element (never on blank canvas —
    // out of scope this ticket).
    // NOOP-90/T2 §4.4: the keyboard relay for shortcuts that must work even
    // when focus is inside the iframe.
    | "stage-key"
    // Sent once, after the runtime's listeners are attached (§2.1(c)) —
    // carries no payload of its own.
    | "runtime-ready"
    // [E2.T7]/D9: the reply to a host-issued `measure` command — bounds for
    // an arbitrary id list (the current slide's animation badge targets),
    // independent of `selectedIds`.
    | "measured"
    // F8 (NOOP-289 決定 G1): every id-carrying element's bounding box,
    // self-reported at startup (and once web fonts settle) rather than in
    // reply to a host command — the browser has no bundled font-metrics
    // engine any more to compute this from the parsed model, so the
    // runtime's own `getBBox()`/`getCTM()` is the only source left.
    | "element-bounds"
    // [E2.T17]: where each third-party embed placeholder currently sits,
    // so the parent's embed overlay can stay aligned. Sent by BOTH
    // runtimes (player-runtime.js has its own copy) because the overlay
    // has to survive play mode, where selection-runtime.js is not even
    // injected.
    | "embed-boxes"
    // E2.T14 §4.5: table cell hit reports (click/dblclick/contextmenu) and
    // the reply to a host-issued `table-cells` command.
    | "table-cell-click"
    | "table-cell-dblclick"
    | "table-cell-contextmenu"
    | "table-cells"
    // E2.T14r2 §4.2: the iframe's own keyboard relay for a cell range
    // in progress (Tab/⇧Tab, Esc, Delete/Backspace, ⌘B) — sent only while
    // the runtime's `tableRangeId` flag is set, carrying that same id.
    | "table-key";
  id?: string;
  name?: string | null;
  /** The runtime's hidden `<textarea>`'s current value, on "text-edit-input" only. */
  text?: string;
  additive?: boolean;
  svgRect?: Rect;
  viewBox?: Rect;
  kind?: "move" | "marquee" | "scale" | "rotate" | "textbox-width";
  /** Scale corner ("nw"/"ne"/"sw"/"se") or textbox-width edge ("left"/"right"); null for move/marquee/rotate. */
  handle?: string | null;
  point?: { x: number; y: number };
  modifiers?: { shift: boolean; alt: boolean };
  cancelled?: boolean;
  /** "stage-wheel" only — raw `WheelEvent.deltaX`/`deltaY`, unconverted (there is no coordinate to convert: a delta is already a magnitude, not a position). */
  deltaX?: number;
  deltaY?: number;
  /** "stage-wheel" only — `event.ctrlKey || event.metaKey`, computed by the runtime so this side never re-derives it. */
  zoomModifier?: boolean;
  /** "stage-space" only. */
  down?: boolean;
  /**
   * Present (and non-empty) only on a "select"/"clear" that entered or
   * stayed inside a group, and always on "group-path" — see
   * selection-runtime.js's `withGroupPath` for why it is omitted rather
   * than sent empty on the common top-level case.
   */
  groupPath?: string[];
  /** "bounds"/"measured" only — one entry per still-resolvable id, in the runtime's own iframe-local client px ("bounds": every selected id, with its ancestor chain; "measured": every id the host asked for, no ancestors). */
  items?: unknown;
  /** "bounds" only — the union of every `items[]` rect, iframe-local client px; `null` when `items` is empty. */
  union?: unknown;
  /** "stage-key" only — `event.metaKey`/`ctrlKey`/`shiftKey`/`altKey`. */
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** "stage-key" only — the relayed `KeyboardEvent.key`. */
  key?: string;
  /** "stage-key" only — the relayed `KeyboardEvent.code` (physical key, layout/Shift independent). */
  code?: string;
  /** "table-cell-click"/"table-cell-dblclick"/"table-cell-contextmenu"/"table-cells" only (E2.T14). */
  row?: number;
  col?: number;
  /** "table-cell-dblclick" only — the clicked cell's own row (differs from `row` for a generated cell, which edits its hidden template row). */
  atRow?: number;
  /** "table-cell-contextmenu" only — iframe-local client px, converted by `toParentClientPoint` before reaching `subscribeTable`'s listener. */
  x?: number;
  y?: number;
  /** "table-cells" only — one entry per cell the runtime could still resolve. */
  cells?: unknown;
  /** "table-cells" only — the table container's own box, same coordinate space as `cells[].rect`. */
  box?: unknown;
}

/** One `bounds` event item, already shape-validated (see `isBoundsItem`). */
interface BoundsItem {
  id: string;
  rect: Rect;
  ancestors: { id: string; name: string | null }[];
}

function isAncestorList(value: unknown): value is { id: string; name: string | null }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        ((entry as { name?: unknown }).name === null || typeof (entry as { name?: unknown }).name === "string"),
    )
  );
}

/** Loosened `isValidRect`: a bounding box may legitimately be zero-width or zero-height (e.g. a perfectly horizontal `<line>`), which the plain `isValidRect` (used for `svgRect`/`viewBox`, which never are) rejects. */
function isNonNegativeRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.width) && isFiniteNumber(r.height) && r.width >= 0 && r.height >= 0;
}

function isBoundsItem(value: unknown): value is BoundsItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; rect?: unknown; ancestors?: unknown };
  return typeof item.id === "string" && isNonNegativeRect(item.rect) && isAncestorList(item.ancestors);
}

/** One `measured` event item (D9) — no `ancestors`, unlike `BoundsItem`. */
interface MeasuredItem {
  id: string;
  rect: Rect;
}

function isMeasuredItem(value: unknown): value is MeasuredItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; rect?: unknown };
  return typeof item.id === "string" && isNonNegativeRect(item.rect);
}

/** One `element-bounds` event item (F8, NOOP-289 決定 G1) — `rect`: full container-chain box in the slide's own coordinate system (`elementBounds`'s old output space); `local`: the element's own bbox before its own transform. */
interface ElementBoundsItem {
  id: string;
  rect: Rect;
  local: Rect;
}

function isElementBoundsItem(value: unknown): value is ElementBoundsItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; rect?: unknown; local?: unknown };
  return typeof item.id === "string" && isNonNegativeRect(item.rect) && isNonNegativeRect(item.local);
}

/** One `table-cells` event item (E2.T14, plan §4.5). */
interface TableCellRectItem {
  row: number;
  col: number;
  rect: Rect;
}

function isTableCellRectItem(value: unknown): value is TableCellRectItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { row?: unknown; col?: unknown; rect?: unknown };
  return isFiniteNumber(item.row) && isFiniteNumber(item.col) && isNonNegativeRect(item.rect);
}

/**
 * A table cell hit report or the reply to `requestTableCells` (E2.T14, plan
 * §4.5), already coordinate-converted to this parent document's client px
 * (`toParentClientPoint`/`toParentClientRect`) — `subscribeTable`'s
 * listener never sees an iframe-local coordinate.
 */
export type TableRuntimeEvent =
  | { type: "cell-click"; id: string; row: number; col: number; additive: boolean }
  | { type: "cell-dblclick"; id: string; row: number; col: number; atRow: number }
  | { type: "cell-contextmenu"; id: string; row: number; col: number; x: number; y: number }
  | { type: "cells"; id: string; cells: TableCellRectItem[]; box: Rect };

function isSelectionMessage(data: unknown): data is SelectionMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "comot-selection" &&
    typeof (data as { event?: unknown }).event === "string"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPoint(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    isFiniteNumber((value as { x?: unknown }).x) &&
    isFiniteNumber((value as { y?: unknown }).y)
  );
}

function isValidRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return (
    isFiniteNumber(r.x) &&
    isFiniteNumber(r.y) &&
    isFiniteNumber(r.width) &&
    isFiniteNumber(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

/** A `groupPath` array is trusted only when every entry is a string — anything else (forged by hostile slide script) is treated the same as "no groupPath field at all", i.e. top level. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Screen-space viewport the runtime last reported (client px <-> user units, NOOP-91 §4.1's "viewport" event). */
interface Viewport {
  svgRect: Rect;
  viewBox: Rect;
}

/** One selected element's transform, captured at gesture start, for preview/revert (§4.2). */
interface OriginalTransform {
  /** The raw `transform` attribute value at gesture start; `null` when absent (preview reverts by removing the attribute). */
  transform: string | null;
  parts: TransformParts;
}

interface MoveGesture {
  kind: "move";
  ids: string[];
  originals: Map<string, OriginalTransform>;
  startUser: { x: number; y: number };
  lastDelta: { dx: number; dy: number };
}

interface MarqueeGesture {
  kind: "marquee";
  startClient: { x: number; y: number };
}

/**
 * A four-corner handle drag (NOOP-90/T2 §4.2, extending the original
 * uniform-only "Scale handles"). Two sub-paths share one gesture object,
 * chosen live every frame by the current Shift state (`updateScaleGesture`)
 * — Figma-style continuous toggling, not a choice locked in at gesture
 * start, since the runtime's `gesture-start` message carries no modifiers
 * to decide with anyway:
 *
 *  - **uniform** (Shift held, or `forceUniform`): send `element scale`,
 *    same math as before — `origin` (the element's own local origin, its
 *    matrix's own translate) lives in the element's PARENT coordinate
 *    space, and `startUser`/every subsequent point is mapped into that
 *    space via `parentInverse` before being compared against `origin`.
 *
 *  - **non-uniform** (the default, decision 4): send `element resize`.
 *    `localBox`/`anchorLocal` are computed with the element's OWN
 *    transform factored out (`invertMatrix(element.matrix)` composed as
 *    the sole "ancestor", the same trick `packages/core`'s own
 *    `resizeOneTarget` uses) — the fixed corner (opposite the dragged
 *    handle) in that local frame never moves as long as native geometry is
 *    scaled about the local origin, which is exactly what the live preview
 *    below does (a temporary non-uniform `scale(sx sy)` on the transform —
 *    visually identical to the real command's native-attribute resize, and
 *    the ONLY way to preview a size change through the existing
 *    `{command:"preview", items:[{id,transform}]}` protocol, which never
 *    changes native attributes). `fullInverse` maps a top-level user point
 *    into that same local frame, so a live pointer position becomes a
 *    local-frame corner comparable against `anchorLocal`. `null` when the
 *    element's local box could not be computed at gesture start (an
 *    unmeasurable `<text>`, a degenerate ancestor chain) — `forceUniform`
 *    is then also true, so the non-uniform path is never reached.
 *
 * `original`/`originalMatrix` — the element's own transform decomposed,
 * and its raw `Matrix`, both captured once at gesture start — are shared by
 * both sub-paths; `originalMatrix`'s linear part (no translation) is what
 * carries a local anchor-preserving delta into the parent frame for the
 * resize path, the same computation `resizeOneTarget` does server-side.
 */
interface ScaleGesture {
  kind: "scale";
  id: string;
  corner: "nw" | "ne" | "sw" | "se";
  original: OriginalTransform;
  originalMatrix: Matrix;
  /** True when the target (or, for a group, any descendant) contains a `<text>`/`<circle>`/`<path>` primitive — none has a non-uniform representation (core's `element resize` rejects all three), so the non-uniform path is never offered regardless of Shift. */
  forceUniform: boolean;
  origin: { x: number; y: number };
  startUser: { x: number; y: number };
  parentInverse: Matrix;
  localBox: Rect | null;
  /** The FIXED corner (opposite the dragged handle) in the element's own local frame, from the gesture-start `localBox`. */
  anchorLocal: { x: number; y: number };
  fullInverse: Matrix | null;
  /** Which sub-path actually produced the last applied preview — read by `endScaleGesture` to decide which command to send, since the trailing `gesture-end` message carries no modifiers of its own. */
  lastMode: "scale" | "resize";
  lastFactor: number;
  lastWidth: number;
  lastHeight: number;
}

/**
 * Rotation anchored at the element's own local origin, tracking a
 * continuously-unwrapped angle so a multi-revolution drag is not clamped to
 * ±180° (§4.2-follow-up "Rotate handle"). Same parent-coordinate-space
 * reasoning as `ScaleGesture` above — `origin` is in the element's parent
 * space, and every pointer point is mapped into that space via
 * `parentInverse` before its angle is measured.
 */
interface RotateGesture {
  kind: "rotate";
  id: string;
  original: OriginalTransform;
  origin: { x: number; y: number };
  /** Maps a top-level user-unit point into the element's parent coordinate space; the inverse of the composed ancestor chain (`entry.ancestors`) captured at gesture start. */
  parentInverse: Matrix;
  /** The raw (wrapped, -180..180) angle, in degrees, as of the last processed point — used to unwrap the next frame's delta. */
  lastAngleDeg: number;
  /** Sum of every frame's unwrapped angle delta so far, in degrees — can exceed ±360 across a multi-revolution drag. */
  cumulativeDeltaDeg: number;
}

/**
 * Textbox mid-edge width drag (§4.4). The command this ends in
 * (`textbox width`) accepts only a width, never a position — so unlike a
 * typical "drag the left edge" handle, the container's own `transform`
 * never moves; only the declared width changes, and the box's local
 * origin (its top-left corner, per `textBounds`'s own contract) stays
 * exactly where it started regardless of which handle is dragged. See the
 * PR body's 風險與未處理項 for what this means for the LEFT handle's own
 * on-screen position during the drag.
 */
/**
 * Textbox mid-edge width drag (F8, NOOP-289 決定 (b)): no font is fetched
 * any more — the drag only ever touches `data-comot-text-width`, never the
 * `<text>` content (the runtime's `selectionClientRect` computes the
 * live-previewed box from the element's own unchanged bbox + this width,
 * see selection-runtime.js), so there is nothing left to measure.
 */
interface TextboxWidthGesture {
  kind: "textbox-width";
  id: string;
  handle: "left" | "right";
  originalWidth: number;
  originalTransform: string | null;
  startUserX: number;
  lastWidth: number;
}

type ActiveGesture = MoveGesture | MarqueeGesture | ScaleGesture | RotateGesture | TextboxWidthGesture;

/**
 * In-place text editing (NOOP-91/#70 US1, T5). Unlike `ActiveGesture`, this
 * is not driven by pointer coordinates — the runtime's hidden `<textarea>`
 * is the source of truth for the current string, and `currentText` here
 * only mirrors its last-reported value (`text-edit-input`) so
 * `commitTextEdit()` has something to diff against `originalText` and to
 * send. Exactly one of these exists at a time, independent of
 * `activeGesture` (a drag can never start while editing — see the runtime's
 * own editingId guard).
 */
interface TextEditState {
  id: string;
  slidePath: string;
  originalText: string;
  currentText: string;
}

/** Snap threshold in screen px, converted to user units per-viewport at drag time (assumption noted in the PR body). */
const SNAP_THRESHOLD_PX = 8;

/** Minimum interval between `POST /api/editing/begin` lease renewals fired from `gesture-move`. Well under `HUMAN_LEASE_MAX_MS` (5000ms, editing-lock.ts) so a drag longer than one interval never lets the lease lapse. */
const HUMAN_RENEW_THROTTLE_MS = 2000;

/** Rounds like `formatTransform`'s own 4-decimal rule, for the "did anything actually move/scale/rotate/resize" check. */
function roundsToZero(value: number): boolean {
  return Number(value.toFixed(4)) === 0;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Flattens a slide model into id -> {element, ancestor matrix chain (excluding the element's own matrix)}, recursing into groups. */
function flattenElements(
  elements: readonly SlideElement[],
  ancestors: readonly Matrix[],
  ancestorIds: readonly string[],
  out: Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>,
): void {
  for (const element of elements) {
    out.set(element.id, { element, ancestors: [...ancestors], ancestorIds: [...ancestorIds] });
    if (element.kind === "group") {
      flattenElements(element.children, [...ancestors, element.matrix], [...ancestorIds, element.id], out);
    }
  }
}

/** Every id inside `element`'s own subtree, `element.id` itself included — used to keep a dragged group's own descendants out of its snap-candidate set (see `updateMoveGesture`'s exclusion set). */
function subtreeIds(element: SlideElement, out: Set<string>): void {
  out.add(element.id);
  for (const child of element.children) subtreeIds(child, out);
}

/** True when `element` (or, recursively for a group, any descendant) contains a `<text>`, `<circle>`, or `<path>` primitive — none has a non-uniform representation (`packages/core`'s `element resize` rejects all three; ADR-0012's "compound" holds several primitives, so it is checked one by one). Used by the four-corner handle to decide whether the non-uniform resize path applies at all, regardless of Shift. */
function subtreeForcesUniformScale(element: SlideElement): boolean {
  if (element.kind === "group") return element.children.some(subtreeForcesUniformScale);
  if (element.kind === "text" || element.kind === "circle" || element.kind === "path") return true;
  // A table scales through its container transform (see element-edit.ts), so a non-uniform factor would distort every glyph in it.
  if (element.kind === "table") return true;
  if (element.kind === "compound") {
    return element.primitives.some((primitive) => primitive.tag === "text" || primitive.tag === "circle" || primitive.tag === "path");
  }
  return false;
}

const OPPOSITE_CORNER: Record<"nw" | "ne" | "sw" | "se", "nw" | "ne" | "sw" | "se"> = {
  nw: "se",
  ne: "sw",
  sw: "ne",
  se: "nw",
};

/** The named corner of `box` — "nw" is `(box.x, box.y)`, "se" is the opposite corner, etc. Same formula as `packages/core`'s own `anchorCorner` (element-edit.ts), duplicated here because this module cannot import a Node-only core module and the formula is three lines. */
function cornerPoint(corner: "nw" | "ne" | "sw" | "se", box: Rect): { x: number; y: number } {
  return {
    x: corner === "ne" || corner === "se" ? box.x + box.width : box.x,
    y: corner === "sw" || corner === "se" ? box.y + box.height : box.y,
  };
}

export function mountCanvas(container: HTMLElement): CanvasController {
  let destroyed = false;
  // The selected slide lives here, not in React (ADR-0001/ADR-0002): the
  // 投影片 on screen is the artifact, not something React computes from
  // state. React subscribes to read it and issues commands to change it.
  let slides: string[] = [];
  let currentIndex = -1;
  // [E2.T11]: the page currently on screen's own enter/exit transition,
  // read fresh from its markup by renderPlay() (or migrateLegacyTransition
  // vintage — every slide has a resolved value even when it never set one
  // explicitly). playExitTransition() reads this rather than re-fetching —
  // it always describes whatever page renderPlay() last painted, which is
  // exactly the page a forward navigation is about to leave.
  let currentPageTransition: SlideTransition = {
    enter: { effect: "none", duration: 0.6 },
    exit: { effect: "none", duration: 0.5 },
  };
  // True for the duration of one playExitTransition() call. A second
  // forward-navigation request arriving mid-exit is dropped outright, not
  // queued (§4.6 决定: "不得排隊、不得疊播") — see that function's own
  // comment.
  let exiting = false;
  let mode: CanvasMode = "view";
  let playerHasFocus = false;
  let error: string | null = null;
  // [E2.T7]/D8: the selection Preview entered from, restored (top-level ids
  // only — drill-in group scope is not preserved, a deliberate
  // simplification) once the runtime posts "preview-done" and this module
  // returns to view mode. `null` between previews.
  let previewReturnSelectionIds: string[] | null = null;
  // The elements the author has selected in view mode (ADR-0011/#56,
  // extended by NOOP-91 to a list). Cleared (with notify()) whenever the
  // slide changes, reload() runs, play() is entered, or exitPlay()
  // returns — a selection surviving a page change would point at a
  // different slide's DOM entirely.
  let selectionIds: string[] = [];
  let selectionNames: (string | null)[] = [];
  // Mirrors selection-runtime.js's own `groupPath` — cleared alongside
  // selectionIds/Names everywhere they are cleared (see that comment).
  let selectionGroupPath: string[] = [];
  // [E2.T18]: `paste-offset.ts`'s own state, one instance per editor session
  // (that module's own doc comment) — advanced by a successful `copySelection`/
  // `cutSelection`/`pasteFromText`, never by a `table cell paste` (offsets
  // are an element-clipboard-only concept).
  let pasteOffsetState: PasteOffsetState = INITIAL_PASTE_OFFSET_STATE;
  // [E2.T18] 計畫「補充 (b)」：儲存格範圍選取的路由縫，恆回 null 直到
  // [E2.T14] 合併並換上真正的實作——見 `clipboard/dispatch.ts`'s
  // `CellRangeProvider` doc comment.
  const cellRangeProvider: CellRangeProvider = () => null;
  // NOOP-227: the element(s) a just-finished insert/paste command created,
  // still waiting for the reload()/render() its own write triggers over
  // /api/events. reload() would otherwise clear the selection like every
  // other reload — this is the one case where the id(s) ARE trustworthy,
  // because this module made them moments ago. Consumed (set back to null)
  // by the render() that follows, whether or not any id still resolves.
  // Extended by NOOP-275/#156 from a single id to a list, so a multi-element
  // paste selects everything it created rather than just the first one.
  let pendingSelectionIds: string[] | null = null;
  // True from a committed gesture until render() has re-selected
  // `pendingSelectionIds` — reported as `OverlayState.dragging` so the
  // context bar stays hidden across the reload (see keepSelectionAcrossReload).
  let overlaySettling = false;
  // See CanvasState.dragSignal's own comment — bumped on every "drag-enter"
  // message, never reset (there is nothing to reset it back to: it is an
  // edge counter, not a level).
  let dragSignal = 0;
  // NOOP-83 §4/§2.1(c): Stage.tsx's subscribers to the on-slide wheel/
  // pointer/Space relay, and the last 抓取模式 value `setStageHandMode` was
  // told to apply — resent to the runtime whenever it reports
  // "runtime-ready" (a slide change rebuilds the srcdoc and loses whatever
  // the previous document's `stageHandMode` variable held).
  const stageInputListeners = new Set<(event: StageInputEvent) => void>();
  let stageHandMode = false;
  // NOOP-90/T2 §4.6: the runtime's last-reported per-selected-element
  // bounds/ancestors, kept in the runtime's OWN
  // iframe client px — the conversion to this parent document's client px
  // happens in `buildOverlayState()` at emit time, so a later zoom/pan only
  // needs `refreshOverlay()` to re-emit, not a fresh "bounds" round trip.
  // See `OverlayState`'s own doc comment for why this is a separate,
  // high-frequency channel rather than `CanvasState`.
  const overlayListeners = new Set<(state: OverlayState) => void>();
  /** E2.T14 §4.5: table cell hit reports and `table-cells` replies — transient events, same "listener set, no persisted state" shape as `subscribeStageInput`, not folded into `CanvasState`/`OverlayState` since neither is about a table specifically. */
  const tableListeners = new Set<(event: TableRuntimeEvent) => void>();
  /** E2.T14r2 §4.1: `subscribeTableRange`'s listeners — a real state channel (unlike `tableListeners` above), so a late subscriber gets the current value immediately, same contract as `overlayListeners`. */
  const tableRangeListeners = new Set<(value: { tableId: string; range: CellRange } | null) => void>();
  /** The active cell range, or `null`. Built from `table-cell-click`/`table-cell-contextmenu` reports (handleSelectionMessage below) and cleared whenever the selection changes away from this table (§4.1's lifecycle table). */
  let tableRange: { tableId: string; range: CellRange } | null = null;
  /** The cell a range gesture started from — set on a non-additive click/contextmenu, read on a ⇧-click to build the range via `normalizeRange`. Private to this module: not part of the public `tableRange`, exactly like `TableOverlay`'s old local `anchorRef` this replaces. */
  let tableRangeAnchor: { row: number; col: number } | null = null;
  // E2.T12 plan §2.8/§4.5: at most one chart data window open at a time
  // (`chartWindowTarget`, `null` = closed) — opened by the runtime's
  // "dblclick-chart" report, closed by Esc (ChartWindow.tsx's own
  // listener) or a slide change (`showSlide`). A separate channel from
  // `subscribeOverlay`/`CanvasState` for the same reason those are: high-
  // frequency during local editing, and shaped nothing like either.
  const chartWindowListeners = new Set<(state: ChartWindowState | null) => void>();
  let chartWindowTarget: string | null = null;
  let overlayBoxes: Rect[] = [];
  let overlayUnion: Rect | null = null;
  let overlayAncestors: { id: string; name: string | null }[] = [];
  let overlayGuides: { orientation: "v" | "h"; position: number }[] = [];
  // [E2.T7]: the current slide's effect list, parsed fresh on every
  // render() (never on gesture/selection changes — an effect list edit
  // always comes back over /api/events -> reload() -> render() like any
  // other write). A parse failure is treated as "no animations" (GUI table:
  // view mode never surfaces the player's own parse error), not a thrown
  // exception up through render().
  let currentSlideEffects: Effect[] = [];
  // [E2.T7]/D9: `{target, n}` for every distinct effect target on the
  // current slide, in first-appearance order — computed alongside
  // currentSlideEffects and re-sent to the runtime as a `measure` command
  // once it reports "runtime-ready". `overlayBadges` holds the last
  // successful `measured` reply, converted to parent client px.
  let badgeTargets: { target: string; n: number }[] = [];
  let overlayBadges: { target: string; n: number; rect: Rect }[] = [];
  // [E2.T17] the embed overlay's own state channel. `embedEntries` is the
  // current slide's `stageEmbedsFor` table (set at render time, parent
  // side); `embedBoxes` is where each of those elements last reported
  // itself to be, already converted to parent client px. Kept apart from
  // `OverlayState` because the embed overlay must also render in play
  // mode, where `OverlayLayer` is unmounted entirely (Stage.tsx's
  // `shellVisible` gate).
  let embedEntries: Record<string, StageEmbedEntry> = {};
  let embedBoxes: Record<string, Rect> = {};
  const embedListeners = new Set<(state: EmbedState) => void>();
  const embedCommandListeners = new Set<(command: EmbedCommand) => void>();

  /** Validates an `embed-command` payload and fans it out. Both fields come from untrusted slide-side script (ADR-0010), so an unknown id or command is dropped, never forwarded to a player. */
  function emitEmbedCommand(rawId: unknown, rawCommand: unknown): void {
    if (typeof rawId !== "string" || !Object.prototype.hasOwnProperty.call(embedEntries, rawId)) return;
    if (rawCommand !== "play" && rawCommand !== "pause") return;
    const command: EmbedCommand = { id: rawId, command: rawCommand };
    for (const listener of embedCommandListeners) listener(command);
  }

  /** Validates and stores an `embed-boxes` payload from either runtime, then pushes the new state out. Every field is untrusted slide-side data (ADR-0010), so nothing is stored before `isMeasuredItem` has checked its shape. */
  function applyEmbedBoxes(rawItems: unknown): void {
    const items = Array.isArray(rawItems) ? rawItems.filter(isMeasuredItem) : [];
    const next: Record<string, Rect> = {};
    for (const item of items) next[item.id] = item.rect;
    embedBoxes = next;
    notifyEmbeds();
  }

  /** Converts the stored runtime-px embed boxes to parent client px against the frame's rect *right now* — same contract, and same reason, as `buildOverlayState`. An entry whose element has not reported a box yet is simply absent, never rendered at a guessed position. */
  function buildEmbedState(): EmbedState {
    const items: EmbedItem[] = [];
    for (const id of Object.keys(embedEntries)) {
      const rect = embedBoxes[id];
      if (!rect) continue;
      items.push({ id, url: embedEntries[id].url, provider: embedEntries[id].provider, rect: toParentClientRect(rect) });
    }
    return { items, interactive: mode === "play" };
  }

  function notifyEmbeds(): void {
    const state = buildEmbedState();
    for (const listener of embedListeners) listener(state);
  }
  // The current slide's parsed model plus its raw markup, kept only so
  // gestures can compute bounding boxes/candidates without re-fetching —
  // reset on every render() alongside the selection.
  let currentSlideModel: SlideModel | null = null;
  // E2.T12: the current slide's raw SVG text, kept so `notifyChartWindow`
  // can re-derive the open chart's `ChartModel` (`readChartModel`) after
  // every render() without a second fetch — the chart data window is the
  // one caller that needs the actual bytes, not just the parsed
  // `SlideElement` shape `currentSlideModel` carries.
  let currentSlideMarkup: string | null = null;
  // F8 (NOOP-289 決定 G1): every id-carrying element's bounding box, as the
  // runtime last reported it (`element-bounds`, selection-runtime.js's
  // `reportElementBounds`) — the browser has no bundled font-metrics engine
  // any more to compute one from the parsed model, so this replaces core's
  // `elementBounds` as the source every marquee/snap-candidate lookup below
  // reads. `slide`: the full container-chain box in the slide's own
  // coordinate system (`elementBounds`'s old output space). `local`: the
  // element's own bbox in its OWN local coordinate system, before its own
  // transform (what `elementBounds({ancestors: [invertMatrix(own matrix)]})`
  // used to fake by cancelling the chain out — the scale-gesture anchor
  // corner needs exactly this). Reset to empty on every render(); an id the
  // runtime could not measure (jsdom in tests, or a genuinely gone element)
  // is simply absent, degrading the same way `computeBounds`'s try/catch
  // already did for an unmeasurable element.
  let elementBoundsById = new Map<string, { slide: Rect; local: Rect }>();
  // The runtime's last-reported client-px <-> user-unit mapping. `null`
  // until the runtime's "viewport" message arrives (on the iframe's own
  // `load`), which is also the state a gesture message must be ignored in.
  let viewport: Viewport | null = null;
  let activeGesture: ActiveGesture | null = null;
  // The in-place text edit in progress, or null between edits — see
  // TextEditState's own doc comment. Independent of activeGesture: the
  // runtime refuses to start a drag/marquee gesture while it has an
  // editingId set, so the two never coexist in practice, but nothing here
  // relies on that for correctness.
  let editingState: TextEditState | null = null;
  // App.tsx's `runUndoRedo`, once registered — see `setUndoRedoHandler`.
  let undoRedoHandler: ((kind: "undo" | "redo") => void) | null = null;
  // Timestamp (ms) of the last `POST /api/editing/begin` fired for the
  // human lease (T5/NOOP-110, editing-lock.ts). Read by gesture-move to
  // throttle lease renewal to once per HUMAN_RENEW_THROTTLE_MS — gesture-
  // move is rAF-throttled but still fires dozens of times a second, which
  // would otherwise hammer the server.
  let lastEditingLeaseAt = 0;
  const listeners = new Set<(state: CanvasState) => void>();
  // Bumped on every reload()/showSlide()/play()/exitPlay() call and
  // captured by each call's own closure. Nothing orders concurrent calls
  // against each other, so a slower earlier one can resolve after a
  // faster later one and paint stale content over it. Comparing the
  // captured generation against the current one right before each await's
  // result is applied discards a superseded call's result instead of
  // applying it. play()/exitPlay() bump it too — not just reload()/
  // showSlide() — because they replace the iframe element itself: without
  // that, a slow in-flight view-mode render() could resume after play()
  // has already swapped in the fresh play iframe and write into it via the
  // still-current `frame` reference (see the mode-switch note below).
  let generation = 0;

  let frame = buildFrame("allow-scripts");
  container.appendChild(frame);

  // One listener for the whole controller's lifetime, not per-frame: it
  // reads `frame` (the current, possibly-rebuilt element) at call time
  // rather than closing over a specific iframe, so it keeps working across
  // play()/exitPlay() rebuilds without being re-attached.
  window.addEventListener("message", onWindowMessage);
  // [E2.T17]: the embed overlay's parent-side conversion reads the frame's
  // rect at message time, so a window resize that moves/scales the frame
  // without the runtime re-reporting would leave the player behind. The
  // stored runtime-local boxes are still correct — only the conversion has
  // to be redone.
  window.addEventListener("resize", notifyEmbeds);

  function onWindowMessage(event: MessageEvent): void {
    if (destroyed) return;
    // Authenticate by sender identity, never by trusting `event.origin` —
    // an opaque-origin document's `event.origin` is literally the string
    // "null", which proves nothing about who sent it (ADR-0010). Sender
    // identity only proves *which iframe* the message came from, though —
    // never which script inside that iframe sent it. Any slide markup
    // running in that iframe (view mode has `allow-scripts` too, since
    // ADR-0011) can forge either message shape by hand, so the mode gate
    // below is load-bearing, not defensive: without it a view-mode deck
    // could self-issue "advance-past-end" and drive the same privileged
    // path play mode uses, on open, with no click from the author (found
    // in gate review round 1, #56).
    if (event.source !== frame.contentWindow) return;

    if (isSelectionMessage(event.data)) {
      // Selection/gesture messages are only ever meaningful in view mode —
      // selection-runtime.js is not even injected into the play-mode
      // srcdoc (wrapPlayDocument), so any of these arriving while
      // mode === "play" can only be a forgery from slide script.
      if (mode !== "view") return;
      handleSelectionMessage(event.data);
      return;
    }

    if (!isPlayerMessage(event.data)) return;
    // Player messages are only legitimate from the player runtime, which
    // only ever runs while mode === "play" or mode === "preview" ([E2.T7]/
    // D8 — Preview reuses the exact same runtime/wrapPlayDocument, just
    // with `plan.preview` set). A view-mode slide has no business sending
    // any of these — reject the whole message rather than gating
    // individual events, so a future new event type is safe by default
    // instead of needing its own opt-in gate.
    if (mode !== "play" && mode !== "preview") return;

    const message = event.data;
    if (message.event === "ready") {
      // Entering play mode hands focus to the player (acceptance
      // criterion); "ready" is the runtime's own signal that its listeners
      // are attached and it can actually receive the focus/keydown.
      // Preview never takes focus (D8: the side panel stays interactive
      // while it plays) — the runtime still posts "ready" as the last
      // message of its own boot sequence regardless of mode.
      if (mode === "play") focusPlayer();
      return;
    }
    if (message.event === "focus") {
      if (mode === "play") {
        playerHasFocus = Boolean(message.hasFocus);
        notify();
      }
      return;
    }
    if (message.event === "error") {
      error = message.message ?? "播放時發生未知錯誤";
      notify();
      return;
    }
    if (message.event === "embed-boxes") {
      applyEmbedBoxes(message.items);
      return;
    }
    if (message.event === "embed-command") {
      emitEmbedCommand(message.id, message.command);
      return;
    }
    if (message.event === "advance-past-end") {
      if (mode === "play") void advancePastEnd();
      return;
    }
    if (message.event === "retreat-past-start") {
      if (mode === "play") void retreatPastStart();
      return;
    }
    if (message.event === "preview-done") {
      if (mode === "preview") exitPreview();
      return;
    }
    if (message.event === "exit-play") {
      // §4.5: fullscreen owns Esc first — the browser's own fullscreen
      // exit is already underway by the time this message arrives, and
      // leaving play mode too would drop the author straight out of both
      // at once instead of just the one Esc asked for. The runtime cannot
      // make this check itself (it has no notion of fullscreen), which is
      // why it is repeated here rather than only in App.tsx's own Escape
      // listener (the other route to the same call).
      if (mode === "play" && !isAnyElementFullscreen()) void exitPlay();
      return;
    }
  }

  /** Dispatches one already-validated-as-comot-selection message to the right handler (NOOP-91 §4.1). */
  function handleSelectionMessage(message: SelectionMessage): void {
    if (message.event === "viewport") {
      if (isValidRect(message.svgRect) && isValidRect(message.viewBox)) {
        viewport = { svgRect: message.svgRect, viewBox: message.viewBox };
      }
      return;
    }
    if (message.event === "select") {
      const id = typeof message.id === "string" ? message.id : "";
      const name = typeof message.name === "string" ? message.name : null;
      if (message.additive) {
        const index = selectionIds.indexOf(id);
        if (index >= 0) {
          selectionIds.splice(index, 1);
          selectionNames.splice(index, 1);
        } else {
          selectionIds.push(id);
          selectionNames.push(name);
        }
      } else {
        selectionIds = [id];
        selectionNames = [name];
      }
      // "select"/"clear" always describe the runtime's FULL current
      // groupPath, never a delta — a missing field means "no group", the
      // same as an explicit `[]` (see selection-runtime.js's withGroupPath).
      selectionGroupPath = isStringArray(message.groupPath) ? message.groupPath : [];
      notify();
      pushSelectionToRuntime(selectionIds);
      // E2.T14r2 §4.1 lifecycle table: a range only survives while its own
      // table stays the sole selection — any other shape (a different
      // element, no selection, a multi-selection) drops it.
      if (tableRange && (selectionIds.length !== 1 || selectionIds[0] !== tableRange.tableId)) {
        setTableRange(null);
      }
      return;
    }
    if (message.event === "clear") {
      clearSelectionState(isStringArray(message.groupPath) ? message.groupPath : []);
      return;
    }
    if (message.event === "drag-enter") {
      // No payload to validate — see selection-runtime.js's dragenter
      // listener: it deliberately sends nothing but the bare event, ADR-0010
      // (the sandboxed slide's own dataTransfer content is never trusted
      // across postMessage).
      dragSignal++;
      notify();
      return;
    }
    if (message.event === "group-path") {
      // Esc popping one level (or already at top) while not mid-gesture —
      // selection itself is untouched, only the scope. No handle-flags
      // push needed: which element(s) are selected, and therefore which
      // handles apply, has not changed.
      selectionGroupPath = isStringArray(message.groupPath) ? message.groupPath : [];
      notify();
      return;
    }
    if (message.event === "bounds") {
      const items = Array.isArray(message.items) ? message.items.filter(isBoundsItem) : [];
      overlayBoxes = items.map((item) => item.rect);
      overlayUnion = isNonNegativeRect(message.union) ? message.union : null;
      overlayAncestors = items.length === 1 ? items[0].ancestors : [];
      notifyOverlay();
      return;
    }
    if (message.event === "stage-key") {
      if (typeof message.key !== "string") return;
      const modifiers = { meta: Boolean(message.meta), ctrl: Boolean(message.ctrl), shift: Boolean(message.shift) };
      if (message.key === "Delete" || message.key === "Backspace") void deleteSelection();
      else if (message.key === "a" && (modifiers.meta || modifiers.ctrl)) selectAll();
      else if (message.key === "d" && (modifiers.meta || modifiers.ctrl)) void duplicateSelection();
      else if (
        (message.key === "]" || message.key === "}" || message.code === "BracketRight") &&
        (modifiers.meta || modifiers.ctrl)
      )
        void orderSelection(modifiers.shift ? "front" : "up");
      else if (
        (message.key === "[" || message.key === "{" || message.code === "BracketLeft") &&
        (modifiers.meta || modifiers.ctrl)
      )
        void orderSelection(modifiers.shift ? "back" : "down");
      else if ((message.key === "z" || message.key === "Z") && (modifiers.meta || modifiers.ctrl)) undoRedoHandler?.(modifiers.shift ? "redo" : "undo");
      // [E2.T18] 計畫 §3.8/A0：與 App.tsx 的 keydown handler 同一套非同步
      // `navigator.clipboard` 邏輯，只是觸發源是「焦點在 iframe 內時的 stage-key
      // 轉送」而不是父文件自己的 keydown——兩條路徑呼叫同一組 controller
      // 方法，不會漂移。
      else if (message.key === "c" && (modifiers.meta || modifiers.ctrl)) {
        void copySelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
      } else if (message.key === "x" && (modifiers.meta || modifiers.ctrl)) {
        void cutSelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
      } else if (message.key === "v" && (modifiers.meta || modifiers.ctrl)) {
        void navigator.clipboard.readText().then((text) => pasteFromText(text));
      }
      // E2.T12 plan §4.5: Esc closes the chart data window — relayed here
      // because opening it (a double-click on the slide) leaves focus
      // inside this sandboxed iframe, where the parent document's own
      // `window` keydown listener (ChartWindow.tsx) never sees the
      // keypress at all (same reason ⌘Z/Delete/etc. above need relaying).
      else if (message.key === "Escape") closeChartWindow();
      return;
    }
    if (message.event === "gesture-start") {
      if (!isValidPoint(message.point)) return;
      if (message.kind === "move") beginMoveGesture(message.point);
      else if (message.kind === "marquee") beginMarqueeGesture(message.point);
      else if (message.kind === "scale" && isScaleHandle(message.handle)) beginScaleGesture(message.point, message.handle);
      else if (message.kind === "rotate") beginRotateGesture(message.point);
      else if (message.kind === "textbox-width" && isTextboxHandle(message.handle)) beginTextboxWidthGesture(message.point, message.handle);
      // Marquee never writes to the file, so it never contends with the
      // agent for the editing lock (T5/NOOP-110) — only the four
      // write-capable gestures take a human lease.
      if (message.kind !== "marquee") beginEditingLease();
      return;
    }
    if (message.event === "gesture-move") {
      if (!isValidPoint(message.point)) return;
      const modifiers = { shift: Boolean(message.modifiers?.shift), alt: Boolean(message.modifiers?.alt) };
      if (activeGesture?.kind === "move") updateMoveGesture(message.point, modifiers);
      else if (activeGesture?.kind === "marquee") updateMarqueeGesture(message.point);
      else if (activeGesture?.kind === "scale") updateScaleGesture(message.point, modifiers);
      else if (activeGesture?.kind === "rotate") updateRotateGesture(message.point);
      else if (activeGesture?.kind === "textbox-width") updateTextboxWidthGesture(message.point);
      if (
        activeGesture &&
        activeGesture.kind !== "marquee" &&
        Date.now() - lastEditingLeaseAt >= HUMAN_RENEW_THROTTLE_MS
      ) {
        beginEditingLease();
      }
      return;
    }
    if (message.event === "gesture-end") {
      if (!isValidPoint(message.point)) {
        // No usable endpoint at all: still tear the gesture down rather
        // than leaving a stale preview and a phantom activeGesture around.
        const wasLeaseHolder = activeGesture !== null && activeGesture.kind !== "marquee";
        activeGesture = null;
        if (wasLeaseHolder) endEditingLease();
        return;
      }
      const cancelled = Boolean(message.cancelled);
      const gesture = activeGesture;
      // Keep the context bar hidden through the gesture's tail: the end
      // handlers null `activeGesture` and notify the overlay *before* their
      // command round-trips, and a committed write then reloads the slide.
      // `settle` lifts it only when no reload is coming (cancelled, no-op,
      // or failed — nothing was parked in pendingSelectionIds); otherwise
      // render()/selectOnceLoaded clear it once the re-selection has landed.
      if (gesture && gesture.kind !== "marquee") overlaySettling = true;
      const settle = () => {
        if (pendingSelectionIds === null && activeGesture === null) {
          overlaySettling = false;
          notifyOverlay();
        }
        endEditingLease();
      };
      if (gesture?.kind === "move") void endMoveGesture(cancelled).then(settle);
      else if (gesture?.kind === "marquee") endMarqueeGesture(message.point, cancelled);
      else if (gesture?.kind === "scale") void endScaleGesture(message.point, cancelled).then(settle);
      else if (gesture?.kind === "rotate") void endRotateGesture(message.point, cancelled).then(settle);
      else if (gesture?.kind === "textbox-width") void endTextboxWidthGesture(message.point, cancelled).then(settle);
      // activeGesture is already null (e.g. a stray gesture-end with no
      // matching start) — still release the lease so it does not sit until
      // HUMAN_LEASE_MAX_MS expires.
      else endEditingLease();
      return;
    }
    if (message.event === "dblclick-textbox") {
      if (typeof message.id === "string") void enterTextEdit(message.id);
      return;
    }
    if (message.event === "dblclick-chart") {
      if (typeof message.id === "string") openChartWindow(message.id);
      return;
    }
    if (message.event === "text-edit-input") {
      if (!editingState || message.id !== editingState.id) return;
      // 決定 T1: no repaint round trip any more — the runtime already
      // repainted itself before sending this report (its own `input`
      // handler). This side only mirrors the string for commitTextEdit.
      editingState.currentText = typeof message.text === "string" ? message.text : "";
      return;
    }
    if (message.event === "text-edit-commit") {
      if (!editingState || message.id !== editingState.id) return;
      void commitTextEdit();
      return;
    }
    if (message.event === "text-edit-denied") {
      // The runtime's own lock check rejected a host-initiated
      // begin-text-edit (defense in depth — the dblclick path never even
      // reaches here, since findSelectable already refuses to resolve a
      // locked element to a click target). No error: this mirrors the
      // silent "不進入編輯" the dblclick path gives a locked box.
      if (editingState && editingState.id === message.id) {
        endEditingLease();
        editingState = null;
      }
      return;
    }
    if (message.event === "stage-wheel") {
      if (!isValidPoint(message.point) || !isFiniteNumber(message.deltaX) || !isFiniteNumber(message.deltaY)) return;
      const point = toParentClientPoint(message.point);
      if (message.zoomModifier) emitStageInput({ type: "wheel-zoom", point, deltaY: message.deltaY });
      else emitStageInput({ type: "wheel-pan", deltaX: message.deltaX, deltaY: message.deltaY });
      return;
    }
    if (message.event === "stage-pan-start") {
      if (!isValidPoint(message.point)) return;
      emitStageInput({ type: "pan-start", point: toParentClientPoint(message.point) });
      return;
    }
    if (message.event === "stage-pan-move") {
      if (!isValidPoint(message.point)) return;
      emitStageInput({ type: "pan-move", point: toParentClientPoint(message.point) });
      return;
    }
    if (message.event === "stage-pan-end") {
      emitStageInput({ type: "pan-end" });
      return;
    }
    if (message.event === "stage-space") {
      emitStageInput({ type: message.down ? "space-down" : "space-up" });
      return;
    }
    if (message.event === "runtime-ready") {
      // A fresh srcdoc (slide change) starts its own copy of
      // selection-runtime.js with `stageHandMode = false` — re-push this
      // side's last-known value so 抓取模式 does not silently drop on
      // every slide change (§2.1(c)).
      postToFrame({ command: "stage-mode", hand: stageHandMode });
      // [E2.T7]/D9: a fresh document has never been asked to measure
      // anything — re-request the current slide's badge targets so the
      // overlay is not stuck showing the PREVIOUS slide's badge positions.
      requestBadgeMeasurement();
      return;
    }
    if (message.event === "embed-boxes") {
      applyEmbedBoxes(message.items);
      return;
    }
    if (message.event === "measured") {
      const items = Array.isArray(message.items) ? message.items.filter(isMeasuredItem) : [];
      const rectByTarget = new Map(items.map((item) => [item.id, item.rect]));
      overlayBadges = badgeTargets.flatMap((entry) => {
        const rect = rectByTarget.get(entry.target);
        return rect ? [{ target: entry.target, n: entry.n, rect: toParentClientRect(rect) }] : [];
      });
      notifyOverlay();
      return;
    }
    if (message.event === "element-bounds") {
      const items = Array.isArray(message.items) ? message.items.filter(isElementBoundsItem) : [];
      elementBoundsById = new Map(items.map((item) => [item.id, { slide: item.rect, local: item.local }]));
      return;
    }
    if (message.event === "table-cell-click") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col)) {
        const row = message.row;
        const col = message.col;
        emitTableEvent({ type: "cell-click", id, row, col, additive: Boolean(message.additive) });
        // E2.T14r2 §4.1 lifecycle table: a ⇧-click while a range is already
        // active on THIS table extends it from the stored anchor; anything
        // else (plain click, or a ⇧-click that arrives with no anchor of
        // its own — e.g. right after a table id change already cleared it
        // above) starts a fresh single-cell range and a fresh anchor.
        if (message.additive && tableRangeAnchor && tableRange && tableRange.tableId === id) {
          setTableRange({ tableId: id, range: normalizeRange(tableRangeAnchor, { row, col }) });
        } else {
          tableRangeAnchor = { row, col };
          setTableRange({ tableId: id, range: { r0: row, c0: col, r1: row, c1: col } });
        }
      }
      return;
    }
    if (message.event === "table-cell-dblclick") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col)) {
        emitTableEvent({ type: "cell-dblclick", id, row: message.row, col: message.col, atRow: isFiniteNumber(message.atRow) ? message.atRow : message.row });
      }
      return;
    }
    if (message.event === "table-cell-contextmenu") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col) && isFiniteNumber(message.x) && isFiniteNumber(message.y)) {
        const row = message.row;
        const col = message.col;
        const point = toParentClientPoint({ x: message.x, y: message.y });
        emitTableEvent({ type: "cell-contextmenu", id, row, col, x: point.x, y: point.y });
        // §4.1 lifecycle table: right-clicking inside the current range
        // leaves it untouched (the menu acts on the whole range); right-
        // clicking outside it starts a fresh single-cell range/anchor.
        const cell = { row, col };
        if (!tableRange || tableRange.tableId !== id || !isCellInRange(cell, tableRange.range)) {
          tableRangeAnchor = cell;
          setTableRange({ tableId: id, range: { r0: row, c0: col, r1: row, c1: col } });
        }
      }
      return;
    }
    if (message.event === "table-cells") {
      const id = typeof message.id === "string" ? message.id : null;
      const cells = Array.isArray(message.cells) ? message.cells.filter(isTableCellRectItem) : [];
      const box = isNonNegativeRect(message.box) ? message.box : null;
      if (id !== null && box !== null) {
        emitTableEvent({
          type: "cells",
          id,
          cells: cells.map((cell) => ({ ...cell, rect: toParentClientRect(cell.rect) })),
          box: toParentClientRect(box),
        });
      }
      return;
    }
    if (message.event === "table-key") {
      if (typeof message.key !== "string") return;
      // The runtime only ever sends this while its own `tableRangeId` flag
      // is set (§4.2) — `handleTableRangeKey` re-derives everything else
      // (which range, which table) from this module's own `tableRange`, the
      // single source of truth both input paths share.
      handleTableRangeKey(message.key, { meta: Boolean(message.meta), ctrl: Boolean(message.ctrl), shift: Boolean(message.shift) });
      return;
    }
  }

  /** A `cell-dblclick` that arrived before any `TableOverlay` subscribed — the drill-in double-click selects the table and reports the cell in the same runtime handler, so the overlay for that table mounts one React render later. Replayed to the first subscriber. */
  let pendingTableDblclick: TableRuntimeEvent | null = null;

  function emitTableEvent(event: TableRuntimeEvent): void {
    if (event.type === "cell-dblclick" && tableListeners.size === 0) {
      pendingTableDblclick = event;
      return;
    }
    for (const listener of tableListeners) listener(event);
  }

  function notifyTableRange(): void {
    for (const listener of tableRangeListeners) listener(tableRange);
  }

  /** `CanvasController.setTableRange` (E2.T14r2 §4.1/§4.2) — also tells the runtime which table (if any) owns the range, so its own keyboard relay can decide Delete/Tab/⌘B/Esc's routing. */
  function setTableRange(value: { tableId: string; range: CellRange } | null): void {
    tableRange = value;
    notifyTableRange();
    postToFrame({ command: "table-range", id: value ? value.tableId : null });
  }

  /**
   * `CanvasController.handleTableRangeKey` (E2.T14r2 §4.1, "本輪唯一的新設
   * 計") — the single decision function for every cell-range keyboard
   * shortcut. Both `handleSelectionMessage`'s "table-key" branch above (the
   * iframe relay) and App.tsx's capture-phase keydown listener call this
   * exact function, never a copy of its logic, so the two input paths
   * cannot drift apart (same posture as the existing ⌘Z/Delete/etc. relay
   * `App.tsx:610`'s own comment already documents).
   */
  function handleTableRangeKey(key: string, modifiers: { meta: boolean; ctrl: boolean; shift: boolean }): boolean {
    if (!tableRange) return false;
    if (selectionIds.length !== 1 || selectionIds[0] !== tableRange.tableId) {
      // The selection moved on without the range ever being told (should
      // not normally happen — the "select"/"clear" branches above already
      // clear it — but this is the behaviour contract's own explicit row,
      // not just a defensive fallback).
      setTableRange(null);
      return false;
    }
    const table = selectedElements()[0]?.table ?? null;
    if (!table) {
      setTableRange(null);
      return false;
    }
    const { tableId, range } = tableRange;
    const slidePath = slides[currentIndex];

    if (key === "Tab") {
      const next = tabTarget({ row: range.r0, col: range.c0 }, table.rows.length, table.cols.length, modifiers.shift ? -1 : 1);
      setTableRange({ tableId, range: { r0: next.row, c0: next.col, r1: next.row, c1: next.col } });
      return true;
    }
    if (key === "Escape") {
      setTableRange(null);
      return true;
    }
    if (key === "Delete" || key === "Backspace") {
      // Sequential, not `Promise.all` — `/api/command` has no per-file
      // write queue, so N concurrent `table cell set` calls against the
      // SAME slide is a genuine lost-update race (verified directly: two
      // concurrent calls for different cells left one cell's write silently
      // dropped). One history entry per cell either way (§2.17); this just
      // orders them instead of racing them.
      const cellsToClear = cellsInRange(range);
      void (async () => {
        for (const cell of cellsToClear) {
          await runCommand("table cell set", { slidePath, elementId: tableId, row: cell.row, col: cell.col, text: "" });
        }
      })();
      return true;
    }
    if ((key === "b" || key === "B") && (modifiers.meta || modifiers.ctrl)) {
      const topLeft = table.cells.find((cell) => cell.row === range.r0 && cell.col === range.c0);
      const nextWeight = topLeft && topLeft.fontWeight >= 700 ? 400 : 700;
      void runCommand("table cell style set", {
        slidePath,
        elementId: tableId,
        row: range.r0,
        col: range.c0,
        rowEnd: range.r1,
        colEnd: range.c1,
        attr: "font-weight",
        value: String(nextWeight),
      });
      return true;
    }
    return false;
  }

  /**
   * iframe-local client coordinates (as selection-runtime.js's own
   * `event.clientX/clientY` see them) -> this parent document's client
   * coordinates. `.stage`'s inline transform (translate/scale) sits between
   * `.canvas` and the iframe, so `getBoundingClientRect()` already reflects
   * the current zoom — `rect.width / offsetWidth` recovers that same scale
   * factor from measured DOM sizes without reading `stage-view.ts`'s zoom
   * value at all (NOOP-83 §3.4). This is the only geometry canvas.ts does
   * for the stage relay: a unit conversion, never a zoom/pan decision.
   */
  function toParentClientPoint(point: { x: number; y: number }): { x: number; y: number } {
    const rect = frame.getBoundingClientRect();
    const scale = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1;
    return { x: rect.left + point.x * scale, y: rect.top + point.y * scale };
  }

  /** Same conversion as `toParentClientPoint`, applied to a whole rect — width/height scale by the same factor the corner point does (uniform iframe scaling, never a separate X/Y factor). Used for the "bounds" event's per-item/union rects (§4.6). */
  function toParentClientRect(rect: Rect): Rect {
    const frameRect = frame.getBoundingClientRect();
    const scale = frame.offsetWidth > 0 ? frameRect.width / frame.offsetWidth : 1;
    return {
      x: frameRect.left + rect.x * scale,
      y: frameRect.top + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  /** `OverlayState.label` (§4.6): `null` with nothing selected, `"N elements"` (no path) for a multi-selection, or the single selected element's own name/id plus its ancestor-chain names (outermost first, from the runtime's last-reported `bounds` event) otherwise. */
  function computeOverlayLabel(): { text: string; path: string[] } | null {
    if (selectionIds.length === 0) return null;
    if (selectionIds.length > 1) return { text: `${selectionIds.length} elements`, path: [] };
    const text = selectionNames[0] ?? selectionIds[0];
    const path = overlayAncestors.map((ancestor) => ancestor.name ?? ancestor.id);
    return { text, path };
  }

  /** Converts the stored runtime-px overlay geometry to parent client px against the frame's rect *right now* — the one place that conversion happens, shared by `notifyOverlay` and `subscribeOverlay`'s initial push. Guides are the exception: they only exist mid-drag and are converted where they are computed. */
  function buildOverlayState(): OverlayState {
    return {
      boxes: overlayBoxes.map(toParentClientRect),
      union: overlayUnion ? toParentClientRect(overlayUnion) : null,
      label: computeOverlayLabel(),
      guides: [...overlayGuides],
      dragging: (activeGesture !== null && activeGesture.kind !== "marquee") || overlaySettling,
      hasAnimation: selectionIds.some((id) => currentSlideEffects.some((effect) => effect.target === id)),
      badges: overlayBadges,
    };
  }

  /** `{target, n}` for every distinct effect target, in first-appearance (file) order — D9/[E2.T7]. */
  function computeBadgeTargets(effects: readonly Effect[]): { target: string; n: number }[] {
    const seen = new Set<string>();
    const result: { target: string; n: number }[] = [];
    effects.forEach((effect, index) => {
      if (seen.has(effect.target)) return;
      seen.add(effect.target);
      result.push({ target: effect.target, n: index + 1 });
    });
    return result;
  }

  /**
   * Re-measures every current badge target (D9) — called once per fresh
   * view-mode `srcdoc` load (`runtime-ready`). A move/scale/rotate that
   * shifts an animated element gets picked up for free the same way: a
   * committed gesture's command round-trips through `/api/events` into
   * `reload()`, which rebuilds the srcdoc and fires a fresh
   * "runtime-ready" — there is no separate "re-measure after a drag" path
   * to maintain. No-op outside view mode.
   */
  function requestBadgeMeasurement(): void {
    if (mode !== "view") return;
    badgeTargets = computeBadgeTargets(currentSlideEffects);
    if (badgeTargets.length === 0) {
      overlayBadges = [];
      notifyOverlay();
      return;
    }
    postToFrame({ command: "measure", ids: badgeTargets.map((entry) => entry.target) });
  }

  function notifyOverlay(): void {
    const state = buildOverlayState();
    for (const listener of overlayListeners) listener(state);
  }

  /**
   * E2.T12: re-derives the open chart window's `ChartModel` off
   * `currentSlideMarkup` and pushes it to every `subscribeChartWindow`
   * listener — called after every render() (so a committed edit's
   * normalized result reflects back) and whenever `chartWindowTarget`
   * itself changes (open/close). A target that no longer resolves to a
   * chart (deleted, or the slide changed under it) closes the window
   * rather than surfacing a parse error — same "silently do nothing"
   * posture `enterTextEdit` gives an id that no longer resolves.
   */
  /** Reads `chartWindowTarget`'s current `ChartModel` off `currentSlideMarkup`; closes the window (clears `chartWindowTarget`) as a side effect when the target no longer resolves to a chart. Shared by `notifyChartWindow` and `subscribeChartWindow`'s initial push. */
  function buildChartWindowState(): ChartWindowState | null {
    if (chartWindowTarget === null) return null;
    try {
      if (currentSlideMarkup === null) throw new Error("no slide loaded");
      const model = readChartModel(currentSlideMarkup, chartWindowTarget);
      return { id: chartWindowTarget, slidePath: slides[currentIndex], model };
    } catch {
      chartWindowTarget = null;
      return null;
    }
  }

  function notifyChartWindow(): void {
    const state = buildChartWindowState();
    for (const listener of chartWindowListeners) listener(state);
  }

  /** The runtime's "dblclick-chart" report (selection-runtime.js, plan §3.6) — a plain double-click on a chart container opens its data window. No-op outside view mode, or when `id` does not resolve to a chart (`notifyChartWindow` closes it again in that case). */
  function openChartWindow(id: string): void {
    if (mode !== "view") return;
    chartWindowTarget = id;
    notifyChartWindow();
  }

  function emitStageInput(event: StageInputEvent): void {
    for (const listener of stageInputListeners) listener(event);
  }

  /** Shared by handleSelectionMessage's "clear" case and the public clearSelection() (NOOP-83 §4.5) — same four steps either way. */
  function clearSelectionState(groupPath: string[]): void {
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = groupPath;
    notify();
    pushSelectionToRuntime(selectionIds);
    if (tableRange) setTableRange(null);
  }

  /**
   * Fire-and-forget human-editing lease calls (T5/NOOP-110,
   * `packages/server/src/editing-lock.ts`). The lease is best-effort: a 409
   * (agent already holds the floor) or a network failure is silently
   * swallowed on both begin and end. The real conflict signal for a drag
   * that started while the agent already held the lock is `POST
   * /api/command`'s own 409, handled by each `endXxxGesture` — this lease
   * only exists so an agent about to *start* a turn waits for a human drag
   * already in progress (`EditingLock.acquireAgent`'s `while (state ===
   * "human")` wait) instead of the two racing.
   */
  function beginEditingLease(): void {
    lastEditingLeaseAt = Date.now();
    void fetch("/api/editing/begin", { method: "POST" }).catch(() => {});
  }

  function endEditingLease(): void {
    void fetch("/api/editing/end", { method: "POST" }).catch(() => {});
  }

  function isScaleHandle(value: unknown): value is "nw" | "ne" | "sw" | "se" {
    return value === "nw" || value === "ne" || value === "sw" || value === "se";
  }

  function isTextboxHandle(value: unknown): value is "left" | "right" {
    return value === "left" || value === "right";
  }

  function postToFrame(message: Record<string, unknown>): void {
    frame.contentWindow?.postMessage({ source: "comot-host", ...message }, "*");
  }

  function toUserPoint(point: { x: number; y: number }): { x: number; y: number } {
    if (!viewport) return { x: 0, y: 0 };
    const scaleX = viewport.viewBox.width / viewport.svgRect.width;
    const scaleY = viewport.viewBox.height / viewport.svgRect.height;
    return {
      x: viewport.viewBox.x + (point.x - viewport.svgRect.x) * scaleX,
      y: viewport.viewBox.y + (point.y - viewport.svgRect.y) * scaleY,
    };
  }

  function userXToClient(x: number): number {
    const scaleX = viewport!.svgRect.width / viewport!.viewBox.width;
    return viewport!.svgRect.x + (x - viewport!.viewBox.x) * scaleX;
  }

  function userYToClient(y: number): number {
    const scaleY = viewport!.svgRect.height / viewport!.viewBox.height;
    return viewport!.svgRect.y + (y - viewport!.viewBox.y) * scaleY;
  }

  function elementIndex(): Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }> {
    const index = new Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>();
    if (currentSlideModel) flattenElements(currentSlideModel.elements, [], [], index);
    return index;
  }

  /** `CanvasSelection.elements` (NOOP-143 §1 decision 2/3): `selectionIds[i]`'s parsed `SlideElement`, or `null` when it is not (or no longer) in the current model. */
  function selectedElements(): (SlideElement | null)[] {
    const index = elementIndex();
    return selectionIds.map((id) => index.get(id)?.element ?? null);
  }

  /** `id`'s full container-chain bounds, off the runtime's last `element-bounds` report — `null` when the runtime never measured it (not currently rendered, or a test environment with no real SVG geometry). */
  function computeBounds(id: string): Rect | null {
    return elementBoundsById.get(id)?.slide ?? null;
  }

  function offsetUnion(rects: readonly Rect[], dx: number, dy: number): Rect {
    const minX = Math.min(...rects.map((r) => r.x)) + dx;
    const minY = Math.min(...rects.map((r) => r.y)) + dy;
    const maxX = Math.max(...rects.map((r) => r.x + r.width)) + dx;
    const maxY = Math.max(...rects.map((r) => r.y + r.height)) + dy;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * `POST /api/command` (§4.9) — the only write path this front end has.
   * Never retried, never silently swallowed: a failure is surfaced through
   * `CanvasState.error`, and the caller is responsible for reverting the
   * optimistic preview it already painted.
   */
  async function postCommand(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, input }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string; data?: unknown }
        | null;
      if (!response.ok) {
        return { ok: false, message: (body && typeof body.error === "string" && body.error) || `命令失敗（HTTP ${response.status}）` };
      }
      return { ok: true, message: (body && typeof body.message === "string" && body.message) || "", data: body?.data };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "命令送出失敗" };
    }
  }

  /**
   * Whitelisted commands whose result (NOOP-227, extended by NOOP-275/#156)
   * should become the selection once this write's own reload lands — the
   * Ribbon's insert actions (`textbox add`, `element insert`: 矩形/橢圓/線)
   * and paste (`element paste`). The value says which shape that command's
   * `data` uses: `"elementId"` for the single-element commands' existing
   * string field, `"elementIds"` for paste's array field. This is purely a
   * front-end lookup — the two backend response shapes are not unified by
   * this change. Every other whitelisted command leaves the selection to
   * reload()'s existing clear.
   */
  const SELECT_AFTER_COMMAND = new Map<string, "elementId" | "elementIds">([
    ["textbox add", "elementId"],
    ["element insert", "elementId"],
    ["element paste", "elementIds"],
    ["element duplicate", "elementIds"],
    // [E2.T15]/#205 4.2: grouping selects the new group itself; ungrouping
    // selects the dissolved group's released children (`data.elementIds`,
    // D2's new return value).
    ["element group", "elementId"],
    ["element ungroup", "elementIds"],
    ["table create", "elementId"],
    ["chart create", "elementId"],
  ]);

  /**
   * `CanvasController.runCommand` (NOOP-141) — a thin wrapper over the
   * module's own `postCommand` that also surfaces a failure through
   * `CanvasState.error`, the same way every existing direct-manipulation
   * gesture below already does. No optimistic preview: a Ribbon button
   * click has nothing already painted to revert. A success clears any
   * stale error left over from a previous failed Ribbon command — nothing
   * else in view mode clears it otherwise.
   */
  async function runCommand(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const result = await postCommand(name, input);
    error = result.ok ? null : result.message;
    const shape = SELECT_AFTER_COMMAND.get(name);
    if (result.ok && shape) {
      const data = result.data as { elementId?: unknown; elementIds?: unknown } | undefined;
      const raw = shape === "elementId" ? [data?.elementId] : data?.elementIds;
      const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
      if (ids.length > 0) pendingSelectionIds = ids;
    } else if (result.ok) {
      // Every other successful GUI write (effect add/set/move/remove, text
      // set, …) lands back over /api/events and drives a reload() that
      // drops the selection. Park it so the author keeps what they had —
      // otherwise the right rail's Page/Object sub-tab (keyed on "is
      // anything selected") snaps back to Page after every edit.
      keepSelectionAcrossReload();
    }
    notify();
    return result;
  }

  /**
   * `CanvasController.importAsset` (T3/NOOP-142) — uploads `file`'s raw
   * bytes to `POST /api/asset`. Like `postCommand`, this never throws: a
   * rejected format, a frozen editing lock, or a network failure all come
   * back as `{ ok: false, message }`, which the caller (`runCommand`'s
   * sibling below) turns into `CanvasState.error` the same way every other
   * write failure on this controller does.
   */
  async function importAsset(file: File): Promise<ImportAssetResult> {
    const result = await postAsset(file);
    error = result.ok ? null : result.message;
    notify();
    return result;
  }

  /**
   * [E2.T17] plan §4.3/D5's front-end half of `CanvasController.importAssetFromUrl`
   * — the URL-source counterpart of `importAsset` above, same failure
   * posture (never throws, `{ ok: false, message }` on any failure). The
   * `http(s)`-only scheme check is server-side (asset-upload.ts) — this
   * function is a thin transport wrapper, not a second copy of that
   * validation.
   */
  async function importAssetFromUrl(url: string): Promise<ImportAssetResult> {
    const result = await postAssetUrl(url);
    error = result.ok ? null : result.message;
    notify();
    return result;
  }

  async function postAsset(file: File): Promise<ImportAssetResult> {
    try {
      const bytes = await file.arrayBuffer();
      const response = await fetch("/api/asset", {
        method: "POST",
        headers: { "X-Co-Motion-Asset-Name": encodeURIComponent(file.name) },
        body: bytes,
      });
      return parseAssetResponse(response);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "匯入失敗" };
    }
  }

  async function postAssetUrl(url: string): Promise<ImportAssetResult> {
    try {
      const response = await fetch("/api/asset", {
        method: "POST",
        headers: { "X-Co-Motion-Asset-Url": encodeURIComponent(url) },
      });
      return parseAssetResponse(response);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "匯入失敗" };
    }
  }

  async function parseAssetResponse(response: Response): Promise<ImportAssetResult> {
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; message?: string; error?: string; data?: ImportedAsset }
      | null;
    if (!response.ok || !body?.data) {
      return { ok: false, message: (body && typeof body.error === "string" && body.error) || `匯入失敗（HTTP ${response.status}）` };
    }
    return { ok: true, message: typeof body.message === "string" ? body.message : "", data: body.data };
  }

  /**
   * "full" (single selection: scale + rotate handles — a table scales
   * through its container transform, a chart re-renders at the new size;
   * see `element-edit.ts`'s `scaleSpecialContainer`) / "move-only" (0 or
   * 2+ selected) / "none" — the rendering condition the
   * "selection" host->runtime command carries (§5's multi-select rule:
   * this is computed here, never at click time in the runtime).
   */
  function computeHandleFlags(ids: readonly string[]): { handles: "full" | "move-only" | "none"; textbox: boolean } {
    if (ids.length === 0) return { handles: "none", textbox: false };
    if (ids.length > 1) return { handles: "move-only", textbox: false };
    const entry = elementIndex().get(ids[0]);
    return { handles: "full", textbox: entry !== undefined && entry.element.textWidth !== null };
  }

  /** Pushes the current selection's handle-visibility (and group-scope) state down to the runtime. Called after every selection-mutating path so the corner/rotate/textbox-width handles always reflect the live selection, regardless of which side (runtime click, or host-driven marquee) originated the change. */
  function pushSelectionToRuntime(ids: readonly string[]): void {
    postToFrame({ command: "selection", ids: [...ids], ...computeHandleFlags(ids), groupPath: [...selectionGroupPath] });
  }

  // --- Select all / delete / duplicate / order (NOOP-90/T2 §4.4/§4.5) ---
  // Shared by App.tsx's own document-level keydown listener, the runtime's
  // relayed "stage-key" (handleSelectionMessage above), and the element
  // context menu — one place decides what each of these four actually
  // does, so the three trigger paths can never drift apart.

  /**
   * [E2.T8]: selects a single element by id — Pinned context's own row
   * click (§4.7 of the plan: jump to the slide, select the target, open
   * its comment). No-op when `id` does not resolve on the current slide
   * (e.g. the element was deleted after the comment was written) — same
   * "silently do nothing" posture `beginTextEdit` takes for the same
   * reason, rather than throwing for a state the caller cannot always
   * avoid racing.
   */
  function selectElement(id: string): void {
    if (mode !== "view" || !currentSlideModel) return;
    const entry = elementIndex().get(id);
    if (!entry) return;
    selectionIds = [id];
    selectionNames = [entry.element.name];
    selectionGroupPath = [];
    notify();
    pushSelectionToRuntime(selectionIds);
  }

  /** ⌘A: every TOP-LEVEL element on the current slide — never a group's own children, matching `05-INTERACTIONS.feature`'s "本頁頂層所有元素" wording. `groupPath` resets to top level, same as any other host-driven selection change. */
  function selectAll(): void {
    if (mode !== "view" || !currentSlideModel) return;
    if (currentSlideModel.elements.length === 0) return;
    selectionIds = currentSlideModel.elements.map((element) => element.id);
    selectionNames = currentSlideModel.elements.map((element) => element.name);
    selectionGroupPath = [];
    notify();
    pushSelectionToRuntime(selectionIds);
  }

  /**
   * [E2.T7]: selects exactly `ids` (only the ones that still resolve in
   * `currentSlideModel`, same tolerance `selectOnceLoaded` already gives a
   * stale id) — the stage badge layer's click-to-select (D9's GUI table:
   * "點徽章 → 選取該元素"), the one host-driven selection entry point that
   * did not already exist (`selectAll` picks every top-level element,
   * nothing picks one arbitrary id by name). Same shape as `selectAll`
   * immediately above. `groupPath` resets to top level — a badge is drawn
   * in document (not group-scoped) coordinates, so there is no meaningful
   * "current group" to preserve.
   */
  function selectElements(ids: readonly string[]): void {
    if (mode !== "view" || !currentSlideModel) return;
    const index = elementIndex();
    const entries = ids
      .map((id) => [id, index.get(id)] as const)
      .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined);
    if (entries.length === 0) return;
    selectionIds = entries.map(([id]) => id);
    selectionNames = entries.map(([, entry]) => entry.element.name);
    selectionGroupPath = [];
    notify();
    pushSelectionToRuntime(selectionIds);
  }

  async function deleteSelection(): Promise<void> {
    if (mode !== "view" || selectionIds.length === 0) return;
    const result = await runCommand("element delete", { slidePath: slides[currentIndex], elementIds: [...selectionIds] });
    if (result.ok) clearSelectionState([]);
  }

  /** `+3% / +4%` of the viewBox (prototype's own `comotion-logic-v3.js` offset) — `runCommand`'s existing `SELECT_AFTER_COMMAND` entry for `"element duplicate"` selects the new copy on success. */
  async function duplicateSelection(): Promise<void> {
    if (mode !== "view" || selectionIds.length === 0 || !viewport) return;
    await runCommand("element duplicate", {
      slidePath: slides[currentIndex],
      elementIds: [...selectionIds],
      dx: 0.03 * viewport.viewBox.width,
      dy: 0.04 * viewport.viewBox.height,
    });
  }

  /** `result.data.svg`, the shape `element copy`/`element cut` both return (`docs/spec/cli.md`) — `undefined`/wrong type degrades to `null` (nothing to write to the system clipboard) rather than throwing. */
  function svgFromCommandData(data: unknown): string | null {
    const svg = (data as { svg?: unknown } | undefined)?.svg;
    return typeof svg === "string" ? svg : null;
  }

  /**
   * ⌘C, or the ContextBar Copy button (F8, NOOP-289 決定 (d)): sends
   * `element copy` and returns the `svg` it replies with — the exact bytes
   * `navigator.clipboard.writeText` should receive (the caller does the
   * actual write, mirroring `cutSelection`). Never mutates the
   * presentation. A command failure surfaces through the existing
   * `CanvasState.error` (`runCommand`) and leaves the system clipboard
   * untouched — the caller only writes when this resolves non-null.
   */
  async function copySelection(): Promise<string | null> {
    if (mode !== "view" || selectionIds.length === 0 || currentIndex === -1) return null;
    const slidePath = slides[currentIndex];
    const result = await runCommand("element copy", { slidePath, elementIds: [...selectionIds] });
    const svg = result.ok ? svgFromCommandData(result.data) : null;
    if (svg !== null) pasteOffsetState = clipboardWritten(slidePath);
    return svg;
  }

  /**
   * ⌘X, or the ContextBar Cut button: `element cut` replaces the former
   * "local serialize + `element delete`" pair (決定 (d)/C2) — the CLI does
   * both in one write, returning the same `svg` shape `element copy` does.
   * Awaited before the caller writes `navigator.clipboard`, since there is
   * no synchronous ClipboardEvent to race against (計畫 §3.8/A0 記錄:
   * headless Chromium 底下 keyboard-only ⌘X 不會觸發原生 `cut` 事件，改走
   * 非同步 `navigator.clipboard` API，見 App.tsx 的 keydown handler)。
   */
  async function cutSelection(): Promise<string | null> {
    if (mode !== "view" || selectionIds.length === 0 || currentIndex === -1) return null;
    const slidePath = slides[currentIndex];
    const elementIds = [...selectionIds];
    const result = await runCommand("element cut", { slidePath, elementIds });
    const svg = result.ok ? svgFromCommandData(result.data) : null;
    if (svg === null) return null;
    pasteOffsetState = clipboardWritten(slidePath);
    clearSelectionState([]);
    return svg;
  }

  function cellRangeTarget(): ClipboardTarget {
    if (currentIndex === -1) return null;
    const range = cellRangeProvider();
    return range ? { kind: "cells", slidePath: slides[currentIndex], range } : null;
  }

  async function pasteFromText(text: string): Promise<void> {
    if (mode !== "view" || currentIndex === -1) return;
    const slidePath = slides[currentIndex];
    const classified = classifyClipboardText(text);
    const { dx, dy, next } = nextPasteOffset(pasteOffsetState, slidePath);
    const command = pasteCommandFor(cellRangeTarget(), classified, slidePath, { dx, dy });
    if (!command) return;
    const result = await runCommand(command.name, command.input);
    if (result.ok && command.name === "element paste") pasteOffsetState = next;
  }

  async function orderSelection(direction: "up" | "down" | "front" | "back"): Promise<void> {
    if (mode !== "view" || selectionIds.length === 0) return;
    await runCommand("element order", { slidePath: slides[currentIndex], elementIds: [...selectionIds], direction });
  }

  async function alignSelection(direction: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"): Promise<void> {
    if (mode !== "view" || selectionIds.length < 2) return;
    await runCommand("element align", { slidePath: slides[currentIndex], elementIds: [...selectionIds], direction });
  }

  async function distributeSelection(axis: "horizontal" | "vertical"): Promise<void> {
    if (mode !== "view" || selectionIds.length < 3) return;
    await runCommand("element distribute", { slidePath: slides[currentIndex], elementIds: [...selectionIds], axis });
  }

  async function insertTextBox(input: {
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    fontWeight: number;
    align: "left" | "center" | "right";
  }): Promise<void> {
    if (mode !== "view") return;
    await runCommand("textbox add", { slidePath: slides[currentIndex], ...input });
  }

  // --- Drag-to-move (§4.2) ---

  function beginMoveGesture(point: { x: number; y: number }): void {
    // Without this guard, toUserPoint(point) silently returns { x: 0, y: 0 }
    // when the runtime's first "viewport" message has not landed yet, and
    // that becomes the gesture's startUser with no indication anything went
    // wrong — every subsequent delta is then measured from the wrong
    // origin (NOOP-328: traced to a 180px-off drag landing spot). Declining
    // to start the gesture at all is the same posture updateMoveGesture
    // already takes on every subsequent move while viewport is null.
    if (selectionIds.length === 0 || !currentSlideModel || !viewport) return;
    const index = elementIndex();
    const originals = new Map<string, OriginalTransform>();
    for (const id of selectionIds) {
      const entry = index.get(id);
      if (!entry) continue;
      try {
        originals.set(id, { transform: entry.element.transform, parts: decomposeMatrix(entry.element.matrix) });
      } catch {
        // A skewed/degenerate matrix cannot be decomposed — skip this id
        // rather than aborting the whole gesture for the rest of a
        // multi-selection.
      }
    }
    if (originals.size === 0) return;
    activeGesture = {
      kind: "move",
      ids: [...originals.keys()],
      originals,
      startUser: toUserPoint(point),
      lastDelta: { dx: 0, dy: 0 },
    };
  }

  function updateMoveGesture(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "move" || !viewport) return;
    const now = toUserPoint(point);
    let dx = now.x - gesture.startUser.x;
    let dy = now.y - gesture.startUser.y;
    let guides: SnapGuide[] = [];

    if (!modifiers.alt) {
      const index = elementIndex();
      const movingRects = gesture.ids.map((id) => computeBounds(id)).filter((r): r is Rect => r !== null);
      if (movingRects.length > 0) {
        const moving = offsetUnion(movingRects, dx, dy);
        // Excludes the dragged id(s) themselves (as before), PLUS every one
        // of their own ancestors and descendants (NOOP-91 follow-up: group
        // editing is the first scenario that can drag a NESTED element).
        // Without this, a single-child group is its own snap candidate —
        // its bounds are identical to its only child's, so dragging that
        // child would spuriously "snap" against its own unmoving parent
        // (found while building this ticket's own group-edit test, not
        // from any prior gate).
        const excluded = new Set<string>(gesture.ids);
        for (const id of gesture.ids) {
          const entry = index.get(id);
          if (!entry) continue;
          for (const ancestorId of entry.ancestorIds) excluded.add(ancestorId);
          subtreeIds(entry.element, excluded);
        }
        const candidates: SnapCandidate[] = [];
        for (const id of index.keys()) {
          if (excluded.has(id)) continue;
          const bounds = computeBounds(id);
          if (bounds) candidates.push({ id, bounds });
        }
        const thresholdUser = SNAP_THRESHOLD_PX * (viewport.viewBox.width / viewport.svgRect.width);
        try {
          const result = snapTranslation({
            moving,
            candidates,
            canvas: { width: viewport.viewBox.width, height: viewport.viewBox.height },
            threshold: thresholdUser,
          });
          dx += result.dx;
          dy += result.dy;
          guides = result.guides;
        } catch {
          // Malformed viewport/bounds (should not happen given the
          // isValidRect/computeBounds guards above) — fall back to the
          // unsnapped delta rather than freezing the drag.
        }
      }
    }

    gesture.lastDelta = { dx, dy };
    const items = gesture.ids.map((id) => {
      const original = gesture.originals.get(id)!;
      const parts: TransformParts = { ...original.parts, translateX: original.parts.translateX + dx, translateY: original.parts.translateY + dy };
      return { id, transform: formatTransform(parts) };
    });
    postToFrame({ command: "preview", items });
    // NOOP-90/T2 ADR-0011 amend: guides are drawn by the PARENT document's
    // own GuideLayer overlay now, not inside the sandboxed iframe — a
    // client-px position converts the same way a point's own coordinate
    // does (toParentClientPoint), just for one axis at a time.
    overlayGuides = guides.map((guide) => ({
      orientation: guide.orientation,
      position:
        guide.orientation === "v"
          ? toParentClientPoint({ x: userXToClient(guide.position), y: 0 }).x
          : toParentClientPoint({ x: 0, y: userYToClient(guide.position) }).y,
    }));
    notifyOverlay();
  }

  function revertMovePreview(gesture: MoveGesture): void {
    const items = gesture.ids.map((id) => ({ id, transform: gesture.originals.get(id)!.transform ?? "" }));
    postToFrame({ command: "preview", items });
  }

  /**
   * A committed gesture's write comes back over /api/events and drives a full
   * render(), which would otherwise drop the selection (and with it the
   * context bar). Park the current ids so that render() re-selects them once
   * the reloaded slide is up — same channel `runCommand`'s SELECT_AFTER_COMMAND
   * uses for insert/paste/duplicate. Group drill-in depth is not preserved
   * (selectOnceLoaded resets groupPath), same as those commands.
   */
  function keepSelectionAcrossReload(): void {
    if (selectionIds.length === 0) return;
    pendingSelectionIds = [...selectionIds];
    // The context bar stays down until that re-selection has landed (see the
    // gesture-end handler) — otherwise it flashes: shown the instant the
    // gesture ends, gone when the reload drops the selection, shown again
    // once it is restored.
    overlaySettling = true;
  }

  async function endMoveGesture(cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "move") return;
    overlayGuides = [];
    notifyOverlay();

    if (cancelled) {
      revertMovePreview(gesture);
      return;
    }
    if (roundsToZero(gesture.lastDelta.dx) && roundsToZero(gesture.lastDelta.dy)) {
      // No real movement after snapping — do not create an empty undo step.
      revertMovePreview(gesture);
      return;
    }

    const thisGeneration = generation;
    const result = await postCommand("element move", {
      slidePath: slides[currentIndex],
      elementIds: gesture.ids,
      dx: gesture.lastDelta.dx,
      dy: gesture.lastDelta.dy,
    });
    // A reload() (e.g. from the live-reload /api/events push, or the
    // author navigating away) superseded this gesture while the request
    // was in flight — its result is stale, and the reload's own render()
    // has already replaced the srcdoc wholesale, discarding any preview.
    if (destroyed || thisGeneration !== generation) return;

    if (!result.ok) {
      revertMovePreview(gesture);
      error = result.message;
      notify();
      return;
    }
    keepSelectionAcrossReload();
    // Success: the preview already shows the final position. The write
    // this command just made will arrive back over /api/events and drive
    // reload() on its own — this module deliberately adds no second
    // refresh path (§4.9's closing note).
  }

  // --- Scale handles (§4.2-follow-up) ---

  function beginScaleGesture(point: { x: number; y: number }, corner: "nw" | "ne" | "sw" | "se"): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when viewport hasn't arrived yet (NOOP-328).
    if (!viewport) return;
    if (selectionIds.length !== 1) return;
    const id = selectionIds[0];
    const entry = elementIndex().get(id);
    if (!entry) return;
    // NOOP-65 §7-I: a four-corner handle on a text box only ever changes
    // its declared WIDTH — font-size and the container's own transform
    // never move, and height is whatever the content re-wraps to. This
    // reuses the exact same `textbox width` gesture the left/right
    // mid-edge handles already drive (`beginTextboxWidthGesture`), just
    // entered from a corner instead: "nw"/"sw" behave like the left edge,
    // "ne"/"se" like the right edge (`computeTextboxWidth` only ever reads
    // the horizontal component of the drag). Core's `element scale`
    // command itself is untouched — this is purely a front-end handle
    // remapping (§2 第 8 條).
    if (entry.element.textWidth !== null) {
      beginTextboxWidthGesture(point, corner === "nw" || corner === "sw" ? "left" : "right");
      return;
    }
    let parts: TransformParts;
    try {
      parts = decomposeMatrix(entry.element.matrix);
    } catch {
      return; // Skewed/degenerate matrix — cannot decompose, no gesture.
    }
    const origin = { x: parts.translateX, y: parts.translateY };
    let parentInverse: Matrix;
    try {
      parentInverse = invertMatrix(composeMatrices(entry.ancestors));
    } catch {
      return; // Degenerate (zero-scale) ancestor chain — no ray to project onto.
    }
    const startUser = applyMatrixToPoint(parentInverse, toUserPoint(point));
    if (startUser.x === origin.x && startUser.y === origin.y) return; // No ray to project onto.

    let forceUniform = subtreeForcesUniformScale(entry.element);
    let localBox: Rect | null = null;
    let fullInverse: Matrix | null = null;
    let anchorLocal = { x: 0, y: 0 };
    if (!forceUniform) {
      // `elementBoundsById`'s `local` entry is exactly the box `elementBounds({
      // ancestors: [invertMatrix(own matrix)] })` used to fake by cancelling
      // the chain out (F8, NOOP-289 決定 G1) — the runtime reports it
      // directly (`getBBox()`) instead. Absent (unmeasurable — jsdom, or a
      // genuinely gone element) or a degenerate own-matrix both fall back to
      // uniform-only rather than refusing the gesture outright.
      const local = elementBoundsById.get(id)?.local ?? null;
      try {
        if (local === null) throw new Error("unmeasurable");
        fullInverse = invertMatrix(composeMatrices([...entry.ancestors, entry.element.matrix]));
        localBox = local;
        anchorLocal = cornerPoint(OPPOSITE_CORNER[corner], localBox);
      } catch {
        forceUniform = true;
        localBox = null;
        fullInverse = null;
      }
    }

    activeGesture = {
      kind: "scale",
      id,
      corner,
      original: { transform: entry.element.transform, parts },
      originalMatrix: entry.element.matrix,
      forceUniform,
      origin,
      startUser,
      parentInverse,
      localBox,
      anchorLocal,
      fullInverse,
      lastMode: "scale",
      lastFactor: 1,
      lastWidth: localBox?.width ?? 0,
      lastHeight: localBox?.height ?? 0,
    };
  }

  /** `factor = ((now - origin) · (down - origin)) / |down - origin|²` — the scalar projection of "origin -> now" onto the ray "origin -> pointer-down", expressed as a fraction of that ray's own length. Both ends of the ray live in the element's parent coordinate space (see `ScaleGesture`'s doc comment). */
  function computeScaleFactor(gesture: ScaleGesture, point: { x: number; y: number }): number {
    const now = applyMatrixToPoint(gesture.parentInverse, toUserPoint(point));
    const downX = gesture.startUser.x - gesture.origin.x;
    const downY = gesture.startUser.y - gesture.origin.y;
    const nowX = now.x - gesture.origin.x;
    const nowY = now.y - gesture.origin.y;
    const denom = downX * downX + downY * downY;
    if (denom === 0) return NaN;
    return (nowX * downX + nowY * downY) / denom;
  }

  function revertScalePreview(gesture: ScaleGesture): void {
    postToFrame({ command: "preview", items: [{ id: gesture.id, transform: gesture.original.transform ?? "" }] });
  }

  /** Minimum size a live resize preview/commit is clamped to — 3% of the slide's own width, 0.6% of its height (05-INTERACTIONS.feature「縮放」). The command layer does not enforce this (決定 7: purely a GUI usability floor). */
  function minResizeSize(): { width: number; height: number } {
    return { width: 0.03 * viewport!.viewBox.width, height: 0.006 * viewport!.viewBox.height };
  }

  /**
   * Clamps a slide-frame (viewBox-space) point to the slide's own boundary —
   * 05-INTERACTIONS.feature「縮放」's "不超出投影片": dragging a resize
   * handle past the visible edge of the slide must not push the dragged
   * corner any further than that edge, no matter how the target itself is
   * rotated or nested. Same GUI-only floor as `minResizeSize` (決定 7).
   */
  function clampToViewBox(point: { x: number; y: number }): { x: number; y: number } {
    const box = viewport!.viewBox;
    return {
      x: Math.min(Math.max(point.x, box.x), box.x + box.width),
      y: Math.min(Math.max(point.y, box.y), box.y + box.height),
    };
  }

  /**
   * The non-uniform resize path's live preview: computes `(sx, sy)` against
   * the gesture-start `localBox`, then the SAME anchor-preserving translate
   * delta `packages/core`'s `resizeOneTarget` computes server-side — but
   * expressed as a temporary `scale(sx sy)` transform component rather than
   * a native-attribute change, since that is all the existing `preview`
   * protocol can show (see `ScaleGesture`'s doc comment for why this is
   * visually identical to the real thing). Returns `false` (no preview
   * applied) when the dragged corner has not moved past the origin at all —
   * `updateScaleGesture` then simply holds last frame's preview, the same
   * "freeze rather than show garbage" posture the uniform path already has.
   */
  function applyResizePreview(gesture: ScaleGesture, point: { x: number; y: number }): boolean {
    if (!gesture.localBox || !gesture.fullInverse) return false;
    const draggedLocal = applyMatrixToPoint(gesture.fullInverse, clampToViewBox(toUserPoint(point)));
    const { width: minWidth, height: minHeight } = minResizeSize();
    const width = Math.max(Math.abs(draggedLocal.x - gesture.anchorLocal.x), minWidth);
    const height = Math.max(Math.abs(draggedLocal.y - gesture.anchorLocal.y), minHeight);
    if (!(width > 0) || !(height > 0)) return false;

    const sx = width / gesture.localBox.width;
    const sy = height / gesture.localBox.height;
    const cornerLocalNew = { x: gesture.anchorLocal.x * sx, y: gesture.anchorLocal.y * sy };
    const deltaLocal = { x: gesture.anchorLocal.x - cornerLocalNew.x, y: gesture.anchorLocal.y - cornerLocalNew.y };
    const m = gesture.originalMatrix;
    // The matrix's linear part only (no translation) — deltaLocal is a
    // vector, not a point, so `m.e`/`m.f` must not be added in.
    const deltaParent = { x: m.a * deltaLocal.x + m.c * deltaLocal.y, y: m.b * deltaLocal.x + m.d * deltaLocal.y };

    gesture.lastMode = "resize";
    gesture.lastWidth = width;
    gesture.lastHeight = height;
    const parts: TransformParts = {
      ...gesture.original.parts,
      translateX: gesture.original.parts.translateX + deltaParent.x,
      translateY: gesture.original.parts.translateY + deltaParent.y,
      scaleX: gesture.original.parts.scaleX * sx,
      scaleY: gesture.original.parts.scaleY * sy,
    };
    postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
    return true;
  }

  function updateScaleGesture(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "scale") return;
    if (!(gesture.forceUniform || modifiers.shift)) {
      if (applyResizePreview(gesture, point)) return;
      // Not computable this frame (e.g. dragged exactly onto the anchor) —
      // fall through to holding the last preview rather than freezing on a
      // stale non-uniform frame while the user is still trying to drag.
      return;
    }
    const factor = computeScaleFactor(gesture, point);
    // Non-positive, NaN or infinite: dragged past the origin (would flip)
    // or otherwise invalid. Freeze the preview at the last valid factor
    // rather than showing a flipped/garbage transform — endScaleGesture
    // recomputes from the final point and aborts explicitly if it is
    // still invalid there.
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    gesture.lastMode = "scale";
    gesture.lastFactor = factor;
    const parts: TransformParts = {
      ...gesture.original.parts,
      scaleX: gesture.original.parts.scaleX * factor,
      scaleY: gesture.original.parts.scaleY * factor,
    };
    postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
  }

  async function endScaleGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "scale") return;

    if (cancelled) {
      revertScalePreview(gesture);
      return;
    }

    if (gesture.lastMode === "resize" && gesture.localBox) {
      if (roundsToZero(gesture.lastWidth - gesture.localBox.width) && roundsToZero(gesture.lastHeight - gesture.localBox.height)) {
        revertScalePreview(gesture);
        return;
      }
      const thisGeneration = generation;
      const result = await postCommand("element resize", {
        slidePath: slides[currentIndex],
        elementIds: [gesture.id],
        width: gesture.lastWidth,
        height: gesture.lastHeight,
        anchor: OPPOSITE_CORNER[gesture.corner],
      });
      if (destroyed || thisGeneration !== generation) return;
      if (!result.ok) {
        revertScalePreview(gesture);
        error = result.message;
        notify();
        return;
      }
      keepSelectionAcrossReload();
      // Success: same "no second refresh path" reasoning as endMoveGesture.
      return;
    }

    const factor = computeScaleFactor(gesture, point);
    if (!(factor > 0) || !Number.isFinite(factor)) {
      revertScalePreview(gesture);
      error = "縮放比例必須是正數（拖過了原點）";
      notify();
      return;
    }
    if (roundsToZero(factor - 1)) {
      revertScalePreview(gesture);
      return;
    }

    const thisGeneration = generation;
    const result = await postCommand("element scale", {
      slidePath: slides[currentIndex],
      elementIds: [gesture.id],
      factor,
    });
    if (destroyed || thisGeneration !== generation) return;
    if (!result.ok) {
      revertScalePreview(gesture);
      error = result.message;
      notify();
      return;
    }
    keepSelectionAcrossReload();
    // Success: same "no second refresh path" reasoning as endMoveGesture.
  }

  // --- Rotate handle (§4.2-follow-up) ---

  function beginRotateGesture(point: { x: number; y: number }): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when viewport hasn't arrived yet (NOOP-328).
    if (!viewport) return;
    if (selectionIds.length !== 1) return;
    const id = selectionIds[0];
    const entry = elementIndex().get(id);
    if (!entry) return;
    let parts: TransformParts;
    try {
      parts = decomposeMatrix(entry.element.matrix);
    } catch {
      return;
    }
    const origin = { x: parts.translateX, y: parts.translateY };
    let parentInverse: Matrix;
    try {
      parentInverse = invertMatrix(composeMatrices(entry.ancestors));
    } catch {
      return; // Degenerate (zero-scale) ancestor chain — angle undefined.
    }
    const startUser = applyMatrixToPoint(parentInverse, toUserPoint(point));
    const vx = startUser.x - origin.x;
    const vy = startUser.y - origin.y;
    if (vx === 0 && vy === 0) return; // Pointer-down coincides with the origin — angle undefined, gesture never starts.
    activeGesture = {
      kind: "rotate",
      id,
      original: { transform: entry.element.transform, parts },
      origin,
      parentInverse,
      lastAngleDeg: (Math.atan2(vy, vx) * 180) / Math.PI,
      cumulativeDeltaDeg: 0,
    };
  }

  /** Advances `gesture`'s unwrapped cumulative angle to `point`, normalizing each frame's own delta into (-180, 180] before accumulating — this is what lets a drag exceed ±360° across multiple revolutions instead of clamping at the atan2 discontinuity. Returns false (and leaves the gesture untouched) when `point` sits exactly on the origin, where the angle is undefined. `point` is mapped into the element's parent coordinate space via `gesture.parentInverse` before its angle relative to `origin` is measured (see `RotateGesture`'s doc comment). */
  function advanceRotateGesture(gesture: RotateGesture, point: { x: number; y: number }): boolean {
    const now = applyMatrixToPoint(gesture.parentInverse, toUserPoint(point));
    const vx = now.x - gesture.origin.x;
    const vy = now.y - gesture.origin.y;
    if (vx === 0 && vy === 0) return false;
    const nowAngleDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
    let diff = nowAngleDeg - gesture.lastAngleDeg;
    while (diff > 180) diff -= 360;
    while (diff <= -180) diff += 360;
    gesture.cumulativeDeltaDeg += diff;
    gesture.lastAngleDeg = nowAngleDeg;
    return true;
  }

  function revertRotatePreview(gesture: RotateGesture): void {
    postToFrame({ command: "preview", items: [{ id: gesture.id, transform: gesture.original.transform ?? "" }] });
  }

  function updateRotateGesture(point: { x: number; y: number }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "rotate") return;
    if (!advanceRotateGesture(gesture, point)) return;
    const parts: TransformParts = { ...gesture.original.parts, rotation: gesture.original.parts.rotation + gesture.cumulativeDeltaDeg };
    postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
  }

  async function endRotateGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "rotate") return;

    if (cancelled) {
      revertRotatePreview(gesture);
      return;
    }
    advanceRotateGesture(gesture, point);
    const degrees = gesture.cumulativeDeltaDeg;
    if (roundsToZero(degrees)) {
      revertRotatePreview(gesture);
      return;
    }

    const thisGeneration = generation;
    const result = await postCommand("element rotate", {
      slidePath: slides[currentIndex],
      elementIds: [gesture.id],
      degrees,
    });
    if (destroyed || thisGeneration !== generation) return;
    if (!result.ok) {
      revertRotatePreview(gesture);
      error = result.message;
      notify();
      return;
    }
    keepSelectionAcrossReload();
  }

  // --- Textbox-width handles (F8, NOOP-289 決定 (b): 拖曳中只更新框，<text> 不動) ---

  function beginTextboxWidthGesture(point: { x: number; y: number }, handle: "left" | "right"): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when viewport hasn't arrived yet (NOOP-328).
    if (!viewport) return;
    if (selectionIds.length !== 1) return;
    const id = selectionIds[0];
    const entry = elementIndex().get(id);
    if (!entry || entry.element.textWidth === null) return;

    activeGesture = {
      kind: "textbox-width",
      id,
      handle,
      originalWidth: entry.element.textWidth,
      originalTransform: entry.element.transform,
      startUserX: toUserPoint(point).x,
      lastWidth: entry.element.textWidth,
    };
  }

  function computeTextboxWidth(gesture: TextboxWidthGesture, point: { x: number; y: number }): number {
    const nowX = toUserPoint(point).x;
    const dx = nowX - gesture.startUserX;
    // The container's own transform never changes (`textbox width` has no
    // position input) — the box's left edge stays pinned at the local
    // origin regardless of which handle is dragged (see TextboxWidthGesture's
    // own doc comment). Dragging the right handle further right, or the
    // left handle further left (away from the box), both grow the width.
    return gesture.handle === "right" ? gesture.originalWidth + dx : gesture.originalWidth - dx;
  }

  /** Tells the runtime to show `width` — it only ever updates `data-comot-text-width` and the selection box/handles (`selectionClientRect` in selection-runtime.js), never the `<text>` content itself. */
  function previewTextboxWidth(id: string, width: number): void {
    postToFrame({ command: "preview-textbox-width", id, width });
  }

  function updateTextboxWidthGesture(point: { x: number; y: number }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "textbox-width") return;
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0)) return; // Would go non-positive — freeze at the last valid preview.
    gesture.lastWidth = width;
    previewTextboxWidth(gesture.id, width);
  }

  async function endTextboxWidthGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "textbox-width") return;

    if (cancelled) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      return;
    }
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0) || roundsToZero(width)) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      error = "文字框寬度必須大於 0";
      notify();
      return;
    }
    if (roundsToZero(width - gesture.originalWidth)) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      return;
    }

    const thisGeneration = generation;
    const result = await postCommand("textbox width", {
      slidePath: slides[currentIndex],
      elementId: gesture.id,
      width,
    });
    if (destroyed || thisGeneration !== generation) return;
    if (!result.ok) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      error = result.message;
      notify();
      return;
    }
    keepSelectionAcrossReload();
  }

  // --- Chart data window (F8, NOOP-289 決定 (c): no local preview any more) ---

  /** `CanvasController.closeChartWindow` (Esc): just closes the window — every control already commits straight to a `chart *` command, so there is nothing local left to revert. */
  function closeChartWindow(): void {
    chartWindowTarget = null;
    notifyChartWindow();
  }

  // --- In-place text editing (NOOP-91/#70 US1, T5; F8/NOOP-289 決定 T1) ---

  /**
   * Opens `id` for editing — the shared entry point for `beginTextEdit`
   * (CanvasController) and the runtime's own "dblclick-textbox" report.
   * Lock is NOT checked here: the parsed slide model (`elementIndex`) never
   * carries `data-comot-lock` (it is a container attribute the normal-form
   * parser does not surface on `SlideElement`), so the only place that can
   * answer "is this locked" is the runtime's own DOM — see the
   * "begin-text-edit"/"text-edit-denied" round trip below and
   * selection-runtime.js's `enterRuntimeTextEdit`.
   *
   * 決定 T1: no font is fetched and no layout is computed here any more —
   * `begin-text-edit` carries only `{ id, text }`. The runtime repaints the
   * edited `<text>` itself, entirely locally, on every keystroke (one hard
   * break per line, zero measurement); this side only ever mirrors the
   * latest string (`text-edit-input`) so `commitTextEdit` has something to
   * diff and send.
   */
  async function enterTextEdit(id: string): Promise<void> {
    if (mode !== "view") return;
    const entry = elementIndex().get(id);
    if (!entry) return;
    if (editingState && editingState.id === id) return; // Already editing this exact element — no-op.
    if (editingState) await commitTextEdit(); // Editing a different element — commit it first.
    if (destroyed || mode !== "view") return;

    const textPrimitive = entry.element.primitives.find((primitive) => primitive.tag === "text");
    if (!textPrimitive) return;
    const sourceText = textPrimitive.text;

    editingState = { id, slidePath: slides[currentIndex], originalText: sourceText, currentText: sourceText };
    beginEditingLease();
    postToFrame({ command: "begin-text-edit", id, text: sourceText });
  }

  /**
   * Ends the in-progress edit (if any) and, when the text actually changed,
   * sends the single `text set` command the whole edit produces (§4.3).
   * Safe to call with no edit in progress (no-op) and safe to call more
   * than once for the same edit (the second call finds `editingState`
   * already cleared).
   */
  async function commitTextEdit(): Promise<void> {
    const state = editingState;
    if (!state) return;
    editingState = null;
    if (state.currentText === state.originalText) {
      // Nothing to write — sending "text set" with the unchanged string
      // would still create an empty, pointless undo entry.
      endEditingLease();
      return;
    }
    const thisGeneration = generation;
    const result = await postCommand("text set", {
      slidePath: state.slidePath,
      elementId: state.id,
      newText: state.currentText,
    });
    endEditingLease();
    if (destroyed || thisGeneration !== generation) return;
    if (!result.ok) {
      // The runtime has already exited its own edit session by now (it
      // calls exitRuntimeTextEdit() synchronously before ever sending
      // text-edit-commit) — this just paints `<text>` back to what the
      // file actually holds, using the same local \n-split render
      // `begin-text-edit` itself uses, without reopening an edit session.
      postToFrame({ command: "revert-text-edit", id: state.id, text: state.originalText });
      error = result.message;
      notify();
    }
    // On success: no local write. /api/events's live reload paints the real
    // file content back, the same posture every other gesture's success
    // path relies on.
  }

  // --- Marquee select (§4.8's "框選" row) ---

  function beginMarqueeGesture(point: { x: number; y: number }): void {
    activeGesture = { kind: "marquee", startClient: point };
  }

  function updateMarqueeGesture(point: { x: number; y: number }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "marquee") return;
    const rect: Rect = {
      x: Math.min(gesture.startClient.x, point.x),
      y: Math.min(gesture.startClient.y, point.y),
      width: Math.abs(point.x - gesture.startClient.x),
      height: Math.abs(point.y - gesture.startClient.y),
    };
    postToFrame({ command: "marquee", rect });
  }

  function endMarqueeGesture(point: { x: number; y: number }, cancelled: boolean): void {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "marquee") return;
    postToFrame({ command: "marquee", rect: null });
    if (cancelled || !currentSlideModel || !viewport) return;

    const a = toUserPoint(gesture.startClient);
    const b = toUserPoint(point);
    const marqueeRect: Rect = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };

    const hitIds: string[] = [];
    const hitNames: (string | null)[] = [];
    for (const element of currentSlideModel.elements) {
      const bounds = computeBounds(element.id);
      // An element the runtime never reported bounds for (jsdom in tests,
      // or a genuinely gone element) is simply not selectable by marquee —
      // same degradation `computeBounds`'s callers already apply elsewhere.
      if (bounds && rectsIntersect(marqueeRect, bounds)) {
        hitIds.push(element.id);
        hitNames.push(element.name);
      }
    }
    selectionIds = hitIds;
    selectionNames = hitNames;
    // Marquee always operates at the top level (the loop above walks
    // currentSlideModel.elements, never a group's children) — it
    // unconditionally exits any group-edit scope, same as clicking outside
    // the entered group would.
    selectionGroupPath = [];
    notify();
    pushSelectionToRuntime(hitIds);
  }

  async function advancePastEnd(): Promise<void> {
    // On the last slide of the presentation, advancing past the end does
    // nothing — there is nowhere further to go, and this must not throw.
    if (currentIndex === -1 || currentIndex >= slides.length - 1) return;
    // A stale runtime can still be alive in the old play iframe for a
    // moment after a page change (the iframe is only rebuilt once
    // renderPlay() below actually finishes), so repeated ArrowRight
    // presses before that finishes can fire several advance-past-end
    // messages back to back. Bumping generation here — the same guard
    // play()/exitPlay()/showSlide() already use — makes an earlier one of
    // these calls' renderPlay() discard its own result instead of racing
    // a later one to paint last.
    const thisGeneration = ++generation;
    // §4.6: the page currently on screen plays its own exit first — this
    // is the "leave" half of the page change, and it must finish (or be
    // aborted) before currentIndex moves at all.
    if (!(await playExitTransition(thisGeneration))) return;
    currentIndex += 1;
    notify();
    await renderPlay(thisGeneration, "first", true);
  }

  /** Mirrors advancePastEnd() exactly, in reverse (#46, decision 六) — except retreat never plays an exit (§4.6 决定 7: `prev()` in the prototype is a plain `go()`, no `goWithExit`). */
  async function retreatPastStart(): Promise<void> {
    // At the very start of the presentation, retreating does nothing —
    // there is nowhere further back to go, and this must not throw.
    if (currentIndex <= 0) return;
    // Same race guard as advancePastEnd(): a stale runtime in the old play
    // iframe can still fire repeated retreat-past-start messages for a
    // moment after a page change, and bumping generation here makes an
    // earlier one of these calls' renderPlay() discard its own result
    // instead of racing a later one to paint last.
    const thisGeneration = ++generation;
    currentIndex -= 1;
    notify();
    await renderPlay(thisGeneration, "last", true);
  }

  async function reload(): Promise<void> {
    // A no-op after destroy(): the iframe this closure owns is gone from
    // the DOM, so there is nothing left to redraw, and re-fetching would
    // just race the next mount for no benefit.
    if (destroyed) return;

    // [E4.T7]: an external change (an agent's command, another tab, `co-motion
    // effect *` from the CLI) may have touched any slide's effect list —
    // reload() has no way to know which, so invalidate every cached plan
    // rather than one. render()/renderPlay() below re-fetch as needed.
    invalidateSlideEffectPlans();

    // An edit in progress when an external change lands is committed, not
    // discarded — reload() also fires on this exact edit's own successful
    // `text set` landing back over /api/events, and any OTHER external
    // change must not silently drop text the author already typed. Not
    // awaited: the re-render a few lines down already repaints from
    // whatever the file holds next, and commitTextEdit()'s own generation
    // guard discards its result if a second reload() or a mode change
    // supersedes it first.
    if (editingState) void commitTextEdit();

    // A gesture in progress when an external change lands must be
    // abandoned, not applied on top of a slide that has already moved out
    // from under it (§4.2's "拖曳中投影片被 /api/events 通知變更" row).
    // Clearing it here — before the fetch below — is enough: render()
    // replaces the whole srcdoc, which discards any DOM preview the old
    // gesture painted, and any gesture-move/-end message that still
    // arrives afterwards finds activeGesture already null and no-ops.
    activeGesture = null;

    // Claim this call's generation before the first await, then compare
    // against the live counter after every await: if another call already
    // bumped `generation` past what this call captured, this call's result
    // is stale and must be discarded — no matter how much later it settles.
    const thisGeneration = ++generation;

    const project = await fetchJson<ProjectJson>("/api/presentation");
    if (destroyed || thisGeneration !== generation) return;

    slides = project.slides;
    // Live reload calls reload() on every external edit. Staying on the
    // slide the author is looking at is the whole point — jumping back to
    // the first one because an agent changed a word elsewhere is a bug.
    // Only a presentation that got shorter forces a move, and then only as
    // far as the new last slide.
    currentIndex = slides.length === 0 ? -1 : Math.min(Math.max(currentIndex, 0), slides.length - 1);
    // An external edit can rewrite the very elements the author had
    // selected (or remove them entirely) — the ids it points at are no
    // longer trustworthy, so the selection does not survive a reload.
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    overlayBoxes = [];
    overlayUnion = null;
    overlayAncestors = [];
    overlayGuides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    badgeTargets = [];
    overlayBadges = [];
    notify();
    notifyOverlay();

    if (mode === "play") {
      // §4.6: a background refresh plays neither enter nor exit.
      await renderPlay(thisGeneration, "first", false);
    } else {
      await render(thisGeneration);
    }
  }

  /**
   * Paints the currently selected slide in view mode. Takes the caller's
   * captured generation so navigation shares reload()'s race guard: rapid
   * arrow presses issue overlapping slide fetches, and a slower earlier one
   * must never paint over the newer page the author actually asked for.
   */
  async function render(thisGeneration: number): Promise<void> {
    // Consumed here regardless of outcome (NOOP-227) — stale ids (the
    // slide moved out from under them, or the write failed to parse back)
    // must not leak into some later, unrelated render().
    const selectAfterLoad = pendingSelectionIds;
    pendingSelectionIds = null;
    // Nothing to re-select after this render → nothing to wait for either.
    if (!selectAfterLoad) overlaySettling = false;

    if (currentIndex === -1) {
      currentSlideModel = null;
      currentSlideMarkup = null;
      elementBoundsById = new Map();
      currentSlideEffects = [];
      badgeTargets = [];
      overlayBadges = [];
      frame.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      notifyChartWindow();
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || thisGeneration !== generation) return;
    currentSlideMarkup = svgMarkup;

    currentSlideMarkup = svgMarkup;

    // Parsed once per render so gestures never re-fetch/re-parse mid-drag.
    // A non-compliant slide (should not happen — every write path asserts
    // compliance) simply gets no model: gestures degrade to "no snap
    // candidates, no marquee hits" rather than throwing.
    try {
      currentSlideModel = parseSlide(svgMarkup);
    } catch {
      currentSlideModel = null;
    }
    // The runtime's previous "element-bounds" report belonged to the OLD
    // srcdoc (about to be replaced below) — clear it so a stale bounds map
    // never outlives the slide it measured. The fresh iframe self-reports
    // its own bounds once its script runs (selection-runtime.js's
    // `reportElementBounds`), same "runtime-ready" timing `overlayBadges`
    // already relies on.
    elementBoundsById = new Map();

    // [E2.T7]/[E4.T7]: a slide whose effect list fails to parse is treated
    // as having no animations at all in view mode (GUI table — the
    // player's own parse error is a play-mode-only concern), never thrown
    // up through render().
    try {
      currentSlideEffects = (await fetchSlideEffectPlan(slidePath)).effects;
    } catch {
      currentSlideEffects = [];
    }
    if (destroyed || thisGeneration !== generation) return;

    // [E2.T17]: the embed table is the parent's, not the iframe's — the
    // runtime is only told which ids to measure. Boxes are cleared here
    // and refilled by the runtime's first `embed-boxes` report, so a
    // stale slide's geometry is never painted under the new slide.
    embedEntries = stageEmbedsFor(svgMarkup);
    embedBoxes = {};
    notifyEmbeds();

    frame.srcdoc = wrapSelectionDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      selectionColors(),
      stageMediaFor(svgMarkup),
      Object.keys(embedEntries),
    );

    // E2.T12: re-derive the open chart window's model off the just-loaded
    // markup so a committed edit's normalized result (formatSvgNumber
    // rounding, an existing series' carried-over axis/color) reflects back
    // into the window rather than it quietly drifting from the file.
    notifyChartWindow();
    // #200: `CanvasState.pageStyle` reads off `currentSlideModel`, just
    // parsed above — and, unlike every other field this module notifies on,
    // it has no selection to piggyback a notify() on (Style › Page has to
    // work with nothing selected at all). Before this field existed nothing
    // in `CanvasState` depended on `currentSlideModel` without a selection
    // change also happening in the same call, so `render()` never needed
    // its own notify() — reload()'s own notify() (before this function even
    // runs) was always followed by SOME selection-changing call that
    // notified again. `selectOnceLoaded` below still fires its own later
    // notify() once the frame's `load` event lands; this one is what makes
    // a plain navigation/reload with no pending selection visible at all.
    notify();

    if (selectAfterLoad) selectOnceLoaded(selectAfterLoad, thisGeneration);
  }

  /**
   * NOOP-227: `frame.srcdoc` just changed, which means selection-runtime.js
   * has not attached its `message` listener yet — a `postMessage` sent now
   * would race the navigation and be silently dropped. `load` fires only
   * once the new document (and every synchronous script in it, the
   * listener included) has finished, so waiting for it is what makes this
   * safe. Captures its own target iframe rather than reading the closure's
   * `frame` variable, so a `play()`/`exitPlay()` swap in the meantime
   * cannot redirect the listener onto a different element.
   */
  function selectOnceLoaded(elementIds: string[], thisGeneration: number): void {
    const targetFrame = frame;
    const onLoad = () => {
      targetFrame.removeEventListener("load", onLoad);
      // Whatever happens next, the wait is over — never leave the context
      // bar stuck hidden behind a stale `overlaySettling`.
      overlaySettling = false;
      if (destroyed || thisGeneration !== generation || mode !== "view") return;
      // Only the ids that still resolve are selected — a paste of several
      // elements where one was concurrently deleted still gives feedback
      // for the rest, rather than discarding the whole selection.
      const entries = elementIds
        .map((id) => [id, elementIndex().get(id)] as const)
        .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined);
      if (entries.length === 0) {
        notifyOverlay();
        return;
      }
      selectionIds = entries.map(([id]) => id);
      selectionNames = entries.map(([, entry]) => entry.element.name);
      selectionGroupPath = [];
      notify();
      pushSelectionToRuntime(selectionIds);
    };
    targetFrame.addEventListener("load", onLoad);
  }

  /**
   * Reads the selection box's colours from this document's own tokens.css
   * so selection-runtime.js — living in an opaque-origin document with no
   * access to this document's :root — never has to hard-code them
   * (ADR-0011). Read fresh on every render() call rather than cached, so a
   * future token change takes effect immediately.
   *
   * NOOP-90/T2 §0: reads the design package's own tokens, replacing the
   * old-shell compatibility values this used to read — see
   * `styles/selection.css`'s updated contract note.
   */
  function selectionColors(): { accent: string; handle: string } {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      accent: rootStyle.getPropertyValue("--brand-red").trim(),
      handle: rootStyle.getPropertyValue("--surface-white").trim(),
    };
  }

  /**
   * Paints the currently selected slide in play mode: fetches the markup,
   * derives the plan (Seam C's parent half, in player-plan.ts), and injects
   * both the plan and the runtime into the srcdoc. An effect list the
   * parser rejects surfaces through `error` instead of being applied.
   *
   * `startAt` (#46, decision 五): "first" is every existing caller's
   * behaviour, unchanged. "last" is a parent-side intent used only by
   * retreatPastStart() — the wire integer (`plan.steps.length - 1`, or
   * `-1` for a slide with no effects at all, decision 三) is computed here,
   * after computePlayerPlan() has run, because only the parent knows the
   * slide's step count. The sentinel itself never travels over the wire.
   *
   * `playEnter` ([E2.T11], replacing T6's `animate`): whether THIS
   * particular call should play the new page's own enter transition, on
   * top of whatever `<comot:transition>` it declares. §4.6's table: every
   * caller passes `true` except `reload()`'s background refresh and
   * `previewEffects()` — a page change (forward or backward), and
   * entering play mode itself, all count as a real arrival. This is a
   * distinct layer from element-entrance transitions inside the slide's
   * own runtime: this one animates the `<iframe>` itself, from the parent
   * document, and never touches player-runtime.js.
   */
  async function renderPlay(
    thisGeneration?: number,
    startAt: "first" | "last" = "first",
    playEnter = true,
    /**
     * [E2.T7]/D8: `undefined` (every existing caller) means "not a
     * Preview — never set `plan.preview`". A concrete value (only
     * `previewEffects()` passes one) becomes `plan.preview.effectIndices`:
     * a specific list plays just those effect-list positions, `null`
     * plays the whole slide's steps in sequence.
     */
    previewEffectIndices?: number[] | null,
  ): Promise<void> {
    const captured = thisGeneration ?? generation;
    if (currentIndex === -1) {
      frame.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || captured !== generation) return;

    let planScript: string;
    let hideStyle: string;
    try {
      const plan = await computePlayerPlan(svgMarkup, slidePath);
      if (destroyed || captured !== generation) return;
      const startStep = startAt === "last" ? plan.steps.length - 1 : -1;
      const planForWire = previewEffectIndices === undefined ? plan : { ...plan, preview: { effectIndices: previewEffectIndices } };
      planScript = renderPlanScript(planForWire, startStep);
      hideStyle = renderHideStyle(plan.hidden);
      // [E2.T11]: a slide whose <comot:transition> is present but malformed
      // (§4.2: an unknown effect value, an illegal duration, more than one
      // node) surfaces through the exact same `error` banner + static-
      // fallback path a broken effect list already does, rather than a
      // second, differently shaped failure mode — `plan.transition` comes
      // from the SAME `computePlayerPlan` call above, so a malformed
      // transition fails this same `try` (F8, NOOP-289 決定 E1: riding
      // along on `computePlayerPlan`'s own `fetchSlideEffectPlan` call
      // rather than a second one, since even a cache-hit await is one more
      // microtask on a path PlayChrome.tsx's 2.5s auto-hide timer races
      // against).
      currentPageTransition = plan.transition;
      // Must notify here, not just assign: a prior slide's parse failure
      // may have left `error` set, and without this call React never
      // learns this render cleared it — the error banner from the
      // previous, broken slide would keep showing on top of a page that
      // is in fact playing fine (found in gate review round 2).
      if (error !== null) {
        error = null;
        notify();
      }
    } catch (planError) {
      // A stale generation's own rejection (e.g. a superseded navigation's
      // /api/effects/ fetch resolving after a newer renderPlay() already
      // took over) must not clobber state a newer, still-live call owns.
      if (destroyed || captured !== generation) return;
      // Surfaced, never silently swallowed (design doc). Play the static
      // slide with no runtime rather than leaving the frame blank — the
      // author still sees the slide, plus the reason nothing animates.
      error = planError instanceof Error ? planError.message : "效果清單無法解析";
      notify();
      // A broken page has no transition to play on the way out either —
      // reset to the all-"none" default so a later playExitTransition()
      // call leaving this (static) page does not act on stale data left
      // over from whichever slide was last painted successfully.
      currentPageTransition = { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } };
      frame.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
      return;
    }

    // Same as render(): the ids travel to the runtime inside the plan
    // (`plan.embedIds`), the URLs stay here.
    embedEntries = stageEmbedsFor(svgMarkup);
    embedBoxes = {};
    notifyEmbeds();

    frame.srcdoc = wrapPlayDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      hideStyle,
      planScript,
    );

    const { effect, duration } = currentPageTransition.enter;
    if (playEnter && effect !== "none" && duration > 0) {
      const ms = duration * 1000;
      frame.style.transition = "none";
      frame.style.opacity = "0";
      frame.style.transform = pageTransitionTransform(effect, "enter-start");
      // The "none" transition and the start values above must land in a
      // rendered frame before switching to the real transition, or the
      // browser coalesces both style writes into one paint and nothing
      // animates.
      requestAnimationFrame(() => {
        if (destroyed || captured !== generation) return;
        frame.style.transition = `opacity ${ms}ms var(--ease-out), transform ${ms}ms var(--ease-out)`;
        frame.style.opacity = "1";
        frame.style.transform = "none";
      });
      // [E2.T17]: the embed overlay converts runtime-local px against
      // `frame.getBoundingClientRect()` *at message time*, and the runtime
      // reports its boxes while this transform is still mid-flight — which
      // lands the player offset by however far the frame still had to
      // travel. Re-converting once the transition has settled (the stored
      // runtime-local boxes are unchanged; only the frame's own rect moved)
      // is what puts it back on its placeholder.
      window.setTimeout(() => {
        if (destroyed || captured !== generation) return;
        notifyEmbeds();
      }, ms + 50);
    } else {
      // Instant path must actively clear any inline opacity/transition/
      // transform a PRIOR animation left behind — otherwise this page
      // silently inherits the last frame's mid-animation state instead of
      // showing at rest. `transition` is cleared before the values it was
      // animating, defensively — clearing a value while `transition` is
      // still declared risks animating the removal itself instead of
      // jumping straight to the resting state.
      frame.style.removeProperty("transition");
      frame.style.removeProperty("opacity");
      frame.style.removeProperty("transform");
    }
  }

  /**
   * Plays the page currently on screen's own exit transition (§4.6),
   * before a forward page change replaces `frame.srcdoc`. Unlike
   * renderPlay()'s enter fade-in, no two-step rAF commit is needed here:
   * the `<iframe>` is already sitting at its resting opacity/transform (no
   * inline style forced it there a moment ago), so setting `transition`
   * and the end values together in one synchronous block still animates
   * — the browser compares against the last real paint, not against
   * something this function itself just wrote.
   *
   * Returns `false` when the caller must NOT proceed to the page change at
   * all: either a forward request arrived while an earlier one is still
   * exiting (§4.6 决定: ignored outright, never queued or stacked), or
   * `generation` moved on mid-exit — some other navigation (reload(),
   * exitPlay(), a second showSlide()) superseded this one, and the caller
   * must abandon its own page change rather than apply it on top.
   */
  async function playExitTransition(thisGeneration: number): Promise<boolean> {
    if (exiting) return false;
    const { effect, duration } = currentPageTransition.exit;
    if (effect === "none" || duration === 0) return true;

    exiting = true;
    const ms = duration * 1000;
    frame.style.transition = `opacity ${ms}ms var(--ease-in), transform ${ms}ms var(--ease-in)`;
    frame.style.opacity = "0";
    frame.style.transform = pageTransitionTransform(effect, "exit-end");
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    exiting = false;

    if (destroyed || thisGeneration !== generation) {
      frame.style.removeProperty("transition");
      frame.style.removeProperty("opacity");
      frame.style.removeProperty("transform");
      return false;
    }
    return true;
  }

  async function showSlide(index: number, selectAfter?: readonly string[]): Promise<void> {
    if (destroyed) return;
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      throw new Error(`投影片索引超出範圍：${index}`);
    }

    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++generation;
    // Captured before currentIndex moves — "forward" decides whether the
    // page being left plays an exit (§4.6: only a forward change does),
    // same intent as advancePastEnd()'s "+= 1" vs retreatPastStart()'s
    // "-= 1".
    const forward = index > currentIndex;
    if (mode === "play" && forward) {
      if (!(await playExitTransition(thisGeneration))) return;
    }
    currentIndex = index;
    // E2.T12 plan §4.5: "切換投影片時關閉" — a chart window's edits target
    // a specific element id on the slide being left; render()'s own
    // notifyChartWindow() below would eventually close it anyway (the id
    // resolves on the wrong slide), but that happens after the slide fetch
    // resolves — closing it here means the window never lingers open for a
    // beat while the next slide loads.
    chartWindowTarget = null;
    notifyChartWindow();
    // A selection points at elements' ids on the slide the author was
    // looking at; a stale selection surviving onto a different slide's DOM
    // is a defect, not a convenience.
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    overlayBoxes = [];
    overlayUnion = null;
    overlayAncestors = [];
    overlayGuides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    badgeTargets = [];
    overlayBadges = [];
    notify();
    notifyOverlay();
    if (mode === "play") {
      await renderPlay(thisGeneration, "first", true);
    } else {
      // [E2.T8]: `selectAfter` reuses the exact same "reselect once the
      // new document's `load` fires" mechanism `SELECT_AFTER_COMMAND`
      // parks in `pendingSelectionIds` — calling the public `selectElement`
      // immediately after this promise resolves would race `render()`'s
      // `frame.srcdoc` navigation (NOOP-227: the runtime hasn't attached
      // its `message` listener yet) and be silently dropped, exactly the
      // failure `render()`'s own `selectOnceLoaded` exists to avoid.
      if (selectAfter && selectAfter.length > 0) pendingSelectionIds = [...selectAfter];
      await render(thisGeneration);
    }
  }

  async function next(): Promise<void> {
    if (currentIndex === -1 || currentIndex >= slides.length - 1) return;
    await showSlide(currentIndex + 1);
  }

  async function previous(): Promise<void> {
    if (currentIndex <= 0) return;
    await showSlide(currentIndex - 1);
  }

  async function play(): Promise<void> {
    if (destroyed || mode === "play") return;
    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++generation;
    mode = "play";
    playerHasFocus = false;
    error = null;
    // Entering play mode destroys the view-mode iframe (selection-runtime.js
    // included), so any selection it reported is gone with it.
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    overlayBoxes = [];
    overlayUnion = null;
    overlayAncestors = [];
    overlayGuides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    badgeTargets = [];
    overlayBadges = [];
    rebuildFrame("allow-scripts");
    notify();
    notifyOverlay();
    await renderPlay(thisGeneration);
  }

  async function exitPlay(): Promise<void> {
    if (destroyed || mode === "view") return;
    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++generation;
    mode = "view";
    playerHasFocus = false;
    error = null;
    // Returning to view mode rebuilds the iframe with a fresh
    // selection-runtime.js instance that has never heard a click yet.
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    overlayBoxes = [];
    overlayUnion = null;
    overlayAncestors = [];
    overlayGuides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    badgeTargets = [];
    overlayBadges = [];
    rebuildFrame("allow-scripts");
    notify();
    notifyOverlay();
    await render(thisGeneration);
  }

  /**
   * [E2.T7]/D8: plays either one card's specific effect-list positions
   * (`effectIndices`, the card's own ▶) or the whole slide's steps in
   * sequence (`null`, the panel's Preview button) — reusing `renderPlay`'s
   * `wrapPlayDocument`/player-runtime.js path exactly like `play()` does,
   * never a second animation engine. Side-panel focus is left alone (no
   * `focusPlayer()` call anywhere in the preview path — see the
   * `onWindowMessage` "ready" handler): Animate › Object stays interactive
   * while the preview plays. No-op outside view mode.
   */
  async function previewEffects(effectIndices: number[] | null): Promise<void> {
    if (destroyed || mode !== "view") return;
    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++generation;
    mode = "preview";
    previewReturnSelectionIds = [...selectionIds];
    error = null;
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    overlayBoxes = [];
    overlayUnion = null;
    overlayAncestors = [];
    overlayGuides = [];
    currentSlideEffects = [];
    badgeTargets = [];
    overlayBadges = [];
    rebuildFrame("allow-scripts");
    notify();
    notifyOverlay();
    await renderPlay(thisGeneration, "first", false, effectIndices);
  }

  /**
   * Returns to view mode from Preview, restoring whatever selection was
   * active before `previewEffects()` was called (top-level ids only —
   * drill-in group scope is not preserved). Called from the runtime's own
   * "preview-done" message (D8) or from the GUI on Esc/click-away
   * (`CanvasController.exitPreview`'s public export — see App.tsx/
   * AnimateObjectPanel's own Escape handling). No-op outside preview mode.
   */
  function exitPreview(): void {
    if (destroyed || mode !== "preview") return;
    const thisGeneration = ++generation;
    mode = "view";
    error = null;
    const restoreIds = previewReturnSelectionIds ?? [];
    previewReturnSelectionIds = null;
    rebuildFrame("allow-scripts");
    notify();
    notifyOverlay();
    pendingSelectionIds = restoreIds.length > 0 ? restoreIds : null;
    void render(thisGeneration);
  }

  function focusPlayer(): void {
    if (destroyed || mode !== "play") return;
    frame.contentWindow?.focus();
    // Belt-and-braces, confirmed necessary (not merely defensive) by
    // e2e/player-mode.test.ts: a bare cross-document `.focus()` call from
    // the parent alone did not reliably fire the runtime's own `focus`
    // listener in headless Chromium during testing. Asking the runtime to
    // call `window.focus()` on itself, from inside its own document, is
    // the half that actually lands.
    frame.contentWindow?.postMessage({ source: "comot-host", command: "focus" }, "*");
  }

  function stepPlayer(direction: "advance" | "retreat"): void {
    if (destroyed || mode !== "play") return;
    frame.contentWindow?.postMessage({ source: "comot-host", command: direction }, "*");
  }

  /** Destroys the current iframe and builds a fresh one with the given sandbox tokens, in the same container position. */
  function rebuildFrame(sandbox: string): void {
    const old = frame;
    frame = buildFrame(sandbox);
    container.insertBefore(frame, old);
    old.remove();
  }

  /**
   * 樣式面板 (NOOP-143 §1 decision 4, §4.6): one `element style set` call
   * carrying every currently-selected id, so one undo reverts the whole
   * multi-selection edit at once — the same "one call, not one per id"
   * shape `endMoveGesture` above uses for `element move`. No optimistic
   * preview is painted here (§2 item 3 of the plan): a successful command's
   * file write comes back over `/api/events` and drives `reload()` on its
   * own, same as every other direct-manipulation command in this module.
   */
  async function setStyle(attr: string, value: string): Promise<boolean> {
    if (selectionIds.length === 0 || currentIndex < 0) return false;
    const thisGeneration = generation;
    const result = await postCommand("element style set", {
      slidePath: slides[currentIndex],
      elementIds: [...selectionIds],
      attr,
      value,
    });
    // Same race guard as endMoveGesture: a reload superseding this call
    // while it was in flight means the result is stale.
    if (destroyed || thisGeneration !== generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    // Same as runCommand: the write lands back over /api/events and drives a
    // reload() that drops the selection — park it so the Style › Object
    // sub-tab (keyed on "is anything selected") does not snap back to Page.
    keepSelectionAcrossReload();
    return true;
  }

  async function setTextAlign(align: "left" | "center" | "right"): Promise<boolean> {
    if (selectionIds.length === 0 || currentIndex < 0) return false;
    const thisGeneration = generation;
    for (const elementId of selectionIds) {
      const result = await postCommand("textbox align", {
        slidePath: slides[currentIndex],
        elementId,
        align,
      });
      if (destroyed || thisGeneration !== generation) return false;
      if (!result.ok) {
        error = result.message;
        notify();
        return false;
      }
      keepSelectionAcrossReload();
    }
    return true;
  }

  async function setPageStyle(update: { background?: string; accent?: string }): Promise<boolean> {
    if (currentIndex < 0) return false;
    const thisGeneration = generation;
    const result = await postCommand("slide style set", {
      slidePath: slides[currentIndex],
      ...update,
    });
    if (destroyed || thisGeneration !== generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    keepSelectionAcrossReload();
    return true;
  }

  async function setCanvasSize(width: number, height: number): Promise<boolean> {
    const thisGeneration = generation;
    const result = await postCommand("presentation canvas set", { width, height });
    if (destroyed || thisGeneration !== generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    keepSelectionAcrossReload();
    return true;
  }

  function notify(): void {
    // A fresh object per notification: listeners keep it as React state,
    // and handing out a mutable reference to internal arrays would let a
    // later reload silently rewrite what a listener already read.
    const state: CanvasState = {
      slides: [...slides],
      currentIndex,
      mode,
      playerHasFocus,
      error,
      selection: {
        ids: [...selectionIds],
        names: [...selectionNames],
        groupPath: [...selectionGroupPath],
        elements: selectedElements(),
      },
      dragSignal,
      pageStyle: currentSlideModel?.pageStyle ?? null,
    };
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener: (state: CanvasState) => void): () => void {
    listeners.add(listener);
    listener({
      slides: [...slides],
      currentIndex,
      mode,
      playerHasFocus,
      error,
      selection: {
        ids: [...selectionIds],
        names: [...selectionNames],
        groupPath: [...selectionGroupPath],
        elements: selectedElements(),
      },
      dragSignal,
      pageStyle: currentSlideModel?.pageStyle ?? null,
    });
    return () => {
      listeners.delete(listener);
    };
  }

  void reload();

  return {
    reload,
    showSlide,
    next,
    previous,
    subscribe,
    play,
    exitPlay,
    previewEffects,
    exitPreview,
    focusPlayer,
    stepPlayer,
    beginTextEdit: enterTextEdit,
    runCommand,
    importAsset,
    importAssetFromUrl,
    reportError: (message: string) => {
      error = message;
      notify();
    },
    setStyle,
    setTextAlign,
    setPageStyle,
    setCanvasSize,
    get frameElement() {
      return frame;
    },
    subscribeStageInput: (listener: (event: StageInputEvent) => void) => {
      stageInputListeners.add(listener);
      return () => {
        stageInputListeners.delete(listener);
      };
    },
    setStageHandMode: (hand: boolean) => {
      stageHandMode = hand;
      postToFrame({ command: "stage-mode", hand: stageHandMode });
    },
    clearSelection: () => {
      if (mode !== "view") return;
      clearSelectionState([]);
    },
    selectElement,
    setUndoRedoHandler: (handler: ((kind: "undo" | "redo") => void) | null) => {
      undoRedoHandler = handler;
    },
    subscribeOverlay: (listener: (state: OverlayState) => void) => {
      overlayListeners.add(listener);
      listener(buildOverlayState());
      return () => {
        overlayListeners.delete(listener);
      };
    },
    subscribeEmbeds: (listener: (state: EmbedState) => void) => {
      embedListeners.add(listener);
      listener(buildEmbedState());
      return () => {
        embedListeners.delete(listener);
      };
    },
    refreshEmbeds: () => {
      notifyEmbeds();
    },
    subscribeEmbedCommand: (listener: (command: EmbedCommand) => void) => {
      embedCommandListeners.add(listener);
      return () => {
        embedCommandListeners.delete(listener);
      };
    },
    refreshOverlay: () => {
      notifyEmbeds();
      notifyOverlay();
    },
    subscribeTable: (listener: (event: TableRuntimeEvent) => void) => {
      tableListeners.add(listener);
      if (pendingTableDblclick) {
        const replay = pendingTableDblclick;
        pendingTableDblclick = null;
        listener(replay);
      }
      return () => {
        tableListeners.delete(listener);
      };
    },
    requestTableCells: (id: string) => {
      if (mode !== "view") return;
      postToFrame({ command: "table-cells", id });
    },
    previewTableCols: (id: string, cols: readonly number[]) => {
      if (mode !== "view") return;
      postToFrame({ command: "preview-table-cols", id, cols: [...cols] });
    },
    subscribeTableRange: (listener: (value: { tableId: string; range: CellRange } | null) => void) => {
      tableRangeListeners.add(listener);
      listener(tableRange);
      return () => {
        tableRangeListeners.delete(listener);
      };
    },
    setTableRange,
    handleTableRangeKey,
    selectAll,
    selectElements,
    deleteSelection,
    duplicateSelection,
    copySelection,
    cutSelection,
    pasteFromText,
    orderSelection,
    alignSelection,
    distributeSelection,
    insertTextBox,
    subscribeChartWindow: (listener: (state: ChartWindowState | null) => void) => {
      chartWindowListeners.add(listener);
      listener(buildChartWindowState());
      return () => {
        chartWindowListeners.delete(listener);
      };
    },
    closeChartWindow,
    destroy: () => {
      destroyed = true;
      window.removeEventListener("resize", notifyEmbeds);
      listeners.clear();
      embedListeners.clear();
      embedCommandListeners.clear();
      stageInputListeners.clear();
      overlayListeners.clear();
      tableListeners.clear();
      tableRangeListeners.clear();
      chartWindowListeners.clear();
      window.removeEventListener("message", onWindowMessage);
      // Remove exactly the element this call created — never the
      // container's other children. The container belongs to React
      // (ADR-0001); this module has no business deciding what else lives
      // in it. `.remove()` is also a no-op if the iframe is already
      // detached, so double-destroy stays safe.
      frame.remove();
    },
  };
}

/** A bare, unmounted iframe with the given `sandbox` tokens — appending it is the caller's job. */
function buildFrame(sandbox: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "slide-frame";
  // `sandbox` with no tokens is the opaque-origin default: no scripts, no
  // forms, no top-level navigation, and — load-bearing — no
  // `allow-same-origin`. `allow-same-origin` is what lets the iframe keep
  // this document's origin instead of getting a fresh opaque one; add it
  // and the isolation this exists for is gone. Do not add it, including
  // for the play-mode frame alongside `allow-scripts`: an iframe with both
  // `allow-scripts` and `allow-same-origin` can script itself free of its
  // own sandbox (e.g. reach back into same-origin APIs via
  // `document.domain`), which is strictly worse than either flag alone.
  frame.setAttribute("sandbox", sandbox);
  return frame;
}

/**
 * `@font-face` for the presentation font every `.comot` embeds (ticket
 * #71), injected into every srcdoc `<head>` below so a slide's
 * `font-family="Noto Sans TC"` renders from the font the container ships,
 * not whatever "Noto Sans TC" happens to resolve to (or not) on the host
 * OS. `url()` is an absolute `/api/raw/` path, not relative to `<base>`, so
 * it resolves the same regardless of which wrap function's `baseHref` is in
 * effect. The srcdoc document is an opaque origin, so this fetch is
 * cross-origin even though it targets this same server — see the
 * `Access-Control-Allow-Origin` header serve.ts adds to every `/api/raw/`
 * response for why that still works.
 */
const PRESENTATION_FONT_FACE_STYLE =
  '<style>@font-face{font-family:"Noto Sans TC";src:url("/api/raw/fonts/NotoSansTC-Presentation.ttf") format("truetype");font-weight:400;font-style:normal;}</style>';

/**
 * Wraps the fetched slide markup for `srcdoc`. When `baseHref` is given, a
 * `<base>` element is injected so the browser's own relative-URL resolution
 * — not a regex rewrite of untrusted markup (ADR-0003) — turns a slide
 * reference like `href="../assets/photo.png"` into the byte-preserving
 * `/api/raw/` route's path for it. A `srcdoc` document otherwise resolves
 * relative URLs against the *parent* document's URL, which is why a
 * relative asset reference needs this at all. `<base>` alone needs no
 * sandbox token: subresource loads (`<img>`, `<video>`) from an
 * opaque-origin document to this origin are not blocked by `sandbox`.
 *
 * The `<base>` does NOT disturb same-document fragment references
 * (`url(#grad)`, `<use href="#sym">` and friends) — measured, not assumed,
 * on all three engines by e2e/base-fragment-spike.test.ts, which is why
 * this and wrapPlayDocument/slideDirectory are exported.
 *
 * `background:#fff` on `<body>` (#120): a slide with no background rect of
 * its own (e.g. `co-motion new`'s blank title slide) otherwise leaves this
 * document fully transparent. This function's own callers only ever render
 * inside a black loading/error placeholder (the empty-deck message and
 * renderPlay()'s parse-error fallback, both painted over play.css's `.canvas`
 * `#000`), so a transparent document there reads as solid black instead of a
 * blank page.
 */
export function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${PRESENTATION_FONT_FACE_STYLE}</head><body style="margin:0;background:#fff">${bodyMarkup}</body></html>`;
}

/**
 * Wraps the fetched slide markup for view mode's `srcdoc` (ADR-0011/#56):
 * same shape as wrapSlideDocument, plus selection-runtime.js injected as a
 * second `<script>`, seeded with the accent/handle colours the parent read
 * from its own tokens.css (selectionColors() above) — the opaque-origin
 * document this becomes has no access to that `:root` itself.
 *
 * Deliberately a separate function rather than a new parameter on
 * wrapSlideDocument: that function's signature is depended on by
 * e2e/base-fragment-spike.test.ts, and — more importantly — it is also
 * still used for the play-mode fallback path (renderPlay()'s `catch`
 * branch) and the empty-deck placeholder, neither of which may ever
 * acquire a selection runtime.
 *
 * Colour values are computed CSS strings, never anything an author
 * controls, but they still get the same `<` escaping wrapPlayDocument's
 * planScript needs (see that function's own comment for why a bare
 * `</script` guard is not enough) — cheap insurance against a future
 * token value that happens to contain one.
 *
 * The runtime's two `<script>` tags come BEFORE `bodyMarkup`, not after
 * (unlike wrapPlayDocument, which deliberately puts its runtime last).
 * `document.body` already exists by the time an inline script that is
 * body's first child runs, so `document.body.appendChild(host)` inside
 * selection-runtime.js still works. What this ordering buys: the
 * runtime's capturing `window` click listener registers before any slide
 * script gets a chance to run. A hostile slide can call
 * `stopImmediatePropagation()` from its own capturing `window` listener,
 * which kills every other listener on that same target (`window`) — ours
 * included — regardless of phase. Registering first is the only thing
 * that makes ours win that race; putting the runtime after `bodyMarkup`
 * (or leaving the listener on `document`, which capture never even
 * reaches before `window`) reopens exactly the silent-selection-death
 * hole this ordering exists to close (gate round 2, #56). Do not
 * "simplify" this back to matching wrapPlayDocument's order.
 */
export function wrapSelectionDocument(
  bodyMarkup: string,
  baseHref: string | undefined,
  colors: { accent: string; handle: string },
  /**
   * [E2.T17] plan §4.4: `stageMediaFor(bodyMarkup)`'s own return value —
   * computed by the CALLER (render(), which already has `bodyMarkup` in
   * hand before calling this function), not derived again in here, so this
   * function stays a pure "given everything it needs, produce a document"
   * wrapper, same shape as its `colors` parameter.
   */
  media: Record<string, { src: string; kind: "video" | "audio" }>,
  /** [E2.T17]: ids of the slide's third-party embeds — the runtime measures these and posts their boxes out, nothing more. Same caller-computes-it contract as `media`. */
  embedIds: string[],
): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  const safeColorsJson = JSON.stringify(colors).replace(/</g, "\\u003C");
  // Same `__proto__`-safety reasoning as renderPlanScript() in
  // player-plan.ts: `media` is keyed by untrusted SVG element ids
  // (ADR-0010), and JSON.parse (not a bare object literal) is what keeps a
  // "__proto__" key a genuine own property on the far side of the wire.
  const safeMediaJson = JSON.stringify(JSON.stringify(media)).replace(/</g, "\\u003C");
  const safeEmbedIdsJson = JSON.stringify(JSON.stringify(embedIds)).replace(/</g, "\\u003C");
  // `background:#fff` (#120), same as the other two wrappers: view mode
  // used to lean on `.stage`'s white background for slides that paint no
  // background of their own — stage.css no longer has one (it caused a 1px
  // seam), so the document must be opaque white by itself.
  //
  // `user-select:none` (NOOP-349): a slide is a canvas of objects to
  // manipulate, and the browser's own text selection has no role in it —
  // text is edited through the runtime's hidden textarea (ensureTextarea in
  // selection-runtime.js), never by selecting glyphs in the SVG. Left at the
  // default `auto`, dragging a marquee ALSO ran a native text selection, and
  // native selection walks DOCUMENT ORDER rather than the dragged rectangle:
  // marqueeing the three body lines highlighted the title as well, because
  // the title's text node sits before them in the document even though the
  // rectangle never touched it. The app's own selection was right (3
  // elements); the extra highlight was the browser's. Note this reproduces
  // only under a real pointer — CDP-synthesised drags never start a native
  // selection, so no qa/cases script or e2e test can catch a regression here.
  // Applied to this wrapper only: play mode is a separate document where
  // letting a viewer select text is a different decision.
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${PRESENTATION_FONT_FACE_STYLE}</head><body style="margin:0;background:#fff;user-select:none;-webkit-user-select:none"><script>window.__COMOT_SELECTION_COLORS__=${safeColorsJson};window.__COMOT_SELECTION_MEDIA__=JSON.parse(${safeMediaJson});window.__COMOT_SELECTION_EMBEDS__=JSON.parse(${safeEmbedIdsJson});<\/script><script>${selectionRuntimeSource}<\/script>${bodyMarkup}</body></html>`;
}

/**
 * Wraps the fetched slide markup for play mode's `srcdoc`. The hide style
 * lives in `<head>` so the browser applies it while parsing, before any
 * script runs — the runtime never hides anything on DOMContentLoaded,
 * which would flash the full slide first. The runtime script comes last in
 * `<body>`, after the slide markup, so `document.getElementById` inside it
 * can find every element immediately without waiting for an event.
 *
 * `background:#fff` on `<body>` (#120): this is play mode's normal
 * rendering path (renderPlay()'s non-error branch), painted over play.css's
 * `.canvas` `#000` loading placeholder. A slide with no background rect of
 * its own (e.g. `co-motion new`'s blank title slide) otherwise leaves this
 * document transparent, so the black placeholder never gets covered — the
 * whole point of #000 there (avoid a flash of white before content paints)
 * regresses into the opposite failure: a flash of black that never clears.
 */
export function wrapPlayDocument(bodyMarkup: string, baseHref: string, hideStyle: string, planScript: string): string {
  const baseTag = `<base href="${escapeAttribute(baseHref)}">`;
  // planScript is built from parsed slide attributes (target ids, effect
  // names) — untrusted content (ADR-0010), and it lands inside a raw
  // <script> element, not an HTML text node, so HTML-entity escaping
  // (escapeAttribute's job, above) does not apply here at all. Escaping
  // only a literal "</script" (an earlier version of this function) is
  // not enough: a target containing "<!--<script>" drives the HTML
  // tokenizer into "script data double escaped" state, where the very
  // "</script>" text this function writes to close the tag no longer
  // counts as a real closing tag — the parser keeps consuming straight
  // through the runtime's own <script> below, and play mode never starts
  // (found in gate review round 3). Every `<` inside planScript can only
  // ever occur inside a quoted JSON string value (JSON's own structural
  // characters never include "<"), so replacing all of them with the
  // equivalent JSON/JS string escape `<` is unconditionally safe —
  // it cannot land outside a string literal — and removes every foothold
  // for a tokenizer state change, not just the one this function used to
  // special-case.
  const safePlanScript = planScript.replace(/</g, "\\u003C");
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${PRESENTATION_FONT_FACE_STYLE}${hideStyle}</head><body style="margin:0;background:#fff">${bodyMarkup}<script>${safePlanScript}<\/script><script>${playerRuntimeSource}<\/script></body></html>`;
}

/** The virtual directory a slide lives in, percent-encoded per segment. */
export function slideDirectory(slidePath: string): string {
  const lastSlash = slidePath.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return slidePath
    .slice(0, lastSlash + 1)
    .split("/")
    .map((segment) => (segment === "" ? segment : encodeURIComponent(segment)))
    .join("/");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return response.text();
}
