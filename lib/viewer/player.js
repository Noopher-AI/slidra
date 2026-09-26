// The host half of the player: owns the sandboxed slide frame, moves
// between slides with their page transitions, relays the runtime's
// messages, and keeps third-party embeds aligned over their placeholders.
// It reads its deck through a deck source (lib/viewer/source.js) and asks
// it only for the slides it shows, prepares next, or draws.

import { fontFaceCss, fontFaceRules, playDocument } from "./frame.js";
import { LruCache } from "./lru.js";
import { planMorph } from "./morph.js";
import { loadSlide, prepareSlide, youtubeVideoId } from "./slide.js";
import { PlayableDeck } from "./source.js";
import { renderThumbnail } from "./thumbnail.js";

const READY_TIMEOUT_MS = 2000;
const SNAPSHOT_TIMEOUT_MS = 400;
const PREPARED_SLIDES = 12;

/** The resting-state transform a page transition starts from (enter) or ends at (exit) — spec/playback.md §5. */
export function transitionTransform(effect, phase) {
  if (effect === "slide") return phase === "enter" ? "translateX(8%)" : "translateX(-8%)";
  if (effect === "zoom") return phase === "enter" ? "scale(1.06)" : "scale(0.94)";
  return "none";
}

export class Player extends EventTarget {
  /**
   * @param {{ frame: HTMLIFrameElement, surface: HTMLElement, embedLayer: HTMLElement, runtimeSource: string, muted?: boolean, embeds?: boolean }} parts
   *   `surface` is the element page transitions animate (it wraps the frame and the embed layer).
   *   `muted` silences every media element (a presenter view's copy, playback §6.1); `embeds: false` places no third-party players.
   */
  constructor({ frame, surface, embedLayer, runtimeSource, muted = false, embeds = true }) {
    super();
    this.frame = frame;
    this.surface = surface;
    this.embedLayer = embedLayer;
    this.runtimeSource = runtimeSource;
    this.muted = muted;
    // Reduced motion (playback §9): effects and page transitions become instant.
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.reducedMotion = query ? query.matches : false;
    if (query && typeof query.addEventListener === "function") query.addEventListener("change", (event) => (this.reducedMotion = event.matches));
    this.embedsEnabled = embeds;
    /** @type {PlayableDeck | null} */
    this.deck = null;
    this.index = -1;
    this.step = -1;
    this.stepCount = 0;
    this.current = null;
    this.generation = 0;
    this.exiting = false;
    // Prepared slides hold their assets inlined, so only the neighbourhood of the current slide is kept.
    /** @type {LruCache} index -> Promise of the prepared slide */
    this.prepared = new LruCache(PREPARED_SLIDES);
    /** @type {Map<number, Promise<string>>} */
    this.thumbnails = new Map();
    /** @type {Promise<unknown>} */
    this.thumbnailQueue = Promise.resolve();
    this.fontCss = "";
    this.fonts = "";
    /** The deck source's file URLs the fonts load from (none for a deck in memory: its fonts are data: URLs). */
    this.fontFiles = [];
    /** @type {Promise<void>} */
    this.fontsReady = Promise.resolve();
    this.embedFrames = new Map();
    this.readyWaiter = null;
    this.snapshotWaiter = null;
    this.keysHeld = false;
    /** Whether a slide that finishes loading may take keyboard focus (the host says no while a dialog is open). */
    this.canTakeFocus = () => true;
    /** Whether this deck may load network resources (format §13); off until the viewer allows it. */
    this.allowRemote = false;
    this.snapshotRequests = 0;
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener("message", this.onMessage);
  }

  destroy() {
    this.dropThumbnails();
    window.removeEventListener("message", this.onMessage);
    this.generation++;
    this.clearEmbeds();
    this.frame.srcdoc = "";
    this.deck = null;
  }

