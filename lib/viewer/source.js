// A deck source: where the player reads a deck from. The player never needs
// the whole `.slidra` file; it asks a source for `project.json`, for one
// slide's markup at a time, and for a URL for each packaged file a slide or
// font needs. `deckSourceFromBytes` is the source behind the viewer, `/embed`
// and `<slidra-player src>`: a whole file in memory, files handed out as
// `data:` URLs. A server can implement the same interface and never send the
// file itself (speaker notes stripped, files at their own URLs).
//
// Everything a source returns is untrusted (format §17): project.json is
// checked here again, slide markup is prepared like any other, and a file
// URL is only ever loaded by the sandboxed slide frame, whose
// Content-Security-Policy admits exactly the URLs the source returned.

import { Deck, DeckError, FORMAT_VERSION, deckInfo, isSafeEntryPath, openDeck } from "./deck.js";
import { slideIdOf } from "./links.js";
import { LruCache } from "./lru.js";

/** How many files fetched for drawing slides as images (thumbnails, printing) are kept as data: URLs. */
const IMAGE_DATA_URLS = 48;

/**
 * Where the player reads a deck from. Every member may be called at any time
 * and more than once; the player caches what it needs.
 *
 * - `project()`: the parsed `project.json`. A source may validate it; the
 *   player checks it again, because it treats a source as untrusted.
 * - `slide(path)`: the SVG markup of one slide listed in `project.slides`,
 *   fetched when the player needs it (the current slide and its neighbours,
 *   a thumbnail, a printout). A source may strip speaker notes first.
 * - `fileUrl(path)`: a URL the slide frame may load for a packaged file
 *   (a font, image, video or audio file), or null when the deck has no such
 *   file. `data:` and `blob:` URLs are loaded as they are; for an `https:` (or
 *   `http:`) URL the frame's Content-Security-Policy admits that exact URL.
 *   A source's own file URLs are not a deck's remote content (format §13):
 *   they load without the viewer's consent.
 * - `slideIds()` (optional): each slide's `data-slidra-slide-id`, in slide
 *   order (null for a slide without one). Links to a slide (format §4.8)
 *   resolve with it; a source without it has links resolved by reading slides
 *   in order when such a link is followed.
 * - `presenter()` (optional): a structured-cloneable descriptor another
 *   window can open the same deck from (see `startPresenter({ openSource })`
 *   in lib/viewer/presenter.js). A source without it, and not backed by
 *   bytes, cannot be shown in a presenter view.
 *
 * @typedef {{
 *   project: () => Promise<object>,
 *   slide: (path: string) => Promise<string>,
 *   fileUrl: (path: string) => Promise<string | null> | string | null,
 *   slideIds?: () => Promise<(string | null)[]>,
 *   presenter?: () => unknown,
 * }} DeckSource
 */

/**
 * A source backed by a whole `.slidra` file in memory (what `openDeck`
 * reads). Files are handed out as `data:` URLs, so a self-contained deck
 * makes no network requests at all.
 * @param {Uint8Array} bytes
 * @param {{ fileName?: string, limits?: Partial<import("./deck.js").DeckLimits> }} [options]
 * @returns {Promise<BytesDeckSource>}
 */
export async function deckSourceFromBytes(bytes, options = {}) {
  return new BytesDeckSource(await openDeck(bytes, options), bytes);
}

/** The source for an already opened Deck. `bytes` (the file) lets a presenter view get its own copy. */
export class BytesDeckSource {
  /**
   * @param {Deck} deck
   * @param {Uint8Array | null} [bytes]
   */
  constructor(deck, bytes = null) {
    this.deck = deck;
    this.bytes = bytes;
  }

  async project() {
    return this.deck.project;
  }

  /** @param {string} path */
  async slide(path) {
    return this.deck.readText(path);
  }

  /** @param {string} path */
  fileUrl(path) {
    return this.deck.hasFile(path) ? this.deck.dataUrl(path) : null;
  }

  async slideIds() {
    return this.deck.slides.map((path) => slideIdOf(this.deck.readText(path)));
  }
}

/** URL schemes a source may hand out for a file. Anything else is ignored. */
const FILE_URL = /^(?:data|blob|https?):/i;

/**
 * A file URL a source returned, or null when it is not one the frame may
 * load. Quotes, parentheses, backslashes, angle brackets and whitespace are
 * percent-encoded, so the URL can sit in a CSS `url("…")` or an attribute
 * as it is.
 */
