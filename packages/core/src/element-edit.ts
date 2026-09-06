import { CoMotionError } from "./errors.js";
import {
  applySplices,
  assertNotLocked,
  escapeXmlAttr,
  readTextFontInfo,
  resolveFont,
  rewrapTextBoxContent,
  setAttrSplice,
  type Splice,
} from "./element-text.js";
import { assertSlideCompliant, parseSlide, TEXT_WIDTH_ATTRIBUTE, type SlideElement } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { decomposeMatrix, formatTransform, invertMatrix, parseTransform, type TransformParts } from "./geometry/transform.js";
import { elementBounds } from "./geometry/bbox.js";
import { formatSvgNumber } from "./svg-number.js";
import type { FontMetrics } from "./text-metrics.js";

/**
 * The seven "element edit" command primitives (#104, ADR-0012 followed
 * through to editing): insert / delete / move / scale / rotate / style set /
 * order. Modeled after `element-text.ts`: pure `svgContent: string ->
 * string` functions, no Node built-in imports (the front end has to be able
 * to run this too), errors are always `CoMotionError`.
 *
 * Every command locates its target(s) by scanning a *fresh* `scanDocument`
 * result before each mutation, rather than collecting byte offsets up front
 * and hoping they still line up after an earlier splice. A multi-target
 * command therefore costs an extra re-scan per target — slides are small
 * text files, and "never stale offsets" is worth more here than the
 * micro-optimisation of a single combined splice pass.
 */

/** Doc furniture children accessibility markup can carry; never a real target. */
const IGNORED_CHILD_TAGS = new Set(["title", "desc"]);

/**
 * T3, ADR-0013: `force` bypasses the locked-element guard (`assertNotLocked`,
 * element-text.ts) for one call. Added to all seven mutations' signatures for
 * a uniform shape, even though `insertElement` (a new element is never
 * locked) and `deleteElements` (locked elements are deletable with no
 * `--force`, ADR-0013) never read it.
 */
export interface MutationOptions {
  readonly force?: boolean;
}

function requireSvgRoot(roots: readonly ScannedNode[]): ScannedNode {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

/** Depth-first search for the `<g id="...">` container `id` names, tracking its immediate parent container (`<svg>` root or an ancestor group). */
function findContainer(svgRoot: ScannedNode, id: string): { node: ScannedNode; parent: ScannedNode } | undefined {
  function search(parent: ScannedNode): { node: ScannedNode; parent: ScannedNode } | undefined {
    for (const child of parent.children) {
      if (child.tag !== "g") continue;
      if (attributeValue(child, "id") === id) return { node: child, parent };
      const found = search(child);
      if (found) return found;
    }
    return undefined;
  }
  return search(svgRoot);
}

function requireContainer(svgRoot: ScannedNode, id: string): { node: ScannedNode; parent: ScannedNode } {
  const found = findContainer(svgRoot, id);
  if (!found) {
    throw new CoMotionError(`找不到元素：${id}`);
  }
  return found;
}

/** `elementIds` must be a non-empty list with no repeated id (第 4 節: 結構化輸入一律是 elementIds: string[]). */
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

function meaningfulChildren(node: ScannedNode): ScannedNode[] {
  return node.children.filter((child) => !IGNORED_CHILD_TAGS.has(child.tag));
}

/** Whether `node` is a group container (ADR-0012: a container's children are all `<g>`, or all primitives — never mixed). */
function isGroupContainer(node: ScannedNode): boolean {
  const children = meaningfulChildren(node);
  return children.length > 0 && children.every((child) => child.tag === "g");
}

/** Rounds through `formatSvgNumber` and rejects a value that is positive on input but rounds to zero or below. Mirrors `workspace.ts`'s `assertPositiveAfterRounding` (#76) — small enough, and specific enough to the 4-decimal write rule, that duplicating it here is simpler than threading it across the Node/browser boundary this module cannot cross. */
function assertPositiveAfterRounding(value: number, message: string): number {
  const rounded = Number(formatSvgNumber(value));
  if (!(rounded > 0)) {
    throw new CoMotionError(message);
  }
  return rounded;
}

// ---------------------------------------------------------------------------
// element insert
// ---------------------------------------------------------------------------

export type InsertElementKind = "rect" | "ellipse" | "line" | "image" | "path";

export interface InsertElementInput {
  kind: InsertElementKind;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** `path` only. */
  d?: string;
  fill?: string;
  /** Outline colour. A `line` has no fill area, so this is the only way to make one visible (NOOP-227 follow-up: without it SVG's `stroke: none` default renders nothing). */
  stroke?: string;
  /** Outline width, paired with `stroke`. */
  strokeWidth?: number;
  /** `image` only. */
  href?: string;
  /** Any kind — ADR-0005 media placeholder marker (T3/NOOP-142: video/audio placeholders are a `rect` with `media` set, no `href`). */
  media?: string;
}

function requireFiniteNumber(value: number | undefined, flag: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new CoMotionError(`element insert 缺少或不合法的參數：--${flag}`);
  }
  return value;
}

function requirePositiveNumber(value: number | undefined, flag: string): number {
  const n = requireFiniteNumber(value, flag);
  if (!(n > 0)) {
    throw new CoMotionError(`--${flag} 必須是大於 0 的數字`);
  }
  return n;
}

/**
 * Builds and appends one new element (`co-motion element insert`, #104).
 * `elementId` is generated by the caller (`workspace.ts`) — this module
 * never imports `id.ts`, which reaches for Node's crypto module.
 */
