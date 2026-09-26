// <slidra-player>: a .slidra deck on any web page, as one custom element.
//
//   <script type="module" src="slidra-player.js"></script>
//   <slidra-player src="talk.slidra" controls slide="3"></slidra-player>
//
// Attributes: src (the deck's URL), slide (1-based start, default 1),
// controls (show previous / counter / next / fullscreen), allow-remote
// (let the deck load network resources, format §13; off by default),
// runtime-src (where the slide runtime is, when it is not built in).
// Methods: next(), previous(), goTo(slide). Properties: slide (settable), step,
// slideCount, deck. Events: "slidechange" and "stepchange" (detail
// { slide, step, slideCount }), "error" (detail { message }).
//
// It uses the viewer's own player (lib/viewer/player.js), so every slide
// still renders in a sandboxed, opaque-origin frame (format §17).

import { openDeck } from "../viewer/deck.js";
import { Player } from "../viewer/player.js";

/* global __SLIDRA_RUNTIME__ */
/** The slide runtime, inlined by tools/build-element.mjs; unbundled, it is fetched from `runtime-src`. */
const BUILT_IN_RUNTIME = typeof __SLIDRA_RUNTIME__ === "string" ? __SLIDRA_RUNTIME__ : null;
const DEFAULT_RUNTIME_SRC = "/js/player-runtime.js";

const STYLE = `
:host { display: block; position: relative; background: #000; color: #f4f6f8; aspect-ratio: var(--slidra-aspect, 16 / 9); overflow: hidden; font: 13px system-ui, sans-serif; }
:host([hidden]) { display: none; }
.stage { position: absolute; inset: 0; display: grid; place-items: center; }
:host([controls]) .stage { bottom: 40px; }
.surface { position: relative; width: var(--slide-w, 100%); height: var(--slide-h, 100%); }
iframe.slide { display: block; width: 100%; height: 100%; border: 0; background: #000; }
.embeds { position: absolute; inset: 0; pointer-events: none; }
.embeds iframe { position: absolute; border: 0; pointer-events: auto; background: #000; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; display: none; align-items: center; gap: 4px; padding: 0 6px; background: #1b1d24; }
:host([controls]) .bar { display: flex; }
.bar button { width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.bar button:hover { background: rgba(255,255,255,.1); }
.bar button:focus-visible { outline: 2px solid #c8233b; }
.bar button:disabled { opacity: .35; cursor: default; }
.bar svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.counter { min-width: 4.5em; text-align: center; font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.status { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 16px; text-align: center; background: rgba(8,8,10,.92); }
.status[hidden] { display: none; }
`;

const TEMPLATE = `
<style>${STYLE}</style>
<div class="stage" part="stage"><div class="surface"><iframe class="slide" title="Slide" sandbox="allow-scripts" allow="autoplay; fullscreen"></iframe><div class="embeds"></div></div></div>
<nav class="bar" part="controls" aria-label="Playback">
  <button class="prev" type="button" aria-label="Previous"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg></button>
  <span class="counter" aria-live="polite"></span>
  <button class="next" type="button" aria-label="Next"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg></button>
  <span class="spacer"></span>
  <button class="fullscreen" type="button" aria-label="Fullscreen"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg></button>
</nav>
<p class="status" role="status" hidden></p>
`;

