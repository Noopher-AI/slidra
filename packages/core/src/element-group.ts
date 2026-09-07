import { CoMotionError } from "./errors.js";
import { escapeXmlAttr } from "./element-text.js";
import { assertSlideCompliant, TABLE_CONTAINER_TYPE } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { decomposeMatrix, formatTransform, multiplyMatrix, parseTransform, type TransformParts } from "./geometry/transform.js";
import { removeEffectsTargeting } from "./effects/edit.js";

/**
 * `element group` / `element ungroup` / `element name set` — the container
 * structure commands (ADR-0012 nested groups). This module deliberately
 * duplicates the small offset-splicing helpers `element-edit.ts` already
 * has: other tickets run against that file in parallel, and both modules
 * are small enough that sharing a module is not worth the coordination
 * cost (per the plan for this ticket).
 */

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

/** Depth-first search for the `<g id="...">` container named `id`, tracking its immediate parent container. */
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

const IGNORED_CHILD_TAGS = new Set(["title", "desc"]);

function meaningfulChildren(node: ScannedNode): ScannedNode[] {
  return node.children.filter((child) => !IGNORED_CHILD_TAGS.has(child.tag));
}

/**
 * ADR-0012: a container's children are all `<g>`, or all primitives —
 * never mixed. An unbound table's cells are all `<g data-comot-cell>` too
 * (E2.T14) — explicitly excluded so `ungroupOne` below never mistakes a
 * table for an ordinary group and dissolves it into a pile of id-less
 * cells.
 */
function isGroupContainer(node: ScannedNode): boolean {
  if (attributeValue(node, "data-comot-type") === TABLE_CONTAINER_TYPE) return false;
  const children = meaningfulChildren(node);
  return children.length > 0 && children.every((child) => child.tag === "g");
}

const GROUP_NAME_PATTERN = /^Group (\d+)$/;

function collectDataCommotNames(node: ScannedNode, names: string[]): void {
  const name = attributeValue(node, "data-comot-name");
  if (name !== null) names.push(name);
  for (const child of node.children) collectDataCommotNames(child, names);
}

/**
 * D1: a freshly created group's default name (`Group N`) — the highest
 * existing `Group <n>` name on the slide, plus one, or `Group 1` when none
 * exist. Deliberately never fills a gap left by a dissolved group (e.g.
 * `Group 1`, `Group 5` → next is `Group 6`, not `Group 2`): reusing a
 * number that already existed once on this slide would make undo/redo
 * ambiguous about which "Group 2" is meant.
 */