export function insertElement(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: InsertElementInput,
  /** Shape parity with the other six mutations (T3); a new element is never locked, so unused here. */
  _options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);

  const fillAttr = input.fill !== undefined ? ` fill="${escapeXmlAttr(input.fill)}"` : "";
  // Applies to every kind, not just `line` — an outlined rect is the same
  // two attributes, so there is nothing kind-specific to special-case.
  const strokeAttr =
    (input.stroke !== undefined ? ` stroke="${escapeXmlAttr(input.stroke)}"` : "") +
    (input.strokeWidth !== undefined ? ` stroke-width="${formatSvgNumber(requirePositiveNumber(input.strokeWidth, "stroke-width"))}"` : "");
  let containerAttrs = `id="${elementId}"`;
  // Common to every kind (T3/NOOP-142): a media placeholder can be a `rect`
  // (video/audio, no `href`) as well as an `image`, so this can no longer
  // live inside `case "image"` alone.
  if (input.media !== undefined) {
    containerAttrs += ` data-comot-media="${escapeXmlAttr(input.media)}"`;
  }
  let native: string;

  switch (input.kind) {
    case "rect": {
      const x = requireFiniteNumber(input.x, "x");
      const y = requireFiniteNumber(input.y, "y");
      const width = requirePositiveNumber(input.width, "width");
      const height = requirePositiveNumber(input.height, "height");
      containerAttrs += ` transform="translate(${formatSvgNumber(x)} ${formatSvgNumber(y)})"`;
      native = `<rect x="0" y="0" width="${formatSvgNumber(width)}" height="${formatSvgNumber(height)}"${fillAttr}${strokeAttr}/>`;
      break;
    }
    case "ellipse": {
      const x = requireFiniteNumber(input.x, "x");
      const y = requireFiniteNumber(input.y, "y");
      const width = requirePositiveNumber(input.width, "width");
      const height = requirePositiveNumber(input.height, "height");
      const rx = width / 2;
      const ry = height / 2;
      containerAttrs += ` transform="translate(${formatSvgNumber(x)} ${formatSvgNumber(y)})"`;
      native = `<ellipse cx="${formatSvgNumber(rx)}" cy="${formatSvgNumber(ry)}" rx="${formatSvgNumber(rx)}" ry="${formatSvgNumber(ry)}"${fillAttr}${strokeAttr}/>`;
      break;
    }
    case "image": {
      const x = requireFiniteNumber(input.x, "x");
      const y = requireFiniteNumber(input.y, "y");
      const width = requirePositiveNumber(input.width, "width");
      const height = requirePositiveNumber(input.height, "height");
      if (input.href === undefined) {
        throw new CoMotionError("element insert image 缺少參數：--href");
      }
      containerAttrs += ` transform="translate(${formatSvgNumber(x)} ${formatSvgNumber(y)})"`;
      native = `<image x="0" y="0" width="${formatSvgNumber(width)}" height="${formatSvgNumber(height)}" href="${escapeXmlAttr(input.href)}"${fillAttr}${strokeAttr}/>`;
      break;
    }
    case "line": {
      const x1 = requireFiniteNumber(input.x1, "x1");
      const y1 = requireFiniteNumber(input.y1, "y1");
      const x2 = requireFiniteNumber(input.x2, "x2");
      const y2 = requireFiniteNumber(input.y2, "y2");
      native = `<line x1="${formatSvgNumber(x1)}" y1="${formatSvgNumber(y1)}" x2="${formatSvgNumber(x2)}" y2="${formatSvgNumber(y2)}"${fillAttr}${strokeAttr}/>`;
      break;
    }
    case "path": {
      if (input.d === undefined) {
        throw new CoMotionError("element insert path 缺少參數：--d");
      }
      const x = input.x ?? 0;
      const y = input.y ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new CoMotionError("--x/--y 必須是有限數字");
      }
      if (x !== 0 || y !== 0) {
        containerAttrs += ` transform="translate(${formatSvgNumber(x)} ${formatSvgNumber(y)})"`;
      }
      native = `<path d="${escapeXmlAttr(input.d)}"${fillAttr}${strokeAttr}/>`;
      break;
    }
    default:
      throw new CoMotionError(`element insert 不支援的 kind：${input.kind as string}`);
  }

  const markup = `<g ${containerAttrs}>${native}</g>`;
  return appendMarkup(svgContent, markup);
}

/** Appends `markup` as the last child of `<svg>`, preserving every other byte — same contract as `element-text.ts`'s `appendElementToSvg`, duplicated in miniature here so `element-edit.ts` does not import a text-editing module for one splice. */
function appendMarkup(svgContent: string, markup: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  return svgContent.slice(0, svgRoot.contentEnd) + markup + svgContent.slice(svgRoot.contentEnd);
}

// ---------------------------------------------------------------------------
// element delete
// ---------------------------------------------------------------------------

/** Every container id in `node`'s subtree (itself included), so deleting a group also accounts for the ids nested inside it — used both to skip a nested target already covered by an ancestor, and to find dangling effect references (decision 4). */
function collectContainerIds(node: ScannedNode, into: Set<string>): void {
  const id = attributeValue(node, "id");
  if (id) into.add(id);
  for (const child of node.children) {
    if (child.tag === "g") collectContainerIds(child, into);
  }
}

/**
 * ADR-0009's effects list, in the minimal placeholder schema this ticket
 * defines (decision 4, `docs/multi-element-addressing.md`):
 * `<metadata><comot:effects><comot:effect target="el-..."/></comot:effects></metadata>`.
 * Finds every `<comot:effect>` whose `target` names an id being removed.
 */
function findDanglingEffectRanges(svgRoot: ScannedNode, removedIds: ReadonlySet<string>): Splice[] {
  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  if (!metadata) return [];
  const effectsList = metadata.children.find((child) => child.tag === "comot:effects");
  if (!effectsList) return [];
  const ranges: Splice[] = [];
  for (const effect of effectsList.children) {
    if (effect.tag !== "comot:effect") continue;
    const target = attributeValue(effect, "target");
    if (target !== null && removedIds.has(target)) {
      ranges.push({ start: effect.start, end: effect.end, text: "" });
    }
  }
  return ranges;
}

