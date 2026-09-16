// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The canvas: a vanilla DOM module. React hands it a container element and
 * never touches what ends up inside it (ADR-0001) — the slide is the
 * artifact loaded from the presentation file, not something React computes
 * from state.
 *
 * `reload()` is the seam for future work to hook into: the change-push handler
 * calls it directly when the watched file changes on disk, redrawing the
 * slide without React re-rendering anything.
 *
 * A `.slidra` is meant to be opened by people other than its author (ADR-0003
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
 * Play mode reuses the same posture with one deliberate
 * loosening: the play iframe gets `allow-scripts` so the player runtime can
 * run, but never `allow-same-origin` (ADR-0010) — the pair together would
 * let the iframe script itself free of its own sandbox. Because the
 * `sandbox` attribute cannot be changed on a live iframe, entering or
 * leaving play mode destroys the current iframe and builds a fresh one.
 *
 * Element selection (ADR-0011) extends the same loosening to view mode:
 * a zero-token sandbox delivers no clicks to the parent at all (no script,
 * no `allow-same-origin`, nothing bubbles out), so the view-mode iframe now
 * also carries `allow-scripts` — with the same `allow-same-origin` ban —
 * and gets its own injected script (selection-runtime.js) whose only job is
 * reporting which element was clicked and drawing a selection box over it.
 * The zero-token posture stays untouched for the overview thumbnails
 * (overview.ts): this loosening is cut in exactly one place, the main
 * canvas.
 *
 * That runtime resolves a click to the OUTERMOST id-carrying
 * ancestor — an element's `<g>` container, or the whole group when the
 * element sits inside one (ADR-0012). Nothing changes on this side of the
 * seam: the `{ id, name }` arriving over postMessage has always been the
 * resolved node's own `id` and `data-slidra-name`, and after conversion
 * that node is the container.
 *
 * Direct manipulation extends the same runtime with drag-to-move
 * and marquee select. The runtime (selection-runtime.js) only ever reports
 * raw client-px coordinates and paints whatever transform/guide/marquee
 * string this module hands it — matrix decompose and snapping happen here,
 * using this package's own `geometry.ts` (the web bundle no
 * longer depends on core at all), because the runtime is an unbundled
 * `?raw` script that cannot import anything. Bounding-box geometry is the
 * one exception (decision G1): the runtime measures real rendered geometry
 * (`getBBox()`/`getCTM()`) itself and reports it up, since there is no
 * bundled font-metrics engine here any more to compute one from the parsed
 * model. See docs on the postMessage protocol below (`SelectionMessage`).
 */
import { slidePaintKey } from "./slide-paint-key.js";
import type { EmbedProvider } from "./embed.js";
import { computePlayerPlan, renderHideStyle, renderPlanScript, stageEmbedsFor, stageMediaFor, type StageEmbedEntry } from "./player-plan.js";
import { fetchSlideEffectPlan, invalidateSlideEffectPlans } from "./effects.js";
import type { Effect, SlideTransition } from "./effects.js";
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
  type BackgroundImage,
  type PageStyle,
  type SlideElement,
  type SlideModel,
} from "./slide-dom.js";
import { INITIAL_PASTE_OFFSET_STATE, clipboardWritten, nextPasteOffset, type PasteOffsetState } from "./paste-offset.js";
import { classifyClipboardText } from "./clipboard/payload.js";
import { pasteCommandFor, type CellRangeProvider, type ClipboardTarget } from "./clipboard/dispatch.js";
import { tabTarget, cellsInRange, normalizeRange, isCellInRange, type CellRange } from "./table-overlay.js";
import { readChartModel, type ChartModel } from "./chart-model.js";
import { isPlayerMessage, isSelectionMessage, isNonNegativeRect, isBoundsItem, isMeasuredItem, isElementBoundsItem, isTableCellRectItem, isFiniteNumber, isValidPoint, isValidRect, isStringArray, type SelectionMessage, type TableRuntimeEvent } from "./canvas/runtime-messages.js";
export type { TableRuntimeEvent } from "./canvas/runtime-messages.js";
import { SNAP_THRESHOLD_PX, HUMAN_RENEW_THROTTLE_MS, roundsToZero, rectsIntersect, flattenElements, subtreeIds, subtreeForcesUniformScale, OPPOSITE_CORNER, cornerPoint, type Viewport, type OriginalTransform, type MoveGesture, type ScaleGesture, type RotateGesture, type TextboxWidthGesture, type ActiveGesture, type TextEditState } from "./canvas/gesture-geometry.js";
import { EMPTY_DECK_DOCUMENT, fetchJson, fetchText, setPresentationFonts, slideDirectory, wrapPlayDocument, wrapSelectionDocument, wrapSlideDocument } from "./canvas/frame-documents.js";
export { presentationFontFaces, setPresentationFonts, slideDirectory, wrapPlayDocument, wrapSelectionDocument, wrapSlideDocument } from "./canvas/frame-documents.js";
import { normalizeTemplatePaths, pageTransitionTransform, type ProjectJson } from "./canvas/project-io.js";
export { fetchAssetList } from "./canvas/project-io.js";
import { createGestures, type GestureDeps } from "./canvas/gestures.js";
import { createRuntimeMessageHandlers, type RuntimeMessageDeps } from "./canvas/runtime-message-handlers.js";

export type CanvasMode = "view" | "play" | "preview";

