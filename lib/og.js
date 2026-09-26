// Link previews for served decks: the cover slide (format §2.1) as a
// 1200×630 PNG for og:image, rendered on the server with sharp (librsvg).
// Slide markup is untrusted, so before rendering every reference that is
// not a data: URL or an in-document #fragment is removed: the renderer must
// never read a server file or reach the network on a deck's behalf.

import { readFile, stat } from "node:fs/promises";
import { nodeDom } from "./node-dom.js";
import { LruCache } from "./viewer/lru.js";
import { openDeck } from "./viewer/deck.js";
import { prepareSlide, useDom } from "./viewer/slide.js";

useDom(nodeDom);

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const XLINK_NS = "http://www.w3.org/1999/xlink";
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
const allowedReference = (value) => /^\s*(?:data:|#)/i.test(value);

/** Slide markup with every non-data:, non-#fragment reference removed (attributes, style and <style> url()s). */
export function withoutExternalReferences(markup) {
  const doc = new nodeDom.DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  const scrubCss = (css) => css.replace(CSS_URL, (match, quote, value) => (allowedReference(value) ? match : "none"));
  const walk = (el) => {
    for (const attr of Array.from(el.attributes)) {
      const isLink = attr.localName === "href" || attr.name === "src" || attr.name === "xlink:href";
      if (isLink && !allowedReference(attr.value)) el.removeAttributeNode(attr);
      else if (attr.value.includes("url(")) el.setAttribute(attr.name, scrubCss(attr.value));
    }
    if (el.getAttributeNS && el.getAttributeNS(XLINK_NS, "href") && !allowedReference(el.getAttributeNS(XLINK_NS, "href"))) el.removeAttributeNS(XLINK_NS, "href");
    if (el.localName === "style") el.textContent = scrubCss(el.textContent).replace(/@import[^;]*;?/gi, "");
    for (let child = el.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) walk(child);
  };
  walk(root);
  return new nodeDom.XMLSerializer().serializeToString(root);
}

/**
 * The cover slide of a deck as a PNG buffer, letterboxed onto 1200×630.
 * @param {Uint8Array} bytes the deck file
 */
export async function coverImage(bytes) {
  const deck = await openDeck(bytes);
  if (deck.slides.length === 0) throw new Error("the deck has no slides");
  const prepared = prepareSlide(deck, deck.info.cover);
  const { width, height } = deck.canvas;
  const svg = withoutExternalReferences(prepared.markup).replace(/^<svg\b/, `<svg width="${width}" height="${height}"`);
  const { default: sharp } = await import("sharp");
  // librsvg does not paint the root's CSS background-color: flatten onto it, and letterbox with it too.
  const background = backgroundOf(prepared.markup);
  return sharp(Buffer.from(svg), { limitInputPixels: 64_000_000 }).flatten({ background }).resize(OG_WIDTH, OG_HEIGHT, { fit: "contain", background }).png().toBuffer();
}

/** The slide's own background colour, to letterbox with. */
function backgroundOf(markup) {
  const match = /^<svg\b[^>]*\bstyle="[^"]*background-color:\s*(#[0-9a-f]{3,8})/i.exec(markup);
  return match ? match[1] : "#ffffff";
}

const cache = new LruCache(32);

/** coverImage() for a file on disk, cached by path, size and modification time. */
export async function coverImageForFile(file) {
  const info = await stat(file);
  const key = `${file}:${info.size}:${info.mtimeMs}`;
  if (!cache.has(key)) cache.set(key, coverImage(new Uint8Array(await readFile(file))));
  try {
    return await cache.get(key);
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

const metadataCache = new LruCache(64);

/** Name and description of a deck on disk, for a link preview; null when it cannot be read. */
export async function deckSummaryForFile(file) {
  try {
    const info = await stat(file);
    const key = `${file}:${info.size}:${info.mtimeMs}`;
    if (!metadataCache.has(key)) {
      const deck = await openDeck(new Uint8Array(await readFile(file)));
      metadataCache.set(key, { name: deck.name, description: deck.info.description, slides: deck.slides.length });
    }
    return metadataCache.get(key);
  } catch {
    return null;
  }
}
