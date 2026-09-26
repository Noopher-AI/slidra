// Links on slide elements (spec §4.8) and the stable slide ids they point
// at (spec §3). Pure functions over strings, so they run under Node's test
// runner unchanged.

export const SLIDE_ID = /^s-[A-Za-z0-9_-]{12}$/;
export const LINK_ACTIONS = Object.freeze(["next", "previous", "first", "last"]);

/**
 * @typedef {{ kind: "external", url: string } | { kind: "slide", slideId: string } | { kind: "action", action: "next" | "previous" | "first" | "last" }} Link
 */

/**
 * Parses a `data-slidra-link` value. Returns null for anything the spec
 * says to ignore: another URL scheme, a relative path, a malformed id.
 * @param {string | null | undefined} value
 * @returns {Link | null}
 */
export function parseLink(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    const target = trimmed.slice(1);
    if (SLIDE_ID.test(target)) return { kind: "slide", slideId: target };
    if (LINK_ACTIONS.includes(target)) return { kind: "action", action: /** @type {"next" | "previous" | "first" | "last"} */ (target) };
    return null;
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return { kind: "external", url: url.href };
  return null;
}

/**
 * A slide's `data-slidra-slide-id`, read from its root start tag without a
 * full parse (comments, the XML declaration and a doctype are skipped).
 * @param {string} source the slide's SVG text
 * @returns {string | null}
 */
export function slideIdOf(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  const tag = /<svg\b[^>]*>/.exec(withoutComments);
  if (!tag) return null;
  const match = /\sdata-slidra-slide-id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[0]);
  const id = match ? (match[1] ?? match[2]) : null;
  return id && SLIDE_ID.test(id) ? id : null;
}