function nextGroupName(svgRoot: ScannedNode): string {
  const names: string[] = [];
  collectDataCommotNames(svgRoot, names);
  const numbers = names
    .map((name) => GROUP_NAME_PATTERN.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `Group ${next}`;
}

/** `element group`/`element ungroup` never treat a table as a group (E2.T14, plan §2 item 5) — its cells are not independently selectable members. */
function assertNotTableContainer(node: ScannedNode, elementId: string, action: string): void {
  if (attributeValue(node, "data-comot-type") === TABLE_CONTAINER_TYPE) {
    throw new CoMotionError(`元素 ${elementId} 是表格，${action}`);
  }
}

/** The leading whitespace before an attribute, so removing it also removes the separating space. */
function attributeRemovalSplice(container: ScannedNode, svg: string, attr: { start: number; end: number }): Splice {
  let start = attr.start;
  while (start > container.start && /[\t\n\r ]/.test(svg[start - 1])) start--;
  return { start, end: attr.end, text: "" };
}

/** Sets `node`'s `transform` attribute to `newTransform`'s serialization, inserting or removing it as needed. */
function setTransformSplice(svg: string, node: ScannedNode, mutate: (parts: TransformParts) => TransformParts): Splice {
  const attr = attributeOf(node, "transform");
  const matrix = parseTransform(attr ? attr.value : null);
  const nextTransform = formatTransform(mutate(decomposeMatrix(matrix)));

  if (attr) {
    if (nextTransform === "") {
      return attributeRemovalSplice(node, svg, attr);
    }
    return { start: attr.start, end: attr.end, text: `transform="${nextTransform}"` };
  }
  if (nextTransform === "") {
    return { start: node.start, end: node.start, text: "" };
  }
  const insertAt = node.start + 1 + node.tag.length;
  return { start: insertAt, end: insertAt, text: ` transform="${nextTransform}"` };
}

// ---------------------------------------------------------------------------
// element group
// ---------------------------------------------------------------------------

export interface GroupElementsResult {
  svg: string;
  /** Effect items removed because they targeted one of the grouped members directly ([E2.T7]: a member's individual animation does not carry over into the new group). */
  removedEffects: number;
}

/**
 * Wraps every target in a brand-new `<g id="newGroupId">` (`co-motion
 * element group`, ADR-0012). Targets must share the same immediate parent
 * container (an ancestor/descendant pair never shares a parent, so that
 * case is already rejected here without a separate check). The new group
 * carries no `transform` of its own (決定 1) — children keep their exact
 * transforms, and it lands at the position of the topmost (last in document
 * order) target, so z-order among untouched siblings is unaffected.
 *
 * [E2.T7]: any effect item that directly targets one of `elementIds` is
 * removed — grouping does not carry a member's own animation forward, and
 * leaving a now-nested target in place would silently keep animating a
 * member the GUI no longer shows as independently selectable.
 */
export function groupElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  newGroupId: string,
): GroupElementsResult {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (elementIds.length < 2) {
    throw new CoMotionError("群組至少需要兩個元素");
  }

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const found = elementIds.map((id) => requireContainer(svgRoot, id));
  found.forEach((entry, index) => assertNotTableContainer(entry.node, elementIds[index], "不能加入群組"));

  const parent = found[0].parent;
  if (found.some((entry) => entry.parent !== parent)) {
    throw new CoMotionError("群組的元素必須在同一層容器內");
  }

  // Document order among the targets, as they actually appear in `parent`.
  const byDocumentOrder = [...found].sort((a, b) => a.node.start - b.node.start);
  const topmost = byDocumentOrder[byDocumentOrder.length - 1].node;
  const groupName = nextGroupName(svgRoot);
  const combinedMarkup =
    `<g id="${newGroupId}" data-comot-name="${escapeXmlAttr(groupName)}">` +
    byDocumentOrder.map((entry) => svgContent.slice(entry.node.start, entry.node.end)).join("") +
    "</g>";

  const splices: Splice[] = byDocumentOrder
    .filter((entry) => entry.node !== topmost)
    .map((entry) => ({ start: entry.node.start, end: entry.node.end, text: "" }));
  splices.push({ start: topmost.start, end: topmost.end, text: combinedMarkup });

  const grouped = applySplices(svgContent, splices);
  const { updated, removedCount } = removeEffectsTargeting(grouped, slidePath, new Set(elementIds));
  return { svg: updated, removedEffects: removedCount };
}

// ---------------------------------------------------------------------------
// element ungroup
// ---------------------------------------------------------------------------

interface UngroupOneResult {
  svg: string;
  /** The dissolved group's direct children, in document order — the GUI reselects these (SELECT_AFTER_COMMAND). */
  elementIds: string[];
  removedEffects: number;
}

/**
 * Dissolves one group, splicing its children in at the group's old position
 * (document order preserved) and folding the group's own transform into
 * each child's (決定 1): `childMatrix' = groupMatrix ∘ childMatrix`, so the
 * absolute bounds of every child are unchanged. The group's own
 * `data-comot-name`/`data-comot-media` disappear with it.
 *
 * [E2.T7]: any effect item targeting the group `<g>` itself (a group
 * animation, D5) is removed along with it — the id it pointed at no longer
 * exists once the group is dissolved.
 */
