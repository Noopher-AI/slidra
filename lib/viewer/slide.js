// Turns one slide of a Deck into everything the player needs: the slide
// markup with dynamic text substituted and every deck-local reference
// inlined, plus the play plan (steps, pre-hidden targets, media, embeds),
// the page transition, and the speaker notes. Uses the browser's DOMParser
// by default; Node tools pass an implementation to useDom() (see
// lib/node-dom.js), and every DOM call here is one both provide.

import { applyAccessibility, slideAccessibility } from "./a11y.js";
import { NAMESPACE } from "./deck.js";
import { parseLink } from "./links.js";
import { DEFAULT_TRANSITION, EffectError, cssEscapeId, deriveSteps, deriveTriggers, enterTargets, validateEffect, validateTransition } from "./effects.js";

const XLINK_NS = "http://www.w3.org/1999/xlink";
const URL_ATTRIBUTES = ["href", "src", "poster", "data-slidra-media"];
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** @type {{ DOMParser: typeof DOMParser, XMLSerializer: typeof XMLSerializer } | null} */
let domImpl = null;

/** Sets the DOMParser/XMLSerializer pair slides are parsed with (Node has none of its own). */
export function useDom(impl) {
  domImpl = impl;
}

const dom = () => domImpl ?? globalThis;

/** The slide's root `<svg>`, or null when the source is not well-formed SVG. */
function parseSvg(source) {
  let doc;
  try {
    doc = new (dom().DOMParser)().parseFromString(source, "image/svg+xml");
  } catch {
    return null;
  }
  const root = doc && doc.documentElement;
  if (!root || doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") return null;
  return root;
}

/** Every element under `root` in document order (not `root` itself). */
function elementsUnder(root) {
  const out = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const withAttribute = (root, name) => elementsUnder(root).filter((el) => el.hasAttribute(name));
const elementChildren = (el) => Array.from(el.childNodes).filter((node) => node.nodeType === 1);

export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".ogv"];
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".opus", ".oga", ".aac"];

/**
 * @typedef {{ effects: object[] }} Step
 * @typedef {{ effect: string, duration: number }} TransitionEdge
 * @typedef {{
 *   steps: Step[], hidden: string[], hideSelectors: Record<string, string>, media: object, stageMedia: object,
 *   embedIds: string[], triggers: Record<string, Step[]>, triggerIds: string[]
 * }} SlidePlan
 * @typedef {{
 *   path: string, markup: string, notes: string, transition: { enter: TransitionEdge, exit: TransitionEdge },
 *   plan: SlidePlan | null, error: string | null, embeds: Record<string, {provider: string, url: string}>,
 *   title: string | null, lang: string | null, accessibility: import("./a11y.js").SlideAccessibility | null,
 *   links: Record<string, import("./links.js").Link>, warnings: string[], remote: string[], files: string[]
 * }} PreparedSlide
 * `files` lists the URLs of the deck's own files the markup now references
 * (the deck source's file URLs; `data:` URLs for a deck read from bytes).
 *
 * What preparing a slide needs to know about its deck.
 * `slideIndexById` answers -1 for an unknown id, or null when it cannot say
 * yet (the link is then kept and resolved when it is followed).
 * @typedef {{
 *   slides: string[], name: string, canvas: { width: number, height: number }, lang: string | null,
 *   slideIndexById: (id: string) => number | null
 * }} SlideContext
 */

/**
 * Prepares slide `index` of an in-memory Deck, synchronously, with every
 * deck-local reference inlined as a `data:` URL.
 * @param {import("./deck.js").Deck} deck
 * @param {number} index
 * @returns {PreparedSlide}
 * `plan` is null (and `error` says why) when the effect list or transition
 * is malformed: the slide still shows, statically, with no animation.
 */
export function prepareSlide(deck, index) {
  const context = {
    slides: deck.slides,
    name: deck.name,
    canvas: deck.canvas,
    lang: typeof deck.project.lang === "string" ? deck.project.lang : null,
    slideIndexById: (id) => deck.slideIndexById(id),
  };
  const path = deck.slides[index];
  return prepareParsed(context, index, parseSvg(deck.readText(path)), (file) => (deck.hasFile(file) ? deck.dataUrl(file) : null));
}

/**
 * Prepares slide `index` of a deck read through a source
 * (lib/viewer/source.js): fetches its markup, asks the source for a URL for
 * each file it references, and learns slide ids only when the slide links
 * to another slide.
 * @param {import("./source.js").PlayableDeck} deck
 * @param {number} index
 * @returns {Promise<PreparedSlide>}
 */