/**
 * A `selection-runtime.js` wheel/pointer/keyboard event, already validated
 * and — for every variant that carries a `point` — converted from the
 * iframe's own client coordinates into this parent document's client
 * coordinates (`toParentClientPoint` below). This is a pure relay: canvas.ts
 * does zero zoom/pan geometry itself (§2 decision 2) —
 * `point`/`deltaX`/`deltaY` are handed to `subscribeStageInput`'s listener
 * (Stage.tsx) in exactly the shape its existing local `handleWheel`/
 * `handleMouseDown` math already expects from a real DOM `WheelEvent`/
 * `MouseEvent` — Stage.tsx runs that same math unmodified against this
 * event's `point`/`deltaX`/`deltaY`. Only emitted for on-slide input; the
 * gutter (the empty margin) area's own DOM listeners keep calling that math directly.
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
  /** `ids[i]`'s `data-slidra-name`; `null` when the element carries none. */
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
 * High-frequency overlay geometry (§4.6/§8 decision 1): name/group
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
  /** `null` when nothing is selected; `"N elements"` for a multi-selection (no path); the single selected element's own name/id and ancestor-chain names (outermost first) otherwise — grouping reads `path` for its "Group 2 › Group 1" drill-in label. */
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
  /**
   * The style panel's manual controls: the current slide's background image, straight off
   * `currentSlideModel.backgroundImage` — `null` both when there is no
   * current slide and when the current slide has no background image;
   * callers distinguish the two the same way they already do for
   * `pageStyle` (`currentIndex === -1`).
   */
  backgroundImage: BackgroundImage | null;
  /**
   * Which page list `slides`/`currentIndex` currently index — `"slides"`
   * normally, `"templates"` while master mode
   * (`.dev_docs/adr/0013-templates-not-masters.md`) is active. Only
   * `setPageSource` changes this.
   */
  pageSource: "slides" | "templates";
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
   * Switches the page list `CanvasState.slides`/`currentIndex` index
   * between the deck's slides and its templates (master-mode
   * `.dev_docs/adr/0013-templates-not-masters.md`) — the one seam every
   * other read/write path (`showSlide`, `runCommand`, every
   * `slides[currentIndex]` call site) stays unaware of. A no-op when
   * already on the requested source. Resets `currentIndex` to the head of
   * the new list — there is no meaningful correspondence between a slide
   * index and a template index — so a caller that needs to land on a
   * specific page (leaving master mode back to the slide the author was
   * looking at) calls `showSlide` afterwards.
   */
  setPageSource: (source: "slides" | "templates") => Promise<void>;
  /**
   * `project.slides.length`, independent of `pageSource` — while master
   * mode has swapped `CanvasState.slides` over to the template list, the
   * "Let the agent update the slides" prompt (AC3) still needs to say how
   * many real slides exist.
   */
  readonly deckSlideCount: number;
  /**
   * Throws when the index is out of range — that is a programming error,
   * not user input. `selectAfter` re-selects these element ids
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
   * Plays `effectIndices` (a specific card's own effect-list
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
   * the runtime's own keydown listener never saw it. Safe to call
   * outside play mode (no-op). See the runtime's `message` handler for
   * the transient-activation limit this path carries.
   */
  stepPlayer: (direction: "advance" | "retreat") => void;
  /**
   * Opens `elementId` for in-place text editing — the
   * same entry point double-clicking an existing text box on the canvas
   * uses. No-op (no throw) when `elementId` does not name an existing,
   * unlocked text box, the canvas is not in view mode, or the box's font
   * cannot be resolved (`CanvasState.error` is set in that last case).
   * Resolves once editing has actually started (or the attempt has been
   * abandoned) — never once the edit itself is committed.
   */
  beginTextEdit: (elementId: string) => Promise<void>;
  /**
   * Sends a whitelisted command (the Ribbon's common-action buttons). The only
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
   * Uploads one file's raw bytes to `POST /api/asset` — the
   * human asset-import path: file picker, drag/drop, clipboard paste.
   * Separate from `runCommand` because the transport is different (raw
   * bytes, not JSON `{name, input}`) — the whitelist and command-dispatch
   * machinery `runCommand` wraps do not apply here at all, `asset import`
   * is deliberately not on `/api/command`'s whitelist. Same failure
   * posture as `runCommand`: never thrown, surfaced through
   * `CanvasState.error`, and a success clears any stale error.
   */
  importAsset: (file: File) => Promise<ImportAssetResult>;
  /**
   * §4.3/D5 — the URL-source counterpart of `importAsset`,
   * for the Image/Video/Audio panels' URL text field. Same transport family
   * as `importAsset` (`POST /api/asset`, same 409-freeze gate, same
   * `CanvasState.error` failure posture), just a different header instead
   * of a raw-bytes body.
   */
  importAssetFromUrl: (url: string) => Promise<ImportAssetResult>;
  /**
   * Surfaces `message` through the same `CanvasState.error` → `[role=alert]`
   * channel `runCommand`/`importAsset` already use (decision 7), for a front-end
   * validation failure that never reaches the network — e.g. App.tsx
   * rejecting a multi-file drop before calling `importAsset` at all. Never
   * used for a real command/import failure; those already report through
   * their own call.
   */
  reportError: (message: string) => void;
  /**
   * Style panel (§1 decision 4): sends `element style set` for the
   * current selection's every id in one call, with the given attr/value.
   * Returns `false` when the command failed — the message is already in
   * `CanvasState.error` by the time this resolves, matching `postCommand`'s
   * own error-surfacing contract; the caller reverts whatever it painted.
   */
  setStyle: (attr: string, value: string) => Promise<boolean>;
  /**
   * Style panel (§4.1): the Text section's Align field. Sends `textbox
   * align` once per currently-selected text box, sequentially (that command
   * names a single element, unlike `element style set`'s list form) — for
   * the common single-selection case this is one command, one undo step;
   * a multi-box selection costs one undo step per box. Same failure
   * contract as `setStyle`.
   */
  setTextAlign: (align: "left" | "center" | "right") => Promise<boolean>;
  /**
   * Style panel (§4.3/§4.4): Style › Page's Background/Accent fields.
   * Sends `slide style set` for the current slide. Same failure contract as
   * `setStyle`. No-op (returns `false`) when there is no current slide.
   */
  setPageStyle: (update: { background?: string; accent?: string }) => Promise<boolean>;
  /**
   * Style panel: Style › Page's background image block. Sends `slide
   * background set`: `asset` sets/replaces the background image, `none:
   * true` clears it, `opacity` adjusts transparency (the CLI requires
   * exactly one of `--asset`/`--none`, so adjusting opacity alone must also
   * pass the current asset along). Same failure behavior as `setStyle`;
   * returns `false` and sends no command when there is no current slide.
   */
  setBackgroundImage: (update: { asset?: string; none?: boolean; opacity?: number }) => Promise<boolean>;
  /**
   * Style panel (§4.3): Style › Page's Width/Height/preset/swap controls.
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
   * Stage.tsx's on-slide wheel/pointer/Space relay (§2 decision 2/§4).
   * Fires only for `StageInputEvent`s the runtime reported that already
   * passed validation and (where relevant) coordinate conversion — see
   * that type's own doc comment. Returns an unsubscribe function, same
   * shape as `subscribe`.
   */
  subscribeStageInput: (listener: (event: StageInputEvent) => void) => () => void;
  /**
   * The runtime's on-slide pointer position, reported only
   * while nothing else is consuming the pointer and something is selected
   * (see `SelectionMessage`'s "stage-hover" doc comment) — already
   * converted to this parent document's client px. `OverlayLayer` combines
   * this with its own `window.mousemove` (for the area outside the iframe)
   * to drive the context bar's ghost/solid toggle. A transient event
   * channel, same shape as `subscribeStageInput` — nothing is replayed to a
   * listener that subscribes after a move already fired.
   */
  subscribeStageHover: (listener: (point: { x: number; y: number }) => void) => () => void;
  /**
   * Tells `selection-runtime.js` whether hand/grab mode (the ✋ toggle or a
   * temporary Space-hold) is active — while true, the runtime hands every
   * pointer to the pan relay above instead of starting a selection/drag
   * gesture (§4.2). Re-sent automatically on the runtime's own
   * "runtime-ready" report (§2.1(c)), so toggling ✋ on and then changing
   * slides does not silently drop back to normal selection.
   */
  setStageHandMode: (hand: boolean) => void;
  /**
   * 05-INTERACTIONS.feature's "hand/grab mode" scenario: clears the current
   * selection the same way `handleSelectionMessage`'s own "clear" case
   * does (id/name/groupPath reset, notify, push the empty selection back
   * to the runtime) — extracted here so Stage.tsx's `handleToggleHand` can
   * call it directly instead of leaving a no-op gap.
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
  /** A column-width drag's live preview (`preview-table-cols` command, decision 13: never re-wraps text) — `cols` is the FULL column-width array with the dragged column's candidate width substituted in. No-op outside view mode. */
  previewTableCols: (id: string, cols: readonly number[]) => void;
  /**
   * The cell range currently active inside a selected table (plan
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
  /** Selects exactly `ids` (a stage animation badge click) — ids that no longer resolve are dropped; a no-op if none resolve. No-op outside view mode. */
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
  /** ⌘C, or the ContextBar Copy button (decision (d)): sends `element copy`, resets the paste-offset run (`paste-offset.ts`'s `clipboardWritten`) on success. Never mutates the presentation. Returns the `svg` the caller should write via `navigator.clipboard.writeText`, or `null` with no selection or on command failure. */
  copySelection: () => Promise<string | null>;
  /** ⌘X, or the ContextBar Cut button: sends `element cut` (replaces the former local-serialize + `element delete` pair) — awaited, since (plan §3.8/A0) there is no synchronous ClipboardEvent to race against a mutation here. `null` with no selection or on command failure. */
  cutSelection: () => Promise<string | null>;
  /** ⌘V, or the ContextBar Paste button: routes `text` — a slidra elements payload, or plain text with a cell range selected — to the matching command; silent no-op for anything else (including plain text with nothing selected). The window `paste` event's own image-file branch (App.tsx) is untouched and independent of this. */
  pasteFromText: (text: string) => Promise<void>;
  /**
   * The Text insert panel's Insert action (§3.8/A11): sends
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
    fill: string;
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




export function mountCanvas(container: HTMLElement): CanvasController {
  let destroyed = false;
  // The selected slide lives here, not in React (ADR-0001/ADR-0002): the
  // slide on screen is the artifact, not something React computes from
  // state. React subscribes to read it and issues commands to change it.
  let slides: string[] = [];
  let currentIndex = -1;
  // Master mode's own page-source switch (`setPageSource`). `slides` above
  // holds whichever list this is set to; `deckSlides` always holds the
  // deck's real slide list regardless, so `deckSlideCount` stays correct
  // while `slides` has been swapped to the template list.
  let pageSource: "slides" | "templates" = "slides";
  let deckSlides: string[] = [];
  // The page currently on screen's own enter/exit transition,
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
  // queued (§4.6 decision: "no queueing, no stacking") — see that function's own
  // comment.
  let exiting = false;
  let mode: CanvasMode = "view";
  // The paint key (`slidePaintKey`) of the slide the view-mode iframe
  // currently shows, or null whenever `srcdoc` was last set by something
  // other than `render()` (empty deck, play/preview, a rebuilt frame.element) —
  // those never count as "already painted". `render()` compares against
  // it to skip a repaint that would show the exact same picture.
  // The play-mode twin of `frame.paintedView`. A live reload while playing
  // (`reload()` → `renderPlay(…, playEnter=false)`) used to reassign
  // `srcdoc` unconditionally, which restarts the play runtime — the step
  // position jumps back to the start and the page blinks — even when the
  // agent's command only touched `<metadata>`. Same key, same slide, same
  // frame.element ⇒ keep the running document; the plan cache was already
  // invalidated by reload(), so the next real navigation re-reads it.
  let error: string | null = null;
  // The selection Preview entered from, restored (top-level ids
  // only — drill-in group scope is not preserved, a deliberate
  // simplification) once the runtime posts "preview-done" and this module
  // returns to view mode. `null` between previews.
  let previewReturnSelectionIds: string[] | null = null;
  // The elements the author has selected in view mode (ADR-0011,
  // extended to a list). Cleared (with notify()) whenever the
  // slide changes, reload() runs, play() is entered, or exitPlay()
  // returns — a selection surviving a page change would point at a
  // different slide's DOM entirely.
  const selection = { ids: [] as string[], names: [] as (string | null)[], groupPath: [] as string[] };
  // Mirrors selection-runtime.js's own `groupPath` — cleared alongside
  // selection.ids/Names everywhere they are cleared (see that comment).
  // `paste-offset.ts`'s own state, one instance per editor session
  // (that module's own doc comment) — advanced by a successful `copySelection`/
  // `cutSelection`/`pasteFromText`, never by a `table cell paste` (offsets
  // are an element-clipboard-only concept).
  let pasteOffsetState: PasteOffsetState = INITIAL_PASTE_OFFSET_STATE;
  // Cell-range-selection routing seam (plan "supplement (b)"): always
  // returns null until a real implementation replaces it — see
  // `clipboard/dispatch.ts`'s `CellRangeProvider` doc comment.
  // The element(s) a just-finished insert/paste command created,
  // still waiting for the reload()/render() its own write triggers over
  // /api/events. reload() would otherwise clear the selection like every
  // other reload — this is the one case where the id(s) ARE trustworthy,
  // because this module made them moments ago. Consumed (set back to null)
  // by the render() that follows, whether or not any id still resolves.
  // Extended from a single id to a list, so a multi-element
  // paste selects everything it created rather than just the first one.
  let pendingSelectionIds: string[] | null = null;
  // True from a committed gesture until render() has re-selected
  // `pendingSelectionIds` — reported as `OverlayState.dragging` so the
  // context bar stays hidden across the reload (see keepSelectionAcrossReload).
  // See CanvasState.dragSignal's own comment — bumped on every "drag-enter"
  // message, never reset (there is nothing to reset it back to: it is an
  // edge counter, not a level).
  let dragSignal = 0;
  // §4/§2.1(c): Stage.tsx's subscribers to the on-slide wheel/
  // pointer/Space relay, and the last hand/grab-mode value `setStageHandMode` was
  // told to apply — resent to the runtime whenever it reports
  // "runtime-ready" (a slide change rebuilds the srcdoc and loses whatever
  // the previous document's `stageHandMode` variable held).
  const listeners = {
    stageInput: new Set<(event: StageInputEvent) => void>(),
    stageHover: new Set<(point: { x: number; y: number }) => void>(),
    overlay: new Set<(state: OverlayState) => void>(),
    table: new Set<(event: TableRuntimeEvent) => void>(),
    tableRange: new Set<(value: { tableId: string; range: CellRange } | null) => void>(),
    chartWindow: new Set<(state: ChartWindowState | null) => void>(),
    embed: new Set<(state: EmbedState) => void>(),
    embedCommand: new Set<(command: EmbedCommand) => void>(),
    state: new Set<(state: CanvasState) => void>(),
  };
  let stageHandMode = false;
  /** `subscribeStageHover`'s listeners — same "transient event, no persisted state" shape as `listeners.stageInput`, kept separate rather than folded into `StageInputEvent` (its own doc comment) because this is not stage navigation, it drives the context bar's own ghost/solid toggle in `OverlayLayer`. */
  // NOOP-90/T2 §4.6: the runtime's last-reported per-selected-element
  // bounds/ancestors, kept in the runtime's OWN
  // iframe client px — the conversion to this parent document's client px
  // happens in `buildOverlayState()` at emit time, so a later zoom/pan only
  // needs `refreshOverlay()` to re-emit, not a fresh "bounds" round trip.
  // See `OverlayState`'s own doc comment for why this is a separate,
  // high-frequency channel rather than `CanvasState`.
  /** E2.T14 §4.5: table cell hit reports and `table-cells` replies — transient events, same "listener set, no persisted state" shape as `subscribeStageInput`, not folded into `CanvasState`/`OverlayState` since neither is about a table specifically. */
  /** E2.T14r2 §4.1: `subscribeTableRange`'s listeners — a real state channel (unlike `listeners.table` above), so a late subscriber gets the current value immediately, same contract as `listeners.overlay`. */
  /** The active cell range, or `null`. Built from `table-cell-click`/`table-cell-contextmenu` reports (handleSelectionMessage below) and cleared whenever the selection changes away from this table (§4.1's lifecycle table). */
  const tableRange = {
    current: null as { tableId: string; range: CellRange } | null,
    anchor: null as { row: number; col: number } | null,
    provider: (() => null) as CellRangeProvider,
    pendingDblclick: null as TableRuntimeEvent | null,
  };
  /** The cell a range gesture started from — set on a non-additive click/contextmenu, read on a ⇧-click to build the range via `normalizeRange`. Private to this module: not part of the public `tableRange.current`, exactly like `TableOverlay`'s old local `anchorRef` this replaces. */
  // E2.T12 plan §2.8/§4.5: at most one chart data window open at a time
  // (`chartWindow.target`, `null` = closed) — opened by the runtime's
  // "dblclick-chart" report, closed by Esc (ChartWindow.tsx's own
  // listener) or a slide change (`showSlide`). A separate channel from
  // `subscribeOverlay`/`CanvasState` for the same reason those are: high-
  // frequency during local editing, and shaped nothing like either.
  const chartWindow = { target: null as string | null };
  const overlay = {
    boxes: [] as Rect[],
    union: null as Rect | null,
    ancestors: [] as { id: string; name: string | null }[],
    guides: [] as { orientation: "v" | "h"; position: number }[],
    badges: [] as { target: string; n: number; rect: Rect }[],
    badgeTargets: [] as { target: string; n: number }[],
    settling: false,
  };
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
  // once it reports "runtime-ready". `overlay.badges` holds the last
  // successful `measured` reply, converted to parent client px.
  // [E2.T17] the embed overlay's own state channel. `embeds.entries` is the
  // current slide's `stageEmbedsFor` table (set at render time, parent
  // side); `embeds.boxes` is where each of those elements last reported
  // itself to be, already converted to parent client px. Kept apart from
  // `OverlayState` because the embed overlay must also render in play
  // mode, where `OverlayLayer` is unmounted entirely (Stage.tsx's
  // `shellVisible` gate).
  const embeds = { entries: {} as Record<string, StageEmbedEntry>, boxes: {} as Record<string, Rect> };

  /** Validates an `embed-command` payload and fans it out. Both fields come from untrusted slide-side script (ADR-0010), so an unknown id or command is dropped, never forwarded to a player. */
  function emitEmbedCommand(rawId: unknown, rawCommand: unknown): void {
    if (typeof rawId !== "string" || !Object.prototype.hasOwnProperty.call(embeds.entries, rawId)) return;
    if (rawCommand !== "play" && rawCommand !== "pause") return;
    const command: EmbedCommand = { id: rawId, command: rawCommand };
    for (const listener of listeners.embedCommand) listener(command);
  }

  /** Validates and stores an `embed-boxes` payload from either runtime, then pushes the new state out. Every field is untrusted slide-side data (ADR-0010), so nothing is stored before `isMeasuredItem` has checked its shape. */
  function applyEmbedBoxes(rawItems: unknown): void {
    const items = Array.isArray(rawItems) ? rawItems.filter(isMeasuredItem) : [];
    const next: Record<string, Rect> = {};
    for (const item of items) next[item.id] = item.rect;
    embeds.boxes = next;
    notifyEmbeds();
  }

  /** Converts the stored runtime-px embed boxes to parent client px against the frame.element's rect *right now* — same contract, and same reason, as `buildOverlayState`. An entry whose element has not reported a box yet is simply absent, never rendered at a guessed position. */
  function buildEmbedState(): EmbedState {
    const items: EmbedItem[] = [];
    for (const id of Object.keys(embeds.entries)) {
      const rect = embeds.boxes[id];
      if (!rect) continue;
      items.push({ id, url: embeds.entries[id].url, provider: embeds.entries[id].provider, rect: toParentClientRect(rect) });
    }
    return { items, interactive: mode === "play" };
  }

  function notifyEmbeds(): void {
    const state = buildEmbedState();
    for (const listener of listeners.embed) listener(state);
  }
  // The current slide's parsed model plus its raw markup, kept only so
  // gestures can compute bounding boxes/candidates without re-fetching —
  // reset on every render() alongside the selection.
  let currentSlideModel: SlideModel | null = null;
  // The current slide's raw SVG text, kept so `notifyChartWindow`
  // can re-derive the open chart's `ChartModel` (`readChartModel`) after
  // every render() without a second fetch — the chart data window is the
  // one caller that needs the actual bytes, not just the parsed
  // `SlideElement` shape `currentSlideModel` carries.
  let currentSlideMarkup: string | null = null;
  // Decision G1: every id-carrying element's bounding box, as the
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
  // Bumped on every reload()/showSlide()/play()/exitPlay() call and
  // captured by each call's own closure. Nothing orders concurrent calls
  // against each other, so a slower earlier one can resolve after a
  // faster later one and paint stale content over it. Comparing the
  // captured frame.generation against the current one right before each await's
  // result is applied discards a superseded call's result instead of
  // applying it. play()/exitPlay() bump it too — not just reload()/
  // showSlide() — because they replace the iframe element itself: without
  // that, a slow in-flight view-mode render() could resume after play()
  // has already swapped in the fresh play iframe and write into it via the
  // still-current `frame.element` reference (see the mode-switch note below).

  const frame = {
    element: buildFrame("allow-scripts"),
    generation: 0,
    paintedView: null as { slidePath: string; key: string } | null,
    paintedPlay: null as { slidePath: string; key: string } | null,
    viewport: null as Viewport | null,
    playerHasFocus: false,
  };
  container.appendChild(frame.element);

  /**
   * [E8.T3] Everything the move/scale/rotate/textbox-width/marquee gesture
   * functions defined below read or write off the rest of this closure,
   * gathered into one object (ADR-0024) — a rehearsal for
   * `canvas/gestures.ts` taking those functions over verbatim: routing
   * every read through this object first, while the functions are still
   * defined right here, means a missing field shows up as a type error in
   * this same file rather than a runtime crash after the move. Built here,
   * before the event listeners below, because the two host pointer
   * handlers those listeners register are wired through this object's
   * eventual factory output (next commit) — `const` bindings are subject
   * to TDZ where function declarations are not.
   */
  const gestureDeps: GestureDeps = {
    activeGesture: {
      get: () => activeGesture,
      set: (value) => {
        activeGesture = value;
      },
    },
    frame,
    selection,
    overlay,
    slide: {
      slidePath: () => slides[currentIndex],
      currentSlideModel: () => currentSlideModel,
      elementIndex,
      computeBounds,
      get elementBoundsById() {
        return elementBoundsById;
      },
    },
    editingLease: {
      begin: beginEditingLease,
      end: endEditingLease,
      lastRenewAt: () => lastEditingLeaseAt,
    },
    pendingSelection: {
      keepAcrossReload: keepSelectionAcrossReload,
      pendingSelectionIds: () => pendingSelectionIds,
    },
    publish: {
      notify,
      notifyOverlay,
      pushSelectionToRuntime,
    },
    coords: {
      toFrameClientPoint,
      toUserPoint,
      userXToClient,
      userYToClient,
      offsetUnion,
    },
    toParentClientPoint,
    postToFrame,
    postCommand,
    setError: (message) => {
      error = message;
    },
    isDestroyed: () => destroyed,
  };
  const gestures = createGestures(gestureDeps);

  /**
   * [E8.T3] Same rehearsal as `gestureDeps` above, for the `onWindowMessage`/
   * `handleSelectionMessage` pair defined below: every read/write against
   * the rest of this closure routed through this object first, so
   * `canvas/runtime-message-handlers.ts` can take the two functions over
   * verbatim in a later commit. `gestures` is the factory output built
   * just above — the callback seam ADR-0024 requires instead of one
   * extracted module importing another.
   */
  const runtimeMessageDeps: RuntimeMessageDeps = {
    frame,
    selection,
    overlay,
    tableRange,
    activeGesture: {
      get: () => activeGesture,
      set: (value) => {
        activeGesture = value;
      },
    },
    gestures,
    session: {
      isDestroyed: () => destroyed,
      mode: () => mode,
      setError: (message) => {
        error = message;
      },
      bumpDragSignal: () => {
        dragSignal++;
      },
      setElementBounds: (value) => {
        elementBoundsById = value;
      },
      pendingSelectionIds: () => pendingSelectionIds,
      stageHandMode: () => stageHandMode,
    },
    editing: {
      getEditingState: () => editingState,
      setEditingState: (value) => {
        editingState = value;
      },
      enterTextEdit,
      commitTextEdit,
      beginLease: beginEditingLease,
      endLease: endEditingLease,
      lastRenewAt: () => lastEditingLeaseAt,
    },
    playback: {
      focusPlayer,
      advancePastEnd,
      retreatPastStart,
      exitPreview,
      exitPlay,
      next,
      previous,
    },
    commands: {
      selectAll,
      deleteSelection,
      duplicateSelection,
      orderSelection,
      undoRedo: (kind) => undoRedoHandler?.(kind),
      copySelection,
      cutSelection,
      pasteFromText,
      closeChartWindow,
      openChartWindow,
      requestBadgeMeasurement,
      clearSelectionState,
    },
    table: {
      emitTableEvent,
      setTableRange,
      handleTableRangeKey,
    },
    host: {
      postToFrame,
      toParentClientPoint,
      toParentClientRect,
      emitStageInput,
      emitStageHover,
      applyEmbedBoxes,
      emitEmbedCommand,
    },
    publish: {
      notify,
      notifyOverlay,
      pushSelectionToRuntime,
    },
  };
  const runtimeMessages = createRuntimeMessageHandlers(runtimeMessageDeps);

  // One listener for the whole controller's lifetime, not per-frame.element: it
  // reads `frame.element` (the current, possibly-rebuilt element) at call time
  // rather than closing over a specific iframe, so it keeps working across
  // play()/exitPlay() rebuilds without being re-attached.
  window.addEventListener("message", runtimeMessages.onWindowMessage);
  // NOOP-382: catches the tail of a move drag once the pointer has crossed
  // the sandboxed slide iframe's own edge — see canvas/gestures.ts's
  // `onHostPointerMove`'s doc comment for why the iframe alone cannot see
  // that part of the drag.
  window.addEventListener("pointermove", gestures.onHostPointerMove, true);
  window.addEventListener("pointerup", gestures.onHostPointerUp, true);
  // [E2.T17]: the embed overlay's parent-side conversion reads the frame.element's
  // rect at message time, so a window resize that moves/scales the frame.element
  // without the runtime re-reporting would leave the player behind. The
  // stored runtime-local boxes are still correct — only the conversion has
  // to be redone.
  window.addEventListener("resize", notifyEmbeds);


  /** A `cell-dblclick` that arrived before any `TableOverlay` subscribed — the drill-in double-click selects the table and reports the cell in the same runtime handler, so the overlay for that table mounts one React render later. Replayed to the first subscriber. */

  function emitTableEvent(event: TableRuntimeEvent): void {
    if (event.type === "cell-dblclick" && listeners.table.size === 0) {
      tableRange.pendingDblclick = event;
      return;
    }
    for (const listener of listeners.table) listener(event);
  }

  function notifyTableRange(): void {
    for (const listener of listeners.tableRange) listener(tableRange.current);
  }

  /** `CanvasController.setTableRange` (§4.1/§4.2) — also tells the runtime which table (if any) owns the range, so its own keyboard relay can decide Delete/Tab/⌘B/Esc's routing. */
  function setTableRange(value: { tableId: string; range: CellRange } | null): void {
    tableRange.current = value;
    notifyTableRange();
    postToFrame({ command: "table-range", id: value ? value.tableId : null });
  }

  /**
   * `CanvasController.handleTableRangeKey` (§4.1) — the single decision function for every cell-range keyboard
   * shortcut. Both `handleSelectionMessage`'s "table-key" branch above (the
   * iframe relay) and App.tsx's capture-phase keydown listener call this
   * exact function, never a copy of its logic, so the two input paths
   * cannot drift apart (same posture as the existing ⌘Z/Delete/etc. relay
   * `App.tsx:610`'s own comment already documents).
   */
  function handleTableRangeKey(key: string, modifiers: { meta: boolean; ctrl: boolean; shift: boolean }): boolean {
    if (!tableRange.current) return false;
    if (selection.ids.length !== 1 || selection.ids[0] !== tableRange.current.tableId) {
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
    const { tableId, range } = tableRange.current;
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
    const rect = frame.element.getBoundingClientRect();
    const scale = frame.element.offsetWidth > 0 ? rect.width / frame.element.offsetWidth : 1;
    return { x: rect.left + point.x * scale, y: rect.top + point.y * scale };
  }

  /**
   * The exact inverse of `toParentClientPoint`: this HOST document's own
   * client coordinates -> iframe-local client coordinates, as
   * selection-runtime.js's `event.clientX/clientY` would see them. Used
   * only by the move-gesture boundary-crossing fallback below (NOOP-382) —
   * every other conversion in this module goes iframe -> parent, because
   * every other input this host acts on originates inside the iframe.
   */
  function toFrameClientPoint(point: { x: number; y: number }): { x: number; y: number } {
    const rect = frame.element.getBoundingClientRect();
    const scale = frame.element.offsetWidth > 0 ? rect.width / frame.element.offsetWidth : 1;
    return { x: (point.x - rect.left) / scale, y: (point.y - rect.top) / scale };
  }

  /** Same conversion as `toParentClientPoint`, applied to a whole rect — width/height scale by the same factor the corner point does (uniform iframe scaling, never a separate X/Y factor). Used for the "bounds" event's per-item/union rects (§4.6). */
  function toParentClientRect(rect: Rect): Rect {
    const frameRect = frame.element.getBoundingClientRect();
    const scale = frame.element.offsetWidth > 0 ? frameRect.width / frame.element.offsetWidth : 1;
    return {
      x: frameRect.left + rect.x * scale,
      y: frameRect.top + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  /** `OverlayState.label` (§4.6): `null` with nothing selected, `"N elements"` (no path) for a multi-selection, or the single selected element's own name/id plus its ancestor-chain names (outermost first, from the runtime's last-reported `bounds` event) otherwise. */
  function computeOverlayLabel(): { text: string; path: string[] } | null {
    if (selection.ids.length === 0) return null;
    if (selection.ids.length > 1) return { text: `${selection.ids.length} elements`, path: [] };
    const text = selection.names[0] ?? selection.ids[0];
    const path = overlay.ancestors.map((ancestor) => ancestor.name ?? ancestor.id);
    return { text, path };
  }

  /** Converts the stored runtime-px overlay geometry to parent client px against the frame.element's rect *right now* — the one place that conversion happens, shared by `notifyOverlay` and `subscribeOverlay`'s initial push. Guides are the exception: they only exist mid-drag and are converted where they are computed. */
  function buildOverlayState(): OverlayState {
    return {
      boxes: overlay.boxes.map(toParentClientRect),
      union: overlay.union ? toParentClientRect(overlay.union) : null,
      label: computeOverlayLabel(),
      guides: [...overlay.guides],
      dragging: (activeGesture !== null && activeGesture.kind !== "marquee") || overlay.settling,
      hasAnimation: selection.ids.some((id) => currentSlideEffects.some((effect) => effect.target === id)),
      badges: overlay.badges,
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
    overlay.badgeTargets = computeBadgeTargets(currentSlideEffects);
    if (overlay.badgeTargets.length === 0) {
      overlay.badges = [];
      notifyOverlay();
      return;
    }
    postToFrame({ command: "measure", ids: overlay.badgeTargets.map((entry) => entry.target) });
  }

  function notifyOverlay(): void {
    const state = buildOverlayState();
    for (const listener of listeners.overlay) listener(state);
  }

  /**
   * E2.T12: re-derives the open chart window's `ChartModel` off
   * `currentSlideMarkup` and pushes it to every `subscribeChartWindow`
   * listener — called after every render() (so a committed edit's
   * normalized result reflects back) and whenever `chartWindow.target`
   * itself changes (open/close). A target that no longer resolves to a
   * chart (deleted, or the slide changed under it) closes the window
   * rather than surfacing a parse error — same "silently do nothing"
   * posture `enterTextEdit` gives an id that no longer resolves.
   */
  /** Reads `chartWindow.target`'s current `ChartModel` off `currentSlideMarkup`; closes the window (clears `chartWindow.target`) as a side effect when the target no longer resolves to a chart. Shared by `notifyChartWindow` and `subscribeChartWindow`'s initial push. */
  function buildChartWindowState(): ChartWindowState | null {
    if (chartWindow.target === null) return null;
    try {
      if (currentSlideMarkup === null) throw new Error("no slide loaded");
      const model = readChartModel(currentSlideMarkup, chartWindow.target);
      return { id: chartWindow.target, slidePath: slides[currentIndex], model };
    } catch {
      chartWindow.target = null;
      return null;
    }
  }

  function notifyChartWindow(): void {
    const state = buildChartWindowState();
    for (const listener of listeners.chartWindow) listener(state);
  }

  /** The runtime's "dblclick-chart" report (selection-runtime.js, plan §3.6) — a plain double-click on a chart container opens its data window. No-op outside view mode, or when `id` does not resolve to a chart (`notifyChartWindow` closes it again in that case). */
  function openChartWindow(id: string): void {
    if (mode !== "view") return;
    chartWindow.target = id;
    notifyChartWindow();
  }

  function emitStageInput(event: StageInputEvent): void {
    for (const listener of listeners.stageInput) listener(event);
  }

  function emitStageHover(point: { x: number; y: number }): void {
    for (const listener of listeners.stageHover) listener(point);
  }

  /** Shared by handleSelectionMessage's "clear" case and the public clearSelection() (NOOP-83 §4.5) — same four steps either way. */
  function clearSelectionState(groupPath: string[]): void {
    selection.ids = [];
    selection.names = [];
    selection.groupPath = groupPath;
    notify();
    pushSelectionToRuntime(selection.ids);
    if (tableRange.current) setTableRange(null);
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


  function postToFrame(message: Record<string, unknown>): void {
    frame.element.contentWindow?.postMessage({ source: "slidra-host", ...message }, "*");
  }

  function toUserPoint(point: { x: number; y: number }): { x: number; y: number } {
    if (!frame.viewport) return { x: 0, y: 0 };
    const scaleX = frame.viewport.viewBox.width / frame.viewport.svgRect.width;
    const scaleY = frame.viewport.viewBox.height / frame.viewport.svgRect.height;
    return {
      x: frame.viewport.viewBox.x + (point.x - frame.viewport.svgRect.x) * scaleX,
      y: frame.viewport.viewBox.y + (point.y - frame.viewport.svgRect.y) * scaleY,
    };
  }

  function userXToClient(x: number): number {
    const scaleX = frame.viewport!.svgRect.width / frame.viewport!.viewBox.width;
    return frame.viewport!.svgRect.x + (x - frame.viewport!.viewBox.x) * scaleX;
  }

  function userYToClient(y: number): number {
    const scaleY = frame.viewport!.svgRect.height / frame.viewport!.viewBox.height;
    return frame.viewport!.svgRect.y + (y - frame.viewport!.viewBox.y) * scaleY;
  }

  function elementIndex(): Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }> {
    const index = new Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>();
    if (currentSlideModel) flattenElements(currentSlideModel.elements, [], [], index);
    return index;
  }

  /** `CanvasSelection.elements` (NOOP-143 §1 decision 2/3): `selection.ids[i]`'s parsed `SlideElement`, or `null` when it is not (or no longer) in the current model. */
  function selectedElements(): (SlideElement | null)[] {
    const index = elementIndex();
    return selection.ids.map((id) => index.get(id)?.element ?? null);
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
        return { ok: false, message: (body && typeof body.error === "string" && body.error) || `command failed (HTTP ${response.status})` };
      }
      return { ok: true, message: (body && typeof body.message === "string" && body.message) || "", data: body?.data };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "failed to submit command" };
    }
  }

  /**
   * Whitelisted commands whose result should become the selection once
   * this write's own reload lands — the Ribbon's insert actions
   * (`textbox add`, `element insert`: rectangle/ellipse/line)
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
        headers: { "X-Slidra-Asset-Name": encodeURIComponent(file.name) },
        body: bytes,
      });
      return parseAssetResponse(response);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "import failed" };
    }
  }

  async function postAssetUrl(url: string): Promise<ImportAssetResult> {
    try {
      const response = await fetch("/api/asset", {
        method: "POST",
        headers: { "X-Slidra-Asset-Url": encodeURIComponent(url) },
      });
      return parseAssetResponse(response);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "import failed" };
    }
  }

  async function parseAssetResponse(response: Response): Promise<ImportAssetResult> {
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; message?: string; error?: string; data?: ImportedAsset }
      | null;
    if (!response.ok || !body?.data) {
      return { ok: false, message: (body && typeof body.error === "string" && body.error) || `import failed (HTTP ${response.status})` };
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
    postToFrame({ command: "selection", ids: [...ids], ...computeHandleFlags(ids), groupPath: [...selection.groupPath] });
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
    selection.ids = [id];
    selection.names = [entry.element.name];
    selection.groupPath = [];
    notify();
    pushSelectionToRuntime(selection.ids);
  }

  /** ⌘A: every TOP-LEVEL element on the current slide — never a group's own children, matching `05-INTERACTIONS.feature`'s "every top-level element on this page" wording. `groupPath` resets to top level, same as any other host-driven selection change. */
  function selectAll(): void {
    if (mode !== "view" || !currentSlideModel) return;
    if (currentSlideModel.elements.length === 0) return;
    selection.ids = currentSlideModel.elements.map((element) => element.id);
    selection.names = currentSlideModel.elements.map((element) => element.name);
    selection.groupPath = [];
    notify();
    pushSelectionToRuntime(selection.ids);
  }

  /**
   * Selects exactly `ids` (only the ones that still resolve in
   * `currentSlideModel`, same tolerance `selectOnceLoaded` already gives a
   * stale id) — the stage badge layer's click-to-select ("click badge →
   * select that element"), the one host-driven selection entry point that
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
    selection.ids = entries.map(([id]) => id);
    selection.names = entries.map(([, entry]) => entry.element.name);
    selection.groupPath = [];
    notify();
    pushSelectionToRuntime(selection.ids);
  }

  async function deleteSelection(): Promise<void> {
    if (mode !== "view" || selection.ids.length === 0) return;
    const result = await runCommand("element delete", { slidePath: slides[currentIndex], elementIds: [...selection.ids] });
    if (result.ok) clearSelectionState([]);
  }

  /** `+3% / +4%` of the viewBox (prototype's own `slidra-logic-v3.js` offset) — `runCommand`'s existing `SELECT_AFTER_COMMAND` entry for `"element duplicate"` selects the new copy on success. */
  async function duplicateSelection(): Promise<void> {
    if (mode !== "view" || selection.ids.length === 0 || !frame.viewport) return;
    await runCommand("element duplicate", {
      slidePath: slides[currentIndex],
      elementIds: [...selection.ids],
      dx: 0.03 * frame.viewport.viewBox.width,
      dy: 0.04 * frame.viewport.viewBox.height,
    });
  }

  /** `result.data.svg`, the shape `element copy`/`element cut` both return (`docs/spec/cli.md`) — `undefined`/wrong type degrades to `null` (nothing to write to the system clipboard) rather than throwing. */
  function svgFromCommandData(data: unknown): string | null {
    const svg = (data as { svg?: unknown } | undefined)?.svg;
    return typeof svg === "string" ? svg : null;
  }

  /**
   * ⌘C, or the ContextBar Copy button (decision (d)): sends
   * `element copy` and returns the `svg` it replies with — the exact bytes
   * `navigator.clipboard.writeText` should receive (the caller does the
   * actual write, mirroring `cutSelection`). Never mutates the
   * presentation. A command failure surfaces through the existing
   * `CanvasState.error` (`runCommand`) and leaves the system clipboard
   * untouched — the caller only writes when this resolves non-null.
   */
  async function copySelection(): Promise<string | null> {
    if (mode !== "view" || selection.ids.length === 0 || currentIndex === -1) return null;
    const slidePath = slides[currentIndex];
    const result = await runCommand("element copy", { slidePath, elementIds: [...selection.ids] });
    const svg = result.ok ? svgFromCommandData(result.data) : null;
    if (svg !== null) pasteOffsetState = clipboardWritten(slidePath);
    return svg;
  }

  /**
   * ⌘X, or the ContextBar Cut button: `element cut` replaces the former
   * "local serialize + `element delete`" pair (decision (d)/C2) — the CLI does
   * both in one write, returning the same `svg` shape `element copy` does.
   * Awaited before the caller writes `navigator.clipboard`, since there is
   * no synchronous ClipboardEvent to race against (per plan §3.8/A0: under
   * headless Chromium, keyboard-only ⌘X does not trigger a native `cut`
   * event, so this falls back to the async `navigator.clipboard` API — see
   * App.tsx's keydown handler).
   */
  async function cutSelection(): Promise<string | null> {
    if (mode !== "view" || selection.ids.length === 0 || currentIndex === -1) return null;
    const slidePath = slides[currentIndex];
    const elementIds = [...selection.ids];
    const result = await runCommand("element cut", { slidePath, elementIds });
    const svg = result.ok ? svgFromCommandData(result.data) : null;
    if (svg === null) return null;
    pasteOffsetState = clipboardWritten(slidePath);
    clearSelectionState([]);
    return svg;
  }

  function cellRangeTarget(): ClipboardTarget {
    if (currentIndex === -1) return null;
    const range = tableRange.provider();
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
    if (mode !== "view" || selection.ids.length === 0) return;
    await runCommand("element order", { slidePath: slides[currentIndex], elementIds: [...selection.ids], direction });
  }

  async function alignSelection(direction: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"): Promise<void> {
    if (mode !== "view" || selection.ids.length < 2) return;
    await runCommand("element align", { slidePath: slides[currentIndex], elementIds: [...selection.ids], direction });
  }

  async function distributeSelection(axis: "horizontal" | "vertical"): Promise<void> {
    if (mode !== "view" || selection.ids.length < 3) return;
    await runCommand("element distribute", { slidePath: slides[currentIndex], elementIds: [...selection.ids], axis });
  }

  async function insertTextBox(input: {
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    fontWeight: number;
    align: "left" | "center" | "right";
    fill: string;
  }): Promise<void> {
    if (mode !== "view") return;
    await runCommand("textbox add", { slidePath: slides[currentIndex], ...input });
  }

  // --- Drag-to-move (§4.2) ---


  /**
   * A committed gesture's write comes back over /api/events and drives a full
   * render(), which would otherwise drop the selection (and with it the
   * context bar). Park the current ids so that render() re-selects them once
   * the reloaded slide is up — same channel `runCommand`'s SELECT_AFTER_COMMAND
   * uses for insert/paste/duplicate. Group drill-in depth is not preserved
   * (selectOnceLoaded resets groupPath), same as those commands.
   */
  function keepSelectionAcrossReload(): void {
    if (selection.ids.length === 0) return;
    pendingSelectionIds = [...selection.ids];
    // The context bar stays down until that re-selection has landed (see the
    // gesture-end handler) — otherwise it flashes: shown the instant the
    // gesture ends, gone when the reload drops the selection, shown again
    // once it is restored.
    overlay.settling = true;
  }


  // --- Chart data window (decision (c): no local preview any more) ---

  /** `CanvasController.closeChartWindow` (Esc): just closes the window — every control already commits straight to a `chart *` command, so there is nothing local left to revert. */
  function closeChartWindow(): void {
    chartWindow.target = null;
    notifyChartWindow();
  }

  // --- In-place text editing (decision T1) ---

  /**
   * Opens `id` for editing — the shared entry point for `beginTextEdit`
   * (CanvasController) and the runtime's own "dblclick-textbox" report.
   * Lock is NOT checked here: the parsed slide model (`elementIndex`) never
   * carries `data-slidra-lock` (it is a container attribute the normal-form
   * parser does not surface on `SlideElement`), so the only place that can
   * answer "is this locked" is the runtime's own DOM — see the
   * "begin-text-edit"/"text-edit-denied" round trip below and
   * selection-runtime.js's `enterRuntimeTextEdit`.
   *
   * Decision T1: no font is fetched and no layout is computed here any more —
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
    const thisGeneration = frame.generation;
    const result = await postCommand("text set", {
      slidePath: state.slidePath,
      elementId: state.id,
      newText: state.currentText,
    });
    endEditingLease();
    if (destroyed || thisGeneration !== frame.generation) return;
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


  async function advancePastEnd(): Promise<void> {
    // On the last slide of the presentation, advancing past the end does
    // nothing — there is nowhere further to go, and this must not throw.
    if (currentIndex === -1 || currentIndex >= slides.length - 1) return;
    // A stale runtime can still be alive in the old play iframe for a
    // moment after a page change (the iframe is only rebuilt once
    // renderPlay() below actually finishes), so repeated ArrowRight
    // presses before that finishes can fire several advance-past-end
    // messages back to back. Bumping frame.generation here — the same guard
    // play()/exitPlay()/showSlide() already use — makes an earlier one of
    // these calls' renderPlay() discard its own result instead of racing
    // a later one to paint last.
    const thisGeneration = ++frame.generation;
    // §4.6: the page currently on screen plays its own exit first — this
    // is the "leave" half of the page change, and it must finish (or be
    // aborted) before currentIndex moves at all.
    if (!(await playExitTransition(thisGeneration))) return;
    currentIndex += 1;
    notify();
    await renderPlay(thisGeneration, "first", true);
  }

  /** Mirrors advancePastEnd() exactly, in reverse (decision 6) — except retreat never plays an exit (§4.6 decision 7: `prev()` in the prototype is a plain `go()`, no `goWithExit`). */
  async function retreatPastStart(): Promise<void> {
    // At the very start of the presentation, retreating does nothing —
    // there is nowhere further back to go, and this must not throw.
    if (currentIndex <= 0) return;
    // Same race guard as advancePastEnd(): a stale runtime in the old play
    // iframe can still fire repeated retreat-past-start messages for a
    // moment after a page change, and bumping frame.generation here makes an
    // earlier one of these calls' renderPlay() discard its own result
    // instead of racing a later one to paint last.
    const thisGeneration = ++frame.generation;
    currentIndex -= 1;
    notify();
    await renderPlay(thisGeneration, "last", true);
  }

  async function reload(): Promise<void> {
    // A no-op after destroy(): the iframe this closure owns is gone from
    // the DOM, so there is nothing left to redraw, and re-fetching would
    // just race the next mount for no benefit.
    if (destroyed) return;

    // [E4.T7]: an external change (an agent's command, another tab, `slidra
    // effect *` from the CLI) may have touched any slide's effect list —
    // reload() has no way to know which, so invalidate every cached plan
    // rather than one. render()/renderPlay() below re-fetch as needed.
    invalidateSlideEffectPlans();

    // An edit in progress when an external change lands is committed, not
    // discarded — reload() also fires on this exact edit's own successful
    // `text set` landing back over /api/events, and any OTHER external
    // change must not silently drop text the author already typed. Not
    // awaited: the re-render a few lines down already repaints from
    // whatever the file holds next, and commitTextEdit()'s own frame.generation
    // guard discards its result if a second reload() or a mode change
    // supersedes it first.
    if (editingState) void commitTextEdit();

    // A gesture in progress when an external change lands must be
    // abandoned, not applied on top of a slide that has already moved out
    // from under it (§4.2's "slide changed via /api/events notification
    // mid-drag" row).
    // Clearing it here — before the fetch below — is enough: render()
    // replaces the whole srcdoc, which discards any DOM preview the old
    // gesture painted, and any gesture-move/-end message that still
    // arrives afterwards finds activeGesture already null and no-ops.
    activeGesture = null;

    // Claim this call's frame.generation before the first await, then compare
    // against the live counter after every await: if another call already
    // bumped `frame.generation` past what this call captured, this call's result
    // is stale and must be discarded — no matter how much later it settles.
    const thisGeneration = ++frame.generation;

    const project = await fetchJson<ProjectJson>("/api/presentation");
    if (destroyed || thisGeneration !== frame.generation) return;

    // Before any slide document is built from this load: the deck's own
    // embedded faces (#305).
    setPresentationFonts(project.fonts);
    deckSlides = project.slides;
    if (pageSource === "templates") {
      const { paths, invalidCount } = normalizeTemplatePaths(project.templates);
      slides = paths;
      if (invalidCount > 0) {
        error = `project.json format error: ${invalidCount} template ${invalidCount === 1 ? "entry is" : "entries are"} not a string or {file,name} and were skipped`;
      }
    } else {
      slides = project.slides;
    }
    // Live reload calls reload() on every external edit. Staying on the
    // slide the author is looking at is the whole point — jumping back to
    // the first one because an agent changed a word elsewhere is a bug.
    // Only a presentation that got shorter forces a move, and then only as
    // far as the new last slide.
    currentIndex = slides.length === 0 ? -1 : Math.min(Math.max(currentIndex, 0), slides.length - 1);
    // An external edit can rewrite the very elements the author had
    // selected (or remove them entirely) — the ids it points at are no
    // longer trustworthy, so the selection does not survive a reload.
    selection.ids = [];
    selection.names = [];
    selection.groupPath = [];
    frame.viewport = null;
    overlay.boxes = [];
    overlay.union = null;
    overlay.ancestors = [];
    overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    overlay.badgeTargets = [];
    overlay.badges = [];
    notify();
    notifyOverlay();

    if (mode === "play") {
      // §4.6: a background refresh plays neither enter nor exit.
      await renderPlay(thisGeneration, "first", false);
    } else {
      await render(thisGeneration);
    }
  }

  /** See `CanvasController.setPageSource`'s own doc comment. */
  async function setPageSource(source: "slides" | "templates"): Promise<void> {
    if (destroyed || pageSource === source) return;
    pageSource = source;
    // A fresh page list — a slide index has no correspondence to a
    // template index — so this always starts at the head, never carries
    // the previous list's position over. reload()'s own clamp turns this
    // into -1 when the new list is empty.
    currentIndex = 0;
    await reload();
  }

  /**
   * Paints the currently selected slide in view mode. Takes the caller's
   * captured frame.generation so navigation shares reload()'s race guard: rapid
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
    if (!selectAfterLoad) overlay.settling = false;

    if (currentIndex === -1) {
      currentSlideModel = null;
      currentSlideMarkup = null;
      elementBoundsById = new Map();
      currentSlideEffects = [];
      overlay.badgeTargets = [];
      overlay.badges = [];
      frame.paintedView = null;
      frame.element.srcdoc = EMPTY_DECK_DOCUMENT;
      notifyChartWindow();
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || thisGeneration !== frame.generation) return;
    currentSlideMarkup = svgMarkup;

    // #303: a reload whose only difference is `<metadata>` (an effect, a
    // note, a comment, a transition landed) paints the same picture — skip
    // the `srcdoc` navigation, which would blank the stage for nothing.
    // A pending post-load selection still forces a repaint: it waits on
    // the frame.element's `load` event (`selectOnceLoaded`), which only a
    // navigation fires.
    const paintKey = slidePaintKey(svgMarkup);
    const repaint =
      selectAfterLoad !== null ||
      frame.paintedView === null ||
      frame.paintedView.slidePath !== slidePath ||
      frame.paintedView.key !== paintKey;

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
    // `reportElementBounds`), same "runtime-ready" timing `overlay.badges`
    // already relies on. Kept when the repaint is skipped (#303): the
    // document — and therefore its bounds — is unchanged.
    if (repaint) elementBoundsById = new Map();

    // [E2.T7]/[E4.T7]: a slide whose effect list fails to parse is treated
    // as having no animations at all in view mode (GUI table — the
    // player's own parse error is a play-mode-only concern), never thrown
    // up through render().
    try {
      currentSlideEffects = (await fetchSlideEffectPlan(slidePath)).effects;
    } catch {
      currentSlideEffects = [];
    }
    if (destroyed || thisGeneration !== frame.generation) return;

    if (!repaint) {
      // #303: same picture, same document. reload() already dropped this
      // side's selection — tell the live runtime so its selection box
      // goes too — and re-measure the badges against the (possibly new)
      // effect list, the job a fresh document's "runtime-ready" would do.
      pushSelectionToRuntime([]);
      requestBadgeMeasurement();
      notifyChartWindow();
      notify();
      return;
    }

    // [E2.T17]: the embed table is the parent's, not the iframe's — the
    // runtime is only told which ids to measure. Boxes are cleared here
    // and refilled by the runtime's first `embed-boxes` report, so a
    // stale slide's geometry is never painted under the new slide.
    embeds.entries = stageEmbedsFor(svgMarkup);
    embeds.boxes = {};
    notifyEmbeds();

    frame.element.srcdoc = wrapSelectionDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      selectionColors(),
      stageMediaFor(svgMarkup),
      Object.keys(embeds.entries),
    );
    frame.paintedView = { slidePath, key: paintKey };

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
    // notify() once the frame.element's `load` event lands; this one is what makes
    // a plain navigation/reload with no pending selection visible at all.
    notify();

    if (selectAfterLoad) selectOnceLoaded(selectAfterLoad, thisGeneration);
  }

  /**
   * NOOP-227: `frame.element.srcdoc` just changed, which means selection-runtime.js
   * has not attached its `message` listener yet — a `postMessage` sent now
   * would race the navigation and be silently dropped. `load` fires only
   * once the new document (and every synchronous script in it, the
   * listener included) has finished, so waiting for it is what makes this
   * safe. Captures its own target iframe rather than reading the closure's
   * `frame.element` variable, so a `play()`/`exitPlay()` swap in the meantime
   * cannot redirect the listener onto a different element.
   */
  function selectOnceLoaded(elementIds: string[], thisGeneration: number): void {
    const targetFrame = frame.element;
    const onLoad = () => {
      targetFrame.removeEventListener("load", onLoad);
      // Whatever happens next, the wait is over — never leave the context
      // bar stuck hidden behind a stale `overlay.settling`.
      overlay.settling = false;
      if (destroyed || thisGeneration !== frame.generation || mode !== "view") return;
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
      selection.ids = entries.map(([id]) => id);
      selection.names = entries.map(([, entry]) => entry.element.name);
      selection.groupPath = [];
      notify();
      pushSelectionToRuntime(selection.ids);
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
   * `startAt` (decision 5): "first" is every existing caller's
   * behaviour, unchanged. "last" is a parent-side intent used only by
   * retreatPastStart() — the wire integer (`plan.steps.length - 1`, or
   * `-1` for a slide with no effects at all, decision 3) is computed here,
   * after computePlayerPlan() has run, because only the parent knows the
   * slide's step count. The sentinel itself never travels over the wire.
   *
   * `playEnter` ([E2.T11], replacing T6's `animate`): whether THIS
   * particular call should play the new page's own enter transition, on
   * top of whatever `<slidra:transition>` it declares. §4.6's table: every
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
    const captured = thisGeneration ?? frame.generation;
    if (currentIndex === -1) {
      frame.paintedView = null;
      frame.paintedPlay = null;
      frame.element.srcdoc = EMPTY_DECK_DOCUMENT;
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || captured !== frame.generation) return;

    // #303: only reload()'s background refresh (playEnter=false, no preview,
    // startAt "first") may keep the running document; every arrival —
    // page change, entering play, a Preview — paints anew.
    const playKey = slidePaintKey(svgMarkup);
    const keepRunningDocument =
      !playEnter &&
      previewEffectIndices === undefined &&
      startAt === "first" &&
      frame.paintedPlay !== null &&
      frame.paintedPlay.slidePath === slidePath &&
      frame.paintedPlay.key === playKey;

    let planScript: string;
    let hideStyle: string;
    try {
      const plan = await computePlayerPlan(svgMarkup, slidePath);
      if (destroyed || captured !== frame.generation) return;
      const startStep = startAt === "last" ? plan.steps.length - 1 : -1;
      const planForWire = previewEffectIndices === undefined ? plan : { ...plan, preview: { effectIndices: previewEffectIndices } };
      planScript = renderPlanScript(planForWire, startStep);
      hideStyle = renderHideStyle(plan.hidden);
      // A slide whose <slidra:transition> is present but malformed
      // (§4.2: an unknown effect value, an illegal duration, more than one
      // node) surfaces through the exact same `error` banner + static-
      // fallback path a broken effect list already does, rather than a
      // second, differently shaped failure mode — `plan.transition` comes
      // from the SAME `computePlayerPlan` call above, so a malformed
      // transition fails this same `try` (decision E1: riding
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
      // A stale frame.generation's own rejection (e.g. a superseded navigation's
      // /api/effects/ fetch resolving after a newer renderPlay() already
      // took over) must not clobber state a newer, still-live call owns.
      if (destroyed || captured !== frame.generation) return;
      // Surfaced, never silently swallowed (design doc). Play the static
      // slide with no runtime rather than leaving the frame.element blank — the
      // author still sees the slide, plus the reason nothing animates.
      error = planError instanceof Error ? planError.message : "effect list could not be parsed";
      notify();
      // A broken page has no transition to play on the way out either —
      // reset to the all-"none" default so a later playExitTransition()
      // call leaving this (static) page does not act on stale data left
      // over from whichever slide was last painted successfully.
      currentPageTransition = { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } };
      frame.paintedView = null;
      frame.paintedPlay = null;
      frame.element.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
      return;
    }

    // #303: metadata-only change while playing — the plan above was
    // re-read (so `currentPageTransition` and the effects cache are
    // fresh) but the document on screen is the same picture: leave the
    // runtime, and the author's step position, alone.
    if (keepRunningDocument) return;

    // Same as render(): the ids travel to the runtime inside the plan
    // (`plan.embedIds`), the URLs stay here.
    embeds.entries = stageEmbedsFor(svgMarkup);
    embeds.boxes = {};
    notifyEmbeds();

    frame.paintedView = null;
    frame.element.srcdoc = wrapPlayDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      hideStyle,
      planScript,
    );
    frame.paintedPlay = { slidePath, key: playKey };

    const { effect, duration } = currentPageTransition.enter;
    if (playEnter && effect !== "none" && duration > 0) {
      const ms = duration * 1000;
      frame.element.style.transition = "none";
      frame.element.style.opacity = "0";
      frame.element.style.transform = pageTransitionTransform(effect, "enter-start");
      // The "none" transition and the start values above must land in a
      // rendered frame before switching to the real transition, or the
      // browser coalesces both style writes into one paint and nothing
      // animates.
      requestAnimationFrame(() => {
        if (destroyed || captured !== frame.generation) return;
        frame.element.style.transition = `opacity ${ms}ms var(--ease-out), transform ${ms}ms var(--ease-out)`;
        frame.element.style.opacity = "1";
        frame.element.style.transform = "none";
      });
      // [E2.T17]: the embed overlay converts runtime-local px against
      // `frame.element.getBoundingClientRect()` *at message time*, and the runtime
      // reports its boxes while this transform is still mid-flight — which
      // lands the player offset by however far the frame.element still had to
      // travel. Re-converting once the transition has settled (the stored
      // runtime-local boxes are unchanged; only the frame.element's own rect moved)
      // is what puts it back on its placeholder.
      window.setTimeout(() => {
        if (destroyed || captured !== frame.generation) return;
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
      frame.element.style.removeProperty("transition");
      frame.element.style.removeProperty("opacity");
      frame.element.style.removeProperty("transform");
    }
  }

  /**
   * Plays the page currently on screen's own exit transition (§4.6),
   * before a forward page change replaces `frame.element.srcdoc`. Unlike
   * renderPlay()'s enter fade-in, no two-step rAF commit is needed here:
   * the `<iframe>` is already sitting at its resting opacity/transform (no
   * inline style forced it there a moment ago), so setting `transition`
   * and the end values together in one synchronous block still animates
   * — the browser compares against the last real paint, not against
   * something this function itself just wrote.
   *
   * Returns `false` when the caller must NOT proceed to the page change at
   * all: either a forward request arrived while an earlier one is still
   * exiting (§4.6 decision: ignored outright, never queued or stacked), or
   * `frame.generation` moved on mid-exit — some other navigation (reload(),
   * exitPlay(), a second showSlide()) superseded this one, and the caller
   * must abandon its own page change rather than apply it on top.
   */
  async function playExitTransition(thisGeneration: number): Promise<boolean> {
    if (exiting) return false;
    const { effect, duration } = currentPageTransition.exit;
    if (effect === "none" || duration === 0) return true;

    exiting = true;
    const ms = duration * 1000;
    frame.element.style.transition = `opacity ${ms}ms var(--ease-in), transform ${ms}ms var(--ease-in)`;
    frame.element.style.opacity = "0";
    frame.element.style.transform = pageTransitionTransform(effect, "exit-end");
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    exiting = false;

    if (destroyed || thisGeneration !== frame.generation) {
      frame.element.style.removeProperty("transition");
      frame.element.style.removeProperty("opacity");
      frame.element.style.removeProperty("transform");
      return false;
    }
    return true;
  }

  async function showSlide(index: number, selectAfter?: readonly string[]): Promise<void> {
    if (destroyed) return;
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      throw new Error(`slide index out of range: ${index}`);
    }

    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++frame.generation;
    // Captured before currentIndex moves — "forward" decides whether the
    // page being left plays an exit (§4.6: only a forward change does),
    // same intent as advancePastEnd()'s "+= 1" vs retreatPastStart()'s
    // "-= 1".
    const forward = index > currentIndex;
    if (mode === "play" && forward) {
      if (!(await playExitTransition(thisGeneration))) return;
    }
    currentIndex = index;
    // Plan §4.5: "close on slide change" — a chart window's edits target
    // a specific element id on the slide being left; render()'s own
    // notifyChartWindow() below would eventually close it anyway (the id
    // resolves on the wrong slide), but that happens after the slide fetch
    // resolves — closing it here means the window never lingers open for a
    // beat while the next slide loads.
    chartWindow.target = null;
    notifyChartWindow();
    // A selection points at elements' ids on the slide the author was
    // looking at; a stale selection surviving onto a different slide's DOM
    // is a defect, not a convenience.
    selection.ids = [];
    selection.names = [];
    selection.groupPath = [];
    frame.viewport = null;
    overlay.boxes = [];
    overlay.union = null;
    overlay.ancestors = [];
    overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    overlay.badgeTargets = [];
    overlay.badges = [];
    notify();
    notifyOverlay();
    if (mode === "play") {
      await renderPlay(thisGeneration, "first", true);
    } else {
      // [E2.T8]: `selectAfter` reuses the exact same "reselect once the
      // new document's `load` fires" mechanism `SELECT_AFTER_COMMAND`
      // parks in `pendingSelectionIds` — calling the public `selectElement`
      // immediately after this promise resolves would race `render()`'s
      // `frame.element.srcdoc` navigation (NOOP-227: the runtime hasn't attached
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
    const thisGeneration = ++frame.generation;
    mode = "play";
    frame.playerHasFocus = false;
    error = null;
    // Entering play mode destroys the view-mode iframe (selection-runtime.js
    // included), so any selection it reported is gone with it.
    selection.ids = [];
    selection.names = [];
    selection.groupPath = [];
    frame.viewport = null;
    overlay.boxes = [];
    overlay.union = null;
    overlay.ancestors = [];
    overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    overlay.badgeTargets = [];
    overlay.badges = [];
    rebuildFrame("allow-scripts");
    notify();
    notifyOverlay();
    await renderPlay(thisGeneration);
  }

  async function exitPlay(): Promise<void> {
    if (destroyed || mode === "view") return;
    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++frame.generation;
    mode = "view";
    frame.playerHasFocus = false;
    error = null;
    // Returning to view mode rebuilds the iframe with a fresh
    // selection-runtime.js instance that has never heard a click yet.
    selection.ids = [];
    selection.names = [];
    selection.groupPath = [];
    frame.viewport = null;
    overlay.boxes = [];
    overlay.union = null;
    overlay.ancestors = [];
    overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    currentSlideEffects = [];
    overlay.badgeTargets = [];
    overlay.badges = [];
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
    const thisGeneration = ++frame.generation;
    mode = "preview";
    previewReturnSelectionIds = [...selection.ids];
    error = null;
    selection.ids = [];
    selection.names = [];
    selection.groupPath = [];
    frame.viewport = null;
    overlay.boxes = [];
    overlay.union = null;
    overlay.ancestors = [];
    overlay.guides = [];
    currentSlideEffects = [];
    overlay.badgeTargets = [];
    overlay.badges = [];
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
    const thisGeneration = ++frame.generation;
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
    frame.element.focus();
    frame.element.contentWindow?.focus();
    // Belt-and-braces, confirmed necessary (not merely defensive) by
    // e2e/player-mode.test.ts: a bare cross-document `.focus()` call from
    // the parent alone did not reliably fire the runtime's own `focus`
    // listener in headless Chromium during testing. Asking the runtime to
    // call `window.focus()` on itself, from inside its own document, is
    // the half that actually lands.
    frame.element.contentWindow?.postMessage({ source: "slidra-host", command: "focus" }, "*");
    frame.playerHasFocus = true;
    notify();
  }

  function stepPlayer(direction: "advance" | "retreat"): void {
    if (destroyed || mode !== "play") return;
    frame.element.contentWindow?.postMessage({ source: "slidra-host", command: direction }, "*");
  }

  /** Destroys the current iframe and builds a fresh one with the given sandbox tokens, in the same container position. */
  function rebuildFrame(sandbox: string): void {
    const old = frame.element;
    frame.paintedView = null; // #303: a new element has painted nothing yet.
    frame.paintedPlay = null;
    frame.element = buildFrame(sandbox);
    container.insertBefore(frame.element, old);
    old.remove();
  }

  /**
   * Style panel (§1 decision 4, §4.6): one `element style set` call
   * carrying every currently-selected id, so one undo reverts the whole
   * multi-selection edit at once — the same "one call, not one per id"
   * shape `endMoveGesture` above uses for `element move`. No optimistic
   * preview is painted here (§2 item 3 of the plan): a successful command's
   * file write comes back over `/api/events` and drives `reload()` on its
   * own, same as every other direct-manipulation command in this module.
   */
  async function setStyle(attr: string, value: string): Promise<boolean> {
    if (selection.ids.length === 0 || currentIndex < 0) return false;
    const thisGeneration = frame.generation;
    const result = await postCommand("element style set", {
      slidePath: slides[currentIndex],
      elementIds: [...selection.ids],
      attr,
      value,
    });
    // Same race guard as endMoveGesture: a reload superseding this call
    // while it was in flight means the result is stale.
    if (destroyed || thisGeneration !== frame.generation) return false;
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
    if (selection.ids.length === 0 || currentIndex < 0) return false;
    const thisGeneration = frame.generation;
    for (const elementId of selection.ids) {
      const result = await postCommand("textbox align", {
        slidePath: slides[currentIndex],
        elementId,
        align,
      });
      if (destroyed || thisGeneration !== frame.generation) return false;
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
    const thisGeneration = frame.generation;
    const result = await postCommand("slide style set", {
      slidePath: slides[currentIndex],
      ...update,
    });
    if (destroyed || thisGeneration !== frame.generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    keepSelectionAcrossReload();
    return true;
  }

  async function setBackgroundImage(update: {
    asset?: string;
    none?: boolean;
    opacity?: number;
  }): Promise<boolean> {
    if (currentIndex < 0) return false;
    const thisGeneration = frame.generation;
    const result = await postCommand("slide background set", {
      slidePath: slides[currentIndex],
      ...update,
    });
    if (destroyed || thisGeneration !== frame.generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    keepSelectionAcrossReload();
    return true;
  }

  async function setCanvasSize(width: number, height: number): Promise<boolean> {
    const thisGeneration = frame.generation;
    const result = await postCommand("presentation canvas set", { width, height });
    if (destroyed || thisGeneration !== frame.generation) return false;
    if (!result.ok) {
      error = result.message;
      notify();
      return false;
    }
    keepSelectionAcrossReload();
    return true;
  }

  function notify(): void {
    // A fresh object per notification: listeners.state keep it as React state,
    // and handing out a mutable reference to internal arrays would let a
    // later reload silently rewrite what a listener already read.
    const state: CanvasState = {
      slides: [...slides],
      currentIndex,
      mode,
      playerHasFocus: frame.playerHasFocus,
      error,
      selection: {
        ids: [...selection.ids],
        names: [...selection.names],
        groupPath: [...selection.groupPath],
        elements: selectedElements(),
      },
      dragSignal,
      pageStyle: currentSlideModel?.pageStyle ?? null,
      backgroundImage: currentSlideModel?.backgroundImage ?? null,
      pageSource,
    };
    for (const listener of listeners.state) listener(state);
  }

  function subscribe(listener: (state: CanvasState) => void): () => void {
    listeners.state.add(listener);
    listener({
      slides: [...slides],
      currentIndex,
      mode,
      playerHasFocus: frame.playerHasFocus,
      error,
      selection: {
        ids: [...selection.ids],
        names: [...selection.names],
        groupPath: [...selection.groupPath],
        elements: selectedElements(),
      },
      dragSignal,
      pageStyle: currentSlideModel?.pageStyle ?? null,
      backgroundImage: currentSlideModel?.backgroundImage ?? null,
      pageSource,
    });
    return () => {
      listeners.state.delete(listener);
    };
  }

  void reload();

  return {
    reload,
    showSlide,
    setPageSource,
    get deckSlideCount() {
      return deckSlides.length;
    },
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
    setBackgroundImage,
    setCanvasSize,
    get frameElement() {
      return frame.element;
    },
    subscribeStageInput: (listener: (event: StageInputEvent) => void) => {
      listeners.stageInput.add(listener);
      return () => {
        listeners.stageInput.delete(listener);
      };
    },
    subscribeStageHover: (listener: (point: { x: number; y: number }) => void) => {
      listeners.stageHover.add(listener);
      return () => {
        listeners.stageHover.delete(listener);
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
      listeners.overlay.add(listener);
      listener(buildOverlayState());
      return () => {
        listeners.overlay.delete(listener);
      };
    },
    subscribeEmbeds: (listener: (state: EmbedState) => void) => {
      listeners.embed.add(listener);
      listener(buildEmbedState());
      return () => {
        listeners.embed.delete(listener);
      };
    },
    refreshEmbeds: () => {
      notifyEmbeds();
    },
    subscribeEmbedCommand: (listener: (command: EmbedCommand) => void) => {
      listeners.embedCommand.add(listener);
      return () => {
        listeners.embedCommand.delete(listener);
      };
    },
    refreshOverlay: () => {
      notifyEmbeds();
      notifyOverlay();
    },
    subscribeTable: (listener: (event: TableRuntimeEvent) => void) => {
      listeners.table.add(listener);
      if (tableRange.pendingDblclick) {
        const replay = tableRange.pendingDblclick;
        tableRange.pendingDblclick = null;
        listener(replay);
      }
      return () => {
        listeners.table.delete(listener);
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
      listeners.tableRange.add(listener);
      listener(tableRange.current);
      return () => {
        listeners.tableRange.delete(listener);
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
      listeners.chartWindow.add(listener);
      listener(buildChartWindowState());
      return () => {
        listeners.chartWindow.delete(listener);
      };
    },
    closeChartWindow,
    destroy: () => {
      destroyed = true;
      window.removeEventListener("resize", notifyEmbeds);
      listeners.state.clear();
      listeners.embed.clear();
      listeners.embedCommand.clear();
      listeners.stageInput.clear();
      listeners.overlay.clear();
      listeners.table.clear();
      listeners.tableRange.clear();
      listeners.chartWindow.clear();
      window.removeEventListener("message", runtimeMessages.onWindowMessage);
      window.removeEventListener("pointermove", gestures.onHostPointerMove, true);
      window.removeEventListener("pointerup", gestures.onHostPointerUp, true);
      // Remove exactly the element this call created — never the
      // container's other children. The container belongs to React
      // (ADR-0001); this module has no business deciding what else lives
      // in it. `.remove()` is also a no-op if the iframe is already
      // detached, so double-destroy stays safe.
      frame.element.remove();
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