export function checkFileUrl(value) {
  if (typeof value !== "string" || !FILE_URL.test(value.trim())) return null;
  let url = value.trim();
  if (!/^data:/i.test(url)) {
    try {
      url = new URL(url).href;
    } catch {
      return null;
    }
  }
  return url.replace(/["'()\\<>\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Checks a project.json that came from a source (format §2) the way the
 * container readers do, less what only a container can know (which entries
 * exist). Unknown fields are kept.
 * @returns {import("./deck.js").ProjectJson}
 */
export function checkSourceProject(project) {
  if (project === null || typeof project !== "object" || Array.isArray(project)) throw new DeckError("project.json must be a JSON object.");
  const version = project.formatVersion;
  if (!Number.isInteger(version) || version < 1 || version > FORMAT_VERSION) throw new DeckError(`This deck's formatVersion (${JSON.stringify(version)}) is not one this viewer plays.`);
  if (typeof project.name !== "string") throw new DeckError("project.json name must be a string.");
  const canvas = project.canvas;
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0) || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)) {
    throw new DeckError("project.json canvas must have positive width and height.");
  }
  if (!Array.isArray(project.slides)) throw new DeckError("project.json slides must be an array.");
  for (const slide of project.slides) {
    if (!isSafeEntryPath(slide)) throw new DeckError(`project.json lists an invalid slide path: ${JSON.stringify(slide)}`);
  }
  if (project.fonts !== undefined) {
    if (!Array.isArray(project.fonts)) throw new DeckError("project.json fonts must be an array.");
    for (const font of project.fonts) {
      if (!font || !isSafeEntryPath(font.file)) throw new DeckError(`project.json lists an invalid font file: ${JSON.stringify(font && font.file)}`);
    }
  }
  return project;
}

/** The face an older deck without a `fonts` field still gets when the file is there (see Deck#fonts). */
const FALLBACK_FONT = "fonts/NotoSansTC-Presentation.ttf";

/**
 * A deck as the player reads it: the checked project.json up front, and
 * slides and files on demand from its source.
 */
export class PlayableDeck {
  /**
   * @param {DeckSource} source
   * @param {import("./deck.js").ProjectJson} project
   * @param {{ fileName?: string | null, container?: string | null }} [info]
   */
  constructor(source, project, info = {}) {
    this.source = source;
    this.project = project;
    this.fileName = info.fileName ?? null;
    this.container = info.container ?? null;
    /** @type {Map<string, Promise<string | null>>} */
    this.fileUrls = new Map();
    /** @type {Promise<(string | null)[] | null> | null} */
    this.ids = null;
    /** @type {import("./deck.js").DeckInfo | null} */
    this.cachedInfo = null;
    /** File URL -> Promise of its data: URL (or null), for drawing slides as images. */
    this.imageDataUrls = new LruCache(IMAGE_DATA_URLS);
  }

