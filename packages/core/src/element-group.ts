import { CoMotionError } from "./errors.js";
import { escapeXmlAttr } from "./element-text.js";
import { assertSlideCompliant } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { decomposeMatrix, formatTransform, multiplyMatrix, parseTransform, type TransformParts } from "./geometry/transform.js";

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

/** ADR-0012: a container's children are all `<g>`, or all primitives — never mixed. */
function isGroupContainer(node: ScannedNode): boolean {
  const children = meaningfulChildren(node);
  return children.length > 0 && children.every((child) => child.tag === "g");
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

/**
 * Wraps every target in a brand-new `<g id="newGroupId">` (`co-motion
 * element group`, ADR-0012). Targets must share the same immediate parent
 * container (an ancestor/descendant pair never shares a parent, so that
 * case is already rejected here without a separate check). The new group
 * carries no `transform` of its own (決定 1) — children keep their exact
 * transforms, and it lands at the position of the topmost (last in document
 * order) target, so z-order among untouched siblings is unaffected.
 */
export function groupElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  newGroupId: string,
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (elementIds.length < 2) {
    throw new CoMotionError("群組至少需要兩個元素");
  }

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const found = elementIds.map((id) => requireContainer(svgRoot, id));

  const parent = found[0].parent;
  if (found.some((entry) => entry.parent !== parent)) {
    throw new CoMotionError("群組的元素必須在同一層容器內");
  }

  // Document order among the targets, as they actually appear in `parent`.
  const byDocumentOrder = [...found].sort((a, b) => a.node.start - b.node.start);
  const topmost = byDocumentOrder[byDocumentOrder.length - 1].node;
  const combinedMarkup =
    `<g id="${newGroupId}">` +
    byDocumentOrder.map((entry) => svgContent.slice(entry.node.start, entry.node.end)).join("") +
    "</g>";

  const splices: Splice[] = byDocumentOrder
    .filter((entry) => entry.node !== topmost)
    .map((entry) => ({ start: entry.node.start, end: entry.node.end, text: "" }));
  splices.push({ start: topmost.start, end: topmost.end, text: combinedMarkup });

  return applySplices(svgContent, splices);
}

// ---------------------------------------------------------------------------
// element ungroup
// ---------------------------------------------------------------------------

/**
 * Dissolves one group, splicing its children in at the group's old position
 * (document order preserved) and folding the group's own transform into
 * each child's (決定 1): `childMatrix' = groupMatrix ∘ childMatrix`, so the
 * absolute bounds of every child are unchanged. The group's own
 * `data-comot-name`/`data-comot-media` disappear with it.
 */
function ungroupOne(svgContent: string, slidePath: string, id: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { node } = requireContainer(svgRoot, id);
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
  const childrenMarkup = refreshedChildren
    .map((child) => withFoldedTransforms.slice(child.start, child.end))
    .join("");

  return (
    withFoldedTransforms.slice(0, refreshedNode.start) +
    childrenMarkup +
    withFoldedTransforms.slice(refreshedNode.end)
  );
}

/**
 * Ungroups every target (`co-motion element ungroup`). Multiple targets are
 * processed in list order, re-scanning the document fresh before each one
 * (element-edit.ts's convention — never reuse stale offsets).
 */
export function ungroupElements(svgContent: string, slidePath: string, elementIds: readonly string[]): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  let current = svgContent;
  for (const id of elementIds) {
    current = ungroupOne(current, slidePath, id);
  }
  return current;
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