/**
 * [E2.T8]'s `<comot:comments>` list, same shape as `findDanglingEffectRanges`
 * above: finds every `<comot:comment>` whose `target` names an id being
 * removed. `target="page"` is never in `removedIds`, so page-level comments
 * are never touched by this.
 */
function findDanglingCommentRanges(svgRoot: ScannedNode, removedIds: ReadonlySet<string>): Splice[] {
  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  if (!metadata) return [];
  const commentsList = metadata.children.find((child) => child.tag === "comot:comments");
  if (!commentsList) return [];
  const ranges: Splice[] = [];
  for (const comment of commentsList.children) {
    if (comment.tag !== "comot:comment") continue;
    const target = attributeValue(comment, "target");
    if (target !== null && removedIds.has(target)) {
      ranges.push({ start: comment.start, end: comment.end, text: "" });
    }
  }
  return ranges;
}

/**
 * Deletes every element named in `elementIds` (`co-motion element delete`,
 * #104). All-or-nothing: every id is confirmed present before any byte is
 * removed. A target that turns out to be a descendant of another target is
 * silently covered by the ancestor's removal, never double-removed or
 * reported as an error (第 4 節).
 */
export function deleteElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  /** Shape parity with the other six mutations (T3); ADR-0013: deleting a locked element never needs `--force`, so unused here. */
  _options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);

  const initialRoots = scanDocument(svgContent);
  const initialSvgRoot = requireSvgRoot(initialRoots);
  const removedIds = new Set<string>();
  for (const id of elementIds) {
    const { node } = requireContainer(initialSvgRoot, id);
    collectContainerIds(node, removedIds);
  }

  let current = svgContent;
  for (const id of elementIds) {
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const found = findContainer(svgRoot, id);
    if (!found) continue; // Already removed as another target's descendant.
    current = current.slice(0, found.node.start) + current.slice(found.node.end);
  }

  const roots = scanDocument(current);
  const svgRoot = requireSvgRoot(roots);
  const effectRanges = findDanglingEffectRanges(svgRoot, removedIds);
  const commentRanges = findDanglingCommentRanges(svgRoot, removedIds);
  return applySplices(current, [...effectRanges, ...commentRanges]);
}

// ---------------------------------------------------------------------------
// element move / rotate — shared transform-delta application
// ---------------------------------------------------------------------------

/** The leading whitespace before an attribute, so removing it also removes the space that separated it from its neighbour. */
function attributeRemovalSplice(container: ScannedNode, svg: string, attr: { start: number; end: number }): Splice {
  let start = attr.start;
  while (start > container.start && /[\t\n\r ]/.test(svg[start - 1])) start--;
  return { start, end: attr.end, text: "" };
}

/** Builds the splice that rewrites `container`'s `transform` attribute after applying `mutate` to its decomposed parts — inserting the attribute if it was absent, or removing it if the mutated parts serialize back to nothing (identity). */
function buildTransformSplice(
  svg: string,
  container: ScannedNode,
  mutate: (parts: TransformParts) => TransformParts,
): Splice {
  const attr = attributeOf(container, "transform");
  const matrix = parseTransform(attr ? attr.value : null);
  const nextParts = mutate(decomposeMatrix(matrix));
  const nextTransform = formatTransform(nextParts);

  if (attr) {
    if (nextTransform === "") {
      return attributeRemovalSplice(container, svg, attr);
    }
    return { start: attr.start, end: attr.end, text: `transform="${nextTransform}"` };
  }
  if (nextTransform === "") {
    return { start: container.start, end: container.start, text: "" };
  }
  const insertAt = container.start + 1 + container.tag.length;
  return { start: insertAt, end: insertAt, text: ` transform="${nextTransform}"` };
}

function applyTransformDelta(
  svg: string,
  id: string,
  mutate: (parts: TransformParts) => TransformParts,
  force: boolean | undefined,
): string {
  const roots = scanDocument(svg);
  const svgRoot = requireSvgRoot(roots);
  const { node } = requireContainer(svgRoot, id);
  assertNotLocked(node, id, force);
  const splice = buildTransformSplice(svg, node, mutate);
  return applySplices(svg, [splice]);
}

/**
 * Moves every target by the same `(dx, dy)`, each applied independently to
 * its own container's `transform` (`co-motion element move`, #104, 決定 3).
 */
export function moveElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  dx: number,
  dy: number,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new CoMotionError("dx/dy 必須是有限數字");
  }
  let current = svgContent;
  for (const id of elementIds) {
    current = applyTransformDelta(
      current,
      id,
      (parts) => ({
        ...parts,
        translateX: parts.translateX + dx,
        translateY: parts.translateY + dy,
      }),
      options.force,
    );
  }
  return current;
}

/**
 * Rotates every target by the same `degrees` delta, each applied
 * independently (`co-motion element rotate`, #104, 決定 3). A target whose
 * existing transform carries skew fails through `decomposeMatrix`'s own
 * error — this command adds no separate check for it.
 */
