// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Rect, Matrix } from "../geometry.js";
import type { SlideElement, SlideModel } from "../slide-dom.js";
import type { ActiveGesture, Viewport } from "./gesture-geometry.js";

/**
 * Everything the move/scale/rotate/textbox-width/marquee gesture functions
 * read off the current slide — grouped apart from `GestureDeps`'s other
 * fields because every member here is about resolving "what's on the slide
 * right now", never about the gesture's own in-progress state.
 */
export interface GestureSlideDeps {
  /** `slides[currentIndex]` — the slide path a committed gesture's command targets. */
  slidePath(): string;
  currentSlideModel(): SlideModel | null;
  elementIndex(): Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>;
  /** `id`'s full container-chain bounds, off the runtime's last `element-bounds` report. */
  computeBounds(id: string): Rect | null;
  /** The runtime's last-reported per-id bounding boxes — read directly (not through `computeBounds`) by the scale gesture's non-uniform resize anchor lookup. */
  elementBoundsById: ReadonlyMap<string, { slide: Rect; local: Rect }>;
}

/** The human-editing-lease throttle (T5/NOOP-110) a committed drag/scale/rotate/textbox-width gesture renews as it goes. */
export interface GestureEditingLeaseDeps {
  begin(): void;
  end(): void;
  /** `Date.now()` of the last `begin()` call — read to throttle renewal to once per `HUMAN_RENEW_THROTTLE_MS`. */
  lastRenewAt(): number;
}

/** The "keep the selection across the reload a committed write triggers" seam (render()'s own `pendingSelectionIds`). */
export interface GesturePendingSelectionDeps {
  keepAcrossReload(): void;
  pendingSelectionIds(): string[] | null;
}

/** The three ways a gesture tells the rest of the module its state changed. */
export interface GesturePublishDeps {
  notify(): void;
  notifyOverlay(): void;
  pushSelectionToRuntime(ids: readonly string[]): void;
}

/**
 * The five frame/viewport coordinate-conversion helpers every gesture kind
 * uses — kept as a single field, rather than moved into `gestures.ts`
 * alongside the gesture functions themselves, to stay under this module's
 * 900-line cap without splitting them into a second file of their own.
 */
export interface GestureCoordsDeps {
  /** Host document client px -> iframe-local client px (NOOP-382's move-gesture boundary-crossing fallback). */
  toFrameClientPoint(point: { x: number; y: number }): { x: number; y: number };
  /** iframe-local client px -> this slide's user units, via the runtime's last-reported viewport mapping. */
  toUserPoint(point: { x: number; y: number }): { x: number; y: number };
  userXToClient(x: number): number;
  userYToClient(y: number): number;
  offsetUnion(rects: readonly Rect[], dx: number, dy: number): Rect;
}

/**
 * What `canvas/gestures.ts`'s move/scale/rotate/textbox-width/marquee
 * factory needs from the `mountCanvas` closure — declared here (the module
 * it serves, ADR-0024's own convention) and constructed once by the entry.
 * Circularity with the rest of the closure is broken by these callback
 * fields, never by an import in the other direction.
 */
export interface GestureDeps {
  /** The one gesture in progress, or `null` between gestures — a single shared slot, also read by `canvas/runtime-message-handlers.ts`. */
  activeGesture: { get(): ActiveGesture | null; set(value: ActiveGesture | null): void };
  /** Read-only for gesture purposes: the runtime's last-reported viewport mapping and the race-guard generation counter. */
  frame: { readonly viewport: Viewport | null; readonly generation: number };
  selection: { ids: string[]; names: (string | null)[]; groupPath: string[] };
  /** Only the two fields a gesture itself paints: snap guides and the drag/settle flag. */
  overlay: { guides: { orientation: "v" | "h"; position: number }[]; settling: boolean };
  slide: GestureSlideDeps;
  editingLease: GestureEditingLeaseDeps;
  pendingSelection: GesturePendingSelectionDeps;
  publish: GesturePublishDeps;
  coords: GestureCoordsDeps;
  toParentClientPoint(point: { x: number; y: number }): { x: number; y: number };
  postToFrame(message: Record<string, unknown>): void;
  postCommand(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }>;
  setError(message: string): void;
  isDestroyed(): boolean;
}
