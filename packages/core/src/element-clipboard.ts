import { CoMotionError } from "./errors.js";
import { composeMatrices, decomposeMatrix, formatTransform, multiplyMatrix, parseTransform, type Matrix, type TransformParts } from "./geometry/transform.js";
import { assertSlideCompliant } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { EFFECTS_NS, type RawEffectAttributes } from "./effects/index.js";

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

/** Attribute values matching any of these schemes are never legal in pasted content — none of them can point at same-document data. */
const DANGEROUS_SCHEME = /\b(javascript|data|file|ftp|blob):/i;
/** An `http(s)://` reference anywhere in the value, or a protocol-relative `//` anywhere in the value (Plan §7.2: unanchored on purpose — both a leading and a mid-value protocol-relative reference resolve to the same external host, so there is no reason to only catch the former). Unanchored on the scheme half too: an absolute URL in the middle of a value (`"x https://evil.example/y"`) is still an external reference. Backslash-tolerant: WHATWG URL parsing treats `\` as equivalent to `/` for any special scheme (http/https included), so `https:\\evil.example` and `\\evil.example` resolve exactly like their forward-slash forms in a browser. */
const ABSOLUTE_URL = /\bhttps?:[/\\]{2}|[/\\]{2}/i;
/** `url(...)` references — only a same-document fragment (`#foo`) is legal. */
const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

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

/** Namespace-declaration attributes carry inert URIs (never fetched or executed) and are exempt from the URL/scheme rules above. */
function isNamespaceDeclaration(attrName: string): boolean {
  return attrName === "xmlns" || attrName.startsWith("xmlns:");
}

/** [E2.T18] 決定 4：`<comot:effect>` 的屬性白名單，從 `RawEffectAttributes` 的欄位推導，不手抄成常數。 */
const EFFECT_ATTRIBUTE_WHITELIST: ReadonlySet<string> = new Set<keyof RawEffectAttributes>([
  "target",
  "family",
  "effect",
  "start",
  "duration",
  "delay",
  "d",
]);

/** [B10] Whitelist, not blacklist, for `href`/`xlink:href`/`src` — the only attributes `assertSlideCompliant`'s primitive whitelist lets a renderer actually fetch through. Only a same-document fragment (`#…`) or a scheme-less, `//`-less (and `\\`-less, per `ABSOLUTE_URL`'s backslash equivalence) relative path is legal; anything with a `:` or a `\` (an explicit scheme, with or without the `//` a browser's URL parser does not require — e.g. `https:evil.example`) or a `//`/`\\` (protocol-relative) is an external reference. A blacklist of schemes can always be enumerated around; this shape cannot. */
function isFragmentOrRelativeReference(value: string): boolean {
  if (value === "" || value.startsWith("#")) return true;
  return !/[:\\]|\/\//.test(value);
}

/**
 * [Corrective Strategy #1] Every content rule below runs inside the same
 * `for (const form of forms)` loop, over both the raw attribute value and
 * its one-pass entity-decode. This is a structural constraint, not a
 * per-rule choice: a rule added beside this loop instead of inside it is a
 * rule that silently trusts whichever form entity-encoding happens to hide
 * its payload in. `forms` is `[value]` when decoding changed nothing (the
 * common case), so unaffected attribute values pay no extra cost.
 */
function checkAttributeValue(attrName: string, value: string, label: string): void {
  if (hasIllegalNumericCharacterReference(value)) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 的屬性 ${attrName} 含有非法的 XML 字元參照（${value}）`);
  }
  if (isNamespaceDeclaration(attrName)) return;

  const decodedValue = decodeXmlEntities(value);
  const forms = decodedValue === value ? [value] : [value, decodedValue];

  for (const form of forms) {
    if (DANGEROUS_SCHEME.test(form)) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 的屬性 ${attrName} 含有不允許的協定（${value}）`);
    }
    if (ABSOLUTE_URL.test(form)) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 的屬性 ${attrName} 是外部參照（${value}）`);
    }
    for (const match of form.matchAll(URL_FUNCTION)) {
      const ref = match[2];
      const decodedRef = decodeXmlEntities(ref);
      if (decodedRef !== ref || !decodedRef.startsWith("#")) {
        throw new CoMotionError(`剪貼簿內容不可信：${label} 的屬性 ${attrName} 的 url(...) 不是同文件片段參照（${ref}）`);
      }
    }
  }

  /** Namespace-aware: `xlink:href` is bound by the `xlink` *namespace*, not the literal prefix `xlink:` — a fragment declaring `xmlns:xl="http://www.w3.org/1999/xlink"` and using `xl:href` refers to the identical attribute under a different local prefix, so enumerating the literal prefix string lets that alias bypass the check entirely. */
  const localName = attrName.slice(attrName.indexOf(":") + 1);
  const isUrlAttr = localName === "href" || localName === "src";
  if (isUrlAttr && (decodedValue !== value || !isFragmentOrRelativeReference(decodedValue))) {
    throw new CoMotionError(`剪貼簿內容不可信：${label} 的屬性 ${attrName} 不是同文件片段或相對路徑（${value}）`);
  }
}

function checkNodeAttributes(node: ScannedNode, label: string, isEffect: boolean): void {
  for (const attribute of node.attributes) {
    if (/^on/i.test(attribute.name)) {
      throw new CoMotionError(`剪貼簿內容不可信：${label} 含有事件屬性 ${attribute.name}`);
    }
    checkAttributeValue(attribute.name, attribute.value, label);
    if (isEffect && node.tag === "comot:effect" && !EFFECT_ATTRIBUTE_WHITELIST.has(attribute.name as keyof RawEffectAttributes)) {
      throw new CoMotionError(`剪貼簿內容不可信：效果項含有不在白名單內的屬性 ${attribute.name}`);
    }
  }
  for (const child of node.children) {
    checkNodeAttributes(child, label, isEffect);
  }
}

/**
 * The one gate every pasted fragment — internal or from the system
 * clipboard — must pass before it is spliced into a presentation (ADR-0010,
 * [E2.T18] 決定 4). Never patches a bad fragment into something acceptable:
 * every violation throws, none are silently stripped. Two layers:
 *
 * 1. Structural: wrapping the fragment so `assertSlideCompliant` can reuse
 *    its existing tag whitelist/`<script>`/`<foreignObject>` sweep for free.
 *    An `elements` fragment is wrapped as direct `<svg>` content (so the
 *    normal-form checks — missing id, mixed children, unknown tag — apply);
 *    an `effects` fragment is wrapped inside `<metadata><comot:effects>`,
 *    where only the forbidden-tag sweep (which walks metadata too) applies —
 *    `checkSlideCompliance` does not otherwise structurally inspect metadata.
 * 2. Attribute-level (not covered by `assertSlideCompliant`, ADR-0010/0011
 *    left that to the iframe sandbox for *rendering* — this is the
 *    write-path guard #201's architecture decision added): no `on*` handler,
 *    no `javascript:`/`data:`/`file:`/`ftp:`/`blob:` scheme, no absolute URL,
 *    no `url(...)` outside a same-document fragment, `href`/`xlink:href`/`src`
 *    limited to a fragment or relative path, and — for an effect item only —
 *    no attribute outside `RawEffectAttributes`' fields.
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
  for (const root of roots) {
    checkNodeAttributes(root, label, kind === "effect");
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

  const viewBox = payload.viewBox ?? SANITIZE_PLACEHOLDER_VIEWBOX;
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

  const viewBox = attributeValue(svgRoot, "viewBox") ?? undefined;

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