  /**
   * Opens a source: reads and checks project.json, nothing else.
   * @param {DeckSource} source
   * @param {{ fileName?: string }} [options]
   */
  static async open(source, options = {}) {
    if (source instanceof BytesDeckSource) return PlayableDeck.fromDeck(source.deck, source);
    if (!source || typeof source.project !== "function" || typeof source.slide !== "function" || typeof source.fileUrl !== "function") {
      throw new DeckError("This is not a deck source: it needs project(), slide(path) and fileUrl(path).");
    }
    let project;
    try {
      project = await source.project();
    } catch (error) {
      throw new DeckError(`The deck could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new PlayableDeck(source, checkSourceProject(project), { fileName: options.fileName });
  }

  /**
   * An opened Deck as a PlayableDeck, synchronously.
   * @param {Deck} deck
   * @param {BytesDeckSource} [source]
   */
  static fromDeck(deck, source = new BytesDeckSource(deck)) {
    return new PlayableDeck(source, deck.project, { fileName: deck.fileName, container: deck.container });
  }

  /** The Deck behind a bytes-backed source, or null. */
  get bytesDeck() {
    return this.source instanceof BytesDeckSource ? this.source.deck : null;
  }

  get name() {
    return this.project.name;
  }

  get canvas() {
    return this.project.canvas;
  }

  get slides() {
    return this.project.slides;
  }

  get lang() {
    return typeof this.project.lang === "string" ? this.project.lang : null;
  }

  /** Document metadata (spec §2.1), read leniently. */
  get info() {
    if (!this.cachedInfo) this.cachedInfo = deckInfo(this.project);
    return this.cachedInfo;
  }

  /** Slide `index`'s markup, from the source. */
  async slideMarkup(index) {
    const text = await this.source.slide(this.slides[index]);
    if (typeof text !== "string") throw new DeckError(`${this.slides[index]} could not be read.`);
    return text;
  }

  /**
   * A URL the slide frame may load for packaged file `path`, or null. Asked
   * of the source once per path (a deck in memory: every time, from its own cache).
   * @param {string} path
   * @returns {Promise<string | null>}
   */
  fileUrl(path) {
    // A deck in memory keeps its data: URLs in its own bounded cache.
    if (this.source instanceof BytesDeckSource) return Promise.resolve(this.source.fileUrl(path));
    let pending = this.fileUrls.get(path);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.source.fileUrl(path))
        .then(checkFileUrl, () => null);
      this.fileUrls.set(path, pending);
    }
    return pending;
  }

  /**
   * Registered fonts with the URL each loads from (spec §8); a font whose
   * file the source does not have is left out.
   * @returns {Promise<{ family: string, file: string, url: string }[]>}
   */
  async fonts() {
    const fonts = this.project.fonts;
    const listed =
      Array.isArray(fonts) && fonts.length > 0 ? fonts.filter((font) => font && typeof font.file === "string" && typeof font.family === "string") : [{ file: FALLBACK_FONT, family: "Noto Sans TC" }];
    const urls = await Promise.all(listed.map((font) => this.fileUrl(font.file)));
    return listed.map((font, i) => ({ family: font.family, file: font.file, url: urls[i] })).filter((font) => font.url !== null);
  }

  /**
   * Each slide's id, when they can be known without reading every slide
   * (the source says, or the deck is in memory anyway); null otherwise.
   * @returns {Promise<(string | null)[] | null>}
   */
  slideIds() {
    if (!this.ids) {
      const source = this.source;
      this.ids =
        typeof source.slideIds === "function"
          ? Promise.resolve(source.slideIds())
              .then((ids) => (Array.isArray(ids) ? ids.map((id) => (typeof id === "string" ? id : null)) : null))
              .catch(() => null)
          : Promise.resolve(null);
    }
    return this.ids;
  }

  /**
   * The position of the slide with `data-slidra-slide-id` = `id` (spec §3),
   * or -1. Without `slideIds()`, reads slides in order until one matches.
   */
  async slideIndexById(id) {
    if (this.bytesDeck) return this.bytesDeck.slideIndexById(id);
    const ids = await this.slideIds();
    if (ids) return ids.indexOf(id);
    for (let index = 0; index < this.slides.length; index++) {
      try {
        if (slideIdOf(await this.slideMarkup(index)) === id) return index;
      } catch {
        /* an unreadable slide is not the one */
      }
    }
    return -1;
  }

  /**
   * `text` with each of `urls` (file URLs this deck's source returned) that
   * is not already a `data:` URL replaced by one holding the file, fetched
   * by the page. A slide drawn as an image (thumbnails, printing, export)
   * loads nothing itself. A file that cannot be fetched is left as it is.
   * @param {string} text
   * @param {string[]} urls
   * @returns {Promise<string>}
   */
  async inlineFiles(text, urls) {
    const remote = [...new Set(urls)].filter((url) => !/^data:/i.test(url) && text.includes(url.split("&")[0]));
    if (remote.length === 0) return text;
    const inlined = await Promise.all(remote.map((url) => this.dataUrlFor(url)));
    remote.forEach((url, i) => {
      if (!inlined[i]) return;
      // Serialized markup escapes & in attributes and text; CSS does not.
      text = text.split(url).join(inlined[i]);
      if (url.includes("&")) text = text.split(url.replace(/&/g, "&amp;")).join(inlined[i]);
    });
    return text;
  }

  /** @param {string} url @returns {Promise<string | null>} */
  dataUrlFor(url) {
    let pending = this.imageDataUrls.get(url);
    if (!pending) {
      pending = fetch(url)
        .then(async (response) => {
          if (!response.ok) return null;
          const type = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
          return `data:${/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream"};base64,${base64(new Uint8Array(await response.arrayBuffer()))}`;
        })
        .catch(() => null);
      this.imageDataUrls.set(url, pending);
    }
    return pending;
  }

  /** A descriptor for another window's copy of this deck, or undefined when the source has none. */
  presenterDescriptor() {
    return typeof this.source.presenter === "function" ? this.source.presenter() : undefined;
  }
}

/** Opens a source, or wraps an opened Deck, as the PlayableDeck the player reads. */
export async function openSource(sourceOrDeck, options = {}) {
  if (sourceOrDeck instanceof PlayableDeck) return sourceOrDeck;
  if (sourceOrDeck instanceof Deck) return PlayableDeck.fromDeck(sourceOrDeck);
  return PlayableDeck.open(sourceOrDeck, options);
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
