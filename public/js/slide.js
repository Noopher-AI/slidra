// Turns one slide of a Deck into everything the player needs: the slide
// markup with dynamic text substituted and every deck-local reference
// inlined, plus the play plan (steps, pre-hidden targets, media, embeds),
// the page transition, and the speaker notes. Browser-only (DOMParser).

import { NAMESPACE } from "./deck.js";
import {
  DEFAULT_TRANSITION,
  EffectError,
  cssEscapeId,
  deriveSteps,
  enterTargets,
  validateEffect,
  validateTransition,
} from "./effects.js";

const XLINK_NS = "http://www.w3.org/1999/xlink";
const URL_ATTRIBUTES = ["href", "src", "poster", "data-slidra-media"];
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".ogv"];
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".opus", ".oga", ".aac"];

/**
 * @returns {{
 *   path: string, markup: string, notes: string, transition: object,
 *   plan: object | null, error: string | null, embeds: Record<string, {provider: string, url: string}>
 * }}
 * `plan` is null (and `error` says why) when the effect list or transition
 * is malformed: the slide still shows, statically, with no animation.
 */
export function prepareSlide(deck, index) {
  const path = deck.slides[index];
  const source = deck.readText(path);
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") {
    return {
      path,
      markup: errorSlideMarkup(deck, `${path} is not well-formed SVG`),
      notes: "",
      transition: DEFAULT_TRANSITION,
      plan: null,
      error: `${path} is not well-formed SVG, so it cannot be shown.`,
      embeds: {},
    };
  }

  substituteDynamicText(root, {
    slide_number: String(index + 1),
    slide_total: String(deck.slides.length),
    presentation_name: deck.name,
  });

  const notes = readNotes(root);
  const embeds = stageEmbedsFor(root);
  let plan = null;
  let transition = DEFAULT_TRANSITION;
  let error = null;
  try {
    const ids = collectIds(root);
    const effects = readEffects(root, ids);
    const steps = deriveSteps(effects);
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
    };
  } catch (caught) {
    if (!(caught instanceof EffectError)) throw caught;
    error = `${path}: ${caught.message}`;
    transition = DEFAULT_TRANSITION;
  }

  resolveDeckReferences(deck, root, path);
  if (plan) {
    // Cue sources were read before inlining (their extension decides the
    // kind); the runtime needs the inlined data: URL the markup now holds.
    for (const table of [plan.media, plan.stageMedia]) {
      for (const id of Object.keys(table)) {
        const el = findById(root, id);
        const src = el && el.getAttribute("data-slidra-media");
        if (src) table[id].src = src;
      }
    }
  }

  return { path, markup: new XMLSerializer().serializeToString(root), notes, transition, plan, error, embeds };
}

/** Every `id` in the document. Built once rather than trusting getElementById on an XML document from untrusted input. */
function collectIds(root) {
  const ids = new Set();
  for (const el of root.querySelectorAll("[id]")) ids.add(el.getAttribute("id"));
  if (root.hasAttribute("id")) ids.add(root.getAttribute("id"));
  return ids;
}

function findById(root, id) {
  for (const el of root.querySelectorAll("[id]")) {
    if (el.getAttribute("id") === id) return el;
  }
  return null;
}

/** The `slidra:*` elements named `localName` that sit inside a `<metadata>` block (spec §5). */
function metadataChildren(root, localName) {
  const found = [];
  for (const metadata of root.getElementsByTagNameNS("http://www.w3.org/2000/svg", "metadata")) {
    for (const el of metadata.getElementsByTagNameNS(NAMESPACE, localName)) found.push(el);
  }
  return found;
}

function attr(el, name) {
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

export function readEffects(root, ids) {
  const effects = [];
  for (const block of metadataChildren(root, "effects")) {
    for (const child of block.children) {
      if (child.namespaceURI !== NAMESPACE || child.localName !== "effect") continue;
      const raw = {
        target: attr(child, "target"),
        family: attr(child, "family"),
        effect: attr(child, "effect"),
        start: attr(child, "start"),
        duration: attr(child, "duration"),
        delay: attr(child, "delay"),
        d: attr(child, "d"),
      };
      effects.push(validateEffect(raw, effects.length, raw.target !== null && ids.has(raw.target)));
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
  const leaves = [...root.querySelectorAll("text, tspan")].filter((el) => el.children.length === 0);
  for (const leaf of leaves) {
    for (const node of leaf.childNodes) {
      if (node.nodeType !== 3 && node.nodeType !== 4) continue;
      const replaced = node.data.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match,
      );
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
  for (const el of root.querySelectorAll("[data-slidra-media]")) {
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
  for (const el of root.querySelectorAll("[data-slidra-embed]")) {
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

/** Inlines every deck-local URL in the slide (attributes, inline style, `<style>` blocks) as a `data:` URL. */
function resolveDeckReferences(deck, root, documentPath) {
  const inline = (reference) => {
    const path = deckPathFor(reference, documentPath);
    return path !== null && deck.hasFile(path) ? deck.dataUrl(path) : null;
  };
  const resolveCss = (css) => css.replace(CSS_URL, (match, quote, reference) => {
    const url = inline(reference);
    return url ? `url("${url}")` : match;
  });

  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const name of URL_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const url = inline(value);
      if (url) el.setAttribute(name, url);
    }
    const xlink = el.getAttributeNS(XLINK_NS, "href");
    if (xlink !== null) {
      const url = inline(xlink);
      if (url) el.setAttributeNS(XLINK_NS, "xlink:href", url);
    }
    const style = el.getAttribute("style");
    if (style && style.includes("url(")) el.setAttribute("style", resolveCss(style));
    if (el.localName === "style" && el.textContent.includes("url(")) el.textContent = resolveCss(el.textContent);
  }
}

function errorSlideMarkup(deck, message) {
  const { width, height } = deck.canvas;
  const escaped = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="background-color:#1b1d24"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="${Math.round(height / 24)}" fill="#f4f6f8" font-family="system-ui, sans-serif">${escaped}</text></svg>`;
}
