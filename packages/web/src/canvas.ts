/**
 * The canvas: a vanilla DOM module. React hands it a container element and
 * never touches what ends up inside it (ADR-0001) — the 投影片 is the
 * artifact loaded from the presentation file, not something React computes
 * from state.
 *
 * `reload()` is the seam future tickets hook into: #5's change-push handler
 * calls it directly when the watched file changes on disk, redrawing the
 * slide without React re-rendering anything.
 *
 * A `.comot` is meant to be opened by people other than its author (ADR-0003
 * — that's the point of it being a single shareable file). Slide markup is
 * therefore untrusted: a legal SVG can carry `onload`/`onerror` handlers or
 * an active `<foreignObject>`, and if it were injected with `innerHTML` into
 * this document it would run as first-party script, able to call
 * `/api/files/*` and exfiltrate the presentation. It is rendered inside a
 * sandboxed iframe instead, fed via `srcdoc`, which puts it in an opaque
 * origin — not a construct that is blocked from reaching the app, but one
 * that has nowhere to reach the app from. See the comment on the iframe's
 * `sandbox` attribute below before changing it.
 *
 * 播放模式 (ticket #28) reuses the same posture with one deliberate
 * loosening: the play iframe gets `allow-scripts` so the player runtime can
 * run, but never `allow-same-origin` (ADR-0010) — the pair together would
 * let the iframe script itself free of its own sandbox. Because the
 * `sandbox` attribute cannot be changed on a live iframe, entering or
 * leaving play mode destroys the current iframe and builds a fresh one.
 */
import playerRuntimeSource from "./player-runtime.js?raw";
import { computePlayerPlan, renderHideStyle, renderPlanScript } from "./player-plan.js";

export type CanvasMode = "view" | "play";

export interface CanvasState {
  /** Slide virtual paths, in project.json's own order. */
  slides: string[];
  /** Currently selected index; -1 when the presentation has no slides. */
  currentIndex: number;
  mode: CanvasMode;
  /** Only meaningful while mode === "play". */
  playerHasFocus: boolean;
  /** Set when the current slide's effect list cannot be run; cleared on the next successful render. */
  error: string | null;
}

export interface CanvasController {
  reload: () => Promise<void>;
  /** Throws when the index is out of range — that is a programming error, not user input. */
  showSlide: (index: number) => Promise<void>;
  /** No-op (and no throw) when already on the last slide. */
  next: () => Promise<void>;
  /** No-op (and no throw) when already on the first slide. */
  previous: () => Promise<void>;
  /** Returns an unsubscribe function. The listener is called once immediately with the current state. */
  subscribe: (listener: (state: CanvasState) => void) => () => void;
  destroy: () => void;
  /** Rebuilds the iframe with `allow-scripts` and enters play mode on the current slide. */
  play: () => Promise<void>;
  /** Rebuilds the iframe back to zero-token sandbox and returns to view mode. */
  exitPlay: () => Promise<void>;
  /** Sends focus to the player iframe. Safe to call outside play mode (no-op). */
  focusPlayer: () => void;
  /**
   * A live getter, not a snapshot: entering/leaving play mode destroys and
   * rebuilds the iframe (the `sandbox` attribute cannot change on a live
   * element), so a caller holding onto a stale reference would be a bug —
   * #29's requestFullscreen() target must always be the iframe that
   * currently exists.
   */
  readonly frameElement: HTMLIFrameElement;
}

interface ProjectJson {
  name: string;
  slides: string[];
}

/** Message shapes the runtime sends (C4 in the design doc). */
interface PlayerMessage {
  source: "comot-player";
  event: "ready" | "focus" | "advance-past-end" | "error";
  hasFocus?: boolean;
  message?: string;
}

function isPlayerMessage(data: unknown): data is PlayerMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "comot-player" &&
    typeof (data as { event?: unknown }).event === "string"
  );
}

