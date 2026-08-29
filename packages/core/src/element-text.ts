import { CoMotionError } from "./errors.js";
import { attributeOf, attributeValue, scanDocument, type ScannedAttribute, type ScannedNode } from "./slide/scan.js";
import { wrapText } from "./text/wrap.js";
import { renderTextBoxContent } from "./text/render.js";
import type { FontMetrics } from "./text-metrics.js";
import { formatSvgNumber } from "./svg-number.js";

/**
 * The slide-mutation primitive behind `text set` (ADR-0002: `text set` must
 * be semantically clear, not a raw SVG edit). This module never parses and
 * re-serializes the SVG document — that would reflow the whole file and
 * violate the byte-identical invariant ticket #3 is built around (ADR-0001,
 * ADR-0004: SVG size is the per-turn token cost). Instead it locates the
 * target element's opening/closing tag by scanning the raw text and splices
 * only the substring between them.
 *
 * No Node built-in imports, not even transitively (#76): `packages/core/src/text/`
 * reuses this module's `escapeXmlText`, and that module has to load verbatim
 * in a browser with no bundler. `assertSlidePathListed`, which does need the
 * real filesystem, lives in workspace.ts instead — it is workspace.ts's own
 * concern (resolving a presentation id to a work directory), not this
 * module's splice logic.
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

/**
 * Escapes the three characters XML character data requires escaped.
 * Exported so #76's `packages/core/src/text/render.ts` reuses this exact
 * rule instead of writing a second one (軍令: one escaping rule, same as
 * one measurement implementation and one rounding rule).
 */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `escapeXmlText`'s exact inverse, for the three entities this codebase
 * ever writes into character data. `#76`'s `elementBounds` support needs
 * to read a `<text>`'s (or its `<tspan>`s') content back out of the raw
 * SVG, decoded, to measure it — this is that decode step. `&amp;` is
 * decoded last, deliberately: decoding it first would turn a literal
 * `&lt;` typed by an author (encoded as `&amp;lt;`) into `<` instead of
 * leaving it as the four literal characters it was.
 *
 * Only these three entities are recognised. A hand-authored SVG using a
 * different named entity (`&quot;`, `&apos;`) or a numeric character
 * reference (`&#65;`) in element text content is out of this function's
 * scope — nothing this codebase's own write paths ever produce needs one.
 */
export function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * `escapeXmlText` plus quoting, for building a double-quoted attribute
 * value from caller-supplied text (`textbox add`'s `--font-family` /
 * `--fill`). Not a second escaping rule — the character-data rule plus the
 * one extra character an attribute value needs escaped that character data
 * does not.
 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

/**
 * `data-comot-text-width`, the attribute a text box's container carries
 * (#76, W1-R1). Duplicated here as a literal, rather than imported from
 * `slide/format.ts`'s `TEXT_WIDTH_ATTRIBUTE`, to avoid a module cycle:
 * `slide/format.ts` already imports `unescapeXmlText` from this file. The
 * two must be kept in sync; there is exactly one other place this literal
 * appears (`slide/format.ts`).
 */
const TEXT_WIDTH_ATTRIBUTE = "data-comot-text-width";

/**
 * Reads the family + size a `<text>` node's own attributes declare, for
 * re-wrapping a text box's content. `font-weight` is not read here: #98's
 * font model resolves purely by family (one embedded font file per family,
 * `project-json.ts`'s `FontEntry` has no weight field), so it plays no part
 * in measurement — only in the CSS the `<text>` renders with, which this
 * module never touches.
 */
export function readTextFontInfo(textNode: ScannedNode, elementId: string): { fontFamily: string; fontSize: number } {
  const fontFamily = attributeValue(textNode, "font-family");
  if (fontFamily === null || fontFamily.trim() === "") {
    throw new CoMotionError(`文字框缺少 font-family，無法重新換行：${elementId}`);
  }
  const fontSizeRaw = attributeValue(textNode, "font-size");
  const fontSize = fontSizeRaw === null || fontSizeRaw.trim() === "" ? 16 : Number(fontSizeRaw);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new CoMotionError(`文字框的 font-size 不是合法的正數，無法重新換行：${elementId}`);
  }
  const anchor = attributeValue(textNode, "text-anchor");
  if (anchor !== null && anchor !== "start") {
    throw new CoMotionError(`文字框的 <text> 不可使用 text-anchor（尚未支援對齊）：${elementId}`);
  }
  return { fontFamily, fontSize };
}

