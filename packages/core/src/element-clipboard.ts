import { CoMotionError } from "./errors.js";
import { composeMatrices, decomposeMatrix, formatTransform, multiplyMatrix, parseTransform, type Matrix, type TransformParts } from "./geometry/transform.js";
import { assertSlideCompliant } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { EFFECTS_NS, SUPPORTED_EFFECTS, SUPPORTED_STARTS, type RawEffectAttributes } from "./effects/index.js";

/**
 * `element copy` / `element paste` / `element duplicate` (決定 5-7). Pure
 * string-in/string-out functions — the clipboard *file* itself (its path
 * under `<CO_MOTION_HOME>/clipboard/<presentationId>.json`, outside the
 * working directory) is `workspace.ts`'s concern, not this module's; this
 * module only knows how to extract a copy payload from one slide and how
 * to splice one into another.
 *
 * Small offset-splicing helpers are duplicated from `element-edit.ts` /
 * `element-group.ts` on purpose (see this ticket's plan).
 */

export interface ClipboardPayload {
  sourceSlidePath: string;
  /** Full container markup, one entry per copied target, ancestor-chain transform already folded in. */
  elements: string[];
  /** `<comot:effect>` markup, verbatim, in original document order. */
  effects: string[];
  /** The source slide's `<svg viewBox>`, verbatim. `undefined` for a payload written before this field existed — `serializeClipboardSvg` falls back to `DEFAULT_CLIPBOARD_VIEWBOX` rather than erroring. */
  viewBox?: string;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

function applySplices(svg: string, splices: readonly Splice[]): string {
  let result = svg;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

function requireSvgRoot(roots: readonly ScannedNode[]): ScannedNode {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

function validateIdList(elementIds: readonly string[]): void {
  if (elementIds.length === 0) {
    throw new CoMotionError("元素清單不可為空");
  }
  const seen = new Set<string>();
  for (const id of elementIds) {
    if (seen.has(id)) {
      throw new CoMotionError(`元素清單重複：${id}`);
    }
    seen.add(id);
  }
}

/** Depth-first search for container `id`, tracking the chain of ancestor `<g>` matrices from the root down to (excluding) the found node itself. */
function findContainerWithAncestors(
  svgRoot: ScannedNode,
  id: string,
  ancestors: readonly Matrix[] = [],
): { node: ScannedNode; ancestors: readonly Matrix[] } | undefined {
  for (const child of svgRoot.children) {
    if (child.tag !== "g") continue;
    if (attributeValue(child, "id") === id) return { node: child, ancestors };
    const childMatrix = parseTransform(attributeValue(child, "transform"));
    const found = findContainerWithAncestors(child, id, [...ancestors, childMatrix]);
    if (found) return found;
  }
  return undefined;
}

function requireContainerWithAncestors(svgRoot: ScannedNode, id: string): { node: ScannedNode; ancestors: readonly Matrix[] } {
  const found = findContainerWithAncestors(svgRoot, id);
  if (!found) {
    throw new CoMotionError(`找不到元素：${id}`);
  }
  return found;
}

/** Every container id in `node`'s subtree, itself included — used to find every effect referencing the copied target or a descendant of it. */
function collectContainerIds(node: ScannedNode, into: Set<string>): void {
  const id = attributeValue(node, "id");
  if (id) into.add(id);
  for (const child of node.children) {
    if (child.tag === "g") collectContainerIds(child, into);
  }
}

function attributeRemovalSplice(container: ScannedNode, svg: string, attr: { start: number; end: number }): Splice {
  let start = attr.start;
  while (start > container.start && /[\t\n\r ]/.test(svg[start - 1])) start--;
  return { start, end: attr.end, text: "" };
}

/** Sets `node`'s `transform` attribute within `svg` to the mutated parts' serialization, all offsets relative to `svg`. */
function transformSplice(svg: string, node: ScannedNode, mutate: (parts: TransformParts) => TransformParts): Splice {
  const attr = attributeOf(node, "transform");
  const matrix = parseTransform(attr ? attr.value : null);
  const nextTransform = formatTransform(mutate(decomposeMatrix(matrix)));
  if (attr) {
    if (nextTransform === "") return attributeRemovalSplice(node, svg, attr);
    return { start: attr.start, end: attr.end, text: `transform="${nextTransform}"` };
  }
  if (nextTransform === "") return { start: node.start, end: node.start, text: "" };
  const insertAt = node.start + 1 + node.tag.length;
  return { start: insertAt, end: insertAt, text: ` transform="${nextTransform}"` };
}

/** Applies `setTransformSplice`-style mutation to a *standalone* markup fragment's own top-level node (its own coordinate system, not the whole document). */
function rewriteFragmentTransform(markup: string, mutate: (parts: TransformParts) => TransformParts): string {
  const roots = scanDocument(markup);
  const root = roots[0];
  const splice = transformSplice(markup, root, mutate);
  return applySplices(markup, [splice]);
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

/**
 * Extracts a copyable snapshot of every target (`co-motion element copy`).
 * Does not mutate `svgContent`. Each target's ancestor-chain matrix (if it
 * sits inside a group) is folded into its own `transform`, so pasting it
 * back at the root level of any slide preserves its visual position.
 * Every `<comot:effect>` whose `target` names the copied element or any of
 * its descendants is captured verbatim, in document order.
 */
export function extractElementsForCopy(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
): ClipboardPayload {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);

  const copiedIds = new Set<string>();
  const elements: string[] = [];
  for (const id of elementIds) {
    const { node, ancestors } = requireContainerWithAncestors(svgRoot, id);
    collectContainerIds(node, copiedIds);
    const ownMatrix = parseTransform(attributeValue(node, "transform"));
    const foldedMatrix = multiplyMatrix(composeMatrices(ancestors), ownMatrix);
    const nodeText = svgContent.slice(node.start, node.end);
    const rebased = rewriteFragmentTransform(nodeText, () => decomposeMatrix(foldedMatrix));
    elements.push(rebased);
  }

  const effects: string[] = [];
  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  const effectsList = metadata?.children.find((child) => child.tag === "comot:effects");
  if (effectsList) {
    for (const effect of effectsList.children) {
      if (effect.tag !== "comot:effect") continue;
      const target = attributeValue(effect, "target");
      if (target !== null && copiedIds.has(target)) {
        effects.push(svgContent.slice(effect.start, effect.end));
      }
    }
  }

  const viewBox = attributeValue(svgRoot, "viewBox") ?? undefined;

  return { sourceSlidePath: slidePath, elements, effects, viewBox };
}

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

/** Regenerates every container id inside a standalone markup fragment (its own top-level id included), consistently, via `generateId()`. */
function regenerateIds(markup: string, generateId: () => string): { markup: string; idMap: Map<string, string> } {
  const roots = scanDocument(markup);
  const root = roots[0];
  const idMap = new Map<string, string>();

  const collect = (node: ScannedNode): void => {
    const idAttr = attributeOf(node, "id");
    if (idAttr) idMap.set(idAttr.value, generateId());
    for (const child of node.children) {
      if (child.tag === "g") collect(child);
    }
  };
  collect(root);

  const splices: Splice[] = [];
  const walk = (node: ScannedNode): void => {
    const idAttr = attributeOf(node, "id");
    if (idAttr) {
      splices.push({ start: idAttr.start, end: idAttr.end, text: `id="${idMap.get(idAttr.value)}"` });
    }
    for (const child of node.children) {
      if (child.tag === "g") walk(child);
    }
  };
  walk(root);

  return { markup: applySplices(markup, splices), idMap };
}

function rewriteEffectTarget(effectMarkup: string, idMap: ReadonlyMap<string, string>): string {
  const roots = scanDocument(effectMarkup);
  const node = roots[0];
  const attr = attributeOf(node, "target");
  if (!attr) {
    throw new CoMotionError("剪貼簿資料損毀：effect 缺少 target 屬性");
  }
  const newId = idMap.get(attr.value);
  if (!newId) {
    throw new CoMotionError(`剪貼簿資料不一致：effect 的 target 找不到對應的新元素（${attr.value}）`);
  }
  return applySplices(effectMarkup, [{ start: attr.start, end: attr.end, text: `target="${newId}"` }]);
}

/** Appends `markup` as the last child of `<svg>`. */
function appendMarkup(svgContent: string, markup: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  return svgContent.slice(0, svgRoot.contentEnd) + markup + svgContent.slice(svgRoot.contentEnd);
}

/**
 * [E2.T7]/D2: this used to be the literal `https://schemas.comotion.app/effects`
 * — a different value than every other reader/writer of `<comot:effects>`
 * uses (`https://co-motion.dev/ns`, `packages/web/src/effects.ts`'s
 * `EFFECTS_NS`, `packages/core/src/effects/index.ts`'s `EFFECTS_NS`,
 * `packages/core/src/notes.ts`'s `NOTES_NS`). Because the web reader
 * matches by namespace URI, pasting onto a slide with no prior effect list
 * created one the player would silently treat as empty — the pasted
 * effects vanished with no error. Now imports the single shared constant.
 */
const EFFECTS_XMLNS = EFFECTS_NS;

/** Inserts `effectMarkups`, joined, at the end of the target slide's effect list — creating `<metadata><comot:effects>` if the slide has none yet. */
function appendEffects(svgContent: string, effectMarkups: readonly string[]): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const joined = effectMarkups.join("");

  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  if (metadata) {
    const effectsList = metadata.children.find((child) => child.tag === "comot:effects");
    if (effectsList) {
      return svgContent.slice(0, effectsList.contentEnd) + joined + svgContent.slice(effectsList.contentEnd);
    }
    const block = `<comot:effects xmlns:comot="${EFFECTS_XMLNS}">${joined}</comot:effects>`;
    return svgContent.slice(0, metadata.contentEnd) + block + svgContent.slice(metadata.contentEnd);
  }
  const block = `<metadata><comot:effects xmlns:comot="${EFFECTS_XMLNS}">${joined}</comot:effects></metadata>`;
  return svgContent.slice(0, svgRoot.contentStart) + block + svgContent.slice(svgRoot.contentStart);
}

// ---------------------------------------------------------------------------
// clipboard SVG (system clipboard exchange format, decided in [E2.T18]'s plan)
// ---------------------------------------------------------------------------

/** Marks the wrapper `<svg>` a paste should recognise as a co-motion element clipboard payload. */
const CLIPBOARD_MARKER_ATTR = "data-comot-clipboard";
const CLIPBOARD_MARKER_VALUE = "elements";
const CLIPBOARD_SOURCE_ATTR = "data-comot-source";

/** Used only to satisfy `assertSlideCompliant`'s `missing-viewbox` check while sanitising a fragment in isolation — never the payload's own `viewBox`. */
const SANITIZE_PLACEHOLDER_VIEWBOX = "0 0 1280 720";

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 1.0 §2.2 legal character ranges — the code points a conforming XML character reference may target. Anything else (surrogate halves, `0xFFFE`/`0xFFFF`, code points above `0x10FFFF`, most C0 controls) would make the written slide unparsable by any XML parser. */
function isLegalXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** Decimal (`&#104;`), hex (`&#x68;`) and the five predefined XML entities — the only character references a browser's XML/SVG parser resolves. Attribute values are scanned *after* this decode so entity-encoding can't hide an external reference or a dangerous scheme from the checks below (e.g. `href="&#104;ttps://evil.example"`). Total function — never throws: a numeric reference outside the legal XML range is returned verbatim (undecoded), so the caller can reject it explicitly via `hasIllegalNumericCharacterReference` instead of this function raising a raw `RangeError`. */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return isLegalXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return XML_NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A numeric character reference (`&#…;`/`&#x…;`) whose code point `decodeXmlEntities` refused to decode — writing it verbatim would produce a slide no XML parser can read back. Checked independently of `decodeXmlEntities` (which must stay total) so the caller can reject it with a `CoMotionError` instead of silently passing the undecoded reference text through. */
function hasIllegalNumericCharacterReference(value: string): boolean {
  for (const match of value.matchAll(/&(#x[0-9a-f]+|#[0-9]+);/gi)) {
    const body = match[1];
    const codePoint = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!isLegalXmlCodePoint(codePoint)) return true;
  }
  return false;
}

/**
 * [I1, r5] Used only by the `RELATIVE_REF` grammar (below) as a second gate
 * behind the shape check, delegating to the same WHATWG `URL` parser a
 * browser uses rather than re-implementing its normalisation steps by hand.
 * Kept per [E2.T18r6] 決定 D6: the shape check alone already blocks every
 * known bypass (see the grammar's own comment), but this catches an unknown
 * unknown — a shape the grammar allows that a browser still resolves
 * off-document. Global `URL` needs no import, so this module stays
 * dependency-free and usable from both Node and the browser.
 *
 * Two probe bases, both must resolve inside the document: with only an
 * `https://` base, `https:evil.example` (an absolute URL that omits `//`)
 * parses as *relative* to that base and would pass; the `http://` base
 * catches it (and vice versa for an `http:` value against an `https://`
 * base). A parse failure is treated as external (reject) — a legitimate
 * relative reference has no reason to fail parsing against either base.
 */
const REFERENCE_PROBE_BASES = ["https://clipboard.invalid/base/", "http://clipboard.invalid/base/"] as const;

function resolvesWithinDocument(value: string): boolean {
  for (const base of REFERENCE_PROBE_BASES) {
    const baseUrl = new URL(base);
    let resolved: URL;
    try {
      resolved = new URL(value, base);
    } catch {
      return false;
    }
    if (resolved.protocol !== baseUrl.protocol || resolved.host !== baseUrl.host) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// [E2.T18r6] Value grammars — the allowlist's third layer. Each grammar
// judges whether a *complete* attribute value has a shape co-motion's own
// serializer can produce (Plan §4.2): a value space small enough for an
// anchored regex, or one large enough to need a real parser (`parseTransform`,
// already strict) delegated to wholesale. None of them parse CSS, a URL
// scheme grammar, or any other downstream syntax — the tag/attribute layers
// below make that unnecessary (`style` and every URL-bearing attribute
// outside `href`/`data-comot-media` are simply not on any tag's list).
// ---------------------------------------------------------------------------

type Grammar = (value: string) => boolean;

// 寫入端：packages/core/src/svg-number.ts:6 `formatSvgNumber`（`Number(v.toFixed(4))` → `String`，含 `1e-7`/`1e+21` 指數形）→ 相容。
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const isNumber: Grammar = (value) => NUMBER_RE.test(value);

/** One or more `NUMBER`s separated by whitespace or commas; `exactCount`, when given, pins the count (the wrapper `viewBox`'s "exactly 4"). */
function numberList(exactCount?: number): Grammar {
  return (value) => {
    const parts = value.split(/[\s,]+/).filter((part) => part.length > 0);
    if (parts.length === 0) return false;
    if (exactCount !== undefined && parts.length !== exactCount) return false;
    return parts.every((part) => isNumber(part));
  };
}

// 寫入端（`id`）：packages/core/src/id.ts `generateElementId`（`el-` + 9 bytes base64url，字元集 `A-Za-z0-9-_`）→ 相容。
const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const isXmlName: Grammar = (value) => XML_NAME_RE.test(value);

/**
 * 寫入端：`element-edit.ts:1011` `STYLE_ATTRIBUTE_WHITELIST` / `validateStyleAttribute`
 * ——`fill`/`stroke` 是這份白名單的成員，但除 `opacity`/`font-size` 外
 * `validateStyleAttribute` 不驗證值本身，`element style set` 可以把任意字串寫進 `fill`。
 * 本文法比寫入端窄，已知誤擋（例：`fill="rgb(1,2,3)"`），見 NOOP-213。
 */
const NAMED_COLOR_RE = /^[a-zA-Z]{1,32}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PAINT_URL_REF_RE = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
const isPaint: Grammar = (value) =>
  value === "none" || value === "currentColor" || HEX_COLOR_RE.test(value) || NAMED_COLOR_RE.test(value) || PAINT_URL_REF_RE.test(value);

/**
 * Conservative character set as a first gate, `parseTransform` (already a
 * strict allowlist parser, geometry/transform.ts) as the real judge — so a
 * future relaxation of that parser can't silently widen this grammar too.
 * 寫入端：`packages/core/src/geometry/transform.ts:248` `formatTransform`
 * （只產 `translate()`/`rotate()`/`scale()`）→ 相容。
 */
const TRANSFORM_CHARSET_RE = /^[A-Za-z0-9 ,.()+\-eE\t\n\r]*$/;
const isTransform: Grammar = (value) => {
  if (!TRANSFORM_CHARSET_RE.test(value)) return false;
  try {
    parseTransform(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Character set only — path data isn't a reference carrier, so there's
 * nothing to parse for, only a shape to bound. 寫入端：`element-edit.ts:238`
 * (`element insert path --d`，`escapeXmlAttr(input.d)` 原樣寫入，不驗證形狀)
 * → 本文法比寫入端窄，已知誤擋（任意 `--d` 字串只要落在 SVG path 語法之外的字元
 * 集就會被擋），見 NOOP-213。
 */
const PATH_DATA_RE = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$/;
const isPathData: Grammar = (value) => PATH_DATA_RE.test(value);

/**
 * Empty, a same-document fragment (`#id`), or a relative path that doesn't
 * open with a protocol-relative `//` — excludes only what actually closes
 * every `javascript:`/`data:`/CSS-escape/backslash-equivalence bypass this
 * ticket's prior rounds each found one new instance of: a scheme colon
 * (`:`), a backslash (`\`, path-separator-equivalent in a browser's URL
 * parser), and C0/C1 control characters (whitespace/newline-hiding tricks).
 * An ASCII-only positive enumeration was tried first and rejected every
 * non-ASCII asset path — co-motion is a Traditional-Chinese-first product
 * where Chinese filenames are ordinary input `element insert`/-media never
 * blocks ([E2.T18r7] FAIL #2). `resolvesWithinDocument` is kept as a second
 * gate behind this shape (決定 D6): it alone already blocks every bypass
 * sample this exclusion set widens for (no non-ASCII sample relies on the
 * charset, only on the `:`/`\`/leading-`//` exclusions or the second gate).
 * 寫入端：`element-edit.ts:181`（`data-comot-media`）與 `element-edit.ts:215`
 * （`image href`），皆經 `escapeXmlAttr` → 相容。
 */
const RELATIVE_REF_FRAGMENT_RE = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;
const RELATIVE_REF_PATH_RE = /^[^\x00-\x1f\x7f-\x9f:\\]*$/;
const isRelativeRef: Grammar = (value) => {
  const shapeOk = value === "" || RELATIVE_REF_FRAGMENT_RE.test(value) || (RELATIVE_REF_PATH_RE.test(value) && !value.startsWith("//"));
  return shapeOk && resolvesWithinDocument(value);
};

// 寫入端：packages/core/src/table-clipboard.ts（`data-comot-cell="r,c"`，0-based）→ 相容。
const CELL_REF_RE = /^\d+,\d+$/;
const isCellRef: Grammar = (value) => CELL_REF_RE.test(value);

/**
 * Excludes `(`/`:`/`;`/`\`/`<`/`>`/`"`/`'` — i.e. every character a CSS
 * function, a protocol, or a markup delimiter needs. 寫入端：
 * `element-edit.ts:1011` `STYLE_ATTRIBUTE_WHITELIST` / `validateStyleAttribute`
 * （不驗證 `font-family` 的值）→ 本文法比寫入端窄，已知誤擋（字型名的引號／逗號
 * 清單，例：`font-family="&quot;Noto Sans TC&quot;, sans-serif"`），見 NOOP-213。
 */
const FONT_FAMILY_RE = /^[^()\\:;<>"'&]{0,128}$/;
const isFontFamily: Grammar = (value) => FONT_FAMILY_RE.test(value);

/**
 * Free-form display text (`data-comot-name`) — not a reference carrier, so
 * this grammar excludes only control characters; markup delimiters (`<`/`>`)
 * and `\` are no longer excluded here ([E2.T18r8] FAIL #2 / 債1): raw-form
 * XML legality is now `checkAttributeValue`'s job (`hasIllegalRawXmlText`,
 * ahead of every grammar), so a *decoded* `<`/`>` — e.g.
 * `data-comot-name="x&lt;y&gt;z"`, a legal display value `escapeXmlAttr`
 * never blocks writing — has no reason to fail here; the raw form is still
 * caught upstream regardless of what this grammar allows. Source:
 * `element-group.ts:265` `setElementName` (via `escapeXmlAttr`, which never
 * escapes `\`) — no length bound: `setElementName` never limits `name`'s
 * length, and a length cap here is not a security property
 * (`data-comot-name` carries no reference, per D9) — it only buys
 * mis-rejections of legitimate long names ([E2.T18r7] FAIL #3).
 */
const FREE_TEXT_RE = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]*$/;
const isFreeText: Grammar = (value) => FREE_TEXT_RE.test(value);

/**
 * `data-comot-list` (NOOP-65 決定 E, `element-text.ts:110-116`): one
 * whitespace-separated token per paragraph (`content.split("\n")`) — no
 * upper bound on paragraph count. `?` (at most two tokens) was a transcription
 * of a probe corpus's actual output, not this contract; any text box with
 * three or more paragraphs failed to copy ([E2.T18r7] FAIL #1).
 */
const LIST_SPEC_RE = /^(bullet|number|none)(?: (bullet|number|none))*$/;
const isListSpec: Grammar = (value) => LIST_SPEC_RE.test(value);

function enumOf(values: readonly string[]): Grammar {
  const set = new Set(values);
  return (value) => set.has(value);
}

const FONT_WEIGHTS = ["normal", "bold", "lighter", "bolder", "100", "200", "300", "400", "500", "600", "700", "800", "900"];

/** Shared by every primitive tag (Plan §4.3 `COMMON`) — `<g>` is deliberately excluded (it has no `fill`/`stroke`/`opacity` of its own, and no `xmlns:*`: the serializer never writes either on a container). */
const COMMON: Readonly<Record<string, Grammar>> = {
  id: isXmlName,
  "data-comot-name": isFreeText,
  fill: isPaint,
  stroke: isPaint,
  "stroke-width": isNumber,
  "stroke-dasharray": numberList(),
  opacity: isNumber,
};

/** Shared by `text`/`tspan` (Plan §4.3 `TEXTISH`). */
const TEXTISH: Readonly<Record<string, Grammar>> = {
  "font-family": isFontFamily,
  "font-size": isNumber,
  "font-weight": enumOf(FONT_WEIGHTS),
  "font-style": enumOf(["normal", "italic", "oblique"]),
  "text-anchor": enumOf(["start", "middle", "end"]),
};

/** [E2.T18r6] Plan §4.3: one grammar map per tag `sanitizeClipboardMarkup("element", …)` may see. A tag with no entry here is rejected outright (`checkNodeAttributes`) — this *is* the allowlist's tag layer, alongside `assertSlideCompliant`'s own (broader, structural) tag sweep. */
const ELEMENT_TAG_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, Grammar>>>> = {
  g: {
    id: isXmlName,
    transform: isTransform,
    "data-comot-name": isFreeText,
    "data-comot-media": isRelativeRef,
    "data-comot-lock": enumOf(["true"]),
    "data-comot-type": enumOf(["table"]),
    "data-comot-cell": isCellRef,
    // 寫入端（表格容器／儲存格，E2.T14 #203）：table/render.ts:25-47 →
    // cols/rows 是空白分隔的數字列表、header/generated 恆為 "1"、span 與
    // cell 同形（"r,c"）、repeat 恆為 "row" 且必搭 display="none"、theme 與
    // align 取自 table/model.ts 的 TABLE_THEMES／CELL_ALIGNS。
    "data-comot-cols": numberList(),
    "data-comot-rows": numberList(),
    "data-comot-header": enumOf(["1"]),
    "data-comot-theme": enumOf(["dark", "light", "zebra"]),
    "data-comot-span": isCellRef,
    "data-comot-repeat": enumOf(["row"]),
    "data-comot-generated": enumOf(["1"]),
    "data-comot-align": enumOf(["left", "center", "right"]),
    display: enumOf(["none"]),
    // 寫入端（data-comot-text-width/height）：workspace.ts:696-697 → 相容。
    "data-comot-text-width": isNumber,
    "data-comot-text-height": isNumber,
    // 寫入端：workspace.ts:694 → 相容。
    "data-comot-text-align": enumOf(["left", "center", "right"]),
  },
  rect: { ...COMMON, x: isNumber, y: isNumber, width: isNumber, height: isNumber, rx: isNumber, ry: isNumber },
  ellipse: { ...COMMON, cx: isNumber, cy: isNumber, rx: isNumber, ry: isNumber },
  circle: { ...COMMON, cx: isNumber, cy: isNumber, r: isNumber, "data-comot-media": isRelativeRef },
  line: { ...COMMON, x1: isNumber, y1: isNumber, x2: isNumber, y2: isNumber },
  path: { ...COMMON, d: isPathData },
  image: {
    ...COMMON,
    x: isNumber,
    y: isNumber,
    width: isNumber,
    height: isNumber,
    href: isRelativeRef,
    // 全 repo 無任何寫入端（`grep -rn preserveAspectRatio packages --include=*.ts`
    // 只命中本行與 web/src/overview.ts:420 的一則註解）→ 疑似無來源，本輪只標註不刪。
    preserveAspectRatio: enumOf(["none", "xMidYMid meet", "xMidYMid slice"]),
    "data-comot-media": isRelativeRef,
  },
  text: {
    ...COMMON,
    ...TEXTISH,
    x: isNumber,
    y: isNumber,
    // 寫入端：element-text.ts:216 → 相容。
    "xml:space": enumOf(["preserve"]),
    "data-comot-list": isListSpec,
    // 寫入端：element-text.ts:126（LIST_MARKER_ATTRIBUTE）→ 相容。
    "data-comot-list-marker": enumOf(["true"]),
  },
  // 寫入端（data-comot-break）：text/render.ts:32 → 相容。
  tspan: { ...COMMON, ...TEXTISH, x: isNumber, y: isNumber, "data-comot-break": enumOf(["1"]) },
  title: { id: isXmlName },
  desc: { id: isXmlName },
};

/** [E2.T18] 決定 4，改寫為 §4.3 的值文法（原本只檢查屬性名稱）：三個 ENUM 的內容從 `effects/index.ts` 推導，不手抄成新常數。 */
const EFFECT_ATTRIBUTE_GRAMMAR_TYPED: Readonly<Record<keyof RawEffectAttributes, Grammar>> = {
  target: isXmlName,
  family: enumOf(Object.keys(SUPPORTED_EFFECTS)),
  effect: enumOf(Object.values(SUPPORTED_EFFECTS).flat()),
  start: enumOf(SUPPORTED_STARTS),
  duration: isNumber,
  delay: isNumber,
  d: isPathData,
};
/** Widened to a string index so `checkNodeAttributes` can look up an arbitrary (possibly-illegal) attribute name against both this map and `ELEMENT_TAG_ATTRIBUTES` through the same code path; `EFFECT_ATTRIBUTE_GRAMMAR_TYPED` above is what actually pins the keys to `RawEffectAttributes`. */
const EFFECT_ATTRIBUTE_GRAMMAR: Readonly<Record<string, Grammar>> = EFFECT_ATTRIBUTE_GRAMMAR_TYPED;

/**
 * [E2.T18r8, Corrective Strategy] "The bytes written into the slide must be
 * well-formed XML" is a property of the *raw* form only — an attribute's
 * decoded form (`href="a&lt;b.png"` decodes to `a<b.png`, a perfectly legal
 * *display* value) is not written to disk, `scan.ts`'s `ScannedAttribute.value`
 * is. Putting this check inside a per-attribute value grammar (as r6/r7 each
 * tried) forces one regex to answer both questions at once and got it wrong
 * both times: r6 rejected raw `<`/`&` by rejecting decoded `<`/`&` too (FAIL:
 * `data-comot-name="x&lt;y&gt;z"` mis-rejected); r7 fixed that by widening the
 * *decoded*-safe character set, which reopened the raw shape (FAIL: a literal
 * unescaped `<` in `href` passed through and produced a slide `DOMParser`
 * can't parse). This check runs once, in `checkAttributeValue`, ahead of any
 * grammar — so no per-attribute grammar needs to reason about raw vs. decoded
 * ever again.
 */
const XML_REFERENCE_RE = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

/** `null` when `raw` is well-formed XML text; otherwise a human-readable reason. */
function hasIllegalRawXmlText(raw: string): string | null {
  if (raw.includes("<")) return "含有未逸出的 <";
  if (raw.replace(XML_REFERENCE_RE, "").includes("&")) return "含有未開啟合法字元參照的 &";
  if (hasIllegalNumericCharacterReference(raw)) return "含有非法的 XML 字元參照";
  for (const ch of raw) {
    if (!isLegalXmlCodePoint(ch.codePointAt(0)!)) return "含有 XML 1.0 不允許的字元";
  }
  return null;
}

/**
 * [Corrective Strategy #1, D6] Every grammar runs inside the same
 * `for (const form of forms)` loop, over both the raw attribute value and
 * its one-pass entity-decode. This is a structural constraint, not a
 * per-rule choice: a grammar checked only against the raw form is one an
 * entity-encoded payload can slip past. `forms` is `[value]` when decoding
 * changed nothing (the common case), so unaffected attribute values pay no
 * extra cost.
 */
function checkAttributeValue(tag: string, attrName: string, value: string, label: string, grammar: Grammar): void {
  const rawProblem = hasIllegalRawXmlText(value);
  if (rawProblem) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 的 <${tag}> 屬性 ${attrName} 的原始文字不是合法的 XML（${rawProblem}）`);
  }
  if (hasIllegalNumericCharacterReference(value)) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 的 <${tag}> 屬性 ${attrName} 含有非法的 XML 字元參照（${value}）`);
  }
  const decodedValue = decodeXmlEntities(value);
  const forms = decodedValue === value ? [value] : [value, decodedValue];
  for (const form of forms) {
    if (!grammar(form)) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 的 <${tag}> 屬性 ${attrName} 的值不符合允許的格式（${value}）`);
    }
  }
}

function checkNodeAttributes(node: ScannedNode, label: string, isEffect: boolean): void {
  const tagGrammar = isEffect
    ? node.tag === "comot:effect"
      ? EFFECT_ATTRIBUTE_GRAMMAR
      : undefined
    : Object.hasOwn(ELEMENT_TAG_ATTRIBUTES, node.tag)
      ? ELEMENT_TAG_ATTRIBUTES[node.tag]
      : undefined;
  if (!tagGrammar) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 含有不在允許清單內的標籤 <${node.tag}>`);
  }
  for (const attribute of node.attributes) {
    /**
     * [E2.T18r7 FAIL #4] `tagGrammar[attribute.name]` alone lets a
     * prototype-chain property name (`constructor`, `toString`, …) resolve
     * to an inherited `Object.prototype` value instead of `undefined` —
     * `Object.hasOwn` restricts the lookup to the grammar map's own keys, so
     * every such name falls through to the same `CoMotionError` an
     * unrecognised attribute name gets, not a truthy inherited value nor a
     * raw JS `TypeError` from calling it as a grammar.
     */
    const grammar = Object.hasOwn(tagGrammar, attribute.name) ? tagGrammar[attribute.name] : undefined;
    if (!grammar) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 的 <${node.tag}> 屬性 ${attribute.name} 不在允許清單內`);
    }
    checkAttributeValue(node.tag, attribute.name, attribute.value, label, grammar);
  }
  for (const child of node.children) {
    checkNodeAttributes(child, label, isEffect);
  }
}

/**
 * [E2.T18r8] Same raw-form XML legality as `checkAttributeValue`, applied to
 * element/character content instead of an attribute value — the same
 * unescaped-`<`/bare-`&`/illegal-code-point defect reaches the written slide
 * through `<text>`/`<tspan>` character data just as readily as through an
 * attribute (a bare `&` in either place produces a slide `DOMParser` can't
 * parse). A node's own text is everything in its content range *not* covered
 * by a child element — `markup.slice` between consecutive child boundaries,
 * recursing into each child for its own text. `markup`/`scanDocument(markup)`
 * share one coordinate system (`sanitizeClipboardMarkup` scans `markup`
 * itself, not `wrapped`), so these offsets are directly usable.
 */
function checkTextContent(markup: string, node: ScannedNode, label: string): void {
  if (node.selfClosing) return;
  let cursor = node.contentStart;
  const spans: string[] = [];
  for (const child of node.children) {
    spans.push(markup.slice(cursor, child.start));
    checkTextContent(markup, child, label);
    cursor = child.end;
  }
  spans.push(markup.slice(cursor, node.contentEnd));
  for (const span of spans) {
    const problem = hasIllegalRawXmlText(span);
    if (problem) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 的 <${node.tag}> 文字內容不是合法的 XML（${problem}）`);
    }
  }
}

/**
 * The one gate every pasted fragment — internal or from the system
 * clipboard — must pass before it is spliced into a presentation (ADR-0010,
 * [E2.T18] 決定 4). Never patches a bad fragment into something acceptable:
 * every violation throws, none are silently stripped. Three layers:
 *
 * 1. Structural: wrapping the fragment so `assertSlideCompliant` can reuse
 *    its existing tag whitelist/`<script>`/`<foreignObject>` sweep for free.
 *    An `elements` fragment is wrapped as direct `<svg>` content (so the
 *    normal-form checks — missing id, mixed children, unknown tag — apply);
 *    an `effects` fragment is wrapped inside `<metadata><comot:effects>`,
 *    where only the forbidden-tag sweep (which walks metadata too) applies —
 *    `checkSlideCompliance` does not otherwise structurally inspect metadata.
 * 2. Single-root (I4, r5): the fragment must scan to exactly one root node
 *    of the expected tag (`<g>` for an element, `<comot:effect>` for an
 *    effect) — see the `roots.length !== 1` check below.
 * 3. Attribute-level (not covered by `assertSlideCompliant`, ADR-0010/0011
 *    left that to the iframe sandbox for *rendering* — this is the
 *    write-path guard #201's architecture decision added), rewritten in
 *    [E2.T18r6] from a denylist to an allowlist (`checkNodeAttributes`):
 *    every tag not in `ELEMENT_TAG_ATTRIBUTES`/`EFFECT_ATTRIBUTE_GRAMMAR` is
 *    rejected outright, every attribute not on that tag's list is rejected
 *    (this alone removes `style`, `on*`, `xlink:href`, and any namespace
 *    alias — none of them are ever on a list), and every attribute that IS
 *    listed must match its value grammar (§4.2 of that ticket's plan).
 *    Nothing here parses CSS, a URL scheme, or any other downstream syntax.
 *
 * `<!DOCTYPE`/`<!ENTITY`/`<!--`/`<![CDATA[` are rejected directly on the raw
 * string: `scanDocument` silently skips all four constructs by design, which
 * would otherwise let one ride through unexamined into the written file (a
 * `<![CDATA[<script>...]]>` or `<!--<script>...-->` payload does not execute,
 * but it does get written verbatim — a legitimate pasted fragment has no
 * reason to carry either).
 */
export function sanitizeClipboardMarkup(markup: string, kind: "element" | "effect"): void {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/i.test(markup)) {
    throw new CoMotionError("剪貼簿內容不可信：含有 DOCTYPE、ENTITY 宣告、CDATA 區塊或註解");
  }

  const label = kind === "element" ? "剪貼簿元素" : "剪貼簿效果項";
  const wrapped =
    kind === "element"
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SANITIZE_PLACEHOLDER_VIEWBOX}">${markup}</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SANITIZE_PLACEHOLDER_VIEWBOX}"><metadata><comot:effects xmlns:comot="${EFFECTS_NS}">${markup}</comot:effects></metadata></svg>`;
  assertSlideCompliant(wrapped, label);

  const roots = scanDocument(markup);
  /**
   * [I4, r5] `scanDocument` returns every root-level node, and nothing
   * above this point limits that to one — a fragment such as
   * `<g id="el-a"/><style>@import "//evil.example/x.css";</style>` scans as
   * two roots and was passing. It happens not to reach an outbound request
   * today only because both call sites (`serializeClipboardSvg`,
   * `pasteElements`) pass a single element/effect string each — a caller
   * invariant, not one this function enforces itself. Requiring exactly
   * one root of the expected tag makes it this function's own guarantee.
   */
  const expectedRootTag = kind === "element" ? "g" : "comot:effect";
  if (roots.length !== 1 || roots[0].tag !== expectedRootTag) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 必須是恰好一個 <${expectedRootTag}> 根節點`);
  }
  for (const root of roots) {
    checkNodeAttributes(root, label, kind === "effect");
    checkTextContent(markup, root, label);
  }
}

