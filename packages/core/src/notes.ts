import { CoMotionError } from "./errors.js";
import { escapeXmlText } from "./element-text.js";
import { attributeOf, scanDocument, type ScannedNode } from "./slide/scan.js";

/**
 * Speaker notes (T3): a pure string -> string splice, modeled on
 * `element-text.ts`'s splice-only style — every other byte of `svgContent`
 * is preserved exactly. Notes live in the same `<metadata>` a slide's
 * `<comot:effects>` list already uses (`element-edit.ts`'s dangling-effect
 * cleanup), as `<comot:notes>` — the two coexist under one `<metadata>`
 * without disturbing each other.
 */

const NOTES_TAG = "comot:notes";
const METADATA_TAG = "metadata";
/** Same namespace URI `packages/web/src/effects.ts`'s `<comot:effects>` binds — an unbound `comot:` prefix is a fatal XML parse error, not a tolerated one. */
const NOTES_NS = "https://co-motion.dev/ns";

function requireSvgRoot(roots: readonly ScannedNode[]): ScannedNode {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

/**
 * Sets a slide's speaker notes to `text` (`co-motion slide notes set`).
 * Creates `<metadata>` as the `<svg>`'s first child when absent; appends
 * `<comot:notes>` to an existing `<metadata>` when it has none yet (leaving
 * any existing `<comot:effects>` untouched); replaces the content of an
 * existing `<comot:notes>` otherwise. An empty `text` is a legal way to
 * clear the notes — it writes `<comot:notes></comot:notes>`, never removes
 * the element and never throws.
 */
export function setSlideNotes(svgContent: string, text: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const escaped = escapeXmlText(text);

  const metadata = svgRoot.children.find((child) => child.tag === METADATA_TAG);
  if (!metadata) {
    const markup = `<${METADATA_TAG}><${NOTES_TAG} xmlns:comot="${NOTES_NS}">${escaped}</${NOTES_TAG}></${METADATA_TAG}>`;
    const insertAt = svgRoot.contentStart;
    return svgContent.slice(0, insertAt) + markup + svgContent.slice(insertAt);
  }

  const notes = metadata.children.find((child) => child.tag === NOTES_TAG);
  if (!notes) {
    const markup = `<${NOTES_TAG} xmlns:comot="${NOTES_NS}">${escaped}</${NOTES_TAG}>`;
    const insertAt = metadata.contentStart;
    return svgContent.slice(0, insertAt) + markup + svgContent.slice(insertAt);
  }

  // A `<comot:notes>` written before this namespace declaration existed (or
  // otherwise missing it) would parse fine here — this scanner doesn't
  // validate namespaces — but produce a fatal parse error the moment a
  // consumer that does (e.g. `effects.ts`'s `parseEffects`) reads it. Rewrite
  // the open tag along with the content so every write leaves the element
  // namespace-valid, not just freshly created ones.
  if (attributeOf(notes, "xmlns:comot")?.value !== NOTES_NS) {
    const markup = `<${NOTES_TAG} xmlns:comot="${NOTES_NS}">${escaped}`;
    return svgContent.slice(0, notes.start) + markup + svgContent.slice(notes.contentEnd);
  }

  return svgContent.slice(0, notes.contentStart) + escaped + svgContent.slice(notes.contentEnd);
}
