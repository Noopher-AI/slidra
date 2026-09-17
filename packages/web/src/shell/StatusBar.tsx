// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { CanvasController, CanvasState } from "../canvas.js";
import { Icon } from "../icons/index.js";

export interface StatusBarProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * The status bar (New v3 skeleton): only lists "selection chip, keyboard
 * shortcut hints, page number" per the design doc — the old shell's three
 * view-switch buttons (Standard/Grid/Play) have no counterpart here anymore:
 * grid view is dropped entirely (GridView has been deleted), and play is
 * now entered via TitleBar's ▶Play (see TitleBar.tsx). The ‹ › page-nav
 * buttons and the selection name keep the old shell's existing class/
 * aria-label contract (selection.test.ts / direct-manipulation.test.ts /
 * locked-element.test.ts test canvas.ts/iframe-runtime's own selection
 * semantics — this only renamed the outer container's class, without
 * touching the computation logic).
 */
export function StatusBar({ state, controller }: StatusBarProps) {
  const slideCount = state.slides.length;
  const hasSlides = slideCount > 0;

  // Shows data-slidra-name (ADR-0007) if present, otherwise falls back to
  // id; a multi-selection shows a count.
  const selectionCount = state.selection.ids.length;
  const selectionLabel =
    selectionCount === 0
      ? null
      : selectionCount === 1
        ? (state.selection.names[0] ?? state.selection.ids[0])
        : `${selectionCount} elements`;

  return (
    <footer className="status status-bar">
      <span className="status-selection-chip">{selectionLabel !== null && <>Selected: <b>{selectionLabel}</b></>}</span>
      <span className="status-hints">
        ← → slides · ⇧click multi-select · double-click to edit · ⌘Z undo · ⌘D duplicate · right-click for more
      </span>
      <span className="spacer" />
      <span className="status-page">
        <button
          type="button"
          className="slide-nav-button"
          aria-label="Previous slide"
          disabled={!hasSlides || state.currentIndex <= 0}
          onClick={() => void controller?.previous()}
        >
          <Icon name="prev" size="inline" />
        </button>
        <span className="slide-nav-position">
          {hasSlides ? (
            <>
              Slide <b>{state.currentIndex + 1}</b> of {slideCount}
            </>
          ) : (
            "No slides"
          )}
        </span>
        <button
          type="button"
          className="slide-nav-button"
          aria-label="Next slide"
          disabled={!hasSlides || state.currentIndex >= slideCount - 1}
          onClick={() => void controller?.next()}
        >
          <Icon name="next" size="inline" />
        </button>
      </span>
    </footer>
  );
}
