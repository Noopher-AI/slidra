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