export function rotateElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  degrees: number,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (!Number.isFinite(degrees)) {
    throw new CoMotionError("degrees 必須是有限數字");
  }
  let current = svgContent;
  for (const id of elementIds) {
    current = applyTransformDelta(
      current,
      id,
      (parts) => ({
        ...parts,
        rotation: parts.rotation + degrees,
      }),
      options.force,
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// element scale
// ---------------------------------------------------------------------------

function scaleNumericAttr(
  node: ScannedNode,
  name: string,
  factor: number,
  elementId: string,
  mustStayPositive: boolean,
): Splice {
  const attr = attributeOf(node, name);
  if (!attr) {
    throw new CoMotionError(`元素 ${elementId} 缺少屬性 ${name}，無法縮放`);
  }
  const value = Number(attr.value);
  if (!Number.isFinite(value)) {
    throw new CoMotionError(`元素 ${elementId} 的 ${name} 不是合法數字：${attr.value}`);
  }
  const scaled = value * factor;
  const rounded = mustStayPositive
    ? assertPositiveAfterRounding(scaled, `元素 ${elementId} 的 ${name} 縮放後不是大於 0 的數字`)
    : Number(formatSvgNumber(scaled));
  return { start: attr.start, end: attr.end, text: `${name}="${formatSvgNumber(rounded)}"` };
}

/** Path `d` commands that carry an elliptical arc — scaling would require re-deriving the arc's radii/rotation, which this ticket does not implement (geometry/bbox.ts#pathBounds has the same limitation). */
const ARC_COMMAND = /[Aa]/;

function scalePathData(d: string, factor: number): string {
  if (ARC_COMMAND.test(d)) {
    throw new CoMotionError("path 含有橢圓弧，尚不支援縮放");
  }
  return d.replace(/[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g, (token) => formatSvgNumber(Number(token) * factor));
}

function buildPrimitiveScaleSplices(node: ScannedNode, factor: number, elementId: string): Splice[] {
  switch (node.tag) {
    case "text": {
      const attr = attributeOf(node, "font-size");
      if (!attr) return [];
      const value = Number(attr.value);
      const scaled = assertPositiveAfterRounding(
        value * factor,
        `元素 ${elementId} 的 font-size 縮放後不是大於 0 的數字`,
      );
      return [{ start: attr.start, end: attr.end, text: `font-size="${formatSvgNumber(scaled)}"` }];
    }
    case "rect":
    case "image":
      return [
        scaleNumericAttr(node, "width", factor, elementId, true),
        scaleNumericAttr(node, "height", factor, elementId, true),
      ];
    case "ellipse":
      return [
        scaleNumericAttr(node, "cx", factor, elementId, false),
        scaleNumericAttr(node, "cy", factor, elementId, false),
        scaleNumericAttr(node, "rx", factor, elementId, true),
        scaleNumericAttr(node, "ry", factor, elementId, true),
      ];
    case "circle":
      return [
        scaleNumericAttr(node, "cx", factor, elementId, false),
        scaleNumericAttr(node, "cy", factor, elementId, false),
        scaleNumericAttr(node, "r", factor, elementId, true),
      ];
    case "line":
      return ["x1", "y1", "x2", "y2"].map((name) => scaleNumericAttr(node, name, factor, elementId, false));
    case "path": {
      const attr = attributeOf(node, "d");
      if (!attr) {
        throw new CoMotionError(`元素 ${elementId} 缺少屬性 d，無法縮放`);
      }
      const scaledD = scalePathData(attr.value, factor);
      return [{ start: attr.start, end: attr.end, text: `d="${scaledD}"` }];
    }
    default:
      throw new CoMotionError(`不支援縮放的圖元 <${node.tag}>：${elementId}`);
  }
}

/** Scales a leaf container's own primitive(s) — the text-box case rewraps through `rewrapTextBoxContent`; every other primitive gets its own attribute splices. */
function scaleLeafPrimitives(
  svg: string,
  container: ScannedNode,
  factor: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  elementId: string,
): string {
  const textWidthAttr = attributeOf(container, TEXT_WIDTH_ATTRIBUTE);
  const primitives = meaningfulChildren(container);
  if (textWidthAttr) {
    const textNode = primitives.find((primitive) => primitive.tag === "text");
    if (!textNode) {
      throw new CoMotionError(`元素不是合法的文字框：${elementId}`);
    }
    const currentWidth = Number(textWidthAttr.value);
    const { fontFamily, fontSize } = readTextFontInfo(textNode, elementId);
    const newWidth = assertPositiveAfterRounding(
      currentWidth * factor,
      `元素 ${elementId} 的文字框寬度縮放後不是大於 0 的數字`,
    );
    const newFontSize = assertPositiveAfterRounding(
      fontSize * factor,
      `元素 ${elementId} 的 font-size 縮放後不是大於 0 的數字`,
    );
    // `rewrapTextBoxContent` only splices the box's width attribute and its
    // <text> content — it never touches font-size, since `resizeTextBox`
    // (its other caller) never changes it. Scale does change it, so splice
    // the new font-size onto the <text> tag first, then re-locate the node
    // and rewrap against the post-splice document.
    const withFontSize = applySplices(svg, [
      setAttrSplice(textNode, "font-size", formatSvgNumber(newFontSize)),
    ]);
    const refreshedRoots = scanDocument(withFontSize);
    const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
    const { node: refreshedContainer } = requireContainer(refreshedSvgRoot, elementId);
    const refreshedTextNode = meaningfulChildren(refreshedContainer).find((primitive) => primitive.tag === "text")!;
    const refreshedWidthAttr = attributeOf(refreshedContainer, TEXT_WIDTH_ATTRIBUTE)!;
    const { updated } = rewrapTextBoxContent(
      withFontSize,
      refreshedContainer,
      refreshedTextNode,
      refreshedWidthAttr,
      newWidth,
      fontFamily,
      newFontSize,
      fontBook,
      elementId,
    );
    return updated;
  }

  const splices: Splice[] = [];
  for (const primitive of primitives) {
    splices.push(...buildPrimitiveScaleSplices(primitive, factor, elementId));
  }
  return applySplices(svg, splices);
}

/**
 * Rejects `id` (and, if it is a group, every descendant container inside
 * it) the moment any one of them is locked without `--force` — ADR-0013.
 * Runs entirely against the caller's `svg` snapshot before any splice, so a
 * lock three levels deep still blocks the whole command atomically instead
 * of leaving earlier siblings already rewritten.
 */
function assertSubtreeNotLocked(svg: string, id: string, force: boolean | undefined): void {
  const roots = scanDocument(svg);
  const svgRoot = requireSvgRoot(roots);
  const { node } = requireContainer(svgRoot, id);
  assertNotLocked(node, id, force);
  if (isGroupContainer(node)) {
    for (const child of meaningfulChildren(node)) {
      const childId = attributeValue(child, "id");
      if (!childId) {
        throw new CoMotionError("群組子容器缺少 id，無法縮放");
      }
      assertSubtreeNotLocked(svg, childId, force);
    }
  }
}

/**
 * Scales one target by `factor`, anchored at the target's own container
 * origin (決定 3): the target's own `transform` never changes. A group
 * target recurses — every descendant container's own `translateX/Y` is
 * multiplied by `factor` once per level (never compounding with depth), and
 * every leaf's native geometry is scaled by `buildPrimitiveScaleSplices` /
 * the text-box rewrap path.
 *
 * Re-locates each node by id from a fresh `scanDocument` before touching it
 * (a worklist of ids, not a single offset-collecting walk) so a splice
 * earlier in the subtree never invalidates a sibling's or child's offsets.
 */
function scaleOneContainer(
  svg: string,
  id: string,
  factor: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  force: boolean | undefined,
): string {
  // ADR-0013: a group scale indirectly moves every descendant container's
  // transform (below), so a locked descendant is just as much "changed" as
  // a locked target — checking only the target let a locked child hide
  // behind an unlocked outer group and still get its translate rewritten.
  // Walk the whole subtree against the *original* document (no splice has
  // happened yet, so ids don't shift) and reject before any splice at all
  // if anything in it is locked and `--force` was not given.
  assertSubtreeNotLocked(svg, id, force);

  let current = svg;
  const worklist: Array<{ id: string; isTarget: boolean }> = [{ id, isTarget: true }];

  while (worklist.length > 0) {
    const { id: currentId, isTarget } = worklist.shift()!;
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, currentId);

    if (!isTarget) {
      // Lock was already checked for every node in the subtree by
      // assertSubtreeNotLocked above, so this call can never be rejected.
      current = applyTransformDelta(
        current,
        currentId,
        (parts) => ({
          ...parts,
          translateX: parts.translateX * factor,
          translateY: parts.translateY * factor,
        }),
        true,
      );
    }

    // Re-scan: the transform splice above (if any) shifted every offset at
    // or after this node's own attribute region, including this node's
    // children's offsets.
    const refreshedRoots = scanDocument(current);
    const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
    const { node: refreshedNode } = requireContainer(refreshedSvgRoot, currentId);

    if (isGroupContainer(refreshedNode)) {
      for (const child of meaningfulChildren(refreshedNode)) {
        const childId = attributeValue(child, "id");
        if (!childId) {
          throw new CoMotionError("群組子容器缺少 id，無法縮放");
        }
        worklist.push({ id: childId, isTarget: false });
      }
    } else {
      current = scaleLeafPrimitives(current, refreshedNode, factor, fontBook, currentId);
    }
  }

  return current;
}

/** Scales every target by the same `factor` (`co-motion element scale`, #104, 決定 3). */
export function scaleElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  factor: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (!Number.isFinite(factor) || !(factor > 0)) {
    throw new CoMotionError("factor 必須是大於 0 的數字");
  }
  let current = svgContent;
  for (const id of elementIds) {
    current = scaleOneContainer(current, id, factor, fontBook, options.force);
  }
  return current;
}

// ---------------------------------------------------------------------------
// element resize
// ---------------------------------------------------------------------------

export type ResizeAnchor = "nw" | "ne" | "sw" | "se";

const RESIZE_ANCHORS: readonly ResizeAnchor[] = ["nw", "ne", "sw", "se"];

/** The local corner of `box` that `anchor` names — "nw" is `(box.x, box.y)`, "se" is the opposite corner, etc. */
function anchorCorner(anchor: ResizeAnchor, box: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  return {
    x: anchor === "ne" || anchor === "se" ? box.x + box.width : box.x,
    y: anchor === "sw" || anchor === "se" ? box.y + box.height : box.y,
  };
}

/** Scales `name` (defaulting to 0 per the SVG spec when absent) by `factor` — absent stays absent since `0 * factor` is still the default. */
function scaleOptionalNumericAttr(node: ScannedNode, name: string, factor: number, elementId: string): Splice[] {
  const attr = attributeOf(node, name);
  if (!attr) return [];
  return [scaleNumericAttr(node, name, factor, elementId, false)];
}

/**
 * Non-uniform counterpart to `buildPrimitiveScaleSplices`: `sx`/`sy` scale
 * the x-ish and y-ish native attributes independently. Shapes whose data
 * model has no non-uniform representation (`<text>`'s `font-size` is a
 * single scalar; `<circle>`'s `r` likewise; a non-uniform `<path>` would
 * need per-command axis-aware re-derivation this ticket does not implement)
 * reject a non-uniform request outright rather than silently degrading to
 * something else — when `sx === sy` they fall through to the existing
 * uniform generator unchanged.
 *
 * `rect`/`image` also scale their own `x`/`y` (unlike the uniform-scale
 * generator, which leaves them alone because scale's contract fixes the
 * *container* origin, not a bbox corner) — `resizeOneTarget`'s anchor delta
 * is derived assuming every primitive's native geometry scales about the
 * local frame's origin `(0, 0)`, exactly like `ellipse`'s `cx`/`cy` and
 * `line`'s `x1`/`y1`/`x2`/`y2` already do. Leaving `x`/`y` fixed broke that
 * assumption for any `rect`/`image` not already sitting at local `(0, 0)`.
 */
function buildPrimitiveResizeSplices(node: ScannedNode, sx: number, sy: number, elementId: string): Splice[] {
  switch (node.tag) {
    case "rect":
    case "image":
      return [
        ...scaleOptionalNumericAttr(node, "x", sx, elementId),
        ...scaleOptionalNumericAttr(node, "y", sy, elementId),
        scaleNumericAttr(node, "width", sx, elementId, true),
        scaleNumericAttr(node, "height", sy, elementId, true),
      ];
    case "ellipse":
      return [
        scaleNumericAttr(node, "cx", sx, elementId, false),
        scaleNumericAttr(node, "cy", sy, elementId, false),
        scaleNumericAttr(node, "rx", sx, elementId, true),
        scaleNumericAttr(node, "ry", sy, elementId, true),
      ];
    case "line":
      return [
        scaleNumericAttr(node, "x1", sx, elementId, false),
        scaleNumericAttr(node, "y1", sy, elementId, false),
        scaleNumericAttr(node, "x2", sx, elementId, false),
        scaleNumericAttr(node, "y2", sy, elementId, false),
      ];
    case "text":
      if (sx !== sy) {
        throw new CoMotionError(`元素 ${elementId} 含 <text>，font-size 無法非等比縮放，請改用 element scale`);
      }
      return buildPrimitiveScaleSplices(node, sx, elementId);
    case "circle":
      if (sx !== sy) {
        throw new CoMotionError(`元素 ${elementId} 是 <circle>，無法非等比縮放，請改用 element scale`);
      }
      return buildPrimitiveScaleSplices(node, sx, elementId);
    case "path":
      if (sx !== sy) {
        throw new CoMotionError(`元素 ${elementId} 是 <path>，無法非等比縮放，請改用 element scale`);
      }
      return buildPrimitiveScaleSplices(node, sx, elementId);
    default:
      throw new CoMotionError(`不支援縮放的圖元 <${node.tag}>：${elementId}`);
  }
}

/** Resize counterpart to `scaleLeafPrimitives` — a text box (single `font-size` scalar) only accepts a uniform `sx === sy` request and then reuses the exact same rewrap path. */
function resizeLeafPrimitives(
  svg: string,
  container: ScannedNode,
  sx: number,
  sy: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  elementId: string,
): string {
  const textWidthAttr = attributeOf(container, TEXT_WIDTH_ATTRIBUTE);
  if (textWidthAttr) {
    if (sx !== sy) {
      throw new CoMotionError(`元素 ${elementId} 含 <text>，font-size 無法非等比縮放，請改用 element scale`);
    }
    return scaleLeafPrimitives(svg, container, sx, fontBook, elementId);
  }

  const splices: Splice[] = [];
  for (const primitive of meaningfulChildren(container)) {
    splices.push(...buildPrimitiveResizeSplices(primitive, sx, sy, elementId));
  }
  return applySplices(svg, splices);
}

/**
 * Resize counterpart to `scaleOneContainer`: same worklist/re-scan shape,
 * `(sx, sy)` applied per axis instead of one `factor`. The target's own
 * container `transform` is left untouched here too — `resizeOneTarget`
 * applies the anchor-preserving translate delta afterward, once, the same
 * way `scaleOneContainer` never touches it at all.
 */
function resizeOneContainer(
  svg: string,
  id: string,
  sx: number,
  sy: number,
  fontBook: ReadonlyMap<string, FontMetrics>,
  force: boolean | undefined,
): string {
  assertSubtreeNotLocked(svg, id, force);

  let current = svg;
  const worklist: Array<{ id: string; isTarget: boolean }> = [{ id, isTarget: true }];

  while (worklist.length > 0) {
    const { id: currentId, isTarget } = worklist.shift()!;
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, currentId);

    if (!isTarget) {
      current = applyTransformDelta(
        current,
        currentId,
        (parts) => ({
          ...parts,
          translateX: parts.translateX * sx,
          translateY: parts.translateY * sy,
        }),
        true,
      );
    }

    const refreshedRoots = scanDocument(current);
    const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
    const { node: refreshedNode } = requireContainer(refreshedSvgRoot, currentId);

    if (isGroupContainer(refreshedNode)) {
      for (const child of meaningfulChildren(refreshedNode)) {
        const childId = attributeValue(child, "id");
        if (!childId) {
          throw new CoMotionError("群組子容器缺少 id，無法縮放");
        }
        worklist.push({ id: childId, isTarget: false });
      }
    } else {
      current = resizeLeafPrimitives(current, refreshedNode, sx, sy, fontBook, currentId);
    }
  }

  return current;
}