export class SlidraPlayerElement extends HTMLElement {
  static observedAttributes = ["src", "allow-remote"];

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = TEMPLATE;
    const $ = (selector) => root.querySelector(selector);
    this.parts = {
      stage: $(".stage"),
      surface: $(".surface"),
      frame: $("iframe.slide"),
      embeds: $(".embeds"),
      prev: $(".prev"),
      next: $(".next"),
      counter: $(".counter"),
      fullscreen: $(".fullscreen"),
      status: $(".status"),
    };
    this.player = null;
    this.loaded = null;
    this.loading = 0;
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.parts.prev.addEventListener("click", () => this.previous());
    this.parts.next.addEventListener("click", () => this.next());
    this.parts.fullscreen.addEventListener("click", () => this.toggleFullscreen());
    this.addEventListener("keydown", (event) => this.onKey(event));
  }

  connectedCallback() {
    this.resizeObserver.observe(this);
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (!this.loaded && this.getAttribute("src")) this.load();
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
  }

  attributeChangedCallback(name, previous, value) {
    if (previous === value || !this.isConnected) return;
    if (name === "src") this.load();
    else if (name === "allow-remote" && this.player) this.player.setAllowRemote(value !== null);
  }

  /** The loaded deck (lib/viewer/deck.js), or null. */
  get deck() {
    return this.loaded;
  }

  /** The current slide, 1-based (0 before a deck has loaded). */
  get slide() {
    return this.player ? this.player.index + 1 : 0;
  }

  /** Setting it goes to that slide; before a deck has loaded, it is where the deck will start (the `slide` attribute). */
  set slide(value) {
    if (this.player && this.player.index >= 0) {
      if (Number(value) !== this.player.index + 1) this.goTo(value);
    } else this.setAttribute("slide", String(value));
  }

  /** The current step on the slide (-1: the opening state). */
  get step() {
    return this.player ? this.player.step : -1;
  }

  get slideCount() {
    return this.loaded ? this.loaded.slides.length : 0;
  }

  next() {
    if (this.player) this.player.advance();
  }

  previous() {
    if (this.player) this.player.retreat();
  }

  /** Goes to slide `slide` (1-based), at its opening state. */
  goTo(slide) {
    if (this.player) return this.player.goTo(Number(slide) - 1);
  }

  async load() {
    const ticket = ++this.loading;
    const src = this.getAttribute("src");
    if (this.player) this.player.destroy();
    this.player = null;
    this.loaded = null;
    if (!src) return;
    this.showStatus("Loading…");
    try {
      const deckUrl = new URL(src, document.baseURI).href;
      const [deckResponse, runtime] = await Promise.all([fetch(deckUrl), this.runtimeSource()]);
      if (!deckResponse.ok) throw new Error(`could not download the deck (HTTP ${deckResponse.status})`);
      const deck = await openDeck(new Uint8Array(await deckResponse.arrayBuffer()), { fileName: deckUrl.split("/").pop() });
      if (ticket !== this.loading) return;
      const player = new Player({ frame: this.parts.frame, surface: this.parts.surface, embedLayer: this.parts.embeds, runtimeSource: runtime });
      player.load(deck);
      player.allowRemote = this.hasAttribute("allow-remote");
      player.addEventListener("slidechange", () => this.changed("slidechange"));
      player.addEventListener("stepchange", () => this.changed("stepchange"));
      player.addEventListener("key", (event) => this.onForwardedKey(/** @type {CustomEvent} */ (event).detail.key));
      player.addEventListener("slideerror", (event) => this.fail(/** @type {CustomEvent} */ (event).detail.message, false));
      this.player = player;
      this.loaded = deck;
      this.style.setProperty("--slidra-aspect", `${deck.canvas.width} / ${deck.canvas.height}`);
      this.hideStatus();
      this.layout();
      if (deck.slides.length === 0) return this.showStatus("This deck has no slides.");
      const start = Math.max(1, Number.parseInt(this.getAttribute("slide") ?? "1", 10) || 1);
      await player.show(Math.min(start, deck.slides.length) - 1);
    } catch (error) {
      if (ticket === this.loading) this.fail(error.message, true);
    }
  }

  async runtimeSource() {
    if (BUILT_IN_RUNTIME) return BUILT_IN_RUNTIME;
    const response = await fetch(new URL(this.getAttribute("runtime-src") ?? DEFAULT_RUNTIME_SRC, document.baseURI));
    if (!response.ok) throw new Error("could not load the slide runtime");
    return response.text();
  }

  changed(type) {
    const { index, step, stepCount } = this.player;
    const total = this.loaded.slides.length;
    this.parts.counter.textContent = `${index + 1} / ${total}`;
    this.parts.prev.disabled = index <= 0 && step < 0;
    this.parts.next.disabled = index >= total - 1 && step >= stepCount - 1;
    this.dispatchEvent(new CustomEvent(type, { detail: { slide: index + 1, step, slideCount: total } }));
  }

  onKey(event) {
    if (!this.player || event.composedPath()[0] instanceof HTMLButtonElement) return;
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) this.next();
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) this.previous();
    else if (!this.onForwardedKey(event.key)) return;
    event.preventDefault();
  }

  /** Keys pressed inside the slide that the slide does not handle itself. */
  onForwardedKey(key) {
    if (key === "Home") this.player.goTo(0);
    else if (key === "End") this.player.goTo(this.loaded.slides.length - 1, { startAt: "last" });
    else if (key === "f" || key === "F") this.toggleFullscreen();
    else return false;
    return true;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this) await document.exitFullscreen();
      else await this.requestFullscreen();
    } catch {
      /* the page does not allow fullscreen */
    }
  }

  layout() {
    if (!this.loaded) return;
    const rect = this.parts.stage.getBoundingClientRect();
    const ratio = this.loaded.canvas.width / this.loaded.canvas.height;
    let width = rect.width;
    let height = width / ratio;
    if (height > rect.height) {
      height = rect.height;
      width = height * ratio;
    }
    this.parts.surface.style.setProperty("--slide-w", `${Math.floor(width)}px`);
    this.parts.surface.style.setProperty("--slide-h", `${Math.floor(height)}px`);
  }

  fail(message, fatal) {
    if (fatal) this.showStatus(`This deck cannot be shown: ${message}`);
    this.dispatchEvent(new CustomEvent("error", { detail: { message } }));
  }

  showStatus(text) {
    this.parts.status.textContent = text;
    this.parts.status.hidden = false;
  }

  hideStatus() {
    this.parts.status.hidden = true;
  }
}

/** Registers <slidra-player> (once). */
export function defineSlidraPlayer(name = "slidra-player") {
  if (!customElements.get(name)) customElements.define(name, SlidraPlayerElement);
  return customElements.get(name);
}