export async function loadSlide(deck, index) {
  const path = deck.slides[index];
  const root = parseSvg(await deck.slideMarkup(index));
  const urls = new Map();
  /** @type {(string | null)[] | null} */
  let ids = null;
  if (root) {
    const files = [...deckPathsIn(root, path)];
    const resolved = await Promise.all(files.map((file) => deck.fileUrl(file)));
    files.forEach((file, i) => urls.set(file, resolved[i]));
    if (withAttribute(root, "data-slidra-link").some((el) => (parseLink(el.getAttribute("data-slidra-link")) ?? {}).kind === "slide")) ids = await deck.slideIds();
  }
  const context = {
    slides: deck.slides,
    name: deck.name,
    canvas: deck.canvas,
    lang: deck.lang,
    slideIndexById: (id) => (ids ? ids.indexOf(id) : null),
  };
  return prepareParsed(context, index, root, (file) => urls.get(file) ?? null);
}

/**
 * @param {SlideContext} deck
 * @param {number} index
 * @param {Element | null} root the slide's parsed `<svg>`, null when it is not well-formed
 * @param {(path: string) => string | null} fileUrl a URL for a deck file, or null when the deck has none
 * @returns {PreparedSlide}
 */
function prepareParsed(deck, index, root, fileUrl) {
  const path = deck.slides[index];
  if (!root) {
    return {
      path,
      markup: errorSlideMarkup(deck, `${path} is not well-formed SVG`),
      notes: "",
      transition: DEFAULT_TRANSITION,
      plan: null,
      error: `${path} is not well-formed SVG, so it cannot be shown.`,
      embeds: {},
      title: null,
      lang: deck.lang,
      accessibility: null,
      links: {},
      warnings: [],
      remote: [],
      files: [],
    };
  }

  substituteDynamicText(root, {
    slide_number: String(index + 1),
    slide_total: String(deck.slides.length),
    presentation_name: deck.name,
  });

  const notes = readNotes(root);
  const warnings = [];
  const links = readLinks(root, deck, path, warnings);
  const accessibility = slideAccessibility(root, { lang: deck.lang });
  const embeds = stageEmbedsFor(root);
  let plan = null;
  let transition = DEFAULT_TRANSITION;
  let error = null;
  try {
    const ids = collectIds(root);
    const effects = readEffects(root, ids);
    const steps = deriveSteps(effects);
    const triggers = deriveTriggers(effects);
    transition = readTransition(root);
    const hidden = enterTargets(effects);
    const hideSelectors = Object.create(null);
    for (const id of hidden) hideSelectors[id] = `#${cssEscapeId(id)}`;
    plan = {
      steps,
      hidden,
      hideSelectors,
      media: mediaCuesFor(root, effects),
      stageMedia: stageMediaFor(root),
      embedIds: Object.keys(embeds),
      triggers,
      triggerIds: Object.keys(triggers),
    };
  } catch (caught) {
    if (!(caught instanceof EffectError)) throw caught;
    error = `${path}: ${caught.message}`;
    transition = DEFAULT_TRANSITION;
  }

  const files = new Set();
  const remote = resolveDeckReferences(root, path, (file) => {
    const url = fileUrl(file);
    if (url) files.add(url);
    return url;
  });
  for (const embed of Object.values(embeds)) remote.add(embed.url);
  if (plan) {
    // Cue sources were read before resolving (their extension decides the
    // kind); the runtime needs the URL the markup now holds.
    for (const table of [plan.media, plan.stageMedia]) {
      for (const id of Object.keys(table)) {
        const el = findById(root, id);
        const src = el && el.getAttribute("data-slidra-media");
        if (src) table[id].src = src;
      }
    }
  }

  applyAccessibility(root, accessibility);
  return {
    path,
    markup: new (dom().XMLSerializer)().serializeToString(root),
    notes,
    transition,
    plan,
    error,
    embeds,
    title: accessibility.title,
    lang: accessibility.lang,
    accessibility,
    links,
    warnings,
    remote: [...remote],
    files: [...files],
  };
}

/**
 * Spec §4.8: every element container's `data-slidra-link`, keyed by element
 * id. A link the spec says to ignore is dropped with a warning; it never
 * makes the slide corrupt.
 */
function readLinks(root, deck, path, warnings) {
  const links = Object.create(null);
  for (const el of withAttribute(root, "data-slidra-link")) {
    const id = el.getAttribute("id");
    const value = el.getAttribute("data-slidra-link");
    const link = parseLink(value);
    if (!id || !link) {
      warnings.push(`${path}: ignoring link ${JSON.stringify(value)}${id ? ` on ${id}` : " on an element with no id"}.`);
      continue;
    }
    // An id the deck cannot place yet (null) is kept, and resolved when the link is followed.
    if (link.kind === "slide" && deck.slideIndexById(link.slideId) === -1) {
      warnings.push(`${path}: ignoring link to #${link.slideId} on ${id}: no slide has that id.`);
      continue;
    }
    links[id] = link;
  }
  return links;
}

