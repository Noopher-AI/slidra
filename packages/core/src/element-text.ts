import { CoMotionError } from "./errors.js";
import { readVirtualFile } from "./virtual-fs.js";
import type { ProjectJson } from "./presentation.js";
import { attributeOf, scanDocument, type ScannedNode } from "./slide/scan.js";

/**
 * The slide-mutation primitive behind `text set` (ADR-0002: `text set` must
 * be semantically clear, not a raw SVG edit). This module never parses and
 * re-serializes the SVG document — that would reflow the whole file and
 * violate the byte-identical invariant ticket #3 is built around (ADR-0001,
 * ADR-0004: SVG size is the per-turn token cost). Instead it locates the
 * target element's opening/closing tag by scanning the raw text and splices
 * only the substring between them.
 */

interface TagMatch {
  tagName: string;
  attrsText: string;
  selfClosing: boolean;
  /** Index of the character right after the tag's closing `>`. */
  contentStart: number;
}

/**
 * Tags whose content the module is willing to treat as editable text. This
 * is a whitelist, not a "not self-closing" heuristic: syntax alone (an
 * element happens to have a closing tag) does not imply it carries text —
 * `<rect>` and `<g>` are perfectly valid non-self-closing elements with no
 * text content. Only add a tag here once the app actually renders text
 * runs on it.
 */
const TEXT_BEARING_TAGS = new Set(["text"]);

/**
 * Finds the terminator of a `<!...>` / `<?...>` construct starting at `i`
 * (comment, CDATA section, processing instruction, or a declaration such as
 * `<!DOCTYPE ...>`) and returns the index right after it. Returns -1 if the
 * construct is never terminated, so the caller can stop scanning rather
 * than misreading markup inside it as a real element.
 */
