// Accessibility semantics of a slide (spec §4.7): its language, its title
// and, in reading order, what each element says to assistive technology.
// Uses only DOM Level 2 calls (childNodes, getAttribute, namespaceURI) so it
// runs on the browser's DOMParser and on @xmldom/xmldom under Node alike.

export const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const SLIDRA_NS = "https://slidra.app/ns/2026";

/**
 * @typedef {"text" | "image" | "media" | "chart" | "table" | "group"} ItemKind
 * @typedef {{ id: string, kind: ItemKind, name: string | null, description: string | null, text: string }} ReadingItem
 *   `text` is what a reader presents: the name (and description) when there is one, otherwise the derived text.
 * @typedef {{ lang: string | null, title: string | null, items: ReadingItem[], unnamed: string[] }} SlideAccessibility
 *   `unnamed` lists elements showing an image, media or a chart with neither a <title> nor a decorative marker (spec §4.7: a checker flags them).
 */

function elementChildren(node) {
  const out = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) out.push(child);
  return out;
}

function isSvg(el, localName) {
  return el.namespaceURI === SVG_NS && el.localName === localName;
}

function descendants(el, predicate, out = []) {
  for (const child of elementChildren(el)) {
    if (predicate(child)) out.push(child);
    descendants(child, predicate, out);
  }
  return out;
}

const squash = (text) => text.replace(/\s+/g, " ").trim();

/** An element container: a `<g>` whose id is an `el-` id (spec §4.1). */
export function isElementContainer(el) {
  return isSvg(el, "g") && /^el-/.test(el.getAttribute("id") ?? "");
}

function isDecorative(el) {
  return el.getAttribute("data-slidra-decorative") === "true" || el.getAttribute("data-slidra-role") === "background";
}

/** The `<title>` / `<desc>` that name `el`: its first child element, and the one right after it. */
export function ownTitle(el) {
  const children = elementChildren(el).filter((child) => !(child.namespaceURI === SVG_NS && child.localName === "metadata"));
  const first = children[0];
  if (!first || !isSvg(first, "title")) return { title: null, desc: null, titleEl: null };
  const second = children[1];
  const desc = second && isSvg(second, "desc") ? squash(second.textContent) || null : null;
  return { title: squash(first.textContent) || null, desc, titleEl: first };
}

/** The language in effect at `el`: the nearest xml:lang / lang, else the deck's. */
export function languageAt(el, fallback) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const lang = node.getAttributeNS(XML_NS, "lang") || node.getAttribute("xml:lang") || node.getAttribute("lang");
    if (lang) return lang;
  }
  return fallback ?? null;
}

/** Visible text of the `<text>` elements under `el`, a new line where a tspan breaks or sets its own x. */
export function textOf(el) {
  const blocks = [];
  for (const text of descendants(el, (node) => isSvg(node, "text"))) {
    let line = "";
    const lines = [];
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3 || child.nodeType === 4) line += child.data;
        else if (child.nodeType === 1 && isSvg(child, "tspan")) {
          const breaks = child.getAttribute("data-slidra-break") === "true" || child.hasAttribute("x");
          if (breaks && squash(line)) {
            lines.push(squash(line));
            line = "";
          }
          walk(child);
        }
      }
    };
    walk(text);
    if (squash(line)) lines.push(squash(line));
    if (lines.length) blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
}

const CHART_NAMES = { bar: "Bar chart", hbar: "Horizontal bar chart", line: "Line chart", area: "Area chart", pie: "Pie chart", donut: "Donut chart" };

/** "Bar chart. Revenue: Q1 100, Q2 120. Costs: …" from a chart's `<slidra:chart>` data (spec §11). */
export function chartSummary(container) {
  const chart = descendants(container, (node) => node.namespaceURI === SLIDRA_NS && node.localName === "chart")[0];
  if (!chart) return "Chart";
  const split = (value) => (value ?? "").split(",").map((part) => part.trim());
  const categoriesEl = elementChildren(chart).find((node) => node.namespaceURI === SLIDRA_NS && node.localName === "categories");
  const categories = categoriesEl ? split(categoriesEl.getAttribute("values")) : [];
  const parts = [CHART_NAMES[chart.getAttribute("type")] ?? "Chart"];
  for (const series of elementChildren(chart).filter((node) => node.namespaceURI === SLIDRA_NS && node.localName === "series")) {
    const values = split(series.getAttribute("values"));
    const pairs = values.map((value, i) => (categories[i] ? `${categories[i]} ${value}` : value));
    parts.push(`${series.getAttribute("name") || "Series"}: ${pairs.join(", ")}`);
  }
  return parts.join(". ");
}