/** Depth-first search of a parsed slide model for `id` — resize only ever needs the element's own local matrix, never an ancestor chain (the anchor delta below is entirely local to the target's own container). */
function findElementById(elements: readonly SlideElement[], id: string): SlideElement | undefined {
  for (const element of elements) {
    if (element.id === id) return element;
    if (element.kind === "group") {
      const found = findElementById(element.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Resizes one target to exactly `(width, height)`, anchored so that the
 * named corner of its bounding box — computed in the target's own local
 * frame, i.e. with the target's own `transform` factored out via
 * `invertMatrix` — lands on exactly the same spot after the resize.
 *
 * Native geometry is scaled by `(sx, sy)` about that local frame's origin
 * (`resizeOneContainer`, mirroring `scaleOneContainer`'s single-`factor`
 * version); the target's own container transform's rotation and any
 * pre-existing scale are left alone, and only its translate is shifted by
 * the delta the anchor corner moved by that scaling — expressed back
 * through the target's own matrix so a rotated target still keeps its
 * anchor corner fixed in the *parent's* frame (決定: "先非等比縮放再旋轉",
 * matching how PowerPoint composes a resize with an existing rotation).
 */
function resizeOneTarget(
  svg: string,
  slidePath: string,
  id: string,
  width: number,
  height: number,
  anchor: ResizeAnchor,
  fontBook: ReadonlyMap<string, FontMetrics>,
  force: boolean | undefined,
): string {
  const model = parseSlide(svg, slidePath);
  const element = findElementById(model.elements, id);
  if (!element) {
    throw new CoMotionError(`找不到元素：${id}`);
  }

  const localBox = elementBounds(element, { ancestors: [invertMatrix(element.matrix)], fonts: fontBook });
  if (!(localBox.width > 0) || !(localBox.height > 0)) {
    throw new CoMotionError(`元素 ${id} 沒有邊界框，無法縮放`);
  }
  const sx = width / localBox.width;
  const sy = height / localBox.height;

  const cornerBefore = anchorCorner(anchor, localBox);
  const cornerAfter = { x: cornerBefore.x * sx, y: cornerBefore.y * sy };
  const deltaLocal = { x: cornerBefore.x - cornerAfter.x, y: cornerBefore.y - cornerAfter.y };
  // The target's own matrix's linear part (no translation) carries a local
  // delta into the parent's frame — this is what makes a rotated target's
  // anchor corner land correctly instead of only working axis-aligned.
  const matrix = element.matrix;
  const deltaParent = {
    x: matrix.a * deltaLocal.x + matrix.c * deltaLocal.y,
    y: matrix.b * deltaLocal.x + matrix.d * deltaLocal.y,
  };

  let current = resizeOneContainer(svg, id, sx, sy, fontBook, force);
  current = applyTransformDelta(
    current,
    id,
    (parts) => ({
      ...parts,
      translateX: parts.translateX + deltaParent.x,
      translateY: parts.translateY + deltaParent.y,
    }),
    true,
  );
  return current;
}

/** Resizes every target to the same `(width, height)` (`co-motion element resize`, NOOP-90/T2 — new alongside the existing uniform `element scale`). */
export function resizeElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  width: number,
  height: number,
  anchor: ResizeAnchor,
  fontBook: ReadonlyMap<string, FontMetrics>,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (!Number.isFinite(width) || !(width > 0)) {
    throw new CoMotionError("width 必須是大於 0 的數字");
  }
  if (!Number.isFinite(height) || !(height > 0)) {
    throw new CoMotionError("height 必須是大於 0 的數字");
  }
  if (!RESIZE_ANCHORS.includes(anchor)) {
    throw new CoMotionError(`anchor 必須是 ${RESIZE_ANCHORS.join("/")} 之一`);
  }

  let current = svgContent;
  for (const id of elementIds) {
    current = resizeOneTarget(current, slidePath, id, width, height, anchor, fontBook, options.force);
  }
  return current;
}

// ---------------------------------------------------------------------------
// element style set
// ---------------------------------------------------------------------------

/** ADR-0014: the style command uses SVG attribute names directly. */
export const STYLE_ATTRIBUTE_WHITELIST: readonly string[] = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
];

const FORBIDDEN_STYLE_ATTRIBUTES: readonly string[] = ["transform", "x", "y", "width", "height"];

function validateStyleAttribute(attr: string, value: string): void {
  if (FORBIDDEN_STYLE_ATTRIBUTES.includes(attr)) {
    throw new CoMotionError(`樣式屬性 ${attr} 不在樣式白名單內，位置與大小必須透過 move/scale 命令調整`);
  }
  if (attr.startsWith("data-comot-")) {
    throw new CoMotionError(`樣式屬性 ${attr} 是保留屬性前綴 data-comot-，不可透過 element style set 設定`);
  }
  if (!STYLE_ATTRIBUTE_WHITELIST.includes(attr)) {
    throw new CoMotionError(`樣式屬性 ${attr} 不在樣式白名單內`);
  }
  if (attr === "opacity") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new CoMotionError("opacity 必須是 0 到 1 之間的數字");
    }
  }
  if (attr === "font-size") {
    const n = Number(value);
    if (!Number.isFinite(n) || !(n > 0)) {
      throw new CoMotionError("font-size 必須是大於 0 的數字");
    }
  }
  if (attr === "stroke-width") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new CoMotionError("stroke-width 不可為負數");
    }
  }
  if (attr === "text-anchor" && !["start", "middle", "end"].includes(value)) {
    throw new CoMotionError("text-anchor 必須是 start、middle 或 end");
  }
}

