// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Rect } from "../geometry.js";
import { HUMAN_RENEW_THROTTLE_MS, type ActiveGesture, type TextEditState, type Viewport } from "./gesture-geometry.js";
import { normalizeRange, isCellInRange, type CellRange } from "../table-overlay.js";
import {
  isSelectionMessage,
  isPlayerMessage,
  isValidRect,
  isStringArray,
  isValidPoint,
  isFiniteNumber,
  isBoundsItem,
  isNonNegativeRect,
  isMeasuredItem,
  isElementBoundsItem,
  isTableCellRectItem,
  type SelectionMessage,
  type TableRuntimeEvent,
} from "./runtime-messages.js";
import type { CanvasMode, StageInputEvent } from "../canvas.js";

/** The runtime's last-reported per-selected-element geometry, and the viewport mapping the `select`/`bounds`/`viewport` events above write into. */
export interface RuntimeMessageOverlayDeps {
  boxes: Rect[];
  union: Rect | null;
  ancestors: { id: string; name: string | null }[];
  badges: { target: string; n: number; rect: Rect }[];
  badgeTargets: { target: string; n: number }[];
  guides: { orientation: "v" | "h"; position: number }[];
  settling: boolean;
}

/** The active cell-range-selection gesture (§4.1/§4.2) — a `table-cell-*` report reads and writes it directly, never through a setter. */
export interface RuntimeMessageTableRangeDeps {
  current: { tableId: string; range: CellRange } | null;
  anchor: { row: number; col: number } | null;
}

/** Everything about `mountCanvas`'s own top-level session state a runtime message can read or flip, gathered apart from the record-shaped fields above. */
export interface RuntimeMessageSessionDeps {
  isDestroyed(): boolean;
  mode(): CanvasMode;
  setError(message: string): void;
  bumpDragSignal(): void;
  setElementBounds(value: Map<string, { slide: Rect; local: Rect }>): void;
  pendingSelectionIds(): string[] | null;
  stageHandMode(): boolean;
}

/** The in-place text-edit session (decision T1) plus the human-editing lease (T5/NOOP-110) every write-capable report renews. */
export interface RuntimeMessageEditingDeps {
  getEditingState(): TextEditState | null;
  setEditingState(value: TextEditState | null): void;
  enterTextEdit(id: string): Promise<void>;
  commitTextEdit(): Promise<void>;
  beginLease(): void;
  endLease(): void;
  /** `Date.now()` of the last `beginLease()` call — read to throttle renewal to once per `HUMAN_RENEW_THROTTLE_MS`. */
  lastRenewAt(): number;
}