/** A table's cells, row by row (spec §12); the template row of a bound table is skipped. */
export function tableText(container) {
  const rows = new Map();
  for (const cell of descendants(container, (node) => node.nodeType === 1 && node.hasAttribute("data-slidra-cell"))) {
    if (cell.getAttribute("data-slidra-repeat") === "row") continue;
    const [row, col] = (cell.getAttribute("data-slidra-cell") ?? "").split(",").map(Number);
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push([col, squash(textOf(cell))]);
  }
  return [...rows.keys()]
    .sort((a, b) => a - b)
    .map((row) =>
      rows
        .get(row)
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join(", "),
    )
    .join("; ");
}

function mediaName(el) {
  const src = el.getAttribute("data-slidra-media") ?? "";
  const kind = el.getAttribute("data-slidra-type") === "audio" || /\.(mp3|m4a|wav|opus|oga|aac)(?:[?#]|$)/i.test(src) ? "Audio" : "Video";
  const file = el.hasAttribute("data-slidra-embed") ? src : src.split(/[?#]/)[0].split("/").pop();
  return file ? `${kind}: ${decodeSafe(file)}` : kind;
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function kindOf(el) {
  const type = el.getAttribute("data-slidra-type");
  if (el.hasAttribute("data-slidra-media")) return "media";
  if (type === "chart") return "chart";
  if (type === "table") return "table";
  if (elementChildren(el).some(isElementContainer)) return "group";
  if (descendants(el, (node) => isSvg(node, "text")).length > 0) return "text";
  return "image";
}

/**
 * The accessibility model of one slide: spec §4.7 applied to its root.
 * @param {Element} root the slide's `<svg>`
 * @param {{ lang?: string | null }} [deck]
 * @returns {SlideAccessibility}
 */
export function slideAccessibility(root, deck = {}) {
  const items = [];
  const unnamed = [];
  const visit = (parent) => {
    for (const el of elementChildren(parent)) {
      if (!isElementContainer(el)) {
        // Containers can sit inside plain wrapper <g>s or <a>s; <metadata> and <defs> hold no content.
        if (!isSvg(el, "metadata") && !isSvg(el, "defs") && !isSvg(el, "title") && !isSvg(el, "desc")) visit(el);
        continue;
      }
      if (isDecorative(el)) continue;
      const id = el.getAttribute("id");
      const { title, desc } = ownTitle(el);
      const kind = kindOf(el);
      if (!title && (kind === "media" || kind === "chart" || (kind === "image" && descendants(el, (node) => isSvg(node, "image")).length > 0))) unnamed.push(id);
      if (title) {
        items.push({ id, kind, name: title, description: desc, text: desc ? `${title}. ${desc}` : title });
        continue;
      }
      if (kind === "group") {
        visit(el);
        continue;
      }
      let text = "";
      if (kind === "chart") text = chartSummary(el);
      else if (kind === "table") text = tableText(el);
      else if (kind === "media") text = mediaName(el);
      else if (kind === "text") text = textOf(el);
      if (kind === "image") continue;
      if (text) items.push({ id, kind, name: null, description: null, text });
    }
  };
  visit(root);
  return { lang: languageAt(root, deck.lang ?? null), title: ownTitle(root).title, items, unnamed };
}

/**
 * Rewrites a slide's markup for presenting (spec §4.7): each `<title>` moves
 * to `aria-label` (no hover tooltip during playback), named graphics become
 * `role="img"`, decorative elements are hidden from assistive technology,
 * and the root carries the slide's language and title.
 * @param {Element} root
 * @param {SlideAccessibility} model
 */
export function applyAccessibility(root, model) {
  const doc = root.ownerDocument;
  const containers = descendants(root, isElementContainer);
  for (const el of containers) {
    if (isDecorative(el)) {
      el.setAttribute("aria-hidden", "true");
      continue;
    }
    const { title, desc, titleEl } = ownTitle(el);
    if (!titleEl) continue;
    el.setAttribute("aria-label", title ?? "");
    if (desc) el.setAttribute("aria-description", desc);
    if (kindOf(el) !== "text") el.setAttribute("role", "img");
    titleEl.parentNode.removeChild(titleEl);
  }
  const rootTitle = ownTitle(root);
  if (rootTitle.titleEl) {
    root.setAttribute("aria-label", rootTitle.title ?? "");
    rootTitle.titleEl.parentNode.removeChild(rootTitle.titleEl);
  }
  root.setAttribute("role", "group");
  root.setAttribute("aria-roledescription", "slide");
  if (model.lang && !root.getAttribute("lang")) root.setAttribute("lang", model.lang);
  return doc;
}