export function mountCanvas(container: HTMLElement): CanvasController {
  let destroyed = false;
  // The selected slide lives here, not in React (ADR-0001/ADR-0002): the
  // 投影片 on screen is the artifact, not something React computes from
  // state. React subscribes to read it and issues commands to change it.
  let slides: string[] = [];
  let currentIndex = -1;
  let mode: CanvasMode = "view";
  let playerHasFocus = false;
  let error: string | null = null;
  const listeners = new Set<(state: CanvasState) => void>();
  // Bumped on every reload()/showSlide()/play()/exitPlay() call and
  // captured by each call's own closure. Nothing orders concurrent calls
  // against each other, so a slower earlier one can resolve after a
  // faster later one and paint stale content over it. Comparing the
  // captured generation against the current one right before each await's
  // result is applied discards a superseded call's result instead of
  // applying it. play()/exitPlay() bump it too — not just reload()/
  // showSlide() — because they replace the iframe element itself: without
  // that, a slow in-flight view-mode render() could resume after play()
  // has already swapped in the fresh play iframe and write into it via the
  // still-current `frame` reference (see the mode-switch note below).
  let generation = 0;

  let frame = buildFrame("");
  container.appendChild(frame);

  // One listener for the whole controller's lifetime, not per-frame: it
  // reads `frame` (the current, possibly-rebuilt element) at call time
  // rather than closing over a specific iframe, so it keeps working across
  // play()/exitPlay() rebuilds without being re-attached.
  window.addEventListener("message", onWindowMessage);

  function onWindowMessage(event: MessageEvent): void {
    if (destroyed) return;
    // Authenticate by sender identity, never by trusting `event.origin` —
    // an opaque-origin document's `event.origin` is literally the string
    // "null", which proves nothing about who sent it (ADR-0010).
    if (event.source !== frame.contentWindow) return;
    if (!isPlayerMessage(event.data)) return;

    const message = event.data;
    if (message.event === "ready") {
      // Entering play mode hands focus to the player (acceptance
      // criterion); "ready" is the runtime's own signal that its listeners
      // are attached and it can actually receive the focus/keydown.
      focusPlayer();
      return;
    }
    if (message.event === "focus") {
      playerHasFocus = Boolean(message.hasFocus);
      notify();
      return;
    }
    if (message.event === "error") {
      error = message.message ?? "播放時發生未知錯誤";
      notify();
      return;
    }
    if (message.event === "advance-past-end") {
      void advancePastEnd();
      return;
    }
  }

  async function advancePastEnd(): Promise<void> {
    // On the last slide of the presentation, advancing past the end does
    // nothing — there is nowhere further to go, and this must not throw.
    if (currentIndex === -1 || currentIndex >= slides.length - 1) return;
    // A stale runtime can still be alive in the old play iframe for a
    // moment after a page change (the iframe is only rebuilt once
    // renderPlay() below actually finishes), so repeated ArrowRight
    // presses before that finishes can fire several advance-past-end
    // messages back to back. Bumping generation here — the same guard
    // play()/exitPlay()/showSlide() already use — makes an earlier one of
    // these calls' renderPlay() discard its own result instead of racing
    // a later one to paint last.
    const thisGeneration = ++generation;
    currentIndex += 1;
    notify();
    await renderPlay(thisGeneration);
  }

  async function reload(): Promise<void> {
    // A no-op after destroy(): the iframe this closure owns is gone from
    // the DOM, so there is nothing left to redraw, and re-fetching would
    // just race the next mount for no benefit.
    if (destroyed) return;

    // Claim this call's generation before the first await, then compare
    // against the live counter after every await: if another call already
    // bumped `generation` past what this call captured, this call's result
    // is stale and must be discarded — no matter how much later it settles.
    const thisGeneration = ++generation;

    const project = await fetchJson<ProjectJson>("/api/presentation");
    if (destroyed || thisGeneration !== generation) return;

    slides = project.slides;
    // Live reload calls reload() on every external edit. Staying on the
    // slide the author is looking at is the whole point — jumping back to
    // the first one because an agent changed a word elsewhere is a bug.
    // Only a presentation that got shorter forces a move, and then only as
    // far as the new last slide.
    currentIndex = slides.length === 0 ? -1 : Math.min(Math.max(currentIndex, 0), slides.length - 1);
    notify();

    if (mode === "play") {
      await renderPlay(thisGeneration);
    } else {
      await render(thisGeneration);
    }
  }

  /**
   * Paints the currently selected slide in view mode. Takes the caller's
   * captured generation so navigation shares reload()'s race guard: rapid
   * arrow presses issue overlapping slide fetches, and a slower earlier one
   * must never paint over the newer page the author actually asked for.
   */
  async function render(thisGeneration: number): Promise<void> {
    if (currentIndex === -1) {
      frame.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || thisGeneration !== generation) return;

    frame.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
  }

  /**
   * Paints the currently selected slide in play mode: fetches the markup,
   * derives the plan (Seam C's parent half, in player-plan.ts), and injects
   * both the plan and the runtime into the srcdoc. An effect list the
   * parser rejects surfaces through `error` instead of being applied.
   */
  async function renderPlay(thisGeneration?: number): Promise<void> {
    const captured = thisGeneration ?? generation;
    if (currentIndex === -1) {
      frame.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      return;
    }

    const slidePath = slides[currentIndex];
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    if (destroyed || captured !== generation) return;

    let planScript: string;
    let hideStyle: string;
    try {
      const plan = computePlayerPlan(svgMarkup);
      planScript = renderPlanScript(plan);
      hideStyle = renderHideStyle(plan.hidden);
      // Must notify here, not just assign: a prior slide's parse failure
      // may have left `error` set, and without this call React never
      // learns this render cleared it — the error banner from the
      // previous, broken slide would keep showing on top of a page that
      // is in fact playing fine (found in gate review round 2).
      if (error !== null) {
        error = null;
        notify();
      }
    } catch (planError) {
      // Surfaced, never silently swallowed (design doc). Play the static
      // slide with no runtime rather than leaving the frame blank — the
      // author still sees the slide, plus the reason nothing animates.
      error = planError instanceof Error ? planError.message : "效果清單無法解析";
      notify();
      frame.srcdoc = wrapSlideDocument(svgMarkup, `/api/raw/${slideDirectory(slidePath)}`);
      return;
    }

    frame.srcdoc = wrapPlayDocument(
      svgMarkup,
      `/api/raw/${slideDirectory(slidePath)}`,
      hideStyle,
      planScript,
    );
  }

  async function showSlide(index: number): Promise<void> {
    if (destroyed) return;
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      throw new Error(`投影片索引超出範圍：${index}`);
    }

    const thisGeneration = ++generation;
    currentIndex = index;
    notify();
    if (mode === "play") {
      await renderPlay(thisGeneration);
    } else {
      await render(thisGeneration);
    }
  }

  async function next(): Promise<void> {
    if (currentIndex === -1 || currentIndex >= slides.length - 1) return;
    await showSlide(currentIndex + 1);
  }

  async function previous(): Promise<void> {
    if (currentIndex <= 0) return;
    await showSlide(currentIndex - 1);
  }

  async function play(): Promise<void> {
    if (destroyed || mode === "play") return;
    const thisGeneration = ++generation;
    mode = "play";
    playerHasFocus = false;
    error = null;
    rebuildFrame("allow-scripts");
    notify();
    await renderPlay(thisGeneration);
  }

  async function exitPlay(): Promise<void> {
    if (destroyed || mode === "view") return;
    const thisGeneration = ++generation;
    mode = "view";
    playerHasFocus = false;
    error = null;
    rebuildFrame("");
    notify();
    await render(thisGeneration);
  }

  function focusPlayer(): void {
    if (destroyed || mode !== "play") return;
    frame.contentWindow?.focus();
    // Belt-and-braces, confirmed necessary (not merely defensive) by
    // e2e/player-mode.test.ts: a bare cross-document `.focus()` call from
    // the parent alone did not reliably fire the runtime's own `focus`
    // listener in headless Chromium during testing. Asking the runtime to
    // call `window.focus()` on itself, from inside its own document, is
    // the half that actually lands.
    frame.contentWindow?.postMessage({ source: "comot-host", command: "focus" }, "*");
  }

  /** Destroys the current iframe and builds a fresh one with the given sandbox tokens, in the same container position. */
  function rebuildFrame(sandbox: string): void {
    const old = frame;
    frame = buildFrame(sandbox);
    container.insertBefore(frame, old);
    old.remove();
  }

  function notify(): void {
    // A fresh object per notification: listeners keep it as React state,
    // and handing out a mutable reference to internal arrays would let a
    // later reload silently rewrite what a listener already read.
    const state: CanvasState = {
      slides: [...slides],
      currentIndex,
      mode,
      playerHasFocus,
      error,
    };
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener: (state: CanvasState) => void): () => void {
    listeners.add(listener);
    listener({ slides: [...slides], currentIndex, mode, playerHasFocus, error });
    return () => {
      listeners.delete(listener);
    };
  }

  void reload();

  return {
    reload,
    showSlide,
    next,
    previous,
    subscribe,
    play,
    exitPlay,
    focusPlayer,
    get frameElement() {
      return frame;
    },
    destroy: () => {
      destroyed = true;
      listeners.clear();
      window.removeEventListener("message", onWindowMessage);
      // Remove exactly the element this call created — never the
      // container's other children. The container belongs to React
      // (ADR-0001); this module has no business deciding what else lives
      // in it. `.remove()` is also a no-op if the iframe is already
      // detached, so double-destroy stays safe.
      frame.remove();
    },
  };
}

