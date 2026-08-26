import { CoMotionError } from "../errors.js";
import { escapeXmlAttr } from "../element-text.js";
import { formatSvgNumber } from "../geometry/transform.js";
import { SLIDE_PRIMITIVE_TAGS } from "./format.js";
import { attributeValue, scanDocument, type ScannedNode } from "./scan.js";

/**
 * Insert-side markup building and delete-side splice removal for `rect add`
 * / `ellipse add` / `line add` / `path add` / `element delete` (#74).
 *
 * Pure, and free of Node built-ins transitively (`slide/index.ts`'s barrel
 * comment: the slide model has to load in the browser). `element-text.ts`,
 * which this module reuses `escapeXmlAttr` from, carries the same guarantee
 * (its own doc comment says so), so importing it does not smuggle Node in.
 *
 * Like `element-text.ts` and `normalise.ts`, this module never parses and
 * re-serializes the SVG document (ADR-0001/0004) — it only splices byte
 * ranges found by `scanDocument`.
 */

export type AddShapeInput =
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill?: string }
  | { kind: "ellipse"; x: number; y: number; rx: number; ry: number; fill?: string }
  /**
   * `stroke` is REQUIRED, not optional: SVG has no default stroke colour
   * (an un-stroked, un-filled `<line>` paints nothing at all), and this
   * project's errors-over-fallbacks rule refuses to invent one on the
   * author's behalf. `strokeWidth` stays optional because SVG itself
   * defines `stroke-width`'s default as `1` — that is a spec default, not
   * an invented one, so omitting the attribute and letting SVG apply its
   * own default is allowed (commander's ruling, wave 2 R4).
   */
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth?: number }
  | { kind: "path"; x: number; y: number; d: string; fill?: string; stroke?: string; strokeWidth?: number };

/**
 * Rounds `value` through the same 4-decimal rule the SVG write path uses
 * (`formatSvgNumber`) and rejects it if that rounding collapses the value to
 * zero or below. Catches both "not positive at all" and the narrower case of
 * a value that is positive on input but would be silently persisted as `0`
 * (#76 finding, W1-R11) — a single check covers both, since rounding a
 * non-positive number never produces a positive one.
 *
 * Moved here from `workspace.ts` (design §1.1) so `buildShapeMarkup` can
 * reuse it without an async/Node-dependent import; `workspace.ts` re-imports
 * it for `addTextBox`'s own use, unchanged.
 */
export function assertPositiveAfterRounding(value: number, message: string): number {
  const rounded = Number(formatSvgNumber(value));
  if (!(rounded > 0)) {
    throw new CoMotionError(message);
  }
  return rounded;
}

function assertFinite(value: number, message: string): void {
  if (!Number.isFinite(value)) {
    throw new CoMotionError(message);
  }
}

/**
 * Builds the `<g id="…" transform="…"><TAG …/></g>` markup for one new
 * shape element, compliant with ADR-0012's normal form by construction: the
 * id and position live on the container, the primitive carries no
 * `transform` of its own, and there is exactly one primitive child. Throws
 * before returning anything on invalid input — the caller must not write a
 * shape this function itself would then refuse to parse back.
 */
