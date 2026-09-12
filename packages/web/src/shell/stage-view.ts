/**
 * Pure zoom/pan/hand-mode state for the New v3 stage. No DOM access,
 * no React — every function here is `(state, ...) => state`, testable with
 * plain function calls (packages/web/test/stage-view.test.ts). Stage.tsx and
 * the Dock components wire these onto React state/event handlers; they must
 * not duplicate this logic themselves.
 *
 * Ground truth for the numeric behaviour is
 * docs/design/prototype/comotion-logic-v3.js's `setZoom`/`wellWheel`
 * (`Math.max(.25, Math.min(4, z))`, the `nz/zoom` anchor-preserving pan
 * formula, `Math.exp(-deltaY * .0025)` for wheel-to-zoom-factor) — see
 * 05-INTERACTIONS.feature's "stage navigation" scenarios for the behaviour rules.
 */

export interface Point {
  x: number;
  y: number;
}

export interface ZoomPanState {
  zoom: number;
  pan: Point;
}

/** Figma-style range, matching the prototype and 05-INTERACTIONS.feature ("range 25%-400%"). */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;

/** The ZoomMenu's fixed preset row. Not a snapping target for `setZoom` — see its own test. */
export const ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.5, 2, 4];

export function initialZoomPan(): ZoomPanState {
  return { zoom: 1, pan: { x: 0, y: 0 } };
}

/**
 * Sets zoom to `z`, silently clamped to [ZOOM_MIN, ZOOM_MAX] — user input
 * (scroll, typed value, preset click) is never an error, only ever clamped.
 * A non-finite or non-numeric `z` is a programmer error (a caller passing
 * through something it should have validated itself) and throws instead of
 * silently clamping or ignoring it.
 */
export function setZoom(state: ZoomPanState, z: number): ZoomPanState {
  if (typeof z !== "number" || !Number.isFinite(z)) {
    throw new Error(`setZoom: 收到非合法數值 zoom=${String(z)}`);
  }
  const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  return { zoom: nz, pan: state.pan };
}

/** Direct pan delta — unbounded in both directions on purpose (see the test file's own comment). */
export function panBy(state: ZoomPanState, dx: number, dy: number): ZoomPanState {
  return { zoom: state.zoom, pan: { x: state.pan.x + dx, y: state.pan.y + dy } };
}

/**
 * Converts a point expressed in the same coordinate space as `pan` (e.g. an
 * offset from the stage well's own center) into the underlying content's
 * coordinate space. Not consumed by any overlay yet (SelectionOverlay et al.
 * are empty containers this ticket) — exported now, as the ticket asks, so
 * the conversion has exactly one definition when a future overlay needs it.
 */
export function clientPointToContentPoint(state: ZoomPanState, point: Point): Point {
  return { x: (point.x - state.pan.x) / state.zoom, y: (point.y - state.pan.y) / state.zoom };
}

/**
 * Sets zoom to `z`, keeping the content under `anchor` (in the same
 * coordinate space as `pan`) visually stationary — the anchor-preserving
 * zoom used by both ⌘/Ctrl+wheel and the ZoomMenu's +/− buttons (which
 * anchor on the stage's own center, per the prototype's `zoomIn`/`zoomOut`).
 * `z` still goes through the same clamping as `setZoom`.
 */
export function zoomAtPoint(state: ZoomPanState, z: number, anchor: Point): ZoomPanState {
  const clamped = setZoom(state, z).zoom;
  const k = clamped / state.zoom;
  return {
    zoom: clamped,
    pan: {
      x: anchor.x - (anchor.x - state.pan.x) * k,
      y: anchor.y - (anchor.y - state.pan.y) * k,
    },
  };
}

/**
 * ⌘/Ctrl+wheel → zoom, centered on the pointer (05-INTERACTIONS.feature's
 * "zoom with the scroll wheel"). `deltaY` is the wheel event's own value; the exponential
 * factor matches the prototype's `wellWheel` so scroll "feel" is identical.
 */
export function zoomByWheel(state: ZoomPanState, deltaY: number, anchor: Point): ZoomPanState {
  const factor = Math.exp(-deltaY * 0.0025);
  return zoomAtPoint(state, state.zoom * factor, anchor);
}

/** ZoomMenu's "Fit": back to 100%, re-centered — identical to the initial state. */
export function zoomFit(_state: ZoomPanState): ZoomPanState {
  return initialZoomPan();
}

/** Display-only rounding — the internal `zoom` value is never snapped (see setZoom's own test). */
export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

// ── Hand mode / temporary grab (Space) ─────────────────────────

export interface HandState {
  /** The ✋ button's own toggle state — sticky until pressed again. */
  hand: boolean;
  /** Whether Space is currently physically held down. */
  spaceHeld: boolean;
}

export function initialHandState(): HandState {
  return { hand: false, spaceHeld: false };
}

/** True while the stage should behave as grab/pan mode — button toggle OR temporary Space-hold. */
export function isHandActive(state: HandState): boolean {
  return state.hand || state.spaceHeld;
}

export interface ToggleHandResult {
  state: HandState;
  /**
   * True only when this call turned hand mode ON — 05-INTERACTIONS.feature's
   * "Hand mode" scenario ("then the current selection is cleared"). Turning it back off does not
   * clear anything. Selection itself lives in canvas.ts's CanvasState (out
   * of this pure module's reach and out of this ticket's scope — selection/
   * drag/resize are a future ticket) — the caller (Stage.tsx) reacts to this
   * flag; see the PR report for the current no-op wiring.
   */
  selectionCleared: boolean;
}

export function toggleHand(state: HandState): ToggleHandResult {
  const hand = !state.hand;
  return { state: { ...state, hand }, selectionCleared: hand };
}

export interface PressSpaceOptions {
  /**
   * Mirrors App.tsx's existing focus-guard for ⌘Z (INPUT/TEXTAREA/SELECT/
   * contentEditable) — Stage.tsx must pass this from the real keydown
   * target; this module has no DOM access to check it itself.
   */
  targetIsTextInput?: boolean;
}

/** Idempotent: a repeated keydown (OS key-repeat) while already held is a no-op, not re-armed. */
export function pressSpace(state: HandState, options: PressSpaceOptions = {}): HandState {
  if (options.targetIsTextInput) return state;
  if (state.spaceHeld) return state;
  return { ...state, spaceHeld: true };
}

/**
 * Releases the temporary Space-hold. Safe to call unconditionally — a
 * window-blur handler (Space physically still down but no keyup will ever
 * arrive) can call this the same way a real keyup does, with no need to
 * check `spaceHeld` first.
 */
export function releaseSpace(state: HandState): HandState {
  if (!state.spaceHeld) return state;
  return { ...state, spaceHeld: false };
}