function setStyleOnContainer(
  svg: string,
  id: string,
  attr: string,
  value: string,
  fontBook: ReadonlyMap<string, FontMetrics>,
  force: boolean | undefined,
): string {
  const roots = scanDocument(svg);
  const svgRoot = requireSvgRoot(roots);
  const { node } = requireContainer(svgRoot, id);
  assertNotLocked(node, id, force);

  if (isGroupContainer(node)) {
    throw new CoMotionError(`元素 ${id} 是群組，沒有可套用樣式的圖元`);
  }

  const primitives = meaningfulChildren(node);
  const textWidthAttr = attributeOf(node, TEXT_WIDTH_ATTRIBUTE);
  const isTextBox = textWidthAttr !== undefined;

  if (attr === "text-anchor" && isTextBox) {
    throw new CoMotionError(`文字框不支援 text-anchor（換行引擎假設 start）：${id}`);
  }

  if (isTextBox && (attr === "font-size" || attr === "font-family")) {
    const textNode = primitives.find((primitive) => primitive.tag === "text");
    if (!textNode) {
      throw new CoMotionError(`元素不是合法的文字框：${id}`);
    }
    const currentInfo = readTextFontInfo(textNode, id);
    const withAttr = applySplices(svg, [setAttrSplice(textNode, attr, value)]);

    const refreshedRoots = scanDocument(withAttr);
    const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
    const { node: refreshedContainer } = requireContainer(refreshedSvgRoot, id);
    const refreshedTextNode = meaningfulChildren(refreshedContainer).find((primitive) => primitive.tag === "text")!;
    const refreshedWidthAttr = attributeOf(refreshedContainer, TEXT_WIDTH_ATTRIBUTE)!;

    const fontFamily = attr === "font-family" ? value : currentInfo.fontFamily;
    const fontSize = attr === "font-size" ? Number(value) : currentInfo.fontSize;
    const { updated } = rewrapTextBoxContent(
      withAttr,
      refreshedContainer,
      refreshedTextNode,
      refreshedWidthAttr,
      Number(refreshedWidthAttr.value),
      fontFamily,
      fontSize,
      fontBook,
      id,
    );
    return updated;
  }

  const splices = primitives.map((primitive) => setAttrSplice(primitive, attr, value));
  return applySplices(svg, splices);
}