export function buildShapeMarkup(elementId: string, input: AddShapeInput): string {
  switch (input.kind) {
    case "rect": {
      assertFinite(input.x, "矩形的座標必須是有限數字");
      assertFinite(input.y, "矩形的座標必須是有限數字");
      const width = assertPositiveAfterRounding(input.width, "矩形寬度四捨五入後不是大於 0 的數字");
      const height = assertPositiveAfterRounding(input.height, "矩形高度四捨五入後不是大於 0 的數字");
      const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
      return (
        `<g id="${elementId}" transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
        `<rect width="${formatSvgNumber(width)}" height="${formatSvgNumber(height)}"${fillAttr}/></g>`
      );
    }
    case "ellipse": {
      assertFinite(input.x, "橢圓的座標必須是有限數字");
      assertFinite(input.y, "橢圓的座標必須是有限數字");
      const rx = assertPositiveAfterRounding(input.rx, "橢圓 rx 四捨五入後不是大於 0 的數字");
      const ry = assertPositiveAfterRounding(input.ry, "橢圓 ry 四捨五入後不是大於 0 的數字");
      const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
      return (
        `<g id="${elementId}" transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
        `<ellipse rx="${formatSvgNumber(rx)}" ry="${formatSvgNumber(ry)}"${fillAttr}/></g>`
      );
    }
    case "line": {
      assertFinite(input.x1, "線的座標必須是有限數字");
      assertFinite(input.y1, "線的座標必須是有限數字");
      assertFinite(input.x2, "線的座標必須是有限數字");
      assertFinite(input.y2, "線的座標必須是有限數字");
      if (input.stroke.trim() === "") {
        throw new CoMotionError("line add 需要 --stroke，SVG 沒有預設線條顏色");
      }
      const strokeWidthAttr =
        input.strokeWidth === undefined
          ? ""
          : ` stroke-width="${formatSvgNumber(
              assertPositiveAfterRounding(input.strokeWidth, "stroke-width 四捨五入後不是大於 0 的數字"),
            )}"`;
      // The container's transform is the line's own origin (x1, y1); the
      // primitive's endpoints are written relative to it, per ADR-0012
      // (position lives only on the container).
      const dx = input.x2 - input.x1;
      const dy = input.y2 - input.y1;
      return (
        `<g id="${elementId}" transform="translate(${formatSvgNumber(input.x1)} ${formatSvgNumber(input.y1)})">` +
        `<line x1="0" y1="0" x2="${formatSvgNumber(dx)}" y2="${formatSvgNumber(dy)}" ` +
        `stroke="${escapeXmlAttr(input.stroke)}"${strokeWidthAttr}/></g>`
      );
    }
    case "path": {
      assertFinite(input.x, "path 的座標必須是有限數字");
      assertFinite(input.y, "path 的座標必須是有限數字");
      if (input.d === "") {
        throw new CoMotionError("path add 需要 --d，不可為空字串");
      }
      const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
      const strokeAttr = input.stroke === undefined ? "" : ` stroke="${escapeXmlAttr(input.stroke)}"`;
      const strokeWidthAttr =
        input.strokeWidth === undefined
          ? ""
          : ` stroke-width="${formatSvgNumber(
              assertPositiveAfterRounding(input.strokeWidth, "stroke-width 四捨五入後不是大於 0 的數字"),
            )}"`;
      return (
        `<g id="${elementId}" transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
        `<path d="${escapeXmlAttr(input.d)}"${fillAttr}${strokeAttr}${strokeWidthAttr}/></g>`
      );
    }
  }
}

export interface RemoveElementsResult {
  updated: string;
  /** Every id actually removed, including ids inside a removed group's subtree, in document order. */
  removedIds: string[];
  /** How many `<comot:effect>`-shaped entries were spliced out of the effect list. */
  removedEffects: number;
}

interface Splice {
  start: number;
  end: number;
}

/**
 * The namespace URI ADR-0009's effect list lives in. Duplicated here as a
 * literal rather than imported from anywhere: `packages/web/src/effects.ts`
 * is the OTHER reader of this shape (DOMParser-based, browser-only) — core
 * becoming a second reader of the same convention is accepted debt (wave 2
 * R6), not something this unit unifies. Keep the two in sync by hand.
 */
const EFFECTS_NAMESPACE_URI = "https://co-motion.dev/ns";

/** Splits a possibly-namespaced tag name ("comot:effect") into prefix and local name. */
function splitNamespacedTag(tag: string): { prefix: string | null; local: string } {
  const colon = tag.indexOf(":");
  if (colon === -1) return { prefix: null, local: tag };
  return { prefix: tag.slice(0, colon), local: tag.slice(colon + 1) };
}

/**
 * Walks the whole document collecting every `<PREFIX:effect>` node whose
 * `PREFIX` resolves (via inherited `xmlns:PREFIX` declarations) to
 * `EFFECTS_NAMESPACE_URI`, and whose parent similarly resolves as
 * `PREFIX:effects`. The `comot:` prefix is a convention, not a guarantee
 * (same stance `effects.ts` takes) — this resolves it structurally instead
 * of hard-coding the prefix string.
 */
function collectEffectEntryNodes(
  nodes: readonly ScannedNode[],
  inheritedNamespaces: ReadonlyMap<string, string>,
  into: ScannedNode[],
): void {
  for (const node of nodes) {
    const namespaces = new Map(inheritedNamespaces);
    for (const attribute of node.attributes) {
      if (attribute.name.startsWith("xmlns:")) {
        namespaces.set(attribute.name.slice("xmlns:".length), attribute.value);
      }
    }
    const { prefix, local } = splitNamespacedTag(node.tag);
    if (local === "effects" && prefix !== null && namespaces.get(prefix) === EFFECTS_NAMESPACE_URI) {
      for (const child of node.children) {
        const childTag = splitNamespacedTag(child.tag);
        if (
          childTag.local === "effect" &&
          childTag.prefix !== null &&
          namespaces.get(childTag.prefix) === EFFECTS_NAMESPACE_URI
        ) {
          into.push(child);
        }
      }
    }
    collectEffectEntryNodes(node.children, namespaces, into);
  }
}

/** Collects every value of an `id` attribute in `node`'s own subtree, itself included, in document order. */
function collectIdsInSubtree(node: ScannedNode, into: string[]): void {
  const id = attributeValue(node, "id");
  if (id !== null) into.push(id);
  for (const child of node.children) collectIdsInSubtree(child, into);
}

/** True when `candidate` lies within `container`'s byte range (and is not `container` itself). */
function isWithin(candidate: ScannedNode, container: ScannedNode): boolean {
  return candidate !== container && candidate.start >= container.start && candidate.end <= container.end;
}

/**
 * Removes the elements named by `elementIds` (and, for a removed group,
 * every descendant inside it) from `svg`, together with every
 * `<comot:effect>`-shaped entry that targets any removed id (ADR-0009's
 * invariant: an effect entry always points at an element that exists).
 *
 * Matches the ADR-0012 normal form only: an id must sit on a `<g>` container
 * reachable through nested `<g>`s from the document root. A bare, unwrapped
 * primitive carrying an id (an unconverted slide) is not matched here — the
 * caller (workspace.ts's `deleteElements`) is responsible for telling the
 * author to run `convert` first (wave 2 R9); this function only ever throws
 * the generic "element not found" error, since it does not know whether an
 * unmatched id is simply absent or present-but-unwrapped.
 *
 * Throws before any splice is computed when any requested id cannot be
 * found, or when removing every child of some container would leave it
 * empty — a partial delete, or an emptied container, is never written.
 */
export function removeElements(svg: string, elementIds: readonly string[]): RemoveElementsResult {
  const roots = scanDocument(svg);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }

  const topLevelGroups = svgRoot.children.filter((child) => child.tag === "g");
  const barePrimitiveIds = new Set<string>();
  for (const child of svgRoot.children) {
    if (child.tag === "g") continue;
    if (SLIDE_PRIMITIVE_TAGS.includes(child.tag)) {
      const id = attributeValue(child, "id");
      if (id !== null) barePrimitiveIds.add(id);
    }
  }

  const parentOf = new Map<ScannedNode, ScannedNode>();
  const indexParents = (node: ScannedNode): void => {
    for (const child of node.children) {
      parentOf.set(child, node);
      indexParents(child);
    }
  };
  indexParents(svgRoot);

  const findGroupById = (groups: readonly ScannedNode[], id: string): ScannedNode | undefined => {
    for (const group of groups) {
      if (attributeValue(group, "id") === id) return group;
      const found = findGroupById(
        group.children.filter((child) => child.tag === "g"),
        id,
      );
      if (found) return found;
    }
    return undefined;
  };

  // Locate every requested id, deduplicated, before any splice is computed
  // — a partial delete would burn an undo slot for half a command.
  const uniqueIds = Array.from(new Set(elementIds));
  const found: ScannedNode[] = [];
  for (const requestedId of uniqueIds) {
    const group = findGroupById(topLevelGroups, requestedId);
    if (!group) {
      if (barePrimitiveIds.has(requestedId)) {
        throw new CoMotionError(
          `元素 ${requestedId} 是尚未轉換的裸圖元，請先執行 co-motion convert 轉換這份簡報再刪除。`,
        );
      }
      throw new CoMotionError(`找不到元素：${requestedId}`);
    }
    found.push(group);
  }

  // Collapse a group and one of its own listed children to a single
  // removal: the child is already covered by the ancestor's splice range.
  const outerMost = found.filter((node) => !found.some((other) => other !== node && isWithin(node, other)));

  // Empty-container check: a delete that would leave a nested group with no
  // remaining children (other than <title>/<desc>) is refused, naming that
  // parent group (wave 2 R3) — no cascade-delete, no silently-left-empty
  // container.
  for (const node of outerMost) {
    const parent = parentOf.get(node);
    if (!parent || parent.tag !== "g") continue;
    const meaningfulSiblings = parent.children.filter((child) => child.tag !== "title" && child.tag !== "desc");
    const allRemoved = meaningfulSiblings.every((sibling) => outerMost.includes(sibling));
    if (allRemoved) {
      const parentId = attributeValue(parent, "id");
      throw new CoMotionError(`刪除後容器 ${parentId ?? "(無 id)"} 會沒有任何子元素，請改為刪除該容器本身。`);
    }
  }

  // The closure: every id inside each removed subtree, document order,
  // de-duplicated in case a nested id repeats a top-level one (already-
  // corrupt input — not this unit's problem to repair, §5).
  const removedIds: string[] = [];
  const removedIdSet = new Set<string>();
  for (const node of outerMost) {
    const subtreeIds: string[] = [];
    collectIdsInSubtree(node, subtreeIds);
    for (const subtreeId of subtreeIds) {
      if (!removedIdSet.has(subtreeId)) {
        removedIdSet.add(subtreeId);
        removedIds.push(subtreeId);
      }
    }
  }

  const effectEntries: ScannedNode[] = [];
  collectEffectEntryNodes(roots, new Map(), effectEntries);
  const removedEffectNodes = effectEntries.filter((entry) => {
    const target = attributeValue(entry, "target");
    return target !== null && removedIdSet.has(target);
  });

  const splices: Splice[] = [
    ...outerMost.map((node) => ({ start: node.start, end: node.end })),
    ...removedEffectNodes.map((node) => ({ start: node.start, end: node.end })),
  ];

  let updated = svg;
  for (const splice of [...splices].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, splice.start) + updated.slice(splice.end);
  }

  return { updated, removedIds, removedEffects: removedEffectNodes.length };
}