function ungroupOne(svgContent: string, slidePath: string, id: string): UngroupOneResult {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { node } = requireContainer(svgRoot, id);
  assertNotTableContainer(node, id, "不能解散群組");
  if (!isGroupContainer(node)) {
    throw new CoMotionError(`元素 ${id} 不是群組`);
  }
  const groupMatrix = parseTransform(attributeOf(node, "transform")?.value ?? null);
  const children = meaningfulChildren(node);

  // Fold the group's matrix into each child's own transform, one splice per
  // child, all relative to the same (pre-splice) document.
  const childSplices: Splice[] = children.map((child) => {
    const childMatrix = parseTransform(attributeOf(child, "transform")?.value ?? null);
    const combined = multiplyMatrix(groupMatrix, childMatrix);
    return setTransformSplice(svgContent, child, () => decomposeMatrix(combined));
  });
  const withFoldedTransforms = applySplices(svgContent, childSplices);

  // The splices above shifted every offset inside the group; re-locate it
  // and its (now-updated) children before building the replacement markup.
  const refreshedRoots = scanDocument(withFoldedTransforms);
  const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
  const { node: refreshedNode } = requireContainer(refreshedSvgRoot, id);
  const refreshedChildren = meaningfulChildren(refreshedNode);
  const childIds = refreshedChildren
    .map((child) => attributeValue(child, "id"))
    .filter((childId): childId is string => childId !== null);
  const childrenMarkup = refreshedChildren
    .map((child) => withFoldedTransforms.slice(child.start, child.end))
    .join("");

  const ungrouped =
    withFoldedTransforms.slice(0, refreshedNode.start) +
    childrenMarkup +
    withFoldedTransforms.slice(refreshedNode.end);

  const { updated, removedCount } = removeEffectsTargeting(ungrouped, slidePath, new Set([id]));
  return { svg: updated, elementIds: childIds, removedEffects: removedCount };
}

export interface UngroupElementsResult {
  svg: string;
  /** Every dissolved group's direct children, concatenated in processing order — the GUI reselects these. */
  elementIds: string[];
  /** [E2.T7]: how many effect items were removed because they targeted one of the dissolved groups directly. */
  removedEffects: number;
}

/**
 * Ungroups every target (`co-motion element ungroup`). Multiple targets are
 * processed in list order, re-scanning the document fresh before each one
 * (element-edit.ts's convention — never reuse stale offsets).
 */
export function ungroupElements(svgContent: string, slidePath: string, elementIds: readonly string[]): UngroupElementsResult {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  const allChildIds: string[] = [];
  let totalRemoved = 0;
  for (const id of elementIds) {
    const result = ungroupOne(current, slidePath, id);
    current = result.svg;
    allChildIds.push(...result.elementIds);
    totalRemoved += result.removedEffects;
  }
  return { svg: current, elementIds: allChildIds, removedEffects: totalRemoved };
}

// ---------------------------------------------------------------------------
// element name set
// ---------------------------------------------------------------------------

/** Builds the splice that sets/removes `attr` on `node` within `svg` — `value === ""` removes the attribute entirely (ADR-0004: no meaningless bytes). */
function nameAttrSplice(svg: string, node: ScannedNode, attr: string, value: string): Splice {
  const existing = attributeOf(node, attr);
  if (value === "") {
    return existing ? attributeRemovalSplice(node, svg, existing) : { start: node.start, end: node.start, text: "" };
  }
  if (existing) {
    return { start: existing.start, end: existing.end, text: `${attr}="${escapeXmlAttr(value)}"` };
  }
  const insertAt = node.start + 1 + node.tag.length;
  return { start: insertAt, end: insertAt, text: ` ${attr}="${escapeXmlAttr(value)}"` };
}

/**
 * Sets `data-comot-name` on every target container (`co-motion element name
 * set`, mirroring `element style set`'s multi-target shape). An empty
 * string removes the attribute (ADR-0004: no meaningless bytes). Names need
 * not be unique.
 */
export function setElementName(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  name: string,
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  for (const id of elementIds) {
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, id);
    const splice = nameAttrSplice(current, node, "data-comot-name", name);
    current = applySplices(current, [splice]);
  }
  return current;
}