/**
 * Sets `attr` to `value` on every target's primitive (`co-motion element
 * style set`, #104, ADR-0014). `attr` must be in the whitelist and pass its
 * per-attribute value validation before any target is touched.
 */
export function setElementStyle(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  attr: string,
  value: string,
  fontBook: ReadonlyMap<string, FontMetrics>,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  validateStyleAttribute(attr, value);
  let current = svgContent;
  for (const id of elementIds) {
    current = setStyleOnContainer(current, id, attr, value, fontBook, options.force);
  }
  return current;
}

// ---------------------------------------------------------------------------
// element order
// ---------------------------------------------------------------------------

export type OrderDirection = "front" | "back" | "up" | "down";

function moveToEdge(svg: string, id: string, direction: "front" | "back", force: boolean | undefined): string {
  const roots = scanDocument(svg);
  const svgRoot = requireSvgRoot(roots);
  const { node, parent } = requireContainer(svgRoot, id);
  assertNotLocked(node, id, force);
  const siblings = parent.children.filter((child) => child.tag === "g");
  if (siblings.length <= 1) return svg; // Only child — no-op.

  if (direction === "front" && siblings[siblings.length - 1] === node) return svg;
  if (direction === "back" && siblings[0] === node) return svg;

  const nodeText = svg.slice(node.start, node.end);
  const withoutNode = svg.slice(0, node.start) + svg.slice(node.end);
  const shift = node.end - node.start;
  const adjust = (offset: number): number => (offset > node.start ? offset - shift : offset);

  if (direction === "front") {
    const insertAt = adjust(parent.contentEnd);
    return withoutNode.slice(0, insertAt) + nodeText + withoutNode.slice(insertAt);
  }
  const firstRemaining = siblings.find((sibling) => sibling !== node)!;
  const insertAt = adjust(firstRemaining.start);
  return withoutNode.slice(0, insertAt) + nodeText + withoutNode.slice(insertAt);
}