  /**
   * Plays `deck`: an opened deck source (PlayableDeck, lib/viewer/source.js)
   * or a Deck read from bytes (openDeck), which plays exactly as before.
   * Nothing but project.json has to be read yet; fonts and slides come on
   * demand.
   * @param {PlayableDeck | import("./deck.js").Deck} deck
   */
  load(deck) {
    this.dropThumbnails();
    const playable = deck instanceof PlayableDeck ? deck : PlayableDeck.fromDeck(deck);
    this.deck = playable;
    this.prepared.clear();
    this.index = -1;
    this.fontFiles = [];
    const bytes = playable.bytesDeck;
    if (bytes) {
      this.setFontCss(fontFaceCss(bytes));
      this.fontsReady = Promise.resolve();
    } else {
      this.setFontCss("");
      this.fontsReady = playable
        .fonts()
        .then((fonts) => {
          if (this.deck !== playable) return;
          this.setFontCss(fontFaceRules(fonts));
          this.fontFiles = fonts.map((font) => font.url);
        })
        .catch(() => {});
    }
  }

  setFontCss(css) {
    this.fontCss = css;
    this.fonts = css ? `<style>${css}</style>` : "";
  }

  /**
   * `text` (prepared markup, or font CSS) with every one of the deck source's
   * file URLs in `files` replaced by a `data:` URL, for drawing as an image
   * (an SVG image loads nothing). A deck in memory has only data: URLs already.
   * @param {string} text
   * @param {string[]} files
   */
  async forImage(text, files) {
    return this.deck ? this.deck.inlineFiles(text, files) : text;
  }

  /** The deck's @font-face rules ready for drawing as an image (see forImage). */
  async imageFontCss() {
    await this.fontsReady;
    return this.forImage(this.fontCss, this.fontFiles);
  }

  /** A prepared slide's markup (or `markup` derived from it) ready for drawing as an image. */
  imageMarkup(prepared, markup = prepared.markup) {
    return this.forImage(markup, prepared.files ?? []);
  }

  /**
   * A PNG thumbnail of slide `index` as an object URL, rendered once per deck
   * and one at a time (an overview of a large deck asks for many at once).
   */
  thumbnail(index) {
    let pending = this.thumbnails.get(index);
    if (!pending) {
      const deck = this.deck;
      pending = this.thumbnailQueue.then(async () => {
        if (this.deck !== deck) throw new Error("the deck was closed");
        const prepared = await this.slide(index);
        const [markup, fontCss] = await Promise.all([this.imageMarkup(prepared), this.imageFontCss()]);
        if (this.deck !== deck) throw new Error("the deck was closed");
        return renderThumbnail(markup, fontCss, deck.canvas);
      });
      this.thumbnailQueue = pending.catch(() => {});
      this.thumbnails.set(index, pending);
    }
    return pending;
  }

  dropThumbnails() {
    for (const pending of this.thumbnails.values()) pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    this.thumbnails.clear();
    this.thumbnailQueue = Promise.resolve();
  }

