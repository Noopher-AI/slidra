// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-275/#156: how far a Ribbon paste (`element paste`) shifts the pasted
 * copy from its source, in SVG user-space units (the canvas viewBox is
 * 1280x720). Fixed and identical for dx/dy — not user-configurable, not
 * capped, not wrapped back into the canvas. 20 is about 1.6% of the canvas
 * width, which stays visible even at typical on-screen zoom without pushing
 * pasted elements off the slide.
 */
export const PASTE_OFFSET_STEP = 20;

/**
 * Tracks enough about the last copy/cut and the last paste to decide the
 * next paste's offset. Lives in the caller (App.tsx), one instance per
 * editor session — this module only computes transitions over it.
 */
export interface PasteOffsetState {
  /** The slide the clipboard's contents were copied/cut from. `null` when unknown (e.g. the clipboard predates this session). */
  sourceSlidePath: string | null;
  /** The slide the previous paste landed on. `null` before the first paste. */
  lastTargetSlidePath: string | null;
  /** How many times in a row a paste has landed on `lastTargetSlidePath`. */
  count: number;
}

export const INITIAL_PASTE_OFFSET_STATE: PasteOffsetState = {
  sourceSlidePath: null,
  lastTargetSlidePath: null,
  count: 0,
};

/** A copy/cut just wrote new clipboard contents from `sourceSlidePath` — resets the paste-offset run. */
export function clipboardWritten(sourceSlidePath: string): PasteOffsetState {
  return { sourceSlidePath, lastTargetSlidePath: null, count: 0 };
}

/**
 * The dx/dy the next paste onto `targetSlidePath` should use, plus the state
 * to carry into the paste after that.
 *
 * - Pasting onto a different slide than both the source and the last paste
 *   target resets the run to 0 steps, so dx/dy are 0 and the new element
 *   lands at exactly the copied coordinates (A4).
 * - Pasting again onto the same target slide advances the run, so each
 *   paste in a row lands `PASTE_OFFSET_STEP` further than the last (A3).
 * - The very first paste back onto the source slide also gets one step of
 *   offset rather than 0 — otherwise it would land exactly on top of the
 *   element it was copied from and look like paste did nothing.
 */
export function nextPasteOffset(
  state: PasteOffsetState,
  targetSlidePath: string,
): { dx: number; dy: number; next: PasteOffsetState } {
  const carriedCount = targetSlidePath === state.lastTargetSlidePath ? state.count : 0;
  const sourceStep = targetSlidePath === state.sourceSlidePath ? 1 : 0;
  const offset = (carriedCount + sourceStep) * PASTE_OFFSET_STEP;
  return {
    dx: offset,
    dy: offset,
    next: {
      sourceSlidePath: state.sourceSlidePath,
      lastTargetSlidePath: targetSlidePath,
      // Deliberately carries carriedCount, not carriedCount + sourceStep:
      // sourceStep is a one-time correction re-applied on every read (via
      // the sourceSlidePath comparison above), not something to compound
      // into the running count — otherwise consecutive pastes back onto
      // the source slide would double-count it (20, 60, 100, ... instead
      // of the intended 20, 40, 60, ...).
      count: carriedCount + 1,
    },
  };
}
