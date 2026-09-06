import { CoMotionError } from "./errors.js";
import { DEFAULT_FONT_FAMILY } from "./default-font.js";
import { attributeOf, attributeValue, scanDocument, type ScannedAttribute, type ScannedNode } from "./slide/scan.js";
import { wrapText } from "./text/wrap.js";
import { renderTextBoxContent } from "./text/render.js";
import { applyRunStyle, readTextBoxRuns } from "./text/runs.js";
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
 * `data-comot-text-height` (NOOP-65 決定 C), duplicated as a literal for the
 * same module-cycle reason as `TEXT_WIDTH_ATTRIBUTE` above. The one other
 * place this literal appears is `slide/format.ts`'s `TEXT_HEIGHT_ATTRIBUTE`.
 */
const TEXT_HEIGHT_ATTRIBUTE = "data-comot-text-height";

/**
 * `data-comot-text-align` (NOOP-65 決定 D): `left` | `center` | `right`,
 * absent means `left`. Set only at `textbox add` time (計畫 §2 決定:
 * 對齊只在插入時) — every rewrap path reads it back with `readTextAlign`
 * below and carries it forward unchanged, it never writes a new value.
 */
const TEXT_ALIGN_ATTRIBUTE = "data-comot-text-align";

/**
 * `data-comot-lock` (T3, ADR-0013). Duplicated here as a literal rather than
 * imported from `slide/format.ts`'s `CONTAINER_ATTRIBUTES`, for the same
 * module-cycle reason `TEXT_WIDTH_ATTRIBUTE` above is duplicated: `slide/format.ts`
 * already imports `unescapeXmlText` from this file.
 */
const LOCK_ATTRIBUTE = "data-comot-lock";

/**
 * A byte-range replacement against an `svgContent` string: `[start, end)`
 * is replaced with `text`. Moved here from `element-edit.ts` (NOOP-65 決定
 * C) so `rewrapTextBoxContent`/`setTextRunStyle` below — which both need to
 * splice the `<text>` content and the container's `data-comot-text-height`
 * attribute in the same pass — share the exact same multi-splice ordering
 * rule `element-edit.ts`'s seven mutation commands already rely on, instead
 * of a second copy of it.
 */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies every splice in `splices` to `svg` in one pass, highest offset
 * first — so an earlier splice's start/end offsets are never invalidated
 * by a length-changing splice applied to a later region of the same
 * string. Splices must not overlap.
 */