  /**
   * The prepared slide (markup, plan, notes, transition), memoised: read from
   * the deck source the first time. A slide that could not be read is not
   * kept, so asking again asks the source again.
   * @param {number} index
   * @returns {Promise<import("./slide.js").PreparedSlide>}
   */
  slide(index) {
    let pending = this.prepared.get(index);
    if (!pending) {
      const deck = this.deck;
      const bytes = deck.bytesDeck;
      pending = bytes ? Promise.resolve().then(() => prepareSlide(bytes, index)) : loadSlide(deck, index);
      this.prepared.set(index, pending);
      const settled = pending;
      pending.catch(() => {
        if (this.prepared.map.get(index) === settled) this.prepared.delete(index);
      });
    }
    return pending;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Shows slide `index`. `startAt: "last"` lands on its final step (arriving
   * backwards), a number lands on that step (-1: the opening state). Only a forward move plays the outgoing page's exit
   * transition; every arrival plays the incoming page's enter transition.
   */
  async show(index, { startAt = "first", animate = true } = {}) {
    if (!this.deck || index < 0 || index >= this.deck.slides.length) return;
    const forward = index > this.index && this.index !== -1;
    if (this.exiting) return;
    const generation = ++this.generation;
    let prepared;
    try {
      [prepared] = await Promise.all([this.slide(index), this.fontsReady]);
    } catch (error) {
      if (generation === this.generation) this.emit("slideerror", { message: `Slide ${index + 1} could not be read: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (generation !== this.generation) return;
    // Morph (playback §5.1) needs another slide on screen; the incoming slide's arrival replaces the outgoing exit edge.
    const morphing = animate && !this.reducedMotion && prepared.plan !== null && prepared.transition.enter.effect === "morph" && prepared.transition.enter.duration > 0 && this.current !== null;

    let morph = null;
    if (morphing) {
      this.exiting = true;
      const shot = await this.requestSnapshot();
      this.exiting = false;
      if (generation !== this.generation) return;
      if (shot) morph = this.planMorph(this.current, shot, prepared);
    } else if (animate && !this.reducedMotion && forward && this.current) {
      const { effect, duration } = this.current.transition.exit;
      if (effect !== "none" && duration > 0) {
        this.exiting = true;
        await this.animateSurface(effect, "exit", duration);
        this.exiting = false;
        if (generation !== this.generation) return;
      }
    }

    // The frame may load the deck source's files this slide, its fonts and (for a morph) the outgoing slide's ghosts use; nothing else.
    const files = [...this.fontFiles, ...prepared.files, ...(morph && this.current ? this.current.files : [])];
    this.index = index;
    this.current = prepared;
    const plan = {
      ...(prepared.plan ?? { steps: [], hidden: [], hideSelectors: {}, media: {}, stageMedia: {}, embedIds: [], triggers: {}, triggerIds: [] }),
      linkIds: Object.keys(prepared.links),
      morph,
      muted: this.muted,
      reducedMotion: this.reducedMotion,
    };
    const startStep =
      typeof startAt === "number"
        ? Math.max(-1, Math.min(startAt, plan.steps.length - 1))
        : startAt === "last"
          ? plan.steps.length - 1
          : startAt === "current"
            ? Math.min(this.step, plan.steps.length - 1)
            : -1;
    this.step = startStep;
    this.stepCount = plan.steps.length;

    this.clearEmbeds();
    this.embedEntries = prepared.embeds;

    // A morph with nothing to morph from (the first slide shown, a frame that did not answer) plays as a fade.
    const { duration } = prepared.transition.enter;
    const effect = prepared.transition.enter.effect === "morph" ? (morph ? "none" : "fade") : prepared.transition.enter.effect;
    const entering = animate && !this.reducedMotion && effect !== "none" && duration > 0;
    if (entering) {
      this.surface.style.transition = "none";
      this.surface.style.opacity = "0";
      this.surface.style.transform = transitionTransform(effect, "enter");
    } else {
      this.resetSurface();
    }

    delete this.frame.dataset.readySlide;
    const ready = this.waitForReady(generation);
    this.frame.srcdoc = playDocument(prepared.markup, this.fonts, plan, startStep, this.runtimeSource, { lang: prepared.lang, allowRemote: this.allowRemote, files });
    this.frame.title = prepared.title ? `Slide ${index + 1}: ${prepared.title}` : `Slide ${index + 1}`;
    this.emit("slidechange", { index, prepared });
    if (prepared.error) this.emit("slideerror", { message: prepared.error });
    for (const message of prepared.warnings) this.emit("slidewarning", { message });

    await ready;
    if (generation !== this.generation) return;
    if (this.keysHeld) this.post({ command: "hold-keys", hold: true });
    // Marks the frame as showing slide `index + 1`, ready for input (tools and tests wait on it).
    this.frame.dataset.readySlide = String(index + 1);
    if (this.canTakeFocus()) this.focusFrame();
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

  /**
   * Lets the deck load its network resources (or stops it), re-rendering the
   * current slide at its current step when that changes what it shows.
   */
  setAllowRemote(allow) {
    if (this.allowRemote === allow) return;
    this.allowRemote = allow;
    if (this.current && this.current.remote.length > 0) this.show(this.index, { startAt: "current", animate: false });
  }

  /** Asks the current slide's runtime what it shows (for a morph); null when it does not answer in time. */
  requestSnapshot() {
    const requestId = ++this.snapshotRequests;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshotWaiter = null;
        resolve(null);
      }, SNAPSHOT_TIMEOUT_MS);
      this.snapshotWaiter = {
        requestId,
        resolve: (value) => {
          clearTimeout(timer);
          this.snapshotWaiter = null;
          resolve(value);
        },
      };
      this.post({ command: "snapshot", requestId });
    });
  }

  planMorph(outgoing, shot, incoming) {
    try {
      const parse = (markup) => new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
      const serializer = new XMLSerializer();
      return planMorph(parse(outgoing.markup), shot, parse(incoming.markup), incoming.plan.hidden, incoming.transition.enter.duration, { serialize: (node) => serializer.serializeToString(node) });
    } catch (error) {
      this.emit("slidewarning", { message: `morph transition skipped: ${error.message}` });
      return null;
    }
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
    const deck = this.deck;
    const run = () => {
      if (this.deck !== deck) return;
      // A failure is surfaced when the slide is actually shown.
      this.slide(index).catch(() => {});
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

  /** Routes every key pressed in the slide to the host (true) or lets the slide act on its own keys again (false). */
  holdKeys(hold) {
    this.keysHeld = hold;
    this.post({ command: "hold-keys", hold });
  }

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
      case "print":
        this.emit("print");
        break;
      case "key":
        if (typeof data.key === "string") this.emit("key", { key: data.key });
        break;
      case "pointer": {
        const inside = (n) => typeof n === "number" && n >= 0 && n <= 1;
        this.emit("pointer", inside(data.x) && inside(data.y) ? { x: data.x, y: data.y } : {});
        break;
      }
      case "error":
        if (typeof data.message === "string") this.emit("slideerror", { message: data.message });
        break;
      case "embed-boxes":
        if (Array.isArray(data.items)) this.placeEmbeds(data.items);
        break;
      case "embed-command":
        this.commandEmbed(data.id, data.command);
        break;
      case "snapshot":
        if (this.snapshotWaiter && data.requestId === this.snapshotWaiter.requestId && data.elements && typeof data.elements === "object") {
          this.snapshotWaiter.resolve({ elements: sanitizeSnapshot(data.elements), background: typeof data.background === "string" ? data.background : null });
        }
        break;
      case "link":
        if (typeof data.id === "string") this.followLink(data.id);
        break;
    }
  }

  /**
   * Follows the link on element `id` of the current slide (spec §4.8). Only
   * links the host itself parsed are followed; the runtime sends an id, never
   * a URL.
   */
  followLink(id) {
    const links = this.current ? this.current.links : null;
    if (!links || !Object.prototype.hasOwnProperty.call(links, id)) return;
    const link = links[id];
    this.emit("link", { link });
    if (link.kind === "external") {
      window.open(link.url, "_blank", "noopener,noreferrer");
    } else if (link.kind === "slide") {
      const deck = this.deck;
      deck.slideIndexById(link.slideId).then((index) => {
        if (index !== -1 && this.deck === deck) this.show(index);
      });
    } else if (link.action === "next") {
      this.next();
    } else if (link.action === "previous") {
      this.previous();
    } else if (link.action === "first") {
      this.show(0);
    } else if (link.action === "last") {
      this.show(this.deck.slides.length - 1);
    }
  }

  // Third-party embeds ────────────────────────────────────────────────

  placeEmbeds(items) {
    // A third-party player is a network resource too: none until the viewer allows them.
    if (!this.allowRemote || !this.embedsEnabled) return;
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

/**
 * The runtime's snapshot, rebuilt from plain numbers only: it crossed the
 * frame boundary, so nothing in it is trusted beyond its shape.
 */
export function sanitizeSnapshot(elements) {
  const clean = Object.create(null);
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  for (const id of Object.keys(elements)) {
    const item = elements[id];
    if (!item || !item.box || !Array.isArray(item.matrix) || item.matrix.length !== 6 || !item.matrix.every(finite)) continue;
    const { x, y, width, height } = item.box;
    if (![x, y, width, height, item.opacity].every(finite)) continue;
    clean[id] = { box: { x, y, width, height }, matrix: item.matrix.slice(), opacity: Math.max(0, Math.min(1, item.opacity)) };
  }
  return clean;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
