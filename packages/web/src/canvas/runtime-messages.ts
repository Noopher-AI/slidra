// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Rect } from "../geometry.js";

/** Message shapes the runtime sends (C4 in the design doc). */
interface PlayerMessage {
  source: "slidra-player";
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

function isPlayerMessage(data: unknown): data is PlayerMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "slidra-player" &&
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
  source: "slidra-selection";
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
    // §4: stage navigation relay (an approved expansion of scope).
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
    // The runtime's own pointermove, reported whenever nothing
    // else (a gesture, a stage-pan, a text-select drag) is already consuming
    // the pointer and at least one element is selected — the parent uses
    // this (plus its own `window.mousemove` for the area outside the
    // iframe) to decide whether the context bar's hover-solidify state
    // should switch. `point` is iframe-local client px, converted the same
    // way as the stage-pan/-wheel points above.
    | "stage-hover"
    // §4.6: precise per-selected-element bounding boxes plus
    // each one's ancestor chain, replacing the old host-computed "guides"
    // approach (ADR-0011 amend) — the runtime measures with
    // `getBoundingClientRect()`, this side only converts coordinate spaces.
    | "bounds"
    // §4.5: right-click on an element (never on blank canvas —
    // out of scope).
    // §4.4: the keyboard relay for shortcuts that must work even
    // when focus is inside the iframe.
    | "stage-key"
    // Sent once, after the runtime's listeners are attached (§2.1(c)) —
    // carries no payload of its own.
    | "runtime-ready"
    // The reply to a host-issued `measure` command — bounds for
    // an arbitrary id list (the current slide's animation badge targets),
    // independent of `selectedIds`.
    | "measured"
    // Every id-carrying element's bounding box,
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

/** One `element-bounds` event item (decision G1) — `rect`: full container-chain box in the slide's own coordinate system (`elementBounds`'s old output space); `local`: the element's own bbox before its own transform. */
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
    (data as { source?: unknown }).source === "slidra-selection" &&
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

export type { PlayerMessage, SelectionMessage, BoundsItem, MeasuredItem, ElementBoundsItem, TableCellRectItem };
export { isPlayerMessage, isSelectionMessage, isAncestorList, isNonNegativeRect, isBoundsItem, isMeasuredItem, isElementBoundsItem, isTableCellRectItem, isFiniteNumber, isValidPoint, isValidRect, isStringArray };
