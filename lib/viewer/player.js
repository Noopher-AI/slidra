// The host half of the player: owns the sandboxed slide frame, moves
// between slides with their page transitions, relays the runtime's
// messages, and keeps third-party embeds aligned over their placeholders.

import { fontFaceStyle, playDocument } from "./frame.js";
import { prepareSlide, youtubeVideoId } from "./slide.js";

const READY_TIMEOUT_MS = 2000;

/** The resting-state transform a page transition starts from (enter) or ends at (exit) — spec/playback.md §5. */
export function transitionTransform(effect, phase) {
  if (effect === "slide") return phase === "enter" ? "translateX(8%)" : "translateX(-8%)";
  if (effect === "zoom") return phase === "enter" ? "scale(1.06)" : "scale(0.94)";
  return "none";
}

export class Player extends EventTarget {
  /**
   * @param {{ frame: HTMLIFrameElement, surface: HTMLElement, embedLayer: HTMLElement, runtimeSource: string }} parts
   *   `surface` is the element page transitions animate (it wraps the frame and the embed layer).
   */
  constructor({ frame, surface, embedLayer, runtimeSource }) {
    super();
    this.frame = frame;
    this.surface = surface;
    this.embedLayer = embedLayer;
    this.runtimeSource = runtimeSource;
    this.deck = null;
    this.index = -1;
    this.step = -1;
    this.stepCount = 0;
    this.current = null;
    this.generation = 0;
    this.exiting = false;
    this.prepared = new Map();
    this.embedFrames = new Map();
    this.readyWaiter = null;
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener("message", this.onMessage);
  }

  destroy() {
    window.removeEventListener("message", this.onMessage);
    this.generation++;
    this.clearEmbeds();
    this.frame.srcdoc = "";
    this.deck = null;
  }

  load(deck) {
    this.deck = deck;
    this.fonts = fontFaceStyle(deck);
    this.prepared.clear();
    this.index = -1;
  }