/** Swaps two adjacent sibling containers, keeping whatever sits between them (whitespace, comments, other siblings) exactly where it was relative to the pair. */
function swapAdjacentContainers(svg: string, x: ScannedNode, y: ScannedNode): string {
  const [first, second] = x.start < y.start ? [x, y] : [y, x];
  const firstText = svg.slice(first.start, first.end);
  const between = svg.slice(first.end, second.start);
  const secondText = svg.slice(second.start, second.end);
  return svg.slice(0, first.start) + secondText + between + firstText + svg.slice(second.end);
}

function moveOneStep(svg: string, id: string, direction: "up" | "down", force: boolean | undefined): string {
  const roots = scanDocument(svg);
  const svgRoot = requireSvgRoot(roots);
  const { node, parent } = requireContainer(svgRoot, id);
  assertNotLocked(node, id, force);
  const siblings = parent.children.filter((child) => child.tag === "g");
  const index = siblings.indexOf(node);
  const swapIndex = direction === "up" ? index + 1 : index - 1;
  if (swapIndex < 0 || swapIndex >= siblings.length) return svg; // Already at that edge — no-op.
  return swapAdjacentContainers(svg, node, siblings[swapIndex]);
}

/**
 * Reorders every target within its own parent container (`co-motion element
 * order`, #104). `front`/`back` process the list in order so the last id
 * ends up topmost/bottommost (第 4 節); `up`/`down` re-query siblings before
 * each step. Targets under different parents never interact.
 */
export function reorderElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  direction: OrderDirection,
  options: MutationOptions = {},
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  for (const id of elementIds) {
    current = direction === "front" || direction === "back"
      ? moveToEdge(current, id, direction, options.force)
      : moveOneStep(current, id, direction, options.force);
  }
  return current;
}

// ---------------------------------------------------------------------------
// element lock / unlock (T3, ADR-0013)
// ---------------------------------------------------------------------------

/**
 * Sets `data-comot-lock="true"` on every target's container (`co-motion
 * element lock`). Idempotent: locking an already-locked element succeeds
 * with no error. Never checks `assertNotLocked` itself — locking a locked
 * element is a no-op, not a rejection.
 */
export function lockElements(svgContent: string, slidePath: string, elementIds: readonly string[]): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  for (const id of elementIds) {
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, id);
    current = applySplices(current, [setAttrSplice(node, "data-comot-lock", "true")]);
  }
  return current;
}

/**
 * Removes `data-comot-lock` from every target's container (`co-motion
 * element unlock`) — unlocking clears the attribute entirely, it never
 * writes `data-comot-lock="false"` (決定 1). Idempotent: unlocking an
 * already-unlocked element is a no-op.
 */
export function unlockElements(svgContent: string, slidePath: string, elementIds: readonly string[]): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  for (const id of elementIds) {
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, id);
    const attr = attributeOf(node, "data-comot-lock");
    if (!attr) continue;
    current = applySplices(current, [attributeRemovalSplice(node, current, attr)]);
  }
  return current;
}