/** A bare, unmounted iframe with the given `sandbox` tokens — appending it is the caller's job. */
function buildFrame(sandbox: string): HTMLIFrameElement {
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

/**
 * Wraps the fetched slide markup for `srcdoc`. When `baseHref` is given, a
 * `<base>` element is injected so the browser's own relative-URL resolution
 * — not a regex rewrite of untrusted markup (ADR-0003) — turns a slide
 * reference like `href="../assets/photo.png"` into the byte-preserving
 * `/api/raw/` route's path for it. A `srcdoc` document otherwise resolves
 * relative URLs against the *parent* document's URL, which is why a
 * relative asset reference needs this at all. `<base>` alone needs no
 * sandbox token: subresource loads (`<img>`, `<video>`) from an
 * opaque-origin document to this origin are not blocked by `sandbox`.
 *
 * The `<base>` does NOT disturb same-document fragment references
 * (`url(#grad)`, `<use href="#sym">` and friends) — measured, not assumed,
 * on all three engines by e2e/base-fragment-spike.test.ts, which is why
 * this and wrapPlayDocument/slideDirectory are exported.
 */
export function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}</head><body style="margin:0">${bodyMarkup}</body></html>`;
}

/**
 * Wraps the fetched slide markup for play mode's `srcdoc`. The hide style
 * lives in `<head>` so the browser applies it while parsing, before any
 * script runs — the runtime never hides anything on DOMContentLoaded,
 * which would flash the full slide first. The runtime script comes last in
 * `<body>`, after the slide markup, so `document.getElementById` inside it
 * can find every element immediately without waiting for an event.
 */
export function wrapPlayDocument(bodyMarkup: string, baseHref: string, hideStyle: string, planScript: string): string {
  const baseTag = `<base href="${escapeAttribute(baseHref)}">`;
  // planScript is built from parsed slide attributes (target ids, effect
  // names) — untrusted content (ADR-0010), and it lands inside a raw
  // <script> element, not an HTML text node, so HTML-entity escaping
  // (escapeAttribute's job, above) does not apply here at all. Escaping
  // only a literal "</script" (an earlier version of this function) is
  // not enough: a target containing "<!--<script>" drives the HTML
  // tokenizer into "script data double escaped" state, where the very
  // "</script>" text this function writes to close the tag no longer
  // counts as a real closing tag — the parser keeps consuming straight
  // through the runtime's own <script> below, and play mode never starts
  // (found in gate review round 3). Every `<` inside planScript can only
  // ever occur inside a quoted JSON string value (JSON's own structural
  // characters never include "<"), so replacing all of them with the
  // equivalent JSON/JS string escape `\u003C` is unconditionally safe —
  // it cannot land outside a string literal — and removes every foothold
  // for a tokenizer state change, not just the one this function used to
  // special-case.
  const safePlanScript = planScript.replace(/</g, "\\u003C");
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${hideStyle}</head><body style="margin:0">${bodyMarkup}<script>${safePlanScript}<\/script><script>${playerRuntimeSource}<\/script></body></html>`;
}

/** The virtual directory a slide lives in, percent-encoded per segment. */
export function slideDirectory(slidePath: string): string {
  const lastSlash = slidePath.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return slidePath
    .slice(0, lastSlash + 1)
    .split("/")
    .map((segment) => (segment === "" ? segment : encodeURIComponent(segment)))
    .join("/");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return response.text();
}
