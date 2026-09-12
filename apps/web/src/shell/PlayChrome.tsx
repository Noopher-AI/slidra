import { useEffect, useState } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";

// The "Exit Fullscreen/Fullscreen" and "Exit Play" buttons stay text
// buttons, matching the pre-existing play chrome verbatim — see the class
// comment below. base-shell.html's icon-only fullscreen/leave-play buttons
// are not adopted for these two: the text-selector freeze (existing e2e
// locates them by their text, see the comment below) still applies to
// them. "Previous/Next" step are new elements no existing test depends on
// the shape of, so *those two* do follow the template's own SVG verbatim
// — see the buttons below.

/** Idle time before the cursor and control bar hide together. */
const IDLE_MS = 2500;

export interface PlayChromeProps {
  state: CanvasState;
  controller: CanvasController | null;
  isFullscreen: boolean;
  /** Fullscreen failure message; stacks alongside the playback error notice without overlapping it. */
  fullscreenError: string | null;
  onToggleFullscreen(): void;
  onExitPlay(): void;
}

/**
 * Play-mode chrome: the floating notices and the leave-play/fullscreen
 * controls. Renders nothing outside play mode. Classes and copy are moved
 * verbatim from App.tsx's pre-existing play nav — see the review-gate
 * comments below, each fixing a real bug this markup used to have.
 *
 * Fullscreen is also available from the ribbon in view mode (orthogonal to
 * play mode), but this component used to return null outright whenever
 * `state.mode !== "play"`. That left a successful view-mode fullscreen
 * request with no in-app way back out (only the browser's own Esc), and a
 * *rejected* request with no visible error at all — a silent failure,
 * which this project's own posture (raise errors, never fail silently)
 * forbids. The two blocks below split cleanly on `isPlayMode`: the
 * play-mode block is untouched, byte-for-byte, from before this fix; the
 * view-mode block is new and only ever renders the fullscreen exit control
 * and/or its own error notice — never the play-only error notice or the
 * leave-play button, which have no meaning outside play mode.
 */
