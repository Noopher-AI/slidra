// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Rect } from "../geometry.js";
import type { Effect, SlideTransition } from "../effects.js";
import type { ActiveGesture, Viewport } from "./gesture-geometry.js";
import type { StageEmbedEntry } from "../player-plan.js";
import type { CanvasMode } from "../canvas.js";

/** `mode`/`exiting`/`error` — the three primitive session fields play/preview navigation reads and flips, each needing get+set since they are reassigned wholesale rather than mutated in place. */
export interface PlayModeSessionDeps {
  isDestroyed(): boolean;
  mode: { get(): CanvasMode; set(value: CanvasMode): void };
  exiting: { get(): boolean; set(value: boolean): void };
  error: { get(): string | null; set(value: string | null): void };
}

/** The current slide's transition (read by `playExitTransition`, written by `renderPlay` once a plan resolves) and its effect list (reset, never read, on every mode/page change — `render()` in the entry is the only reader). */
export interface PlayModeSlideStateDeps {
  pageTransition: { get(): SlideTransition; set(value: SlideTransition): void };
  setSlideEffects(effects: Effect[]): void;
}

/** The two "carry this selection across the next repaint" seams play/preview transitions use — `pendingSelectionIds` (render()'s own consumption side) is write-only here, `previewReturnSelectionIds` is read back once Preview ends. */
export interface PlayModeSelectionStateDeps {
  setPendingSelectionIds(ids: string[] | null): void;
  previewReturnSelectionIds: { get(): string[] | null; set(value: string[] | null): void };
}

/** The four ways a play/preview transition tells the rest of the module its state changed. */
export interface PlayModePublishDeps {
  notify(): void;
  notifyOverlay(): void;
  notifyChartWindow(): void;
  notifyEmbeds(): void;
}

/**
 * What `renderPlay`, `playExitTransition`, `showSlide`, `next`, `previous`,
 * `play`, `exitPlay`, `previewEffects`, `exitPreview`, `focusPlayer`,
 * `stepPlayer`, and `rebuildFrame` read and write off the rest of the
 * `mountCanvas` closure — declared here (the module they would eventually
 * move into, ADR-0024's own convention) even though this ticket moves none
 * of them. Its measured field count is the number a human decides
 * [S10.F4] on (see the pull request body's headline table).
 */
export interface PlayModeDeps {
  frame: {
    element: HTMLIFrameElement;
    generation: number;
    paintedView: { slidePath: string; key: string } | null;
    paintedPlay: { slidePath: string; key: string } | null;
    viewport: Viewport | null;
    playerHasFocus: boolean;
  };
  selection: { ids: string[]; names: (string | null)[]; groupPath: string[] };
  /** Reset to `null` on every mode/page change — the same shared slot `canvas/gestures.ts` and `canvas/runtime-message-handlers.ts` read and write. */
  activeGesture: { get(): ActiveGesture | null; set(value: ActiveGesture | null): void };
  overlay: {
    boxes: Rect[];
    union: Rect | null;
    ancestors: { id: string; name: string | null }[];
    guides: { orientation: "v" | "h"; position: number }[];
    badgeTargets: { target: string; n: number }[];
    badges: { target: string; n: number; rect: Rect }[];
  };
  chartWindow: { target: string | null };
  embeds: { entries: Record<string, StageEmbedEntry>; boxes: Record<string, Rect> };
  /** `rebuildFrame`'s own `container.insertBefore` — the DOM node React handed `mountCanvas`, never reassigned. */
  container: HTMLElement;
  deck: {
    slides(): readonly string[];
    currentIndex(): number;
    setCurrentIndex(index: number): void;
  };
  session: PlayModeSessionDeps;
  slideState: PlayModeSlideStateDeps;
  selectionState: PlayModeSelectionStateDeps;
  publish: PlayModePublishDeps;
  /** Commits the in-place text edit in progress, a no-op when none is open (decision T1) — the entry checks `editingState` itself before deciding whether there is anything to commit. */
  commitTextEditIfEditing(): void;
  /**
   * The view-mode paint path, called directly by `showSlide`/`exitPlay`/
   * `exitPreview` when a transition lands back in view mode. Deliberately
   * NOT absorbed into this interface as its own dependency object:
   * `render()` and `selectionColors()` stay in the entry (see the pull
   * request body's own finding on the three real call sites this callback
   * represents) — this field is the seam, not an invitation to inline
   * `render()`'s body here.
   */
  render(thisGeneration: number): Promise<void>;
}