/** Every `id` in the document. Built once rather than trusting getElementById on an XML document from untrusted input. */
function collectIds(root) {
  const ids = new Set();
  for (const el of withAttribute(root, "id")) ids.add(el.getAttribute("id"));
  if (root.hasAttribute("id")) ids.add(root.getAttribute("id"));
  return ids;
}

function findById(root, id) {
  for (const el of withAttribute(root, "id")) {
    if (el.getAttribute("id") === id) return el;
  }
  return null;
}

/** The `slidra:*` elements named `localName` that sit inside a `<metadata>` block (spec §5). */
function metadataChildren(root, localName) {
  const found = [];
  for (const metadata of Array.from(root.getElementsByTagNameNS("http://www.w3.org/2000/svg", "metadata"))) {
    for (const el of Array.from(metadata.getElementsByTagNameNS(NAMESPACE, localName))) found.push(el);
  }
  return found;
}

function attr(el, name) {
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

export function readEffects(root, ids) {
  const effects = [];
  for (const block of metadataChildren(root, "effects")) {
    for (const child of elementChildren(block)) {
      if (child.namespaceURI !== NAMESPACE || child.localName !== "effect") continue;
      const raw = {
        target: attr(child, "target"),
        family: attr(child, "family"),
        effect: attr(child, "effect"),
        start: attr(child, "start"),
        duration: attr(child, "duration"),
        delay: attr(child, "delay"),
        d: attr(child, "d"),
        easing: attr(child, "easing"),
        repeat: attr(child, "repeat"),
        by: attr(child, "by"),
        stagger: attr(child, "stagger"),
        trigger: attr(child, "trigger"),
      };
      effects.push(validateEffect(raw, effects.length, raw.target !== null && ids.has(raw.target), raw.trigger === null || ids.has(raw.trigger)));
    }
  }
  return effects;
}

function readTransition(root) {
  const nodes = metadataChildren(root, "transition");
  if (nodes.length === 0) return DEFAULT_TRANSITION;
  if (nodes.length > 1) throw new EffectError("the slide has more than one <slidra:transition>; it is corrupted.");
  const el = nodes[0];
  return validateTransition({
    enter: attr(el, "enter"),
    "enter-duration": attr(el, "enter-duration"),
    exit: attr(el, "exit"),
    "exit-duration": attr(el, "exit-duration"),
  });
}

function readNotes(root) {
  return metadataChildren(root, "notes")
    .map((el) => el.textContent.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Spec §14: `{{ name }}` placeholders are replaced only in the character
 * data of leaf `<text>`/`<tspan>` elements; attributes and markup are never
 * touched, and an unknown name is left exactly as written.
 */
export function substituteDynamicText(root, variables) {
  const leaves = elementsUnder(root).filter((el) => (el.localName === "text" || el.localName === "tspan") && elementChildren(el).length === 0);
  for (const leaf of leaves) {
    for (const node of Array.from(leaf.childNodes)) {
      if (node.nodeType !== 3 && node.nodeType !== 4) continue;
      const replaced = node.data.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match));
      if (replaced !== node.data) node.data = replaced;
    }
  }
}

function extensionOf(src) {
  const clean = src.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot).toLowerCase();
}

function mediaKind(src) {
  const extension = extensionOf(src);
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return null;
}

/** Cues for every `family="media" effect="play"` target — a malformed one is a damaged slide. */
function mediaCuesFor(root, effects) {
  const media = Object.create(null);
  for (const effect of effects) {
    if (effect.family !== "media" || effect.effect !== "play") continue;
    const el = findById(root, effect.target);
    if (el.hasAttribute("data-slidra-embed")) continue;
    const src = el.getAttribute("data-slidra-media");
    if (!src) throw new EffectError(`element "${effect.target}" has a media effect but no data-slidra-media.`);
    const declared = el.getAttribute("data-slidra-type");
    const kind = declared === "video" || declared === "audio" ? declared : mediaKind(src);
    if (!kind) throw new EffectError(`element "${effect.target}"'s media "${src}" is not a supported audio or video format.`);
    media[effect.target] = { src, kind };
  }
  return media;
}