  /** The prepared slide (markup, plan, notes, transition), memoised. */
  slide(index) {
    let prepared = this.prepared.get(index);
    if (!prepared) {
      prepared = prepareSlide(this.deck, index);
      this.prepared.set(index, prepared);
    }
    return prepared;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Shows slide `index`. `startAt: "last"` lands on its final step (arriving
   * backwards). Only a forward move plays the outgoing page's exit
   * transition; every arrival plays the incoming page's enter transition.
   */
  async show(index, { startAt = "first", animate = true } = {}) {
    if (!this.deck || index < 0 || index >= this.deck.slides.length) return;
    const forward = index > this.index && this.index !== -1;
    if (this.exiting) return;
    const generation = ++this.generation;

    if (animate && forward && this.current) {
      const { effect, duration } = this.current.transition.exit;
      if (effect !== "none" && duration > 0) {
        this.exiting = true;
        await this.animateSurface(effect, "exit", duration);
        this.exiting = false;
        if (generation !== this.generation) return;
      }
    }

    const prepared = this.slide(index);
    this.index = index;
    this.current = prepared;
    const plan = prepared.plan ?? { steps: [], hidden: [], hideSelectors: {}, media: {}, stageMedia: {}, embedIds: [] };
    const startStep = startAt === "last" ? plan.steps.length - 1 : -1;
    this.step = startStep;
    this.stepCount = plan.steps.length;

    this.clearEmbeds();
    this.embedEntries = prepared.embeds;

    const { effect, duration } = prepared.transition.enter;
    const entering = animate && effect !== "none" && duration > 0;
    if (entering) {
      this.surface.style.transition = "none";
      this.surface.style.opacity = "0";
      this.surface.style.transform = transitionTransform(effect, "enter");
    } else {
      this.resetSurface();
    }

    const ready = this.waitForReady(generation);
    this.frame.srcdoc = playDocument(prepared.markup, this.fonts, plan, startStep, this.runtimeSource, { lang: prepared.lang });
    this.frame.title = prepared.title ? `Slide ${index + 1}: ${prepared.title}` : `Slide ${index + 1}`;
    this.emit("slidechange", { index, prepared });
    if (prepared.error) this.emit("slideerror", { message: prepared.error });

    await ready;
    if (generation !== this.generation) return;
    this.focusFrame();
    if (entering) {
      await nextFrame();
      if (generation !== this.generation) return;
      const ms = duration * 1000;
      this.surface.style.transition = `opacity ${ms}ms cubic-bezier(.2,.7,.2,1), transform ${ms}ms cubic-bezier(.2,.7,.2,1)`;
      this.surface.style.opacity = "1";
      this.surface.style.transform = "none";
      await delay(ms);
      if (generation === this.generation) this.resetSurface();
    }
    this.preload(index + 1);
  }

  animateSurface(effect, phase, duration) {
    const ms = duration * 1000;
    this.surface.style.transition = `opacity ${ms}ms cubic-bezier(.4,0,1,1), transform ${ms}ms cubic-bezier(.4,0,1,1)`;
    this.surface.style.opacity = "0";
    this.surface.style.transform = transitionTransform(effect, phase);
    return delay(ms);
  }

  resetSurface() {
    this.surface.style.removeProperty("transition");
    this.surface.style.removeProperty("opacity");
    this.surface.style.removeProperty("transform");
  }

  waitForReady(generation) {
    if (this.readyWaiter) this.readyWaiter.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, READY_TIMEOUT_MS);
      const waiter = { generation, resolve: done };
      this.readyWaiter = waiter;
      function done() {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  /** Warms the next slide's preparation while the audience looks at this one. */
  preload(index) {
    if (!this.deck || index >= this.deck.slides.length || this.prepared.has(index)) return;
    const run = () => {
      try {
        this.slide(index);
      } catch {
        /* surfaced when the slide is actually shown */
      }
    };
    if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 200);
  }

  focusFrame() {
    this.frame.focus();
    this.post({ command: "focus" });
  }

  post(message) {
    if (this.frame.contentWindow) this.frame.contentWindow.postMessage({ source: "slidra-host", ...message }, "*");
  }

  // Navigation ────────────────────────────────────────────────────────

  /** One step forward: the runtime decides whether that is an effect step or the next slide. */
  advance() {
    this.post({ command: "advance" });
  }

  retreat() {
    this.post({ command: "retreat" });
  }

  next() {
    if (this.deck && this.index < this.deck.slides.length - 1) return this.show(this.index + 1);
    this.emit("end");
  }

  previous() {
    if (this.index > 0) return this.show(this.index - 1);
  }

  goTo(index, options) {
    return this.show(Math.max(0, Math.min(index, this.deck.slides.length - 1)), options);
  }

  // Runtime messages ──────────────────────────────────────────────────

  onMessage(event) {
    if (!this.frame.contentWindow || event.source !== this.frame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== "slidra-player") return;
    switch (data.event) {
      case "ready":
        if (this.readyWaiter) {
          this.readyWaiter.resolve();
          this.readyWaiter = null;
        }
        this.step = data.step;
        this.emit("stepchange", { step: this.step, total: this.stepCount });
        break;
      case "step":
        this.step = data.step;
        this.emit("stepchange", { step: this.step, total: this.stepCount });
        break;
      case "advance-past-end":
        this.next();
        break;
      case "retreat-past-start":
        if (this.index > 0) this.show(this.index - 1, { startAt: "last" });
        break;
      case "exit-play":
        this.emit("escape");
        break;
      case "key":
        if (typeof data.key === "string") this.emit("key", { key: data.key });
        break;
      case "pointer":
        this.emit("pointer");
        break;
      case "error":
        if (typeof data.message === "string") this.emit("slideerror", { message: data.message });
        break;
      case "embed-boxes":
        if (Array.isArray(data.items)) this.placeEmbeds(data.items);
        break;
      case "embed-command":
        this.commandEmbed(data.id, data.command);
        break;
    }
  }

  // Third-party embeds ────────────────────────────────────────────────

  placeEmbeds(items) {
    for (const item of items) {
      const entry = this.embedEntries && Object.prototype.hasOwnProperty.call(this.embedEntries, item.id) ? this.embedEntries[item.id] : null;
      if (!entry || !item.rect) continue;
      let iframe = this.embedFrames.get(item.id);
      if (!iframe) {
        const videoId = youtubeVideoId(entry.url);
        if (!videoId) continue;
        iframe = document.createElement("iframe");
        iframe.className = "embed-frame";
        iframe.title = "Embedded video";
        iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&playsinline=1&rel=0`;
        this.embedLayer.appendChild(iframe);
        this.embedFrames.set(item.id, iframe);
      }
      const { x, y, width, height } = item.rect;
      Object.assign(iframe.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    }
  }

  commandEmbed(id, command) {
    const iframe = this.embedFrames.get(id);
    if (!iframe || !iframe.contentWindow) return;
    const func = command === "play" ? "playVideo" : command === "pause" ? "pauseVideo" : null;
    if (func) iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube-nocookie.com");
  }

  clearEmbeds() {
    for (const iframe of this.embedFrames.values()) iframe.remove();
    this.embedFrames.clear();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
