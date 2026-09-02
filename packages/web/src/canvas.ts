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
 * string this module hands it — every bit of geometry (matrix decompose,
 * bounding boxes, snapping) happens here, using `@co-motion/core`, because
 * the runtime is an unbundled `?raw` script that cannot import anything.
 * See docs on the postMessage protocol below (`SelectionMessage`).
 */
import playerRuntimeSource from "./player-runtime.js?raw";
import selectionRuntimeSource from "./selection-runtime.js?raw";
import { computePlayerPlan, renderHideStyle, renderPlanScript } from "./player-plan.js";
import {
  decomposeMatrix,
  formatTransform,
  elementBounds,
  snapTranslation,
  composeMatrices,
  applyMatrixToPoint,
  invertMatrix,
  type Matrix,
  type Rect,
  type TransformParts,
  type SnapCandidate,
  type SnapGuide,
} from "@co-motion/core/geometry";
import { parseSlide, type SlideElement, type SlideModel } from "@co-motion/core/slide";
import { wrapText } from "@co-motion/core/text";
import { parseFont, type FontMetrics } from "@co-motion/core/text-metrics";

export type CanvasMode = "view" | "play";

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
  /** Throws when the index is out of range — that is a programming error, not user input. */
  showSlide: (index: number) => Promise<void>;
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
  runCommand: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>;
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
  /**
   * The presentation-level slide transition (T6). Absent, empty, or an
   * unknown future value (e.g. an older build opening a newer `.comot`)
   * all mean the same thing on the read side: play `none` instead of
   * throwing (project-json.ts's read side deliberately does not
   * whitelist). Only the literal `"fade"` triggers the fade-in below.
   */
  transition?: string;
}

/** How long renderPlay()'s fade-in runs (T6). Deliberately not shared with
 * player-runtime.js's own 0.4s element-entrance transition — that constant
 * animates elements *inside* the iframe document, this one animates the
 * `<iframe>` element itself from the parent document, and the two layers
 * must stay free to change independently of each other. */
const PAGE_FADE_MS = 400;