/** Every playable `data-slidra-media` element, effect or not; images and unknown formats are skipped. */
function stageMediaFor(root) {
  const result = Object.create(null);
  for (const el of withAttribute(root, "data-slidra-media")) {
    const id = el.getAttribute("id");
    const src = el.getAttribute("data-slidra-media");
    if (!id || !src || el.hasAttribute("data-slidra-embed")) continue;
    const declared = el.getAttribute("data-slidra-type");
    const kind = declared === "video" || declared === "audio" ? declared : mediaKind(src);
    if (kind) result[id] = { src, kind };
  }
  return result;
}

/** Third-party player embeds (`data-slidra-embed`), keyed by element id. Only YouTube is known; anything else is skipped. */
function stageEmbedsFor(root) {
  const result = Object.create(null);
  for (const el of withAttribute(root, "data-slidra-embed")) {
    const id = el.getAttribute("id");
    const url = el.getAttribute("data-slidra-media");
    const provider = el.getAttribute("data-slidra-embed");
    if (!id || !url || provider !== "youtube" || !youtubeVideoId(url)) continue;
    result[id] = { provider, url };
  }
  return result;
}

export function youtubeVideoId(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const valid = (candidate) => (/^[A-Za-z0-9_-]{11}$/.test(candidate ?? "") ? candidate : null);
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") return valid(url.pathname.split("/")[1]);
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "watch") return valid(url.searchParams.get("v"));
  if (["embed", "shorts", "live"].includes(segments[0])) return valid(segments[1]);
  return null;
}

/**
 * Resolves a reference found in `documentPath` to a deck virtual path, or
 * null when it is not deck-local (a fragment, a data: URL, an absolute URL).
 */
export function deckPathFor(reference, documentPath) {
  const value = reference.trim();
  if (value === "" || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("/")) return null;
  const resolved = new URL(value, `https://deck.invalid/${documentPath}`);
  try {
    return decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    return null;
  }
}

/** An absolute network URL (`https:`, `http:`, or scheme-relative `//host/…`): format §13's "not self-contained". */
export function isRemoteUrl(value) {
  return /^\s*(?:https?:)?\/\//i.test(value);
}

/**
 * Calls `visit(value, set)` for every URL-bearing place in the slide
 * (attributes, `xlink:href`, inline style, `<style>` blocks); `set` replaces
 * the value. CSS values are visited per `url(…)`, with `inCss` true.
 */
function forEachReference(root, visit) {
  const resolveCss = (css) =>
    css.replace(CSS_URL, (match, quote, reference) => {
      const url = visit(reference, "css", null);
      return url ? `url("${url}")` : match;
    });
  for (const el of [root, ...elementsUnder(root)]) {
    for (const name of URL_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const url = visit(value, name, el);
      if (url) el.setAttribute(name, url);
    }
    const xlink = el.getAttributeNS(XLINK_NS, "href");
    if (xlink !== null) {
      const url = visit(xlink, "xlink:href", el);
      if (url) el.setAttributeNS(XLINK_NS, "xlink:href", url);
    }
    const style = el.getAttribute("style");
    if (style && style.includes("url(")) el.setAttribute("style", resolveCss(style));
    if (el.localName === "style" && el.textContent.includes("url(")) el.textContent = resolveCss(el.textContent);
  }
}

/** Every deck path the slide references (what `loadSlide` asks the source a URL for). Leaves the slide as it is. */
function deckPathsIn(root, documentPath) {
  const paths = new Set();
  const copy = root.cloneNode(true);
  forEachReference(copy, (value) => {
    const path = deckPathFor(value, documentPath);
    if (path !== null) paths.add(path);
    return null;
  });
  return paths;
}

/**
 * Replaces every deck-local URL in the slide (attributes, inline style,
 * `<style>` blocks) with the URL `fileUrl` gives for it (a `data:` URL for a
 * deck in memory), and returns the network URLs the markup itself names
 * (format §13), which the frame's CSP blocks until the viewer allows them.
 * The deck's own file URLs are not among them.
 */
function resolveDeckReferences(root, documentPath, fileUrl) {
  const remote = new Set();
  forEachReference(root, (value, name, el) => {
    if (isRemoteUrl(value) && !(name === "data-slidra-media" && el && el.hasAttribute("data-slidra-embed"))) remote.add(value.trim());
    const path = deckPathFor(value, documentPath);
    return path === null ? null : fileUrl(path);
  });
  return remote;
}

function errorSlideMarkup(deck, message) {
  const { width, height } = deck.canvas;
  const escaped = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="background-color:#1b1d24"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="${Math.round(height / 24)}" fill="#f4f6f8" font-family="system-ui, sans-serif">${escaped}</text></svg>`;
}