/** Resolves `fontFamily` in `fonts`, throwing the same "缺少字型" error every text-box measurement call uses on a miss. Exported for `element-edit.ts` (#104), which resolves the same way before re-wrapping a text box. */
export function resolveFont(fonts: ReadonlyMap<string, FontMetrics>, fontFamily: string, elementId: string): FontMetrics {
  const font = fonts.get(fontFamily);
  if (!font) {
    throw new CoMotionError(`簡報未內嵌字型 ${fontFamily}，無法重新換行：${elementId}`);
  }
  return font;
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
 *
 * When the container carries `data-comot-text-width` (#76), it is a text
 * box: the spliced content is `renderTextBoxContent(wrapText(newText, …))`
 * instead of the escaped raw string, re-wrapped at the box's declared
 * width using the style already on the `<text>` primitive. `fontBook` is
 * required in that case — a text box with no font book throws.
 */
function replaceContainerText(
  svgContent: string,
  elementId: string,
  newText: string,
  options: ReplaceElementTextOptions,
): string {
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

  const textWidthRaw = attributeValue(container, TEXT_WIDTH_ATTRIBUTE);
  if (textWidthRaw !== null) {
    if (!options.fontBook) {
      throw new CoMotionError(`文字框缺少字型，無法重新換行：${elementId}`);
    }
    const width = Number(textWidthRaw);
    if (!Number.isFinite(width) || width <= 0) {
      throw new CoMotionError(`元素 ${elementId} 的 ${TEXT_WIDTH_ATTRIBUTE} 不是合法的正數：${textWidthRaw}`);
    }
    const { fontFamily, fontSize } = readTextFontInfo(textNode, elementId);
    const font = resolveFont(options.fontBook, fontFamily, elementId);
    const wrapped = wrapText(newText, { width, font, fontSizePx: fontSize });
    const content = renderTextBoxContent(wrapped.lines);
    return svgContent.slice(0, textNode.contentStart) + content + svgContent.slice(textNode.contentEnd);
  }

  return (
    svgContent.slice(0, textNode.contentStart) +
    escapeXmlText(newText) +
    svgContent.slice(textNode.contentEnd)
  );
}

export interface ReplaceElementTextOptions {
  /**
   * Required only when the matched element turns out to be a text box
   * (its container carries `data-comot-text-width`, #76). A plain `<text>`
   * needs no measurement at all, so this is optional, not required — see
   * `setElementText` in workspace.ts for why it is fetched unconditionally
   * anyway on every call.
   */
  readonly fontBook?: ReadonlyMap<string, FontMetrics>;
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
 *
 * When the matched container is a text box (#76), `newText` is re-wrapped
 * at the box's declared width instead of spliced in verbatim — see
 * `replaceContainerText`.
 */
export function replaceElementText(
  svgContent: string,
  elementId: string,
  newText: string,
  options: ReplaceElementTextOptions = {},
): string {
  assertValidXmlText(newText);

  let searchFrom = 0;
  let match = findNextStartTag(svgContent, searchFrom);
  while (match) {
    if (extractId(match.attrsText) === elementId) {
      if (match.tagName === "g") {
        return replaceContainerText(svgContent, elementId, newText, options);
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
 * Re-wraps a text box's *existing* content at a new declared width (#76,
 * AC3's width half) — `co-motion textbox width`. Unlike
 * `replaceElementText`, the text does not change; it has to be recovered
 * from the box's own `<tspan>`s first (`tspans.map(t => t.textContent).join("")`,
 * exactly the concatenation invariant `text/wrap.ts` guarantees is
 * lossless), then re-wrapped and re-rendered at `newWidth`, and finally
 * both the container's `data-comot-text-width` attribute and the `<text>`'s
 * content are spliced in the same pass — the attribute sits strictly before
 * the `<text>` child, so splicing the content first never invalidates the
 * attribute's own byte offsets (see the inline comment where this happens).
 *
 * Throws when `elementId` does not name a text box (no `data-comot-text-width`
 * on its container), and with the same shape of errors `replaceContainerText`
 * throws for a malformed container.
 */
export function resizeTextBox(
  svgContent: string,
  elementId: string,
  newWidth: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
): { updated: string; lines: number } {
  if (!Number.isFinite(newWidth) || newWidth <= 0) {
    throw new CoMotionError("文字框寬度必須是大於 0 的數字");
  }
  // Wrap against the value that will actually be written (4-decimal
  // `formatSvgNumber`), not the raw input: a positive width below that
  // rounding floor would otherwise serialize as "0" while the wrap ran
  // against the un-rounded number (#76 finding, W1-R11). Reject before any
  // splice happens rather than persisting a width the edit path then
  // rejects.
  const roundedWidth = Number(formatSvgNumber(newWidth));
  if (!(roundedWidth > 0)) {
    throw new CoMotionError("文字框寬度四捨五入後不是大於 0 的數字");
  }

  const container = findNodeById(scanDocument(svgContent), elementId);
  if (!container) {
    throw new CoMotionError(`元素不是文字元素：${elementId}`);
  }
  const widthAttr = attributeOf(container, TEXT_WIDTH_ATTRIBUTE);
  if (!widthAttr) {
    throw new CoMotionError(`元素不是文字框：${elementId}`);
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

  const { fontFamily, fontSize } = readTextFontInfo(textNode, elementId);
  return rewrapTextBoxContent(svgContent, textNode, widthAttr, roundedWidth, fontFamily, fontSize, fontBook, elementId);
}

/**
 * Re-wraps a text box's `<text>` content at `newWidth`/`fontFamily`/`fontSize`
 * and splices both the container's `data-comot-text-width` attribute and the
 * `<text>`'s content into `svgContent`. Extracted out of `resizeTextBox`
 * (#104) so `element-edit.ts`'s `element scale` / `element style set` share
 * this exact re-wrap-and-splice logic instead of a second copy — the caller
 * decides which of width/family/size actually changed (any unchanged value
 * is simply passed through unchanged).
 *
 * Takes the already-located `textNode` and `widthAttr` (not an `elementId`
 * to re-locate them from) because both `resizeTextBox` and `element-edit.ts`
 * have already done that lookup themselves, each with their own error
 * wording for "not a text box" / "not found".
 */
export function rewrapTextBoxContent(
  svgContent: string,
  textNode: ScannedNode,
  widthAttr: ScannedAttribute,
  newWidth: number,
  fontFamily: string,
  fontSize: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  elementId: string,
): { updated: string; lines: number } {
  const tspans = textNode.children.filter((child) => child.tag === "tspan");
  const sourceText = tspans
    .map((tspan) => unescapeXmlText(svgContent.slice(tspan.contentStart, tspan.contentEnd)))
    .join("");
  const font = resolveFont(fontBook, fontFamily, elementId);
  const wrapped = wrapText(sourceText, { width: newWidth, font, fontSizePx: fontSize });
  const content = renderTextBoxContent(wrapped.lines);

  // Two independent splices on the same string: the <text> content and the
  // container's width attribute value. The attribute always sits on the
  // container's own opening tag, strictly before any child element, so its
  // byte offsets stay valid after the content splice (which only touches
  // bytes from textNode.contentStart onward) — order between the two does
  // not matter here, but the content splice is applied first for clarity.
  const widthValue = formatSvgNumber(newWidth);
  const contentSpliced =
    svgContent.slice(0, textNode.contentStart) + content + svgContent.slice(textNode.contentEnd);
  const updated =
    contentSpliced.slice(0, widthAttr.start) +
    `${TEXT_WIDTH_ATTRIBUTE}="${widthValue}"` +
    contentSpliced.slice(widthAttr.end);

  return { updated, lines: wrapped.lines.length };
}

/**
 * Appends `markup` as the last child of the document's `<svg>` root,
 * preserving every other byte (`co-motion textbox add`'s write path, #76).
 */
export function appendElementToSvg(svgContent: string, markup: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgContent.slice(0, svgRoot.contentEnd) + markup + svgContent.slice(svgRoot.contentEnd);
}
