// The host half of the morph page transition (spec/playback.md §5.1): pairs
// the outgoing slide's on-screen elements with the incoming slide's by id,
// and builds "ghosts" — copies of the elements that are leaving, drawn where
// they were — for the incoming slide's runtime to fade out. The runtime
// measures and animates; this side only decides who is who. DOM Level 2
// calls only, so it runs on the browser's DOMParser and on xmldom alike.

import { SVG_NS, isElementContainer } from "./a11y.js";

/**
 * What the outgoing slide's runtime reports when asked (see
 * public/js/player-runtime.js `snapshot()`): every visible element
 * container's box in slide coordinates, its full transform to the slide
 * root, and its effective opacity; plus the root's background colour.
 * @typedef {{ box: { x: number, y: number, width: number, height: number }, matrix: number[], opacity: number }} Snapshot
 * @typedef {{ elements: Record<string, Snapshot>, background: string | null }} SlideSnapshot
 * @typedef {{ duration: number, from: Record<string, Snapshot>, ghosts: string, background: string | null }} MorphPlan
 */

function containers(root) {
  const out = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (isElementContainer(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function hasAncestorIn(el, ids) {
  for (let node = el.parentNode; node && node.nodeType === 1; node = node.parentNode) {
    const id = node.getAttribute("id");
    if (id && ids.has(id)) return true;
  }
  return false;
}

const GHOST_PREFIX = "slidra-ghost-";

/** Renames every id inside a ghost (and the references to them) so nothing in it can collide with, or be targeted as, the incoming slide's elements. */
function renameIds(el) {
  const renamed = new Map();
  const all = [el, ...descendantsOf(el)];
  for (const node of all) {
    const id = node.getAttribute("id");
    if (id) {
      renamed.set(id, GHOST_PREFIX + id);
      node.setAttribute("id", GHOST_PREFIX + id);
    }
  }
  const rewrite = (value) => value.replace(/url\(\s*(["']?)#([^"')]+)\1\s*\)/g, (match, quote, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : match));
  for (const node of all) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.value.includes("url(")) node.setAttribute(attr.name, rewrite(attr.value));
      if ((attr.localName === "href" || attr.name === "xlink:href") && attr.value.startsWith("#") && renamed.has(attr.value.slice(1))) {
        node.setAttributeNS(attr.namespaceURI, attr.name, `#${renamed.get(attr.value.slice(1))}`);
      }
    }
    if (node.localName === "style" && node.textContent.includes("url(")) node.textContent = rewrite(node.textContent);
  }
}

function descendantsOf(el) {
  const out = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

const matrixAttr = (m) => `matrix(${m.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0)).join(" ")})`;

/**
 * @param {Element} outgoingRoot the outgoing slide's `<svg>` (its prepared markup, parsed)
 * @param {SlideSnapshot} snapshot what the outgoing runtime reported
 * @param {Element} incomingRoot the incoming slide's `<svg>`
 * @param {string[]} incomingHidden the incoming slide's pre-hidden ids (playback §2)
 * @param {number} duration seconds
 * @param {{ serialize: (node: Node) => string }} xml an XMLSerializer
 * @returns {MorphPlan}
 */
export function planMorph(outgoingRoot, snapshot, incomingRoot, incomingHidden, duration, xml) {
  const shown = new Set(Object.keys(snapshot.elements));
  const incomingIds = new Set(containers(incomingRoot).map((el) => el.getAttribute("id")));
  const hidden = new Set(incomingHidden);

  const from = Object.create(null);
  for (const id of shown) if (incomingIds.has(id) && !hidden.has(id)) from[id] = snapshot.elements[id];
  const paired = new Set(Object.keys(from));

  // Leaving: shown before, and not paired. Only the outermost is copied, and a
  // copy never carries a paired element (that one morphs instead).
  const leaving = new Set([...shown].filter((id) => !paired.has(id)));
  const doc = outgoingRoot.ownerDocument;
  const ghosts = [];
  for (const el of containers(outgoingRoot)) {
    const id = el.getAttribute("id");
    if (!leaving.has(id) || hasAncestorIn(el, leaving)) continue;
    const copy = /** @type {Element} */ (el.cloneNode(true));
    for (const inner of descendantsOf(copy)) {
      const innerId = inner.getAttribute("id");
      if (innerId && (paired.has(innerId) || !shown.has(innerId)) && isElementContainer(inner)) inner.parentNode.removeChild(inner);
    }
    copy.removeAttribute("transform");
    copy.removeAttribute("opacity");
    renameIds(copy);
    const wrapper = doc.createElementNS(SVG_NS, "g");
    wrapper.setAttribute("data-slidra-ghost", "");
    wrapper.setAttribute("transform", matrixAttr(snapshot.elements[id].matrix));
    wrapper.setAttribute("opacity", String(snapshot.elements[id].opacity));
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.appendChild(copy);
    ghosts.push(xml.serialize(wrapper));
  }
  return { duration, from, ghosts: ghosts.join(""), background: snapshot.background };
}