function skipNonElementConstruct(svg: string, i: number): number {
  if (svg.startsWith("<!--", i)) {
    const end = svg.indexOf("-->", i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (svg.startsWith("<![CDATA[", i)) {
    const end = svg.indexOf("]]>", i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (svg[i + 1] === "?") {
    const end = svg.indexOf("?>", i + 2);
    return end === -1 ? -1 : end + 2;
  }
  // Any other "<!" construct (e.g. <!DOCTYPE ...>). Track bracket depth so
  // a ">" inside an internal subset ("[...]") doesn't end it early.
  let k = i + 2;
  let depth = 0;
  while (k < svg.length) {
    const ch = svg[k];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth <= 0) {
      return k + 1;
    }
    k++;
  }
  return -1;
}

/**
 * Scans forward from `fromIndex` for the next start tag (opening or
 * self-closing). Skips closing tags; skips comments, CDATA sections,
 * processing instructions and doctype declarations to their proper
 * terminator so markup written inside them is never read as real markup.
 * Quoted attribute values are tracked so a `>` appearing inside a quoted
 * attribute (e.g. a `d` path string) never mistakenly ends the tag early.
 */
function findNextStartTag(svg: string, fromIndex: number): TagMatch | null {
  let i = svg.indexOf("<", fromIndex);
  while (i !== -1) {
    const marker = svg[i + 1];
    if (marker === "/") {
      i = svg.indexOf("<", i + 1);
      continue;
    }
    if (marker === "!" || marker === "?") {
      const next = skipNonElementConstruct(svg, i);
      if (next === -1) {
        return null;
      }
      i = svg.indexOf("<", next);
      continue;
    }

    let j = i + 1;
    while (j < svg.length && /[\w:.-]/.test(svg[j])) {
      j++;
    }
    const tagName = svg.slice(i + 1, j);
    if (!tagName) {
      i = svg.indexOf("<", i + 1);
      continue;
    }

    let k = j;
    let quote: string | null = null;
    while (k < svg.length) {
      const ch = svg[k];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      k++;
    }
    if (k >= svg.length) {
      return null;
    }

    const selfClosing = svg[k - 1] === "/";
    const attrsEnd = selfClosing ? k - 1 : k;
    const attrsText = svg.slice(j, attrsEnd);
    return { tagName, attrsText, selfClosing, contentStart: k + 1 };
  }
  return null;
}

/**
 * Finds the matching `</tagName>` closing tag for the element whose content
 * starts at `fromIndex`. Reuses `skipNonElementConstruct` — the same skip
 * logic `findNextStartTag` uses for opening tags — so a comment or CDATA
 * section inside the element that happens to contain the literal text
 * `</tagName>` is never mistaken for the real closing tag. The regexp
 * permits XML's optional whitespace before the closing `>` (e.g.
 * `</text >`). Returns -1 if no genuine closing tag is found.
 */
function findMatchingCloseTag(svg: string, tagName: string, fromIndex: number): number {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closeTagPattern = new RegExp(`^</${escapedTagName}\\s*>`);
  let i = svg.indexOf("<", fromIndex);
  while (i !== -1) {
    const marker = svg[i + 1];
    if (marker === "!" || marker === "?") {
      const next = skipNonElementConstruct(svg, i);
      if (next === -1) {
        return -1;
      }
      i = svg.indexOf("<", next);
      continue;
    }
    if (marker === "/" && closeTagPattern.test(svg.slice(i))) {
      return i;
    }
    i = svg.indexOf("<", i + 1);
  }
  return -1;
}

const XML_WHITESPACE = /[\t\n\r ]/;

/**
 * Walks a tag's attribute region (the text between the tag name and its
 * closing `>`, as already isolated by `findNextStartTag`) character by
 * character and returns the actual name/value pairs it contains, keyed by
 * exact attribute name.
 *
 * This replaces searching the region as text: once name and value are
 * tokenised, text sitting inside a quoted value is structurally a value and
 * can never again be mistaken for an attribute name, no matter what it
 * looks like (e.g. `data-note=' id="el-a"'` — the `id="el-a"` there is part
 * of `data-note`'s value, never a candidate for a real `id` match).
 *
 * `findNextStartTag` already tracks quote state to find where a tag ends
 * (so a `>` inside a quoted value doesn't end it early); that guarantee
 * means every quote opened within `attrsText` is already known to close
 * before the tag does. This scanner does its own, separate quote tracking
 * to split the region into name/value pairs — a different job (tokenising
 * attributes, not finding a tag boundary) that reuses the same underlying
 * rule rather than re-deriving it.
 *
 * Throws on attribute syntax it cannot make sense of (a name with no `=`,
 * a value that isn't quoted, an unterminated quote) rather than guessing —
 * this scanner only understands the attribute syntax SVG actually emits.
 */
function scanAttributes(attrsText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const n = attrsText.length;
  let i = 0;
  while (i < n) {
    while (i < n && XML_WHITESPACE.test(attrsText[i])) i++;
    if (i >= n) break;

    const nameStart = i;
    while (i < n && !XML_WHITESPACE.test(attrsText[i]) && attrsText[i] !== "=") i++;
    const name = attrsText.slice(nameStart, i);
    if (!name) {
      throw new CoMotionError("屬性語法錯誤：無法解析屬性名稱");
    }

    while (i < n && XML_WHITESPACE.test(attrsText[i])) i++;
    if (attrsText[i] !== "=") {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 缺少 =`);
    }
    i++;

    while (i < n && XML_WHITESPACE.test(attrsText[i])) i++;
    const quote = attrsText[i];
    if (quote !== '"' && quote !== "'") {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 的值未以引號括住`);
    }
    i++;

    const valueStart = i;
    while (i < n && attrsText[i] !== quote) i++;
    if (i >= n) {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 的引號未封閉`);
    }
    attrs.set(name, attrsText.slice(valueStart, i));
    i++;
  }
  return attrs;
}

/**
 * Extracts the exact value of an `id` attribute, if present, by scanning
 * the attribute region into structured name/value pairs and looking up
 * `id` as an exact attribute name. `data-id="..."` or `xml:id="..."` are
 * different names entirely and are never matched.
 */
function extractId(attrsText: string): string | undefined {
  return scanAttributes(attrsText).get("id");
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The set of code points XML 1.0 permits in character data (spec production
// [2] Char). Anything outside this — control characters like U+0001 in
// particular — would make the document invalid SVG if written verbatim.
const XML_1_0_CHAR = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

function assertValidXmlText(newText: string): void {
  if (!XML_1_0_CHAR.test(newText)) {
    throw new CoMotionError("文字內容包含 XML 不允許的字元");
  }
}

/**
 * Finds `elementId` in the pre-parsed document tree (document order,
 * depth-first) and returns the node it names, or undefined.
 */
function findNodeById(nodes: readonly ScannedNode[], elementId: string): ScannedNode | undefined {
  for (const node of nodes) {
    if (attributeOf(node, "id")?.value === elementId) {
      return node;
    }
    const found = findNodeById(node.children, elementId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Handles the case where `elementId` sits on a `<g>` container rather than
 * directly on a `<text>` (#72's conversion moves `id` up onto the container —
 * see ADR-0012). Descends into the container's direct children to find the
 * single `<text>` child that actually carries the text, then splices its
 * content exactly the way the direct-`<text>` path does.
 *
 * Re-locates the container with `scanDocument` (which carries byte offsets,
 * unlike this module's own attribute-string scanner) rather than adding a
 * third nested-element scanner — see `slide/scan.ts`'s module doc comment
 * for why the two scanners are not merged (#92).
 */
function replaceContainerText(svgContent: string, elementId: string, newText: string): string {
  const container = findNodeById(scanDocument(svgContent), elementId);
  if (!container) {
    // The cheap scanner above already found a `<g id="elementId">` in the
    // raw text; scanDocument disagreeing here would mean the two scanners
    // parse this document differently, not that the element is absent.
    throw new CoMotionError(`元素不是文字元素：${elementId}`);
  }

  const groupChildren = container.children.filter((child) => child.tag === "g");
  const textChildren = container.children.filter((child) => child.tag === "text");
  if (groupChildren.length > 0 || textChildren.length !== 1) {
    throw new CoMotionError(`元素不是文字元素：${elementId}`);
  }

  const textNode = textChildren[0];
  if (textNode.selfClosing) {
    throw new CoMotionError(`元素沒有文字內容：${elementId}`);
  }
  return (
    svgContent.slice(0, textNode.contentStart) +
    escapeXmlText(newText) +
    svgContent.slice(textNode.contentEnd)
  );
}

/**
 * Replaces the text content of the element identified by `elementId` inside
 * `svgContent` with `newText`, and returns the full document with that one
 * substitution applied. Every other byte of `svgContent` is preserved
 * exactly — no reformatting, no attribute reordering, no re-indentation.
 *
 * Throws when `newText` contains a code point XML 1.0 forbids, when
 * `elementId` does not appear in the document (including when it only
 * appears inside a comment or CDATA section, which are never scanned as
 * markup), when the matched element's tag is not on the text-bearing
 * whitelist and is not a `<g>` container wrapping exactly one `<text>`
 * child (e.g. `<rect>`, `<image>`, a `<g>` with no `<text>` child or more
 * than one), or when the matched element is self-closing and therefore has
 * no text content to replace.
 */
export function replaceElementText(svgContent: string, elementId: string, newText: string): string {
  assertValidXmlText(newText);

  let searchFrom = 0;
  let match = findNextStartTag(svgContent, searchFrom);
  while (match) {
    if (extractId(match.attrsText) === elementId) {
      if (match.tagName === "g") {
        return replaceContainerText(svgContent, elementId, newText);
      }
      if (!TEXT_BEARING_TAGS.has(match.tagName)) {
        throw new CoMotionError(`元素不是文字元素：${elementId}`);
      }
      if (match.selfClosing) {
        throw new CoMotionError(`元素沒有文字內容：${elementId}`);
      }
      const closeIndex = findMatchingCloseTag(svgContent, match.tagName, match.contentStart);
      if (closeIndex === -1) {
        throw new CoMotionError(`元素沒有文字內容：${elementId}`);
      }
      return (
        svgContent.slice(0, match.contentStart) +
        escapeXmlText(newText) +
        svgContent.slice(closeIndex)
      );
    }
    searchFrom = match.contentStart;
    match = findNextStartTag(svgContent, searchFrom);
  }
  throw new CoMotionError(`找不到元素：${elementId}`);
}

/**
 * Confirms `virtualPath` is one of the presentation's declared slides
 * (listed in `project.json`'s `slides` array). The write path (`setElementText`
 * in workspace.ts) calls this before touching the slide file itself, so an
 * edit aimed at e.g. `project.json` is rejected before any read/write of it
 * is attempted.
 */
export async function assertSlidePathListed(workDir: string, virtualPath: string): Promise<void> {
  const raw = await readVirtualFile(workDir, "project.json");
  let project: ProjectJson;
  try {
    project = JSON.parse(raw) as ProjectJson;
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  if (!Array.isArray(project.slides) || !project.slides.includes(virtualPath)) {
    throw new CoMotionError(`不是投影片：${virtualPath}`);
  }
}