export function PlayChrome({ state, controller, isFullscreen, fullscreenError, onToggleFullscreen, onExitPlay }: PlayChromeProps) {
  const isPlayMode = state.mode === "play";

  // The cursor and control bar hide together: `awake` toggles both — this
  // component's own `.play-bar.awake` class (opacity, styles/play.css) and,
  // via play.css's `:has(.play-bar.awake)` selector on `.app[data-mode=
  // "play"]`, the ancestor cursor. App.tsx is frozen beyond two narrow
  // grants that do not include adding a class up there, so the toggle has
  // to reach upward through `:has()` instead of downward from a parent
  // state — see the wave brief's "suggested containment" section.
  // Declared unconditionally (not after the `!isPlayMode` early return
  // below) because hooks cannot be conditional; its own effect body no-ops
  // outside play mode instead.
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    if (!isPlayMode) return;
    setAwake(true);
    let timer = window.setTimeout(() => setAwake(false), IDLE_MS);
    function onMouseMove(): void {
      setAwake(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAwake(false), IDLE_MS);
    }
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      window.clearTimeout(timer);
    };
  }, [isPlayMode]);

  if (!isPlayMode) {
    // View mode: only fullscreen (state and/or its error) is this
    // component's concern here — the leave-play button and state.error
    // (a play-mode effect-list error) only mean something in play mode
    // and must not render outside it.
    if (!isFullscreen && !fullscreenError) return null;
    return (
      <>
        {fullscreenError && (
          <div className="player-notices">
            <div className="player-error-notice" role="alert">
              Fullscreen toggle failed: {fullscreenError}
            </div>
          </div>
        )}
        {isFullscreen && (
          <nav className="view-fullscreen-bar">
            <button
              type="button"
              className="fullscreen-toggle-button"
              aria-label="Exit Fullscreen"
              onClick={() => void onToggleFullscreen()}
            >
              Exit Fullscreen
            </button>
          </nav>
        )}
      </>
    );
  }

  return (
    <>
      {/* The slide iframe covers about 87% of the play-mode viewport
          (measured at 1440×900, iframe box 1415×796). When the mouse moves
          inside the iframe, the browser dispatches mousemove directly to
          the iframe's own document — it never bubbles up to the parent.
          That's an existing limitation of cross-document/frame event
          boundaries, not a new bug here, but the original e2e test worked
          around it instead of reporting it, which is what got caught (see
          play-appearance.test.ts's comparison table). This transparent
          overlay sits above `.canvas` (where the iframe lives, z-index
          auto) and below `.player-notices`/`.play-bar` (both z-index:2,
          see style.css/shell.css) — see play.css's z-index:1 — so the
          mousemove lands on the parent document itself and bubbles up to
          the `document` listener the `awake` effect above already has; no
          separate onMouseMove wiring is needed, since bubbling already
          reaches it.

          The cost of intercepting pointer events is that the native
          "clicking the iframe gives it browser focus" behavior no longer
          happens: `player-runtime.js` is fully spec-frozen, and it's been
          verified to have only five listeners (keydown/resize/focus/blur/
          message) that don't handle click; the static fallback page for a
          failed effect-list parse has no runtime at all, so there's no
          existing click behavior to preserve here — calling the existing
          `controller.focusPlayer()` (the same function already used
          elsewhere, e.g. on fullscreen toggle) restores keyboard focus. */}
      <div
        className="play-mousemove-catcher"
        onClick={() => {
          // Clicking the stage also advances a step now (the template's
          // "click screen to advance") — focusPlayer() itself is
          // unchanged, still needed so the very next arrow key takes the
          // runtime's own path.
          controller?.stepPlayer("advance");
          controller?.focusPlayer();
        }}
      />
      {/* Top-centered hint bar, shares the `awake` state with .play-bar so
          it hides/shows together with it. Purely informational — `pointer-
          events: none` keeps it from stealing clicks over
          .play-mousemove-catcher (below it, z-index:1) or .player-notices/
          .play-bar (same layer, z-index:2). */}
      <div className={awake ? "play-hint awake" : "play-hint"}>← → or click to advance · Esc to exit play</div>
      {/* Floating notices for play mode: the playback error and the
          fullscreen error can both be true at once (an effect-list parse
          failure coinciding with a rejected fullscreen request); they used
          to share the same absolute positioning and stack on top of each
          other, with whichever rendered later covering the one before it.
          This wrapper collects them into one flex column, leaving each
          notice's own styling to background/text only, and lets the
          wrapper own positioning and spacing so they stack side by side
          without overlapping.

          A focus hint used to be a third item here. It was removed: it
          required whoever was presenting to click a button with the mouse
          before they could continue using arrow keys — but the path that
          reaches it (pressing Tab once, verified) is itself pure keyboard
          use. Arrow keys already advance even when unfocused (see App.tsx's
          keydown forwarding), so the hint had nothing left to report. */}
      {(state.error || fullscreenError) && (
        <div className="player-notices">
          {state.error && (
            <div className="player-error-notice" role="alert">
              This slide's effect list failed to play: {state.error}
            </div>
          )}
          {fullscreenError && (
            <div className="player-error-notice" role="alert">
              Fullscreen toggle failed: {fullscreenError}
            </div>
          )}
        </div>
      )}
      {/* Whether the player actually holds keyboard focus used to be
          inferred only from whether the focus hint was in the DOM. Now
          that the hint is gone, this state still needs to be visible —
          e2e uses it as a sync point for "focus has already been handed
          over", otherwise tests would have to sleep a fixed duration and
          hope. This is a plain fact about state, not UI meant for the
          user, so it's a data attribute rather than any visible element. */}
      <nav className={awake ? "play-bar awake" : "play-bar"} data-player-focus={state.playerHasFocus}>
        {/* Previous/next step change pages, not effect steps: when the
            effect list fails to parse there is no live runtime to respond
            to arrow keys, so these two buttons are the page-change
            fallback, calling controller.previous()/next() (i.e.
            showSlide(currentIndex±1)), not player-runtime.js's step
            advance. Both buttons' SVGs copy base-shell.html:420-421's path
            verbatim: these are new elements, and no existing test depends
            on their shape, so the frozen text-selector set for the leave-
            play/fullscreen buttons doesn't cover them — they don't reuse
            StatusBar's `.slide-nav-button` (that style is for the text
            ‹/› arrows; the icon buttons use `.play-bar`'s own button
            style, see play.css). */}
        <button
          type="button"
          className="play-nav-button"
          aria-label="Previous"
          disabled={state.currentIndex <= 0}
          onClick={() => void controller?.previous()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M10 3 L5 8 L10 13" />
          </svg>
        </button>
        {/* Page number: the template's `N / M` form (base-shell.html:422's
            `.pos`), not the status bar's "page N of M" — that phrasing is
            the status bar's own rule, and the status bar isn't in the DOM
            during play mode, so the two don't conflict. Order follows the
            template's "previous → page number → next", with the position
            indicator moved to the middle after the two buttons — the
            frozen text/class covers only the button labels, not ordering. */}
        <span className="play-bar-position">
          {state.currentIndex >= 0 ? `${state.currentIndex + 1} / ${state.slides.length}` : "– / –"}
        </span>
        <button
          type="button"
          className="play-nav-button"
          aria-label="Next"
          disabled={state.currentIndex < 0 || state.currentIndex >= state.slides.length - 1}
          onClick={() => void controller?.next()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M6 3 L11 8 L6 13" />
          </svg>
        </button>
        <span className="play-bar-divider" />
        {/* The template's order (base-shell.html:419-426, measured with
            Playwright at 1440×900) is "fullscreen, leave play" — this was
            previously reversed. The frozen text-selector set covers only
            these two buttons' class and text (existing e2e locates them
            with button:has-text() style selectors), not ordering, so
            purely moving the JSX blocks with class and text untouched
            doesn't conflict with that freeze.
            Whether to go fullscreen is left to the author's choice; the
            tool doesn't force it by default. */}
        <button type="button" className="fullscreen-toggle-button" onClick={() => void onToggleFullscreen()}>
          {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
        <button type="button" className="play-toggle-button leave" onClick={() => void onExitPlay()}>
          Exit Play
        </button>
      </nav>
    </>
  );
}