export function applySplices(svg: string, splices: readonly Splice[]): string {
  let result = svg;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

/** Replaces `attr`'s value on `node` if present, or inserts it right after the tag name if absent. */
export function setAttrSplice(node: ScannedNode, attr: string, value: string): Splice {
  const existing = attributeOf(node, attr);
  if (existing) {
    return { start: existing.start, end: existing.end, text: `${attr}="${escapeXmlAttr(value)}"` };
  }
  const insertAt = node.start + 1 + node.tag.length;
  return { start: insertAt, end: insertAt, text: ` ${attr}="${escapeXmlAttr(value)}"` };
}

/**
 * Same replace-if-present behavior as `setAttrSplice`, but a new attribute
 * is appended at the END of the opening tag (right before its own `>`)
 * instead of right after the tag name. `data-comot-text-height` (NOOP-65
 * 決定 C) uses this specifically: it is written onto an EXISTING container
 * by a rewrap, well after `id` was already there — `setAttrSplice`'s
 * front-insertion would put a brand-new attribute ahead of `id` the first
 * time a given text box gets rewrapped post-NOOP-65, silently reordering
 * every consumer that assumes `id` is a container's first attribute (every
 * `<g id="…">`-anchored regex in this codebase's own e2e suite included).
 */
export function setTrailingAttrSplice(node: ScannedNode, attr: string, value: string): Splice {
  const existing = attributeOf(node, attr);
  if (existing) {
    return { start: existing.start, end: existing.end, text: `${attr}="${escapeXmlAttr(value)}"` };
  }
  // `contentStart` is "offset just past the opening tag's `>`" (scan.ts),
  // so `contentStart - 1` is that `>` itself — inserting there appends the
  // new attribute as the tag's last one, never disturbing anything already
  // there.
  const insertAt = node.contentStart - 1;
  return { start: insertAt, end: insertAt, text: ` ${attr}="${escapeXmlAttr(value)}"` };
}

/**
 * Reads a text box container's `data-comot-text-align` (NOOP-65 決定 D),
 * defaulting to `"left"` when absent — every rewrap path calls this to
 * carry the box's alignment forward unchanged, since alignment is only
 * ever set at `textbox add` time.
 */
export function readTextAlign(container: ScannedNode, elementId: string): "left" | "center" | "right" {
  const raw = attributeValue(container, TEXT_ALIGN_ATTRIBUTE);
  if (raw === null) return "left";
  if (raw !== "left" && raw !== "center" && raw !== "right") {
    throw new CoMotionError(`元素 ${elementId} 的 ${TEXT_ALIGN_ATTRIBUTE} 不是合法值（left、center 或 right）：${raw}`);
  }
  return raw;
}

/**
 * The one guard every editing command that targets an *existing* element
 * checks before mutating it (ADR-0013): `element move` / `scale` / `rotate` /
 * `style set` / `order`, plus `text set` / `textbox width` here. `element
 * insert` never calls this (a brand-new element cannot already be locked)
 * and `element delete` deliberately never calls this either (ADR-0013: a
 * locked element may still be deleted, no `--force` required) — see
 * `element-edit.ts`'s `deleteElements`.
 *
 * `force: true` is the one-time bypass an agent asks for explicitly with
 * `--force` on that single command; it never persists (the lock attribute
 * stays exactly as it was). The message deliberately names the element id,
 * why it was rejected, and the exact escape hatch — never just "locked".
 */
export function assertNotLocked(node: ScannedNode, elementId: string, force: boolean | undefined): void {
  if (force) return;
  if (attributeValue(node, LOCK_ATTRIBUTE) === "true") {
    throw new CoMotionError(
      `元素 ${elementId} 是鎖定的版面骨架，一般命令不會改動它。確定要改請在同一條命令加上 --force。`,
    );
  }
}

/**
 * Reads the family + size a `<text>` node's own attributes declare, for
 * re-wrapping a text box's content. `font-weight` is not read here: #98's
 * font model resolves purely by family (one embedded font file per family,
 * `project-json.ts`'s `FontEntry` has no weight field), so it plays no part
 * in measurement — only in the CSS the `<text>` renders with, which this
 * module never touches.
 */
export function readTextFontInfo(textNode: ScannedNode, elementId: string): { fontFamily: string; fontSize: number } {
  // font-family is optional in SVG. A text box that omits it is measured
  // against the build's own bundled family (see default-font.ts), which
  // `resolvePresentationFonts` always puts in the font book — the same
  // rule the browser-side editing path applies in canvas.ts.
  const declaredFamily = attributeValue(textNode, "font-family");
  const fontFamily = declaredFamily === null || declaredFamily.trim() === "" ? DEFAULT_FONT_FAMILY : declaredFamily;
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
 * `container` is the node `replaceElementText` already found via
 * `scanDocument` — this function never re-scans the document.
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
  container: ScannedNode,
  newText: string,
  options: ReplaceElementTextOptions,
): string {
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
    const align = readTextAlign(container, elementId);
    // `text set` replaces the whole content string, so any existing runs'
    // character ranges no longer have a defined meaning against the new
    // text (NOOP-65 判斷: a full replace has no way to remap them) — the
    // new content is plain, exactly like a freshly inserted text box.
    const wrapped = wrapText(newText, { width, font, fontSizePx: fontSize, align });
    const content = renderTextBoxContent(wrapped.lines);
    return applySplices(svgContent, [
      { start: textNode.contentStart, end: textNode.contentEnd, text: content },
      setTrailingAttrSplice(container, TEXT_HEIGHT_ATTRIBUTE, formatSvgNumber(wrapped.height)),
    ]);
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
  /** Bypasses the locked-element guard (T3, ADR-0013, `--force`). */
  readonly force?: boolean;
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

  const node = findNodeById(scanDocument(svgContent), elementId);
  if (!node) {
    throw new CoMotionError(`找不到元素：${elementId}`);
  }
  assertNotLocked(node, elementId, options.force);

  if (node.tag === "g") {
    return replaceContainerText(svgContent, elementId, node, newText, options);
  }
  if (!TEXT_BEARING_TAGS.has(node.tag)) {
    throw new CoMotionError(`元素不是文字元素：${elementId}`);
  }
  if (node.selfClosing) {
    throw new CoMotionError(`元素沒有文字內容：${elementId}`);
  }
  return svgContent.slice(0, node.contentStart) + escapeXmlText(newText) + svgContent.slice(node.contentEnd);
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
  options: { readonly force?: boolean } = {},
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
  assertNotLocked(container, elementId, options.force);

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
  return rewrapTextBoxContent(svgContent, container, textNode, widthAttr, roundedWidth, fontFamily, fontSize, fontBook, elementId);
}

/**
 * Re-wraps a text box's `<text>` content at `newWidth`/`fontFamily`/`fontSize`
 * and splices the container's `data-comot-text-width`/`data-comot-text-height`
 * attributes and the `<text>`'s content into `svgContent`. Extracted out of
 * `resizeTextBox` (#104) so `element-edit.ts`'s `element scale` / `element
 * style set` share this exact re-wrap-and-splice logic instead of a second
 * copy — the caller decides which of width/family/size actually changed
 * (any unchanged value is simply passed through unchanged).
 *
 * The content itself never changes here — only how it lays out — so its
 * existing runs (NOOP-65 決定 B) and alignment (決定 D) are read back from
 * the current markup and carried forward unchanged; a rewrap is never the
 * place a run or an alignment is gained or lost.
 *
 * Takes the already-located `container`/`textNode`/`widthAttr` (not an
 * `elementId` to re-locate them from) because every caller has already done
 * that lookup itself, each with its own error wording for "not a text box"
 * / "not found".
 */
export function rewrapTextBoxContent(
  svgContent: string,
  container: ScannedNode,
  textNode: ScannedNode,
  widthAttr: ScannedAttribute,
  newWidth: number,
  fontFamily: string,
  fontSize: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  elementId: string,
): { updated: string; lines: number } {
  const { content: sourceText, runs } = readTextBoxRuns(textNode, svgContent);
  const align = readTextAlign(container, elementId);
  const font = resolveFont(fontBook, fontFamily, elementId);
  const wrapped = wrapText(sourceText, { width: newWidth, font, fontSizePx: fontSize, align });
  const content = renderTextBoxContent(wrapped.lines, runs);

  const widthValue = formatSvgNumber(newWidth);
  const updated = applySplices(svgContent, [
    { start: textNode.contentStart, end: textNode.contentEnd, text: content },
    { start: widthAttr.start, end: widthAttr.end, text: `${TEXT_WIDTH_ATTRIBUTE}="${widthValue}"` },
    setTrailingAttrSplice(container, TEXT_HEIGHT_ATTRIBUTE, formatSvgNumber(wrapped.height)),
  ]);

  return { updated, lines: wrapped.lines.length };
}

export interface TextRunStyleUpdate {
  /** `"normal"` clears the attribute; any other legal value sets it; `undefined` leaves this axis untouched. */
  readonly fontWeight?: string;
  /** `"normal"` clears the attribute; `"italic"` sets it; `undefined` leaves this axis untouched. */
  readonly fontStyle?: string;
}

const FONT_WEIGHT_KEYWORDS = new Set(["normal", "bold"]);

function isLegalFontWeight(value: string): boolean {
  if (FONT_WEIGHT_KEYWORDS.has(value)) return true;
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 100 && n <= 900 && n % 100 === 0;
}

/** `undefined` (flag absent) -> `undefined` (don't touch); `"normal"` -> `null` (clear); anything else -> itself (set). */
function toRunStyleValue(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === "normal" ? null : raw;
}

/**
 * `co-motion text style set`'s mutation primitive (NOOP-65 §4.2): sets or
 * clears `font-weight`/`font-style` over `[start, end)` of the text box's
 * content string, then re-wraps and re-renders (the range is a content
 * property, not a layout one, so a re-wrap is always required — the new
 * runs change which nested tspans exist).
 */
export function setTextRunStyle(
  svgContent: string,
  elementId: string,
  start: number,
  end: number,
  update: TextRunStyleUpdate,
  fontBook: ReadonlyMap<string, FontMetrics>,
  options: { readonly force?: boolean } = {},
): { updated: string; runs: number } {
  if (update.fontWeight === undefined && update.fontStyle === undefined) {
    throw new CoMotionError("text style set 至少要給 --font-weight 或 --font-style");
  }
  if (update.fontWeight !== undefined && !isLegalFontWeight(update.fontWeight)) {
    throw new CoMotionError(`--font-weight 必須是 normal、bold 或 100 的倍數（100–900）：${update.fontWeight}`);
  }
  if (update.fontStyle !== undefined && update.fontStyle !== "normal" && update.fontStyle !== "italic") {
    throw new CoMotionError(`--font-style 必須是 normal 或 italic：${update.fontStyle}`);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
    throw new CoMotionError("--range 必須是非負整數");
  }
  if (!(start < end)) {
    throw new CoMotionError("--range 的起點必須小於終點");
  }

  const container = findNodeById(scanDocument(svgContent), elementId);
  if (!container) {
    throw new CoMotionError(`找不到元素：${elementId}`);
  }
  const widthAttr = attributeOf(container, TEXT_WIDTH_ATTRIBUTE);
  if (!widthAttr) {
    throw new CoMotionError(`元素不是文字框：${elementId}`);
  }
  assertNotLocked(container, elementId, options.force);

  const groupChildren = container.children.filter((child) => child.tag === "g");
  const textChildren = container.children.filter((child) => child.tag === "text");
  if (groupChildren.length > 0 || textChildren.length !== 1) {
    throw new CoMotionError(`元素不是文字元素：${elementId}`);
  }
  const textNode = textChildren[0];
  if (textNode.selfClosing) {
    throw new CoMotionError(`元素沒有文字內容：${elementId}`);
  }

  const { content, runs } = readTextBoxRuns(textNode, svgContent);
  if (end > content.length) {
    throw new CoMotionError(`--range 超出內容長度（${content.length}）：${start}:${end}`);
  }

  const nextRuns = applyRunStyle(runs, start, end, {
    fontWeight: toRunStyleValue(update.fontWeight),
    fontStyle: toRunStyleValue(update.fontStyle),
  });

  const { fontFamily, fontSize } = readTextFontInfo(textNode, elementId);
  const align = readTextAlign(container, elementId);
  const font = resolveFont(fontBook, fontFamily, elementId);
  const width = Number(widthAttr.value);
  const wrapped = wrapText(content, { width, font, fontSizePx: fontSize, align });
  const renderedContent = renderTextBoxContent(wrapped.lines, nextRuns);

  const updated = applySplices(svgContent, [
    { start: textNode.contentStart, end: textNode.contentEnd, text: renderedContent },
    setTrailingAttrSplice(container, TEXT_HEIGHT_ATTRIBUTE, formatSvgNumber(wrapped.height)),
  ]);

  return { updated, runs: nextRuns.length };
}

// `{{ variableName }}` — whitespace around the name is allowed, the name
// itself is a plain word ([A-Za-z0-9_]). A `{{` with no matching `}}`, or a
// name this project has never heard of, simply does not match here and is
// left as literal text by `substituteDynamicText` below — this scanner
// never throws over dynamic-text syntax (NOOP-90/T4's decision: unknown
// placeholders are a display-time no-op, not an error).
const DYNAMIC_VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Collects the byte ranges of every leaf text-bearing node in the document
 * — a `<text>` or `<tspan>` with no child elements, whose `[contentStart,
 * contentEnd)` span is character data, not markup. A `<text>` wrapping
 * `<tspan>` children (a text box, #76) is not itself a leaf; each of its
 * `<tspan>` children is collected individually instead, so a variable
 * substituted inside one line never touches the others.
 */
function collectTextLeafRanges(nodes: readonly ScannedNode[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const node of nodes) {
    if ((node.tag === "text" || node.tag === "tspan") && !node.selfClosing && node.children.length === 0) {
      ranges.push({ start: node.contentStart, end: node.contentEnd });
    } else {
      ranges.push(...collectTextLeafRanges(node.children));
    }
  }
  return ranges;
}

/**
 * Replaces `{{ variableName }}` placeholders with the values in `variables`,
 * scanning only the character data of `<text>`/`<tspan>` leaves — never
 * attribute values, never markup (ADR-0010: slide content is untrusted, so
 * this is a table lookup, not a template engine; no conditionals, loops or
 * escaping syntax exist). A placeholder naming a variable not present in
 * `variables` is left exactly as written, byte for byte — this is the one
 * deliberately silent case in the whole module (see the ADR's accepted
 * cost: a presentation opened in another tool shows the literal
 * `{{ slide_number }}`). This is a read-time projection, never persisted —
 * callers apply it to a slide's bytes only when serving them for display,
 * never through `writePresentationFile` (`cat`'s byte-exact contract must
 * stay intact for every other reader).
 *
 * Ranges are substituted from the end of the document backwards so that an
 * earlier range's offsets are never invalidated by a length-changing
 * splice applied to a later one.
 */
export function substituteDynamicText(svgContent: string, variables: ReadonlyMap<string, string>): string {
  const ranges = collectTextLeafRanges(scanDocument(svgContent));
  let result = svgContent;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end } = ranges[i];
    const original = result.slice(start, end);
    const replaced = original.replace(DYNAMIC_VARIABLE_PATTERN, (match, name: string) => {
      return variables.get(name) ?? match;
    });
    if (replaced !== original) {
      result = result.slice(0, start) + replaced + result.slice(end);
    }
  }
  return result;
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