/** Play-mode navigation the runtime's own player-message events (`advance-past-end`, `exit-play`, …) trigger. */
export interface RuntimeMessagePlaybackDeps {
  focusPlayer(): void;
  advancePastEnd(): Promise<void>;
  retreatPastStart(): Promise<void>;
  exitPreview(): void;
  exitPlay(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
}

/** The selection/clipboard/order/undo-redo/chart-window actions a relayed `stage-key`, dblclick, or badge measurement triggers — none of them gesture- or table-specific. */
export interface RuntimeMessageCommandsDeps {
  selectAll(): void;
  deleteSelection(): Promise<void>;
  duplicateSelection(): Promise<void>;
  orderSelection(direction: "up" | "down" | "front" | "back"): Promise<void>;
  undoRedo(kind: "undo" | "redo"): void;
  copySelection(): Promise<string | null>;
  cutSelection(): Promise<string | null>;
  pasteFromText(text: string): Promise<void>;
  closeChartWindow(): void;
  openChartWindow(id: string): void;
  requestBadgeMeasurement(): void;
  clearSelectionState(groupPath: string[]): void;
}

/** The table cell-range gesture's own three entry points (§4.1) — kept apart from `RuntimeMessageCommandsDeps` since none of it is selection/clipboard/order/chart. */
export interface RuntimeMessageTableDeps {
  emitTableEvent(event: TableRuntimeEvent): void;
  setTableRange(value: { tableId: string; range: CellRange } | null): void;
  handleTableRangeKey(key: string, modifiers: { meta: boolean; ctrl: boolean; shift: boolean }): boolean;
}

/** Everything that talks to the sandboxed iframe or converts its coordinates into this parent document's — the seam every stage/embed relay above goes through. */
export interface RuntimeMessageHostDeps {
  postToFrame(message: Record<string, unknown>): void;
  toParentClientPoint(point: { x: number; y: number }): { x: number; y: number };
  toParentClientRect(rect: Rect): Rect;
  emitStageInput(event: StageInputEvent): void;
  emitStageHover(point: { x: number; y: number }): void;
  applyEmbedBoxes(rawItems: unknown): void;
  emitEmbedCommand(rawId: unknown, rawCommand: unknown): void;
}

/** The three ways a runtime message tells the rest of the module its state changed. */
export interface RuntimeMessagePublishDeps {
  notify(): void;
  notifyOverlay(): void;
  pushSelectionToRuntime(ids: readonly string[]): void;
}

/**
 * The fifteen begin/update/end gesture handlers a `gesture-start`/
 * `-move`/`-end` report dispatches to — structurally the same shape
 * `canvas/gestures.ts`'s own `GestureHandlers` exports (minus the two host
 * pointer listeners, which this module never calls), declared again here
 * rather than imported from that module: ADR-0024 forbids one extracted
 * module importing another, so the entry hands over an object satisfying
 * this shape instead of this file naming `canvas/gestures.ts` at all.
 */
export interface RuntimeMessageGestureDeps {
  beginMove(point: { x: number; y: number }): void;
  updateMove(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void;
  endMove(cancelled: boolean): Promise<void>;
  beginScale(point: { x: number; y: number }, corner: "nw" | "ne" | "sw" | "se"): void;
  updateScale(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void;
  endScale(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginRotate(point: { x: number; y: number }): void;
  updateRotate(point: { x: number; y: number }): void;
  endRotate(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginTextboxWidth(point: { x: number; y: number }, handle: "left" | "right"): void;
  updateTextboxWidth(point: { x: number; y: number }): void;
  endTextboxWidth(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginMarquee(point: { x: number; y: number }): void;
  updateMarquee(point: { x: number; y: number }): void;
  endMarquee(point: { x: number; y: number }, cancelled: boolean): void;
}

/**
 * What `canvas/runtime-message-handlers.ts`'s `onWindowMessage`/
 * `handleSelectionMessage` factory needs from the `mountCanvas` closure —
 * declared here (the module it serves, ADR-0024's own convention) and
 * constructed once by the entry. `gestures` is the exact object
 * `canvas/gestures.ts`'s own factory returned — the callback seam that
 * breaks the circularity between gesture handling and runtime-message
 * handling (ADR-0024), since neither extracted module ever imports the
 * other.
 */
export interface RuntimeMessageDeps {
  /** Read-only for dispatch (`event.source` identity check) plus the two player-message fields this handler writes: `viewport` and `playerHasFocus`. */
  frame: { readonly element: HTMLIFrameElement; viewport: Viewport | null; playerHasFocus: boolean };
  selection: { ids: string[]; names: (string | null)[]; groupPath: string[] };
  overlay: RuntimeMessageOverlayDeps;
  tableRange: RuntimeMessageTableRangeDeps;
  /** The one gesture in progress, or `null` between gestures — the same shared slot `canvas/gestures.ts` reads and writes. */
  activeGesture: { get(): ActiveGesture | null; set(value: ActiveGesture | null): void };
  gestures: RuntimeMessageGestureDeps;
  session: RuntimeMessageSessionDeps;
  editing: RuntimeMessageEditingDeps;
  playback: RuntimeMessagePlaybackDeps;
  commands: RuntimeMessageCommandsDeps;
  table: RuntimeMessageTableDeps;
  host: RuntimeMessageHostDeps;
  publish: RuntimeMessagePublishDeps;
}

/** Read directly rather than through a container ref (unlike App.tsx's `isCanvasAreaFullscreen`): this module has no reference to the "well" element `toggleFullscreen()` requests fullscreen on, and the app only ever fullscreens that one element while playing — so "is anything fullscreen at all" answers the same question. */
function isAnyElementFullscreen(): boolean {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
}

/** `onWindowMessage`/`handleSelectionMessage`, wired as one listener the entry registers on `window`. */
export interface RuntimeMessageHandlers {
  onWindowMessage(event: MessageEvent): void;
}

export function createRuntimeMessageHandlers(runtimeMessageDeps: RuntimeMessageDeps): RuntimeMessageHandlers {
  function isScaleHandle(value: unknown): value is "nw" | "ne" | "sw" | "se" {
    return value === "nw" || value === "ne" || value === "sw" || value === "se";
  }

  function isTextboxHandle(value: unknown): value is "left" | "right" {
    return value === "left" || value === "right";
  }
  function onWindowMessage(event: MessageEvent): void {
    if (runtimeMessageDeps.session.isDestroyed()) return;
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
    if (event.source !== runtimeMessageDeps.frame.element.contentWindow) return;

    if (isSelectionMessage(event.data)) {
      // Selection/gesture messages are only ever meaningful in view mode —
      // selection-runtime.js is not even injected into the play-mode
      // srcdoc (wrapPlayDocument), so any of these arriving while
      // mode === "play" can only be a forgery from slide script.
      if (runtimeMessageDeps.session.mode() !== "view") return;
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
    const currentMode = runtimeMessageDeps.session.mode();
    if (currentMode !== "play" && currentMode !== "preview") return;

    const message = event.data;
    if (message.event === "ready") {
      // Entering play mode hands focus to the player (acceptance
      // criterion); "ready" is the runtime's own signal that its listeners
      // are attached and it can actually receive the focus/keydown.
      // Preview never takes focus (D8: the side panel stays interactive
      // while it plays) — the runtime still posts "ready" as the last
      // message of its own boot sequence regardless of mode.
      if (runtimeMessageDeps.session.mode() === "play") runtimeMessageDeps.playback.focusPlayer();
      return;
    }
    if (message.event === "focus") {
      if (runtimeMessageDeps.session.mode() === "play") {
        runtimeMessageDeps.frame.playerHasFocus = Boolean(message.hasFocus);
        runtimeMessageDeps.publish.notify();
      }
      return;
    }
    if (message.event === "error") {
      runtimeMessageDeps.session.setError(message.message ?? "unknown error during playback");
      runtimeMessageDeps.publish.notify();
      return;
    }
    if (message.event === "embed-boxes") {
      runtimeMessageDeps.host.applyEmbedBoxes(message.items);
      return;
    }
    if (message.event === "embed-command") {
      runtimeMessageDeps.host.emitEmbedCommand(message.id, message.command);
      return;
    }
    if (message.event === "advance-past-end") {
      if (runtimeMessageDeps.session.mode() === "play") void runtimeMessageDeps.playback.advancePastEnd();
      return;
    }
    if (message.event === "retreat-past-start") {
      if (runtimeMessageDeps.session.mode() === "play") void runtimeMessageDeps.playback.retreatPastStart();
      return;
    }
    if (message.event === "preview-done") {
      if (runtimeMessageDeps.session.mode() === "preview") runtimeMessageDeps.playback.exitPreview();
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
      if (runtimeMessageDeps.session.mode() === "play" && !isAnyElementFullscreen()) void runtimeMessageDeps.playback.exitPlay();
      return;
    }
  }

  /** Dispatches one already-validated-as-slidra-selection message to the right handler (NOOP-91 §4.1). */
  function handleSelectionMessage(message: SelectionMessage): void {
    if (message.event === "viewport") {
      if (isValidRect(message.svgRect) && isValidRect(message.viewBox)) {
        runtimeMessageDeps.frame.viewport = { svgRect: message.svgRect, viewBox: message.viewBox };
      }
      return;
    }
    if (message.event === "select") {
      const id = typeof message.id === "string" ? message.id : "";
      const name = typeof message.name === "string" ? message.name : null;
      if (message.additive) {
        const index = runtimeMessageDeps.selection.ids.indexOf(id);
        if (index >= 0) {
          runtimeMessageDeps.selection.ids.splice(index, 1);
          runtimeMessageDeps.selection.names.splice(index, 1);
        } else {
          runtimeMessageDeps.selection.ids.push(id);
          runtimeMessageDeps.selection.names.push(name);
        }
      } else {
        runtimeMessageDeps.selection.ids = [id];
        runtimeMessageDeps.selection.names = [name];
      }
      // "select"/"clear" always describe the runtime's FULL current
      // groupPath, never a delta — a missing field means "no group", the
      // same as an explicit `[]` (see selection-runtime.js's withGroupPath).
      runtimeMessageDeps.selection.groupPath = isStringArray(message.groupPath) ? message.groupPath : [];
      runtimeMessageDeps.publish.notify();
      runtimeMessageDeps.publish.pushSelectionToRuntime(runtimeMessageDeps.selection.ids);
      // E2.T14r2 §4.1 lifecycle table: a range only survives while its own
      // table stays the sole selection — any other shape (a different
      // element, no selection, a multi-selection) drops it.
      if (
        runtimeMessageDeps.tableRange.current &&
        (runtimeMessageDeps.selection.ids.length !== 1 || runtimeMessageDeps.selection.ids[0] !== runtimeMessageDeps.tableRange.current.tableId)
      ) {
        runtimeMessageDeps.table.setTableRange(null);
      }
      return;
    }
    if (message.event === "clear") {
      runtimeMessageDeps.commands.clearSelectionState(isStringArray(message.groupPath) ? message.groupPath : []);
      return;
    }
    if (message.event === "drag-enter") {
      // No payload to validate — see selection-runtime.js's dragenter
      // listener: it deliberately sends nothing but the bare event, ADR-0010
      // (the sandboxed slide's own dataTransfer content is never trusted
      // across postMessage).
      runtimeMessageDeps.session.bumpDragSignal();
      runtimeMessageDeps.publish.notify();
      return;
    }
    if (message.event === "group-path") {
      // Esc popping one level (or already at top) while not mid-gesture —
      // selection itself is untouched, only the scope. No handle-flags
      // push needed: which element(s) are selected, and therefore which
      // handles apply, has not changed.
      runtimeMessageDeps.selection.groupPath = isStringArray(message.groupPath) ? message.groupPath : [];
      runtimeMessageDeps.publish.notify();
      return;
    }
    if (message.event === "bounds") {
      const items = Array.isArray(message.items) ? message.items.filter(isBoundsItem) : [];
      runtimeMessageDeps.overlay.boxes = items.map((item) => item.rect);
      runtimeMessageDeps.overlay.union = isNonNegativeRect(message.union) ? message.union : null;
      runtimeMessageDeps.overlay.ancestors = items.length === 1 ? items[0].ancestors : [];
      runtimeMessageDeps.publish.notifyOverlay();
      return;
    }
    if (message.event === "stage-key") {
      if (typeof message.key !== "string") return;
      const modifiers = { meta: Boolean(message.meta), ctrl: Boolean(message.ctrl), shift: Boolean(message.shift) };
      if (message.key === "Delete" || message.key === "Backspace") void runtimeMessageDeps.commands.deleteSelection();
      else if (message.key === "a" && (modifiers.meta || modifiers.ctrl)) runtimeMessageDeps.commands.selectAll();
      else if (message.key === "d" && (modifiers.meta || modifiers.ctrl)) void runtimeMessageDeps.commands.duplicateSelection();
      else if (
        (message.key === "]" || message.key === "}" || message.code === "BracketRight") &&
        (modifiers.meta || modifiers.ctrl)
      )
        void runtimeMessageDeps.commands.orderSelection(modifiers.shift ? "front" : "up");
      else if (
        (message.key === "[" || message.key === "{" || message.code === "BracketLeft") &&
        (modifiers.meta || modifiers.ctrl)
      )
        void runtimeMessageDeps.commands.orderSelection(modifiers.shift ? "back" : "down");
      else if ((message.key === "z" || message.key === "Z") && (modifiers.meta || modifiers.ctrl)) runtimeMessageDeps.commands.undoRedo(modifiers.shift ? "redo" : "undo");
      // F-02: ←/→ paging, relayed here for the same reason every other key
      // in this branch is — App.tsx's own document-level keydown listener
      // for ArrowLeft/ArrowRight never sees a keypress that landed inside
      // this iframe. selection-runtime.js's `isRelayedStageKey` already
      // withholds this while a text edit or gesture is in progress, so no
      // extra guard is needed here (unlike App.tsx's listener, which guards
      // against caret movement in a chat/text field itself instead — that
      // guard has no equivalent inside this iframe because a real DOM
      // textarea there also owns `editingId`, the same thing the relay
      // already checks).
      else if (message.key === "ArrowLeft") void runtimeMessageDeps.playback.previous();
      else if (message.key === "ArrowRight") void runtimeMessageDeps.playback.next();
      // Plan §3.8/A0: the same async `navigator.clipboard` logic as
      // App.tsx's keydown handler, just triggered by the relayed
      // "stage-key" from focus inside the iframe rather than the parent
      // document's own keydown — the two paths call the same set of
      // controller methods, so they never drift apart.
      else if (message.key === "c" && (modifiers.meta || modifiers.ctrl)) {
        void runtimeMessageDeps.commands.copySelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
      } else if (message.key === "x" && (modifiers.meta || modifiers.ctrl)) {
        void runtimeMessageDeps.commands.cutSelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
      } else if (message.key === "v" && (modifiers.meta || modifiers.ctrl)) {
        void navigator.clipboard.readText().then((text) => runtimeMessageDeps.commands.pasteFromText(text));
      }
      // E2.T12 plan §4.5: Esc closes the chart data window — relayed here
      // because opening it (a double-click on the slide) leaves focus
      // inside this sandboxed iframe, where the parent document's own
      // `window` keydown listener (ChartWindow.tsx) never sees the
      // keypress at all (same reason ⌘Z/Delete/etc. above need relaying).
      else if (message.key === "Escape") runtimeMessageDeps.commands.closeChartWindow();
      return;
    }
    if (message.event === "gesture-start") {
      if (!isValidPoint(message.point)) return;
      if (message.kind === "move") runtimeMessageDeps.gestures.beginMove(message.point);
      else if (message.kind === "marquee") runtimeMessageDeps.gestures.beginMarquee(message.point);
      else if (message.kind === "scale" && isScaleHandle(message.handle)) runtimeMessageDeps.gestures.beginScale(message.point, message.handle);
      else if (message.kind === "rotate") runtimeMessageDeps.gestures.beginRotate(message.point);
      else if (message.kind === "textbox-width" && isTextboxHandle(message.handle)) runtimeMessageDeps.gestures.beginTextboxWidth(message.point, message.handle);
      // Marquee never writes to the file, so it never contends with the
      // agent for the editing lock (T5/NOOP-110) — only the four
      // write-capable gestures take a human lease.
      if (message.kind !== "marquee") runtimeMessageDeps.editing.beginLease();
      return;
    }
    if (message.event === "gesture-move") {
      if (!isValidPoint(message.point)) return;
      const modifiers = { shift: Boolean(message.modifiers?.shift), alt: Boolean(message.modifiers?.alt) };
      const activeGesture = runtimeMessageDeps.activeGesture.get();
      if (activeGesture?.kind === "move") runtimeMessageDeps.gestures.updateMove(message.point, modifiers);
      else if (activeGesture?.kind === "marquee") runtimeMessageDeps.gestures.updateMarquee(message.point);
      else if (activeGesture?.kind === "scale") runtimeMessageDeps.gestures.updateScale(message.point, modifiers);
      else if (activeGesture?.kind === "rotate") runtimeMessageDeps.gestures.updateRotate(message.point);
      else if (activeGesture?.kind === "textbox-width") runtimeMessageDeps.gestures.updateTextboxWidth(message.point);
      if (
        activeGesture &&
        activeGesture.kind !== "marquee" &&
        Date.now() - runtimeMessageDeps.editing.lastRenewAt() >= HUMAN_RENEW_THROTTLE_MS
      ) {
        runtimeMessageDeps.editing.beginLease();
      }
      return;
    }
    if (message.event === "gesture-end") {
      if (!isValidPoint(message.point)) {
        // No usable endpoint at all: still tear the gesture down rather
        // than leaving a stale preview and a phantom activeGesture around.
        const current = runtimeMessageDeps.activeGesture.get();
        const wasLeaseHolder = current !== null && current.kind !== "marquee";
        runtimeMessageDeps.activeGesture.set(null);
        if (wasLeaseHolder) runtimeMessageDeps.editing.endLease();
        return;
      }
      const cancelled = Boolean(message.cancelled);
      const gesture = runtimeMessageDeps.activeGesture.get();
      // Keep the context bar hidden through the gesture's tail: the end
      // handlers null `activeGesture` and notify the overlay *before* their
      // command round-trips, and a committed write then reloads the slide.
      // `settle` lifts it only when no reload is coming (cancelled, no-op,
      // or failed — nothing was parked in pendingSelectionIds); otherwise
      // render()/selectOnceLoaded clear it once the re-selection has landed.
      if (gesture && gesture.kind !== "marquee") runtimeMessageDeps.overlay.settling = true;
      const settle = () => {
        if (runtimeMessageDeps.session.pendingSelectionIds() === null && runtimeMessageDeps.activeGesture.get() === null) {
          runtimeMessageDeps.overlay.settling = false;
          runtimeMessageDeps.publish.notifyOverlay();
        }
        runtimeMessageDeps.editing.endLease();
      };
      if (gesture?.kind === "move") void runtimeMessageDeps.gestures.endMove(cancelled).then(settle);
      else if (gesture?.kind === "marquee") runtimeMessageDeps.gestures.endMarquee(message.point, cancelled);
      else if (gesture?.kind === "scale") void runtimeMessageDeps.gestures.endScale(message.point, cancelled).then(settle);
      else if (gesture?.kind === "rotate") void runtimeMessageDeps.gestures.endRotate(message.point, cancelled).then(settle);
      else if (gesture?.kind === "textbox-width") void runtimeMessageDeps.gestures.endTextboxWidth(message.point, cancelled).then(settle);
      // activeGesture is already null (e.g. a stray gesture-end with no
      // matching start) — still release the lease so it does not sit until
      // HUMAN_LEASE_MAX_MS expires.
      else runtimeMessageDeps.editing.endLease();
      return;
    }
    if (message.event === "dblclick-textbox") {
      if (typeof message.id === "string") void runtimeMessageDeps.editing.enterTextEdit(message.id);
      return;
    }
    if (message.event === "dblclick-chart") {
      if (typeof message.id === "string") runtimeMessageDeps.commands.openChartWindow(message.id);
      return;
    }
    if (message.event === "text-edit-input") {
      const editingState = runtimeMessageDeps.editing.getEditingState();
      if (!editingState || message.id !== editingState.id) return;
      // Decision T1: no repaint round trip any more — the runtime already
      // repainted itself before sending this report (its own `input`
      // handler). This side only mirrors the string for commitTextEdit.
      editingState.currentText = typeof message.text === "string" ? message.text : "";
      return;
    }
    if (message.event === "text-edit-commit") {
      const editingState = runtimeMessageDeps.editing.getEditingState();
      if (!editingState || message.id !== editingState.id) return;
      void runtimeMessageDeps.editing.commitTextEdit();
      return;
    }
    if (message.event === "text-edit-denied") {
      // The runtime's own lock check rejected a host-initiated
      // begin-text-edit (defense in depth — the dblclick path never even
      // reaches here, since findSelectable already refuses to resolve a
      // locked element to a click target). No error: this mirrors the
      // silent "don't enter edit mode" the dblclick path gives a locked box.
      const editingState = runtimeMessageDeps.editing.getEditingState();
      if (editingState && editingState.id === message.id) {
        runtimeMessageDeps.editing.endLease();
        runtimeMessageDeps.editing.setEditingState(null);
      }
      return;
    }
    if (message.event === "stage-wheel") {
      if (!isValidPoint(message.point) || !isFiniteNumber(message.deltaX) || !isFiniteNumber(message.deltaY)) return;
      const point = runtimeMessageDeps.host.toParentClientPoint(message.point);
      if (message.zoomModifier) runtimeMessageDeps.host.emitStageInput({ type: "wheel-zoom", point, deltaY: message.deltaY });
      else runtimeMessageDeps.host.emitStageInput({ type: "wheel-pan", deltaX: message.deltaX, deltaY: message.deltaY });
      return;
    }
    if (message.event === "stage-pan-start") {
      if (!isValidPoint(message.point)) return;
      runtimeMessageDeps.host.emitStageInput({ type: "pan-start", point: runtimeMessageDeps.host.toParentClientPoint(message.point) });
      return;
    }
    if (message.event === "stage-pan-move") {
      if (!isValidPoint(message.point)) return;
      runtimeMessageDeps.host.emitStageInput({ type: "pan-move", point: runtimeMessageDeps.host.toParentClientPoint(message.point) });
      return;
    }
    if (message.event === "stage-pan-end") {
      runtimeMessageDeps.host.emitStageInput({ type: "pan-end" });
      return;
    }
    if (message.event === "stage-space") {
      runtimeMessageDeps.host.emitStageInput({ type: message.down ? "space-down" : "space-up" });
      return;
    }
    if (message.event === "stage-hover") {
      if (!isValidPoint(message.point)) return;
      runtimeMessageDeps.host.emitStageHover(runtimeMessageDeps.host.toParentClientPoint(message.point));
      return;
    }
    if (message.event === "runtime-ready") {
      // A fresh srcdoc (slide change) starts its own copy of
      // selection-runtime.js with `stageHandMode = false` — re-push this
      // side's last-known value so hand/grab mode does not silently drop on
      // every slide change (§2.1(c)).
      runtimeMessageDeps.host.postToFrame({ command: "stage-mode", hand: runtimeMessageDeps.session.stageHandMode() });
      // [E2.T7]/D9: a fresh document has never been asked to measure
      // anything — re-request the current slide's badge targets so the
      // overlay is not stuck showing the PREVIOUS slide's badge positions.
      runtimeMessageDeps.commands.requestBadgeMeasurement();
      return;
    }
    if (message.event === "embed-boxes") {
      runtimeMessageDeps.host.applyEmbedBoxes(message.items);
      return;
    }
    if (message.event === "measured") {
      const items = Array.isArray(message.items) ? message.items.filter(isMeasuredItem) : [];
      const rectByTarget = new Map(items.map((item) => [item.id, item.rect]));
      runtimeMessageDeps.overlay.badges = runtimeMessageDeps.overlay.badgeTargets.flatMap((entry) => {
        const rect = rectByTarget.get(entry.target);
        return rect ? [{ target: entry.target, n: entry.n, rect: runtimeMessageDeps.host.toParentClientRect(rect) }] : [];
      });
      runtimeMessageDeps.publish.notifyOverlay();
      return;
    }
    if (message.event === "element-bounds") {
      const items = Array.isArray(message.items) ? message.items.filter(isElementBoundsItem) : [];
      runtimeMessageDeps.session.setElementBounds(new Map(items.map((item) => [item.id, { slide: item.rect, local: item.local }])));
      return;
    }
    if (message.event === "table-cell-click") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col)) {
        const row = message.row;
        const col = message.col;
        runtimeMessageDeps.table.emitTableEvent({ type: "cell-click", id, row, col, additive: Boolean(message.additive) });
        // E2.T14r2 §4.1 lifecycle table: a ⇧-click while a range is already
        // active on THIS table extends it from the stored anchor; anything
        // else (plain click, or a ⇧-click that arrives with no anchor of
        // its own — e.g. right after a table id change already cleared it
        // above) starts a fresh single-cell range and a fresh anchor.
        if (message.additive && runtimeMessageDeps.tableRange.anchor && runtimeMessageDeps.tableRange.current && runtimeMessageDeps.tableRange.current.tableId === id) {
          runtimeMessageDeps.table.setTableRange({ tableId: id, range: normalizeRange(runtimeMessageDeps.tableRange.anchor, { row, col }) });
        } else {
          runtimeMessageDeps.tableRange.anchor = { row, col };
          runtimeMessageDeps.table.setTableRange({ tableId: id, range: { r0: row, c0: col, r1: row, c1: col } });
        }
      }
      return;
    }
    if (message.event === "table-cell-dblclick") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col)) {
        runtimeMessageDeps.table.emitTableEvent({ type: "cell-dblclick", id, row: message.row, col: message.col, atRow: isFiniteNumber(message.atRow) ? message.atRow : message.row });
      }
      return;
    }
    if (message.event === "table-cell-contextmenu") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id !== null && isFiniteNumber(message.row) && isFiniteNumber(message.col) && isFiniteNumber(message.x) && isFiniteNumber(message.y)) {
        const row = message.row;
        const col = message.col;
        const point = runtimeMessageDeps.host.toParentClientPoint({ x: message.x, y: message.y });
        runtimeMessageDeps.table.emitTableEvent({ type: "cell-contextmenu", id, row, col, x: point.x, y: point.y });
        // §4.1 lifecycle table: right-clicking inside the current range
        // leaves it untouched (the menu acts on the whole range); right-
        // clicking outside it starts a fresh single-cell range/anchor.
        const cell = { row, col };
        if (!runtimeMessageDeps.tableRange.current || runtimeMessageDeps.tableRange.current.tableId !== id || !isCellInRange(cell, runtimeMessageDeps.tableRange.current.range)) {
          runtimeMessageDeps.tableRange.anchor = cell;
          runtimeMessageDeps.table.setTableRange({ tableId: id, range: { r0: row, c0: col, r1: row, c1: col } });
        }
      }
      return;
    }
    if (message.event === "table-cells") {
      const id = typeof message.id === "string" ? message.id : null;
      const cells = Array.isArray(message.cells) ? message.cells.filter(isTableCellRectItem) : [];
      const box = isNonNegativeRect(message.box) ? message.box : null;
      if (id !== null && box !== null) {
        runtimeMessageDeps.table.emitTableEvent({
          type: "cells",
          id,
          cells: cells.map((cell) => ({ ...cell, rect: runtimeMessageDeps.host.toParentClientRect(cell.rect) })),
          box: runtimeMessageDeps.host.toParentClientRect(box),
        });
      }
      return;
    }
    if (message.event === "table-key") {
      if (typeof message.key !== "string") return;
      // The runtime only ever sends this while its own `tableRangeId` flag
      // is set (§4.2) — `handleTableRangeKey` re-derives everything else
      // (which range, which table) from this module's own `tableRange.current`, the
      // single source of truth both input paths share.
      runtimeMessageDeps.table.handleTableRangeKey(message.key, { meta: Boolean(message.meta), ctrl: Boolean(message.ctrl), shift: Boolean(message.shift) });
      return;
    }
  }

  return { onWindowMessage };
}
