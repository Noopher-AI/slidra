// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Rect } from "../geometry.js";
import type { Effect, SlideTransition } from "../effects.js";
import type { ActiveGesture, Viewport } from "./gesture-geometry.js";
import type { StageEmbedEntry } from "../player-plan.js";
import type { CanvasMode } from "../canvas.js";
import { EMPTY_DECK_DOCUMENT, fetchText, slideDirectory, wrapPlayDocument, wrapSlideDocument } from "./frame-documents.js";
import { computePlayerPlan, renderHideStyle, renderPlanScript, stageEmbedsFor } from "../player-plan.js";
import { slidePaintKey } from "../slide-paint-key.js";
import { pageTransitionTransform } from "./project-io.js";

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
 * `mountCanvas` closure — declared here (the module they were measured
 * against in [E8.T3] and now live in, ADR-0013's own convention). Its
 * measured field count is the number a human decided [S10.F4] on (see the
 * pull request body's headline table); this ticket [E8.T4] moves the twelve
 * functions themselves in without widening it.
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

/** The twelve play-mode handlers `createPlayMode` returns — [E8.T4] moved verbatim out of `mountCanvas`, signatures unchanged. */
export interface PlayModeHandlers {
  renderPlay(thisGeneration?: number, startAt?: "first" | "last", playEnter?: boolean, previewEffectIndices?: number[] | null): Promise<void>;
  playExitTransition(thisGeneration: number): Promise<boolean>;
  showSlide(index: number, selectAfter?: readonly string[]): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  play(): Promise<void>;
  exitPlay(): Promise<void>;
  previewEffects(effectIndices: number[] | null): Promise<void>;
  exitPreview(): void;
  focusPlayer(): void;
  stepPlayer(direction: "advance" | "retreat"): void;
  rebuildFrame(sandbox: string): void;
}

/** Factory for the play-mode handler set — the entry builds one `PlayModeDeps` object and calls this once; the twelve functions below are otherwise unchanged from their pre-[E8.T4] `mountCanvas` bodies. */
export function createPlayMode(playModeDeps: PlayModeDeps): PlayModeHandlers {
  /**
   * Paints the currently selected slide in play mode: fetches the markup,
   * derives the plan (Seam C's parent half, in player-plan.ts), and injects
   * both the plan and the runtime into the srcdoc. An effect list the
   * parser rejects surfaces through `error` instead of being applied.
   *
   * `startAt` (decision 5): "first" is every existing caller's
   * behaviour, unchanged. "last" is a parent-side intent used only by
   * retreatPastStart() — the wire integer (`plan.steps.length - 1`, or
   * `-1` for a slide with no effects at all, decision 3) is computed here,
   * after computePlayerPlan() has run, because only the parent knows the
   * slide's step count. The sentinel itself never travels over the wire.
   *
   * `playEnter` ([E2.T11], replacing T6's `animate`): whether THIS
   * particular call should play the new page's own enter transition, on
   * top of whatever `<slidra:transition>` it declares. §4.6's table: every
   * caller passes `true` except `reload()`'s background refresh and
   * `previewEffects()` — a page change (forward or backward), and
   * entering play mode itself, all count as a real arrival. This is a
   * distinct layer from element-entrance transitions inside the slide's
   * own runtime: this one animates the `<iframe>` itself, from the parent
   * document, and never touches player-runtime.js.
   */
  async function renderPlay(
    thisGeneration?: number,
    startAt: "first" | "last" = "first",
    playEnter = true,
    /**
     * [E2.T7]/D8: `undefined` (every existing caller) means "not a
     * Preview — never set `plan.preview`". A concrete value (only
     * `previewEffects()` passes one) becomes `plan.preview.effectIndices`:
     * a specific list plays just those effect-list positions, `null`
     * plays the whole slide's steps in sequence.
     */
    previewEffectIndices?: number[] | null,
  ): Promise<void> {
    const captured = thisGeneration ?? playModeDeps.frame.generation;
    if (playModeDeps.deck.currentIndex() === -1) {
      playModeDeps.frame.paintedView = null;
      playModeDeps.frame.paintedPlay = null;
      playModeDeps.frame.element.srcdoc = EMPTY_DECK_DOCUMENT;
      return;
    }

    const slidePath = playModeDeps.deck.slides()[playModeDeps.deck.currentIndex()];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (playModeDeps.session.isDestroyed() || captured !== playModeDeps.frame.generation) return;

    // #303: only reload()'s background refresh (playEnter=false, no preview,
    // startAt "first") may keep the running document; every arrival —
    // page change, entering play, a Preview — paints anew.
    const playKey = slidePaintKey(svgMarkup);
    const keepRunningDocument =
      !playEnter &&
      previewEffectIndices === undefined &&
      startAt === "first" &&
      playModeDeps.frame.paintedPlay !== null &&
      playModeDeps.frame.paintedPlay.slidePath === slidePath &&
      playModeDeps.frame.paintedPlay.key === playKey;

    let planScript: string;
    let hideStyle: string;
    try {
      const plan = await computePlayerPlan(svgMarkup, slidePath);
      if (playModeDeps.session.isDestroyed() || captured !== playModeDeps.frame.generation) return;
      const startStep = startAt === "last" ? plan.steps.length - 1 : -1;
      const planForWire = previewEffectIndices === undefined ? plan : { ...plan, preview: { effectIndices: previewEffectIndices } };
      planScript = renderPlanScript(planForWire, startStep);
      hideStyle = renderHideStyle(plan.hidden);
      // A slide whose <slidra:transition> is present but malformed
      // (§4.2: an unknown effect value, an illegal duration, more than one
      // node) surfaces through the exact same `error` banner + static-
      // fallback path a broken effect list already does, rather than a
      // second, differently shaped failure mode — `plan.transition` comes
      // from the SAME `computePlayerPlan` call above, so a malformed
      // transition fails this same `try` (decision E1: riding
      // along on `computePlayerPlan`'s own `fetchSlideEffectPlan` call
      // rather than a second one, since even a cache-hit await is one more
      // microtask on a path PlayChrome.tsx's 2.5s auto-hide timer races
      // against).
      playModeDeps.slideState.pageTransition.set(plan.transition);
      // Must notify here, not just assign: a prior slide's parse failure
      // may have left `error` set, and without this call React never
      // learns this render cleared it — the error banner from the
      // previous, broken slide would keep showing on top of a page that
      // is in fact playing fine (found in gate review round 2).
      if (playModeDeps.session.error.get() !== null) {
        playModeDeps.session.error.set(null);
        playModeDeps.publish.notify();
      }
    } catch (planError) {
      // A stale frame.generation's own rejection (e.g. a superseded navigation's
      // /api/effects/ fetch resolving after a newer renderPlay() already
      // took over) must not clobber state a newer, still-live call owns.
      if (playModeDeps.session.isDestroyed() || captured !== playModeDeps.frame.generation) return;
      // Surfaced, never silently swallowed (design doc). Play the static
      // slide with no runtime rather than leaving the frame.element blank — the
      // author still sees the slide, plus the reason nothing animates.
      playModeDeps.session.error.set(planError instanceof Error ? planError.message : "effect list could not be parsed");
      playModeDeps.publish.notify();
      // A broken page has no transition to play on the way out either —
      // reset to the all-"none" default so a later playExitTransition()
      // call leaving this (static) page does not act on stale data left
      // over from whichever slide was last painted successfully.
      playModeDeps.slideState.pageTransition.set({ enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } });
      playModeDeps.frame.paintedView = null;
      playModeDeps.frame.paintedPlay = null;
      playModeDeps.frame.element.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
      return;
    }

    // #303: metadata-only change while playing — the plan above was
    // re-read (so `currentPageTransition` and the effects cache are
    // fresh) but the document on screen is the same picture: leave the
    // runtime, and the author's step position, alone.
    if (keepRunningDocument) return;

    // Same as render(): the ids travel to the runtime inside the plan
    // (`plan.embedIds`), the URLs stay here.
    playModeDeps.embeds.entries = stageEmbedsFor(svgMarkup);
    playModeDeps.embeds.boxes = {};
    playModeDeps.publish.notifyEmbeds();

    playModeDeps.frame.paintedView = null;
    playModeDeps.frame.element.srcdoc = wrapPlayDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      hideStyle,
      planScript,
    );
    playModeDeps.frame.paintedPlay = { slidePath, key: playKey };

    const { effect, duration } = playModeDeps.slideState.pageTransition.get().enter;
    if (playEnter && effect !== "none" && duration > 0) {
      const ms = duration * 1000;
      playModeDeps.frame.element.style.transition = "none";
      playModeDeps.frame.element.style.opacity = "0";
      playModeDeps.frame.element.style.transform = pageTransitionTransform(effect, "enter-start");
      // The "none" transition and the start values above must land in a
      // rendered frame before switching to the real transition, or the
      // browser coalesces both style writes into one paint and nothing
      // animates.
      requestAnimationFrame(() => {
        if (playModeDeps.session.isDestroyed() || captured !== playModeDeps.frame.generation) return;
        playModeDeps.frame.element.style.transition = `opacity ${ms}ms var(--ease-out), transform ${ms}ms var(--ease-out)`;
        playModeDeps.frame.element.style.opacity = "1";
        playModeDeps.frame.element.style.transform = "none";
      });
      // [E2.T17]: the embed overlay converts runtime-local px against
      // `frame.element.getBoundingClientRect()` *at message time*, and the runtime
      // reports its boxes while this transform is still mid-flight — which
      // lands the player offset by however far the frame.element still had to
      // travel. Re-converting once the transition has settled (the stored
      // runtime-local boxes are unchanged; only the frame.element's own rect moved)
      // is what puts it back on its placeholder.
      window.setTimeout(() => {
        if (playModeDeps.session.isDestroyed() || captured !== playModeDeps.frame.generation) return;
        playModeDeps.publish.notifyEmbeds();
      }, ms + 50);
    } else {
      // Instant path must actively clear any inline opacity/transition/
      // transform a PRIOR animation left behind — otherwise this page
      // silently inherits the last frame's mid-animation state instead of
      // showing at rest. `transition` is cleared before the values it was
      // animating, defensively — clearing a value while `transition` is
      // still declared risks animating the removal itself instead of
      // jumping straight to the resting state.
      playModeDeps.frame.element.style.removeProperty("transition");
      playModeDeps.frame.element.style.removeProperty("opacity");
      playModeDeps.frame.element.style.removeProperty("transform");
    }
  }

  /**
   * Plays the page currently on screen's own exit transition (§4.6),
   * before a forward page change replaces `frame.element.srcdoc`. Unlike
   * renderPlay()'s enter fade-in, no two-step rAF commit is needed here:
   * the `<iframe>` is already sitting at its resting opacity/transform (no
   * inline style forced it there a moment ago), so setting `transition`
   * and the end values together in one synchronous block still animates
   * — the browser compares against the last real paint, not against
   * something this function itself just wrote.
   *
   * Returns `false` when the caller must NOT proceed to the page change at
   * all: either a forward request arrived while an earlier one is still
   * exiting (§4.6 decision: ignored outright, never queued or stacked), or
   * `frame.generation` moved on mid-exit — some other navigation (reload(),
   * exitPlay(), a second showSlide()) superseded this one, and the caller
   * must abandon its own page change rather than apply it on top.
   */
  async function playExitTransition(thisGeneration: number): Promise<boolean> {
    if (playModeDeps.session.exiting.get()) return false;
    const { effect, duration } = playModeDeps.slideState.pageTransition.get().exit;
    if (effect === "none" || duration === 0) return true;

    playModeDeps.session.exiting.set(true);
    const ms = duration * 1000;
    playModeDeps.frame.element.style.transition = `opacity ${ms}ms var(--ease-in), transform ${ms}ms var(--ease-in)`;
    playModeDeps.frame.element.style.opacity = "0";
    playModeDeps.frame.element.style.transform = pageTransitionTransform(effect, "exit-end");
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    playModeDeps.session.exiting.set(false);

    if (playModeDeps.session.isDestroyed() || thisGeneration !== playModeDeps.frame.generation) {
      playModeDeps.frame.element.style.removeProperty("transition");
      playModeDeps.frame.element.style.removeProperty("opacity");
      playModeDeps.frame.element.style.removeProperty("transform");
      return false;
    }
    return true;
  }

  async function showSlide(index: number, selectAfter?: readonly string[]): Promise<void> {
    if (playModeDeps.session.isDestroyed()) return;
    if (!Number.isInteger(index) || index < 0 || index >= playModeDeps.deck.slides().length) {
      throw new Error(`slide index out of range: ${index}`);
    }

    playModeDeps.commitTextEditIfEditing(); // See reload()'s own comment on why this is fire-and-forget.
    playModeDeps.activeGesture.set(null);
    const thisGeneration = ++playModeDeps.frame.generation;
    // Captured before currentIndex moves — "forward" decides whether the
    // page being left plays an exit (§4.6: only a forward change does),
    // same intent as advancePastEnd()'s "+= 1" vs retreatPastStart()'s
    // "-= 1".
    const forward = index > playModeDeps.deck.currentIndex();
    if (playModeDeps.session.mode.get() === "play" && forward) {
      if (!(await playExitTransition(thisGeneration))) return;
    }
    playModeDeps.deck.setCurrentIndex(index);
    // Plan §4.5: "close on slide change" — a chart window's edits target
    // a specific element id on the slide being left; render()'s own
    // notifyChartWindow() below would eventually close it anyway (the id
    // resolves on the wrong slide), but that happens after the slide fetch
    // resolves — closing it here means the window never lingers open for a
    // beat while the next slide loads.
    playModeDeps.chartWindow.target = null;
    playModeDeps.publish.notifyChartWindow();
    // A selection points at elements' ids on the slide the author was
    // looking at; a stale selection surviving onto a different slide's DOM
    // is a defect, not a convenience.
    playModeDeps.selection.ids = [];
    playModeDeps.selection.names = [];
    playModeDeps.selection.groupPath = [];
    playModeDeps.frame.viewport = null;
    playModeDeps.overlay.boxes = [];
    playModeDeps.overlay.union = null;
    playModeDeps.overlay.ancestors = [];
    playModeDeps.overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    playModeDeps.slideState.setSlideEffects([]);
    playModeDeps.overlay.badgeTargets = [];
    playModeDeps.overlay.badges = [];
    playModeDeps.publish.notify();
    playModeDeps.publish.notifyOverlay();
    if (playModeDeps.session.mode.get() === "play") {
      await renderPlay(thisGeneration, "first", true);
    } else {
      // [E2.T8]: `selectAfter` reuses the exact same "reselect once the
      // new document's `load` fires" mechanism `SELECT_AFTER_COMMAND`
      // parks in `pendingSelectionIds` — calling the public `selectElement`
      // immediately after this promise resolves would race `render()`'s
      // `frame.element.srcdoc` navigation (NOOP-227: the runtime hasn't attached
      // its `message` listener yet) and be silently dropped, exactly the
      // failure `render()`'s own `selectOnceLoaded` exists to avoid.
      if (selectAfter && selectAfter.length > 0) playModeDeps.selectionState.setPendingSelectionIds([...selectAfter]);
      await playModeDeps.render(thisGeneration);
    }
  }

  async function next(): Promise<void> {
    if (playModeDeps.deck.currentIndex() === -1 || playModeDeps.deck.currentIndex() >= playModeDeps.deck.slides().length - 1) return;
    await showSlide(playModeDeps.deck.currentIndex() + 1);
  }

  async function previous(): Promise<void> {
    if (playModeDeps.deck.currentIndex() <= 0) return;
    await showSlide(playModeDeps.deck.currentIndex() - 1);
  }

  async function play(): Promise<void> {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() === "play") return;
    playModeDeps.commitTextEditIfEditing(); // See reload()'s own comment on why this is fire-and-forget.
    playModeDeps.activeGesture.set(null);
    const thisGeneration = ++playModeDeps.frame.generation;
    playModeDeps.session.mode.set("play");
    playModeDeps.frame.playerHasFocus = false;
    playModeDeps.session.error.set(null);
    // Entering play mode destroys the view-mode iframe (selection-runtime.js
    // included), so any selection it reported is gone with it.
    playModeDeps.selection.ids = [];
    playModeDeps.selection.names = [];
    playModeDeps.selection.groupPath = [];
    playModeDeps.frame.viewport = null;
    playModeDeps.overlay.boxes = [];
    playModeDeps.overlay.union = null;
    playModeDeps.overlay.ancestors = [];
    playModeDeps.overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    playModeDeps.slideState.setSlideEffects([]);
    playModeDeps.overlay.badgeTargets = [];
    playModeDeps.overlay.badges = [];
    rebuildFrame("allow-scripts");
    playModeDeps.publish.notify();
    playModeDeps.publish.notifyOverlay();
    await renderPlay(thisGeneration);
  }

  async function exitPlay(): Promise<void> {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() === "view") return;
    playModeDeps.commitTextEditIfEditing(); // See reload()'s own comment on why this is fire-and-forget.
    playModeDeps.activeGesture.set(null);
    const thisGeneration = ++playModeDeps.frame.generation;
    playModeDeps.session.mode.set("view");
    playModeDeps.frame.playerHasFocus = false;
    playModeDeps.session.error.set(null);
    // Returning to view mode rebuilds the iframe with a fresh
    // selection-runtime.js instance that has never heard a click yet.
    playModeDeps.selection.ids = [];
    playModeDeps.selection.names = [];
    playModeDeps.selection.groupPath = [];
    playModeDeps.frame.viewport = null;
    playModeDeps.overlay.boxes = [];
    playModeDeps.overlay.union = null;
    playModeDeps.overlay.ancestors = [];
    playModeDeps.overlay.guides = [];
    // [E2.T7]: the slide/mode is changing — the previous slide's badge
    // targets and measured positions no longer apply, and render()/
    // renderPlay() (or leaving view mode entirely) will repopulate them.
    playModeDeps.slideState.setSlideEffects([]);
    playModeDeps.overlay.badgeTargets = [];
    playModeDeps.overlay.badges = [];
    rebuildFrame("allow-scripts");
    playModeDeps.publish.notify();
    playModeDeps.publish.notifyOverlay();
    await playModeDeps.render(thisGeneration);
  }

  /**
   * [E2.T7]/D8: plays either one card's specific effect-list positions
   * (`effectIndices`, the card's own ▶) or the whole slide's steps in
   * sequence (`null`, the panel's Preview button) — reusing `renderPlay`'s
   * `wrapPlayDocument`/player-runtime.js path exactly like `play()` does,
   * never a second animation engine. Side-panel focus is left alone (no
   * `focusPlayer()` call anywhere in the preview path — see the
   * `onWindowMessage` "ready" handler): Animate › Object stays interactive
   * while the preview plays. No-op outside view mode.
   */
  async function previewEffects(effectIndices: number[] | null): Promise<void> {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() !== "view") return;
    playModeDeps.commitTextEditIfEditing(); // See reload()'s own comment on why this is fire-and-forget.
    playModeDeps.activeGesture.set(null);
    const thisGeneration = ++playModeDeps.frame.generation;
    playModeDeps.session.mode.set("preview");
    playModeDeps.selectionState.previewReturnSelectionIds.set([...playModeDeps.selection.ids]);
    playModeDeps.session.error.set(null);
    playModeDeps.selection.ids = [];
    playModeDeps.selection.names = [];
    playModeDeps.selection.groupPath = [];
    playModeDeps.frame.viewport = null;
    playModeDeps.overlay.boxes = [];
    playModeDeps.overlay.union = null;
    playModeDeps.overlay.ancestors = [];
    playModeDeps.overlay.guides = [];
    playModeDeps.slideState.setSlideEffects([]);
    playModeDeps.overlay.badgeTargets = [];
    playModeDeps.overlay.badges = [];
    rebuildFrame("allow-scripts");
    playModeDeps.publish.notify();
    playModeDeps.publish.notifyOverlay();
    await renderPlay(thisGeneration, "first", false, effectIndices);
  }

  /**
   * Returns to view mode from Preview, restoring whatever selection was
   * active before `previewEffects()` was called (top-level ids only —
   * drill-in group scope is not preserved). Called from the runtime's own
   * "preview-done" message (D8) or from the GUI on Esc/click-away
   * (`CanvasController.exitPreview`'s public export — see App.tsx/
   * AnimateObjectPanel's own Escape handling). No-op outside preview mode.
   */
  function exitPreview(): void {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() !== "preview") return;
    const thisGeneration = ++playModeDeps.frame.generation;
    playModeDeps.session.mode.set("view");
    playModeDeps.session.error.set(null);
    const restoreIds = playModeDeps.selectionState.previewReturnSelectionIds.get() ?? [];
    playModeDeps.selectionState.previewReturnSelectionIds.set(null);
    rebuildFrame("allow-scripts");
    playModeDeps.publish.notify();
    playModeDeps.publish.notifyOverlay();
    playModeDeps.selectionState.setPendingSelectionIds(restoreIds.length > 0 ? restoreIds : null);
    void playModeDeps.render(thisGeneration);
  }

  function focusPlayer(): void {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() !== "play") return;
    playModeDeps.frame.element.focus();
    playModeDeps.frame.element.contentWindow?.focus();
    // Belt-and-braces, confirmed necessary (not merely defensive) by
    // e2e/player-mode.test.ts: a bare cross-document `.focus()` call from
    // the parent alone did not reliably fire the runtime's own `focus`
    // listener in headless Chromium during testing. Asking the runtime to
    // call `window.focus()` on itself, from inside its own document, is
    // the half that actually lands.
    playModeDeps.frame.element.contentWindow?.postMessage({ source: "slidra-host", command: "focus" }, "*");
    playModeDeps.frame.playerHasFocus = true;
    playModeDeps.publish.notify();
  }

  function stepPlayer(direction: "advance" | "retreat"): void {
    if (playModeDeps.session.isDestroyed() || playModeDeps.session.mode.get() !== "play") return;
    playModeDeps.frame.element.contentWindow?.postMessage({ source: "slidra-host", command: direction }, "*");
  }

  /** Destroys the current iframe and builds a fresh one with the given sandbox tokens, in the same container position. */
  function rebuildFrame(sandbox: string): void {
    const old = playModeDeps.frame.element;
    playModeDeps.frame.paintedView = null; // #303: a new element has painted nothing yet.
    playModeDeps.frame.paintedPlay = null;
    playModeDeps.frame.element = buildFrame(sandbox);
    playModeDeps.container.insertBefore(playModeDeps.frame.element, old);
    old.remove();
  }

  return {
    renderPlay,
    playExitTransition,
    showSlide,
    next,
    previous,
    play,
    exitPlay,
    previewEffects,
    exitPreview,
    focusPlayer,
    stepPlayer,
    rebuildFrame,
  };
}

/** A bare, unmounted iframe with the given `sandbox` tokens — appending it is the caller's job. */
export function buildFrame(sandbox: string): HTMLIFrameElement {
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
