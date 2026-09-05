import { scanDocument, type ScannedNode } from "@co-motion/core/slide";

/**
 * Reads a slide's speaker notes back out of its raw SVG markup.
 *
 * Deliberately does NOT use `DOMParser` (unlike `effects.ts`'s
 * `parseEffects`): `DOMParser().parseFromString(..., "image/svg+xml")`
 * treats an unbound XML namespace prefix as a fatal parse error, and notes
 * written before this ticket's `xmlns:comot` fix (`@co-motion/core`'s
 * `setSlideNotes`) are still sitting on disk without one. `scanDocument` is
 * a byte-offset scanner with no notion of namespace binding, so it reads
 * both old and new files the same way.
 */

const NOTES_TAG = "comot:notes";
const METADATA_TAG = "metadata";

export type SlideNotesRead = { ok: true; text: string } | { ok: false; error: string };

/**
 * `escapeXmlText`'s exact inverse (`@co-motion/core`'s `element-text.ts`),
 * duplicated here rather than imported: order matters (`&amp;` decoded
 * last) and this is the only place on the web side that needs it.
 */
function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function findChild(node: ScannedNode, tag: string): ScannedNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

/**
 * `svgMarkup` with no `<comot:notes>` (missing `<metadata>`, missing the
 * tag, or an empty tag) all read as `{ ok: true, text: "" }` — the three
 * cases are indistinguishable in the UI (02-DESIGN_DOC, T3 plan §4.1).
 * Markup that isn't a well-formed slide (unparseable, or no `<svg>` root)
 * is the only case reported as an error; callers must not fall back to an
 * editable empty textarea for it, or a blur would overwrite real notes
 * with an empty string.
 */
export function readSlideNotes(svgMarkup: string): SlideNotesRead {
  let roots: ScannedNode[];
  try {
    roots = scanDocument(svgMarkup);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    return { ok: false, error: "投影片的根節點不是 <svg>" };
  }

  const metadata = findChild(svgRoot, METADATA_TAG);
  const notes = metadata && findChild(metadata, NOTES_TAG);
  if (!notes) {
    return { ok: true, text: "" };
  }

  // Attributes (including a namespace declaration) never appear inside
  // content, so reading raw content by offset is unaffected by whether
  // this particular <comot:notes> carries `xmlns:comot` or not.
  const raw = svgMarkup.slice(notes.contentStart, notes.contentEnd);
  return { ok: true, text: unescapeXmlText(raw) };
}

/**
 * Fetches `slidePath`'s raw markup (same `/api/files/` route overview.ts's
 * thumbnails use) and reads its speaker notes. A non-200 response or a
 * network failure is reported the same way a malformed markup is — the
 * caller (`Notes.tsx`) must treat both as "cannot tell what the real notes
 * are", never as "no notes".
 */
export async function fetchSlideNotes(slidePath: string): Promise<SlideNotesRead> {
  let response: Response;
  try {
    response = await fetch(`/api/files/${slidePath}`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { ok: false, error: `載入失敗：/api/files/${slidePath}` };
  }
  const markup = await response.text();
  return readSlideNotes(markup);
}
