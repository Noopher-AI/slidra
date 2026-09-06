import { EFFECTS_NS, deriveSteps, validateEffectItem, type Effect, type RawEffectAttributes } from "@co-motion/core/effects";

export type { Effect, EffectFamily, EffectName, EffectStart, Step } from "@co-motion/core/effects";
export { deriveSteps };

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Reads the effect list out of a slide's <metadata>. Order matches the order
 * the entries appear in the file. A slide with no effects is legal and
 * yields an empty list; anything malformed or not yet implemented throws.
 *
 * [E2.T7]/D1: this keeps its own `DOMParser` reader rather than moving into
 * `@co-motion/core/effects` — namespace-URI matching ("以命名空間 URI 比對，
 * 不管前綴叫什麼", `packages/web/test/effects.test.ts`) needs a real DOM,
 * which the core package's `scanDocument` (no `node:` imports, but also no
 * DOM) cannot give it. Every "is this attribute value legal" judgement is
 * still core's alone — `validateEffectItem` — so the two readers can never
 * quietly drift apart on what counts as a legal effect item.
 */
export function parseEffects(svgMarkup: string): Effect[] {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  // image/svg+xml parsing is not forgiving like HTML: a failure shows up as a
  // <parsererror> element rather than an exception, so look for it.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("投影片不是合法的 XML，無法讀取效果清單。");
  }

  // ADR-0009 puts the list inside <metadata>, so only look there — a
  // comot:effects sitting anywhere else is not the slide's effect list.
  // Match by namespace URI throughout: the "comot:" prefix is a convention,
  // not a guarantee.
  const lists = Array.from(doc.getElementsByTagNameNS(SVG_NS, "metadata")).flatMap((metadata) =>
    Array.from(metadata.getElementsByTagNameNS(EFFECTS_NS, "effects")),
  );
  if (lists.length === 0) {
    return [];
  }
  if (lists.length > 1) {
    throw new Error(`這張投影片的 metadata 裡有 ${lists.length} 組效果清單，但一張投影片只能有一份效果清單，簡報已損毀。`);
  }

  const nodes = Array.from(lists[0].getElementsByTagNameNS(EFFECTS_NS, "effect"));
  return nodes.map((node, index) => readEffect(node, index, doc));
}

function readEffect(node: Element, index: number, doc: Document): Effect {
  const raw: RawEffectAttributes = {
    target: node.getAttribute("target"),
    family: node.getAttribute("family"),
    effect: node.getAttribute("effect"),
    start: node.getAttribute("start"),
    duration: node.getAttribute("duration"),
    delay: node.getAttribute("delay"),
    d: node.getAttribute("d"),
  };
  const targetExists = Boolean(raw.target && doc.getElementById(raw.target));
  return validateEffectItem(raw, index, targetExists);
}