/**
 * Serialises a clipboard payload into the single exchange format both
 * `text/plain` and `image/svg+xml` carry ([E2.T18] 決定 2): a standalone,
 * self-describing `<svg>` — a legal document on its own (pastes into
 * another app), and a compliant slide fragment (`assertSlideCompliant`
 * accepts it) at the same time. Sanitises every element/effect first, so
 * nothing this app ever *writes* to the system clipboard can itself be the
 * unsafe half of a round trip.
 */
export function serializeClipboardSvg(payload: ClipboardPayload): string {
  for (const element of payload.elements) sanitizeClipboardMarkup(element, "element");
  for (const effect of payload.effects) sanitizeClipboardMarkup(effect, "effect");

  /**
   * [E2.T18r6 AC7, §3.5] `viewBox` came from `extractElementsForCopy`'s
   * verbatim read of the source `<svg>`, or — via a `parseClipboardSvg` →
   * `serializeClipboardSvg` round trip — from a foreign clipboard payload
   * this function never validated before now. Unlike `sourceSlidePath`
   * (already `escapeAttr`-ed below since this function was first written),
   * `viewBox` was written straight into the output: a value shaped like
   * `0 0 1 1" onload="fetch(...)` closed its own quote and opened a live
   * event-handler attribute on the wrapper `<svg>` itself. A grammar check
   * plus unconditional escaping (決定 D5) closes both the shape and the
   * quote-breakout at once; an invalid `viewBox` falls back to the same
   * placeholder used when the payload has none at all, rather than throwing
   * — this is the *write* path, and a source `<svg>`'s `viewBox` failing to
   * parse is not a reason to block copying it.
   */
  const rawViewBox = payload.viewBox ?? SANITIZE_PLACEHOLDER_VIEWBOX;
  const viewBox = escapeAttr(numberList(4)(rawViewBox) ? rawViewBox : SANITIZE_PLACEHOLDER_VIEWBOX);
  const effectsBlock =
    payload.effects.length > 0
      ? `<metadata><comot:effects xmlns:comot="${EFFECTS_NS}">${payload.effects.join("")}</comot:effects></metadata>`
      : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:comot="${EFFECTS_NS}" viewBox="${viewBox}" ` +
    `${CLIPBOARD_MARKER_ATTR}="${CLIPBOARD_MARKER_VALUE}" ${CLIPBOARD_SOURCE_ATTR}="${escapeAttr(payload.sourceSlidePath)}">` +
    `${effectsBlock}${payload.elements.join("")}</svg>`
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * `serializeClipboardSvg`'s exact inverse (round-trips: `parseClipboardSvg(serializeClipboardSvg(p))`
 * deep-equals `p`). Returns `null` — never throws — when `markup` is not a
 * co-motion element clipboard payload at all (wrong root marker, or not
 * parseable): that is the ordinary "plain text/foreign SVG on the system
 * clipboard" case a paste handler must treat as silent no-op or route
 * elsewhere, not an error.
 */
export function parseClipboardSvg(markup: string): ClipboardPayload | null {
  let roots: ScannedNode[];
  try {
    roots = scanDocument(markup);
  } catch {
    return null;
  }
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) return null;
  if (attributeValue(svgRoot, CLIPBOARD_MARKER_ATTR) !== CLIPBOARD_MARKER_VALUE) return null;

  const sourceSlidePath = attributeValue(svgRoot, CLIPBOARD_SOURCE_ATTR);
  if (sourceSlidePath === null) return null;

  const rawViewBox = attributeValue(svgRoot, "viewBox");
  /**
   * [E2.T18r6 AC7, §3.5] A `viewBox` that doesn't fit `NUMBER_LIST(4)` is
   * not a shape this app's own `serializeClipboardSvg` ever writes — same
   * "not co-motion clipboard content" case as a missing marker attribute
   * above, so this returns `null` rather than passing the value through
   * unvalidated into a `ClipboardPayload` a later `serializeClipboardSvg`
   * call might re-embed.
   */
  if (rawViewBox !== null && !numberList(4)(rawViewBox)) return null;
  const viewBox = rawViewBox ?? undefined;

  const effects: string[] = [];
  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  const effectsList = metadata?.children.find((child) => child.tag === "comot:effects");
  if (effectsList) {
    for (const effect of effectsList.children) {
      if (effect.tag !== "comot:effect") continue;
      effects.push(markup.slice(effect.start, effect.end));
    }
  }

  const elements = svgRoot.children
    .filter((child) => child.tag === "g")
    .map((child) => markup.slice(child.start, child.end));

  return { sourceSlidePath, elements, effects, viewBox };
}

export interface PasteResult {
  updated: string;
  /** The new ids assigned to `payload.elements`' top-level containers, in payload order (never a descendant's id). */
  elementIds: string[];
}

/**
 * Pastes a clipboard payload into `slidePath` (決定 6): every container id
 * — including descendants — is regenerated via `generateId()` and
 * consistently substituted everywhere it is referenced (including effect
 * `target`s); elements land as the last children of `<svg>` (topmost
 * z-order), in clipboard order; `dx`/`dy` are added to each pasted
 * top-level container's own translate; effects are appended at the end of
 * the target slide's effect list.
 */
export function pasteElements(
  svgContent: string,
  slidePath: string,
  payload: ClipboardPayload,
  dx: number,
  dy: number,
  generateId: () => string,
): PasteResult {
  assertSlideCompliant(svgContent, slidePath);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new CoMotionError("dx/dy 必須是有限數字");
  }
  if (payload.elements.length === 0) {
    throw new CoMotionError("剪貼簿是空的");
  }
  for (const element of payload.elements) sanitizeClipboardMarkup(element, "element");
  for (const effect of payload.effects) sanitizeClipboardMarkup(effect, "effect");

  const idMap = new Map<string, string>();
  const pastedIds: string[] = [];
  const preparedElements: string[] = [];
  for (const markup of payload.elements) {
    const originalId = attributeValue(scanDocument(markup)[0], "id");
    const { markup: renamed, idMap: localMap } = regenerateIds(markup, generateId);
    for (const [oldId, newId] of localMap) idMap.set(oldId, newId);
    const translated = rewriteFragmentTransform(renamed, (parts) => ({
      ...parts,
      translateX: parts.translateX + dx,
      translateY: parts.translateY + dy,
    }));
    preparedElements.push(translated);
    if (originalId) pastedIds.push(idMap.get(originalId)!);
  }

  let updated = appendMarkup(svgContent, preparedElements.join(""));

  if (payload.effects.length > 0) {
    const preparedEffects = payload.effects.map((effect) => rewriteEffectTarget(effect, idMap));
    updated = appendEffects(updated, preparedEffects);
  }

  return { updated, elementIds: pastedIds };
}