/** Message shapes the runtime sends (C4 in the design doc). */
interface PlayerMessage {
  source: "comot-player";
  event: "ready" | "focus" | "advance-past-end" | "retreat-past-start" | "error";
  hasFocus?: boolean;
  message?: string;
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
    | "text-edit-input"
    | "text-edit-commit"
    | "text-edit-denied";
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
  /**
   * Present (and non-empty) only on a "select"/"clear" that entered or
   * stayed inside a group, and always on "group-path" — see
   * selection-runtime.js's `withGroupPath` for why it is omitted rather
   * than sent empty on the common top-level case.
   */
  groupPath?: string[];
}

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
 * Uniform scale anchored at the element's own local origin (§4.2-follow-up
 * "Scale handles"). `origin` lives in the element's PARENT coordinate
 * space (its matrix's own translate) — the same space `decomposeMatrix`
 * already reports it in. `startUser`/every subsequent pointer point is
 * reported in the top-level viewBox's user units, so it is run through
 * `parentInverse` (the inverse of the composed ancestor chain, NOOP-91
 * follow-up round 2) before being compared against `origin`, putting both
 * ends of the ray in the same frame regardless of how many
 * translate/rotate/scale ancestors sit between the element and the slide
 * root.
 */
interface ScaleGesture {
  kind: "scale";
  id: string;
  original: OriginalTransform;
  /** The element's own local origin (its matrix's translate), in its PARENT's coordinate units. */
  origin: { x: number; y: number };
  /** Pointer-down point, mapped into the element's PARENT coordinate space — the ray's other end. */
  startUser: { x: number; y: number };
  /** Maps a top-level user-unit point into the element's parent coordinate space; the inverse of the composed ancestor chain (`entry.ancestors`) captured at gesture start. */
  parentInverse: Matrix;
  /** Last factor actually applied to the preview; used only to decide "did anything change" at release. */
  lastFactor: number;
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
interface TextboxWidthGesture {
  kind: "textbox-width";
  id: string;
  handle: "left" | "right";
  originalWidth: number;
  originalTransform: string | null;
  fontFamily: string;
  fontSize: number;
  sourceText: string;
  /** Resolved asynchronously after the gesture starts (a font fetch); updates never apply until this lands. */
  font: FontMetrics | null;
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
  /**
   * The declared text-box width, or null for a plain `<text>` — one that
   * carries no `data-comot-text-width` and therefore has no wrapping at
   * all. `font`/`fontSize` are null on exactly the same elements: with
   * nothing to wrap, nothing needs measuring. `text set` already handles
   * both shapes (element-text.ts's `replaceContainerText`).
   */
  width: number | null;
  font: FontMetrics | null;
  fontSize: number | null;
}

/**
 * The family a `<text>` is measured against when it declares no
 * `font-family` of its own — `font-family` is optional in SVG, so a
 * perfectly legal text box can omit it, and in-place editing still has to
 * wrap. Kept as a literal rather than imported from core's
 * `DEFAULT_FONT_FAMILY`: that lives in presentation.ts, which reads the
 * font bytes off disk with node:fs and so cannot be imported into the
 * browser bundle. The bytes themselves arrive over /api/default-font.
 */
const DEFAULT_FONT_FAMILY = "Noto Sans TC";

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

export function mountCanvas(container: HTMLElement): CanvasController {
  let destroyed = false;
  // The selected slide lives here, not in React (ADR-0001/ADR-0002): the
  // 投影片 on screen is the artifact, not something React computes from
  // state. React subscribes to read it and issues commands to change it.
  let slides: string[] = [];
  let currentIndex = -1;
  // The presentation-level slide transition (T6), read from
  // project.transition on every reload() — "none" until the first fetch
  // completes. renderPlay() is the only reader; nothing else needs it.
  let transition: string | undefined;
  let mode: CanvasMode = "view";
  let playerHasFocus = false;
  let error: string | null = null;
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
  // NOOP-227: the element a just-finished insert command created, still
  // waiting for the reload()/render() its own write triggers over
  // /api/events. reload() would otherwise clear the selection like every
  // other reload — this is the one case where the id IS trustworthy,
  // because this module made it moments ago. Consumed (set back to null)
  // by the render() that follows, whether or not the id still resolves.
  let pendingSelectionId: string | null = null;
  // See CanvasState.dragSignal's own comment — bumped on every "drag-enter"
  // message, never reset (there is nothing to reset it back to: it is an
  // edge counter, not a level).
  let dragSignal = 0;
  // The current slide's parsed model plus its raw markup, kept only so
  // gestures can compute bounding boxes/candidates without re-fetching —
  // reset on every render() alongside the selection.
  let currentSlideModel: SlideModel | null = null;
  // Fonts this presentation embeds, as reported by /api/presentation
  // (project.json's own `fonts` field) — resolveBrowserFont() below reads
  // this to find the right font FILE for a family it hasn't fetched yet.
  let presentationFonts: { file: string; family: string }[] = [];
  // Parsed FontMetrics, keyed by family, resolved lazily on first use by a
  // textbox-width gesture and cached for the controller's lifetime — a
  // presentation's embedded fonts never change without a full reload()
  // (which does not clear this cache: the bytes on disk for a given
  // family are still the same font).
  const fontCache = new Map<string, Promise<FontMetrics>>();
  // Every embedded font this presentation declares, resolved and parsed at
  // the end of reload() (below) — the browser-side equivalent of the
  // server's `resolvePresentationFonts`. Fed to every `elementBounds` call
  // (marquee framing, snap candidates) so a `<text>` element's box is
  // computable there too, not just in the textbox-width gesture that used
  // to be the only consumer of a parsed font (§4.7/§4.8). A family that
  // fails to fetch/parse is simply absent from this map — any `<text>`
  // using it stays unselectable/un-snappable, the same degradation
  // `computeBounds`'s own try/catch already applies to any other
  // unmeasurable element, rather than failing the whole reload.
  let resolvedFonts: ReadonlyMap<string, FontMetrics> = new Map();
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
    // only ever runs while mode === "play" (wrapPlayDocument is the only
    // place playerRuntimeSource is injected). A view-mode slide has no
    // business sending any of these — reject the whole message rather
    // than gating individual events, so a future new event type is safe
    // by default instead of needing its own opt-in gate.
    if (mode !== "play") return;

    const message = event.data;
    if (message.event === "ready") {
      // Entering play mode hands focus to the player (acceptance
      // criterion); "ready" is the runtime's own signal that its listeners
      // are attached and it can actually receive the focus/keydown.
      focusPlayer();
      return;
    }
    if (message.event === "focus") {
      playerHasFocus = Boolean(message.hasFocus);
      notify();
      return;
    }
    if (message.event === "error") {
      error = message.message ?? "播放時發生未知錯誤";
      notify();
      return;
    }
    if (message.event === "advance-past-end") {
      void advancePastEnd();
      return;
    }
    if (message.event === "retreat-past-start") {
      void retreatPastStart();
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
      return;
    }
    if (message.event === "clear") {
      selectionIds = [];
      selectionNames = [];
      selectionGroupPath = isStringArray(message.groupPath) ? message.groupPath : [];
      notify();
      pushSelectionToRuntime(selectionIds);
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
      else if (activeGesture?.kind === "scale") updateScaleGesture(message.point);
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
      if (gesture?.kind === "move") void endMoveGesture(cancelled).then(endEditingLease);
      else if (gesture?.kind === "marquee") endMarqueeGesture(message.point, cancelled);
      else if (gesture?.kind === "scale") void endScaleGesture(message.point, cancelled).then(endEditingLease);
      else if (gesture?.kind === "rotate") void endRotateGesture(message.point, cancelled).then(endEditingLease);
      else if (gesture?.kind === "textbox-width") void endTextboxWidthGesture(message.point, cancelled).then(endEditingLease);
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
    if (message.event === "text-edit-input") {
      if (!editingState || message.id !== editingState.id) return;
      const text = typeof message.text === "string" ? message.text : "";
      editingState.currentText = text;
      postTextEditPreview(editingState.id, text, editingState.width, editingState.font, editingState.fontSize);
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

  /** An element's bounds, or null when they cannot be computed (e.g. a `<text>` whose font failed to resolve). Never throws. */
  function computeBounds(
    id: string,
    index: Map<string, { element: SlideElement; ancestors: Matrix[] }>,
  ): Rect | null {
    const entry = index.get(id);
    if (!entry) return null;
    try {
      return elementBounds(entry.element, { ancestors: entry.ancestors, fonts: resolvedFonts });
    } catch {
      return null;
    }
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
   * Whitelisted commands whose `data.elementId` (NOOP-227) should become
   * the selection once this write's own reload lands — the Ribbon's insert
   * actions (`textbox add`, `element insert`: 矩形/橢圓/線). Every other
   * whitelisted command leaves the selection to reload()'s existing clear.
   */
  const SELECT_AFTER_COMMAND = new Set(["textbox add", "element insert"]);

  /**
   * `CanvasController.runCommand` (NOOP-141) — a thin wrapper over the
   * module's own `postCommand` that also surfaces a failure through
   * `CanvasState.error`, the same way every existing direct-manipulation
   * gesture below already does. No optimistic preview: a Ribbon button
   * click has nothing already painted to revert. A success clears any
   * stale error left over from a previous failed Ribbon command — nothing
   * else in view mode clears it otherwise.
   */
  async function runCommand(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const result = await postCommand(name, input);
    error = result.ok ? null : result.message;
    if (result.ok && SELECT_AFTER_COMMAND.has(name)) {
      const elementId = (result.data as { elementId?: unknown } | undefined)?.elementId;
      if (typeof elementId === "string") pendingSelectionId = elementId;
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

  async function postAsset(file: File): Promise<ImportAssetResult> {
    try {
      const bytes = await file.arrayBuffer();
      const response = await fetch("/api/asset", {
        method: "POST",
        headers: { "X-Co-Motion-Asset-Name": encodeURIComponent(file.name) },
        body: bytes,
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string; data?: ImportedAsset }
        | null;
      if (!response.ok || !body?.data) {
        return { ok: false, message: (body && typeof body.error === "string" && body.error) || `匯入失敗（HTTP ${response.status}）` };
      }
      return { ok: true, message: typeof body.message === "string" ? body.message : "", data: body.data };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "匯入失敗" };
    }
  }

  /**
   * Fetches and parses (once, then cached) the font bytes for `family` —
   * the browser-side half of what `resolvePresentationFonts` does on the
   * server (fonts.ts), reduced to a single family since a textbox-width
   * gesture only ever needs the one its own `<text>` declares. Throws
   * (via the rejected promise) when the presentation has no such font
   * entry, or the font bytes fail to parse — the caller is responsible for
   * surfacing that as `CanvasState.error` rather than freezing the drag.
   */
  function resolveBrowserFont(family: string): Promise<FontMetrics> {
    const cached = fontCache.get(family);
    if (cached) return cached;
    const promise = (async () => {
      const entry = presentationFonts.find((candidate) => candidate.family === family);
      // The build's own bundled family is always resolvable, even for a
      // presentation whose project.json lists no fonts at all — see
      // DEFAULT_FONT_FAMILY's own comment and serve.ts's /api/default-font.
      if (!entry && family !== DEFAULT_FONT_FAMILY) {
        throw new Error(`簡報未內嵌字型：${family}`);
      }
      const source = entry ? `/api/raw/${entry.file}` : "/api/default-font";
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`字型載入失敗：${entry ? entry.file : DEFAULT_FONT_FAMILY}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return parseFont(bytes);
    })();
    fontCache.set(family, promise);
    return promise;
  }

  /**
   * Resolves every family this presentation declares into a
   * `ReadonlyMap<string, FontMetrics>` (`elementBounds`'s `fonts` option),
   * so a `<text>` element's box is computable outside a textbox-width
   * gesture too — marquee framing and drag-to-move's snap candidates both
   * need it (§4.7/§4.8). Goes through the same `resolveBrowserFont` cache
   * textbox-width already uses, so a family fetched once here is never
   * re-fetched when a gesture needs it later. A family whose fetch/parse
   * fails is simply left out of the returned map rather than failing
   * reload() outright — same "skip the one thing that cannot be computed"
   * posture as `computeBounds`'s own try/catch.
   */
  async function resolveEmbeddedFonts(
    fonts: readonly { file: string; family: string }[],
  ): Promise<ReadonlyMap<string, FontMetrics>> {
    const entries = await Promise.all(
      fonts.map(async (entry): Promise<[string, FontMetrics] | null> => {
        try {
          return [entry.family, await resolveBrowserFont(entry.family)];
        } catch {
          return null;
        }
      }),
    );
    return new Map(entries.filter((entry): entry is [string, FontMetrics] => entry !== null));
  }

  /** "full" (single selection: scale + rotate handles) / "move-only" (0 or 2+ selected) / "none" — the rendering condition the "selection" host->runtime command carries (§5's multi-select rule: this is computed here, never at click time in the runtime). */
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
      const movingRects = gesture.ids.map((id) => computeBounds(id, index)).filter((r): r is Rect => r !== null);
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
          const bounds = computeBounds(id, index);
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
    postToFrame({
      command: "guides",
      lines: guides.map((guide) => ({
        orientation: guide.orientation,
        position: guide.orientation === "v" ? userXToClient(guide.position) : userYToClient(guide.position),
      })),
    });
  }

  function revertMovePreview(gesture: MoveGesture): void {
    const items = gesture.ids.map((id) => ({ id, transform: gesture.originals.get(id)!.transform ?? "" }));
    postToFrame({ command: "preview", items });
  }

  async function endMoveGesture(cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "move") return;
    postToFrame({ command: "guides", lines: [] });

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
    // Success: the preview already shows the final position. The write
    // this command just made will arrive back over /api/events and drive
    // reload() on its own — this module deliberately adds no second
    // refresh path (§4.9's closing note).
  }

  // --- Scale handles (§4.2-follow-up) ---

  function beginScaleGesture(point: { x: number; y: number }, _corner: "nw" | "ne" | "sw" | "se"): void {
    void _corner; // The corner only ever affected the runtime's own handle-cursor styling — every corner drives the identical uniform-scale-from-origin math.
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
    activeGesture = {
      kind: "scale",
      id,
      original: { transform: entry.element.transform, parts },
      origin,
      startUser,
      parentInverse,
      lastFactor: 1,
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

  function updateScaleGesture(point: { x: number; y: number }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "scale") return;
    const factor = computeScaleFactor(gesture, point);
    // Non-positive, NaN or infinite: dragged past the origin (would flip)
    // or otherwise invalid. Freeze the preview at the last valid factor
    // rather than showing a flipped/garbage transform — endScaleGesture
    // recomputes from the final point and aborts explicitly if it is
    // still invalid there.
    if (!(factor > 0) || !Number.isFinite(factor)) return;
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
  }

  // --- Textbox-width handles (§4.4) ---

  function beginTextboxWidthGesture(point: { x: number; y: number }, handle: "left" | "right"): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when viewport hasn't arrived yet (NOOP-328).
    if (!viewport) return;
    if (selectionIds.length !== 1) return;
    const id = selectionIds[0];
    const entry = elementIndex().get(id);
    if (!entry || entry.element.textWidth === null) return;
    const textPrimitive = entry.element.primitives.find((primitive) => primitive.tag === "text");
    if (!textPrimitive) return;
    const fontFamily = textPrimitive.attrs.get("font-family");
    if (!fontFamily) return;
    const fontSizeRaw = textPrimitive.attrs.get("font-size");
    const fontSize = fontSizeRaw === undefined ? 16 : Number(fontSizeRaw);
    if (!Number.isFinite(fontSize) || fontSize <= 0) return;

    const gesture: TextboxWidthGesture = {
      kind: "textbox-width",
      id,
      handle,
      originalWidth: entry.element.textWidth,
      originalTransform: entry.element.transform,
      fontFamily,
      fontSize,
      sourceText: textPrimitive.text,
      font: null,
      startUserX: toUserPoint(point).x,
      lastWidth: entry.element.textWidth,
    };
    activeGesture = gesture;

    void resolveBrowserFont(fontFamily)
      .then((font) => {
        // Only apply if this exact gesture is still the active one — a
        // fast click-drag-release, or a newer gesture starting before the
        // fetch settles, must not resurrect a stale one.
        if (activeGesture === gesture) gesture.font = font;
      })
      .catch((err) => {
        if (activeGesture === gesture) {
          activeGesture = null;
          error = err instanceof Error ? err.message : "字型載入失敗";
          notify();
        }
      });
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

  function revertTextboxPreview(gesture: TextboxWidthGesture, font: FontMetrics): void {
    const wrapped = wrapText(gesture.sourceText, { width: gesture.originalWidth, font, fontSizePx: gesture.fontSize });
    postToFrame({
      command: "preview-textbox",
      id: gesture.id,
      lines: wrapped.lines.map((line) => ({ text: line.text, y: Number(line.y.toFixed(4)) })),
      width: gesture.originalWidth,
    });
  }

  function updateTextboxWidthGesture(point: { x: number; y: number }): void {
    const gesture = activeGesture;
    if (!gesture || gesture.kind !== "textbox-width" || !gesture.font) return; // Font still loading — freeze until it lands.
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0)) return; // Would go non-positive — freeze at the last valid preview.
    gesture.lastWidth = width;
    const wrapped = wrapText(gesture.sourceText, { width, font: gesture.font, fontSizePx: gesture.fontSize });
    postToFrame({
      command: "preview-textbox",
      id: gesture.id,
      lines: wrapped.lines.map((line) => ({ text: line.text, y: Number(line.y.toFixed(4)) })),
      width,
    });
  }

  async function endTextboxWidthGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.kind !== "textbox-width") return;
    if (!gesture.font) return; // Never resolved a usable frame — nothing was ever previewed, nothing to revert or send.

    if (cancelled) {
      revertTextboxPreview(gesture, gesture.font);
      return;
    }
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0) || roundsToZero(width)) {
      revertTextboxPreview(gesture, gesture.font);
      error = "文字框寬度必須大於 0";
      notify();
      return;
    }
    if (roundsToZero(width - gesture.originalWidth)) {
      revertTextboxPreview(gesture, gesture.font);
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
      revertTextboxPreview(gesture, gesture.font);
      error = result.message;
      notify();
      return;
    }
  }

  // --- In-place text editing (NOOP-91/#70 US1, T5) ---

  /** Re-wraps `text` with core's `wrapText` and pushes it to the runtime via the existing preview-textbox channel — shared by the live-typing preview and a failed commit's revert. */
  function postTextEditPreview(
    id: string,
    text: string,
    width: number | null,
    font: FontMetrics | null,
    fontSizePx: number | null,
  ): void {
    if (width === null || font === null || fontSizePx === null) {
      // A plain <text>: no wrapping, and no tspan rewrite either — the
      // runtime replaces the text content in place, leaving the element's
      // own x/y/text-anchor alone.
      postToFrame({ command: "preview-text", id, text });
      return;
    }
    const wrapped = wrapText(text, { width, font, fontSizePx });
    postToFrame({
      command: "preview-textbox",
      id,
      lines: wrapped.lines.map((line) => ({ text: line.text, y: Number(line.y.toFixed(4)) })),
      width,
    });
  }

  /**
   * Opens `id` for editing — the shared entry point for `beginTextEdit`
   * (CanvasController) and the runtime's own "dblclick-textbox" report.
   * Lock is NOT checked here: the parsed slide model (`elementIndex`) never
   * carries `data-comot-lock` (it is a container attribute the normal-form
   * parser does not surface on `SlideElement`), so the only place that can
   * answer "is this locked" is the runtime's own DOM — see the
   * "begin-text-edit"/"text-edit-denied" round trip below and
   * selection-runtime.js's `enterRuntimeTextEdit`.
   */
  async function enterTextEdit(id: string): Promise<void> {
    if (mode !== "view") return;
    const entry = elementIndex().get(id);
    if (!entry) return;
    const width = entry.element.textWidth;
    if (editingState && editingState.id === id) return; // Already editing this exact element — no-op.
    if (editingState) await commitTextEdit(); // Editing a different element — commit it first.
    if (destroyed || mode !== "view") return;

    const textPrimitive = entry.element.primitives.find((primitive) => primitive.tag === "text");
    if (!textPrimitive) return;
    const sourceText = textPrimitive.text;

    if (width === null) {
      // A plain <text>: `text set` writes the string straight through with
      // no re-wrapping, so no font is fetched and no measurement happens.
      editingState = {
        id,
        slidePath: slides[currentIndex],
        originalText: sourceText,
        currentText: sourceText,
        width: null,
        font: null,
        fontSize: null,
      };
      beginEditingLease();
      postToFrame({ command: "begin-text-edit", id, text: sourceText });
      return;
    }

    // font-family is optional in SVG; a text box that omits it is measured
    // against the build's own bundled family rather than refused.
    const fontFamily = textPrimitive.attrs.get("font-family") || DEFAULT_FONT_FAMILY;
    const fontSizeRaw = textPrimitive.attrs.get("font-size");
    const fontSize = fontSizeRaw === undefined ? 16 : Number(fontSizeRaw);
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      error = `文字框的 font-size 不是合法的正數：${fontSizeRaw}`;
      notify();
      return;
    }

    const thisGeneration = generation;
    let font: FontMetrics;
    try {
      font = await resolveBrowserFont(fontFamily);
    } catch (err) {
      if (destroyed || thisGeneration !== generation) return;
      error = err instanceof Error ? err.message : "字型載入失敗";
      notify();
      return;
    }
    if (destroyed || thisGeneration !== generation || mode !== "view") return;

    editingState = {
      id,
      slidePath: slides[currentIndex],
      originalText: sourceText,
      currentText: sourceText,
      font,
      fontSize,
      width,
    };
    beginEditingLease();
    const wrapped = wrapText(sourceText, { width, font, fontSizePx: fontSize });
    postToFrame({
      command: "begin-text-edit",
      id,
      text: sourceText,
      lines: wrapped.lines.map((line) => ({ text: line.text, y: Number(line.y.toFixed(4)) })),
      width,
    });
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
      postTextEditPreview(state.id, state.originalText, state.width, state.font, state.fontSize);
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
      try {
        const bounds = elementBounds(element, { ancestors: [], fonts: resolvedFonts });
        if (rectsIntersect(marqueeRect, bounds)) {
          hitIds.push(element.id);
          hitNames.push(element.name);
        }
      } catch {
        // An element whose bounds still cannot be computed (e.g. a
        // `<text>` whose declared font failed to resolve) is simply not
        // selectable by marquee.
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
    currentIndex += 1;
    notify();
    await renderPlay(thisGeneration, "first", true);
  }

  /** Mirrors advancePastEnd() exactly, in reverse (#46, decision 六). */
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
    await renderPlay(thisGeneration, "last");
  }

  async function reload(): Promise<void> {
    // A no-op after destroy(): the iframe this closure owns is gone from
    // the DOM, so there is nothing left to redraw, and re-fetching would
    // just race the next mount for no benefit.
    if (destroyed) return;

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
    transition = project.transition;
    presentationFonts = project.fonts ?? [];
    resolvedFonts = await resolveEmbeddedFonts(presentationFonts);
    if (destroyed || thisGeneration !== generation) return;
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
    notify();

    if (mode === "play") {
      await renderPlay(thisGeneration);
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
    // Consumed here regardless of outcome (NOOP-227) — a stale id (the
    // slide moved out from under it, or the insert failed to parse back)
    // must not leak into some later, unrelated render().
    const selectAfterLoad = pendingSelectionId;
    pendingSelectionId = null;

    if (currentIndex === -1) {
      currentSlideModel = null;
      frame.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || thisGeneration !== generation) return;

    // Parsed once per render so gestures never re-fetch/re-parse mid-drag.
    // A non-compliant slide (should not happen — every write path asserts
    // compliance) simply gets no model: gestures degrade to "no snap
    // candidates, no marquee hits" rather than throwing.
    try {
      currentSlideModel = parseSlide(svgMarkup, slidePath);
    } catch {
      currentSlideModel = null;
    }

    frame.srcdoc = wrapSelectionDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      selectionColors(),
    );

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
  function selectOnceLoaded(elementId: string, thisGeneration: number): void {
    const targetFrame = frame;
    const onLoad = () => {
      targetFrame.removeEventListener("load", onLoad);
      if (destroyed || thisGeneration !== generation || mode !== "view") return;
      const entry = elementIndex().get(elementId);
      if (!entry) return;
      selectionIds = [elementId];
      selectionNames = [entry.element.name];
      selectionGroupPath = [];
      notify();
      pushSelectionToRuntime(selectionIds);
    };
    targetFrame.addEventListener("load", onLoad);
  }

  /**
   * Reads the selection box's colours from this document's own tokens.css
   * (--accent-hi, --s-titlebar) so selection-runtime.js — living in an
   * opaque-origin document with no access to this document's :root — never
   * has to hard-code them (ADR-0011). Read fresh on every render() call
   * rather than cached, so a future token change takes effect immediately.
   */
  function selectionColors(): { accent: string; handle: string } {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      accent: rootStyle.getPropertyValue("--accent-hi").trim(),
      handle: rootStyle.getPropertyValue("--s-titlebar").trim(),
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
   * `animate` (T6): whether THIS particular page change should play the
   * presentation-level fade, on top of `transition === "fade"` already
   * being true. Callers pass `true` only for a user-initiated forward page
   * change — retreat, play()/exitPlay() entry, and reload() all pass the
   * default `false`, matching runtime's existing "retreat is instant"
   * principle plus "a fade is a *page change*, not an entry or a
   * background refresh". This is a distinct layer from element-entrance
   * transitions inside the slide's own runtime: this one fades the
   * `<iframe>` itself, from the parent document, and never touches
   * player-runtime.js.
   */
  async function renderPlay(
    thisGeneration?: number,
    startAt: "first" | "last" = "first",
    animate = false,
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
      const plan = computePlayerPlan(svgMarkup);
      const startStep = startAt === "last" ? plan.steps.length - 1 : -1;
      planScript = renderPlanScript(plan, startStep);
      hideStyle = renderHideStyle(plan.hidden);
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
      // Surfaced, never silently swallowed (design doc). Play the static
      // slide with no runtime rather than leaving the frame blank — the
      // author still sees the slide, plus the reason nothing animates.
      error = planError instanceof Error ? planError.message : "效果清單無法解析";
      notify();
      frame.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
      return;
    }

    frame.srcdoc = wrapPlayDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      hideStyle,
      planScript,
    );

    if (animate && transition === "fade") {
      // Fade-in only, not a cross-fade (决定 3 in the plan): the old page is
      // simply gone the instant srcdoc is replaced above, and the new one
      // reveals itself from black. Fading the old page out first would mean
      // waiting for that animation before the fetch/srcdoc swap could even
      // start, tangling this with the generation guard above for a result
      // that is strictly less faithful to "fade" than what this buys.
      frame.style.transition = "none";
      frame.style.opacity = "0";
      // The "none" transition and opacity:0 must land in a rendered frame
      // before switching to the real transition, or the browser coalesces
      // both style writes into one paint and nothing animates.
      requestAnimationFrame(() => {
        if (destroyed || captured !== generation) return;
        frame.style.transition = `opacity ${PAGE_FADE_MS}ms`;
        frame.style.opacity = "1";
      });
    } else {
      // Instant path must actively clear any inline opacity/transition a
      // PRIOR fade left behind — otherwise this page silently inherits the
      // last frame's mid-fade opacity instead of showing at full opacity.
      // `transition` is cleared before `opacity` defensively — clearing
      // `opacity` while a `transition` is still declared risks animating
      // the removal itself instead of jumping straight to the resting
      // value.
      frame.style.removeProperty("transition");
      frame.style.removeProperty("opacity");
    }
  }

  async function showSlide(index: number): Promise<void> {
    if (destroyed) return;
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      throw new Error(`投影片索引超出範圍：${index}`);
    }

    if (editingState) void commitTextEdit(); // See reload()'s own comment on why this is fire-and-forget.
    activeGesture = null;
    const thisGeneration = ++generation;
    // Captured before currentIndex moves — "forward" for the fade means
    // this specific call moved strictly ahead, same intent as
    // advancePastEnd()'s "+= 1" (retreatPastStart's own "-= 1" path already
    // passes no animate flag by calling renderPlay's default).
    const forward = index > currentIndex;
    currentIndex = index;
    // A selection points at elements' ids on the slide the author was
    // looking at; a stale selection surviving onto a different slide's DOM
    // is a defect, not a convenience.
    selectionIds = [];
    selectionNames = [];
    selectionGroupPath = [];
    viewport = null;
    notify();
    if (mode === "play") {
      await renderPlay(thisGeneration, "first", forward);
    } else {
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
    rebuildFrame("allow-scripts");
    notify();
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
    rebuildFrame("allow-scripts");
    notify();
    await render(thisGeneration);
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
    focusPlayer,
    stepPlayer,
    beginTextEdit: enterTextEdit,
    runCommand,
    importAsset,
    reportError: (message: string) => {
      error = message;
      notify();
    },
    setStyle,
    get frameElement() {
      return frame;
    },
    destroy: () => {
      destroyed = true;
      listeners.clear();
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
): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  const safeColorsJson = JSON.stringify(colors).replace(/</g, "\\u003C");
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${PRESENTATION_FONT_FACE_STYLE}</head><body style="margin:0"><script>window.__COMOT_SELECTION_COLORS__=${safeColorsJson};<\/script><script>${selectionRuntimeSource}<\/script>${bodyMarkup}</body></html>`;
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
