import { CoMotionError } from "./errors.js";
import { unionRects, elementBounds, type Rect } from "./geometry/bbox.js";
import { decomposeMatrix, formatTransform, type Matrix, type TransformParts } from "./geometry/transform.js";
import { parseTransform } from "./geometry/transform.js";
import { assertSlideCompliant, parseSlide, type SlideElement } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";

/**
 * `element align` / `element distribute` (ADR-0012). Both commands only
 * ever touch the translate component of a target's own container
 * `transform` — never rotation/scale, and (決定 2) only for targets that
 * share the same immediate parent container, so there is no cross-layer
 * inverse-matrix math to do here.
 *
 * Small helpers below duplicate `element-edit.ts`/`element-group.ts`'s
 * shapes on purpose (see this ticket's plan) rather than importing them.
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

function attributeRemovalSplice(container: ScannedNode, svg: string, attr: { start: number; end: number }): Splice {
  let start = attr.start;
  while (start > container.start && /[\t\n\r ]/.test(svg[start - 1])) start--;
  return { start, end: attr.end, text: "" };
}

function buildTransformSplice(
  svg: string,
  container: ScannedNode,
  mutate: (parts: TransformParts) => TransformParts,
): Splice {
  const attr = attributeOf(container, "transform");
  const matrix = parseTransform(attr ? attr.value : null);
  const nextTransform = formatTransform(mutate(decomposeMatrix(matrix)));

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

/** Depth-first search of the parsed slide model for `id`, tracking the chain of ancestor matrices `elementBounds` needs. */
function findElementPath(
  elements: readonly SlideElement[],
  id: string,
  ancestors: readonly Matrix[],
): { element: SlideElement; ancestors: readonly Matrix[] } | undefined {
  for (const element of elements) {
    if (element.id === id) return { element, ancestors };
    if (element.kind === "group") {
      const found = findElementPath(element.children, id, [...ancestors, element.matrix]);
      if (found) return found;
    }
  }
  return undefined;
}

interface Target {
  id: string;
  node: ScannedNode;
  bounds: Rect;
}

/**
 * Resolves every target's container node (all sharing one parent) and its
 * bounding box *within that shared parent's own coordinate system* — i.e.
 * `elementBounds` is called with no ancestor matrices, so a target's own
 * `matrix` (its local translate/scale/rotate) is the only thing applied.
 * That keeps union/center/delta math, and the resulting local-translate
 * write-back, entirely inside the parent's frame — correct even when the
 * parent itself (or one of its ancestors) carries a `scale`/`rotate`
 * (ADR-0012 groups can nest), since that outer transform never enters the
 * computation at all.
 */
function resolveTargets(svgContent: string, slidePath: string, elementIds: readonly string[]): Target[] {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const found = elementIds.map((id) => ({ id, ...requireContainer(svgRoot, id) }));

  const parent = found[0].parent;
  if (found.some((entry) => entry.parent !== parent)) {
    throw new CoMotionError("對齊的元素必須在同一層容器內");
  }

  const model = parseSlide(svgContent, slidePath);
  return found.map(({ id, node }) => {
    const path = findElementPath(model.elements, id, []);
    if (!path) {
      throw new CoMotionError(`找不到元素：${id}`);
    }
    return { id, node, bounds: elementBounds(path.element, { ancestors: [] }) };
  });
}

// ---------------------------------------------------------------------------
// element align
// ---------------------------------------------------------------------------

export type AlignDirection = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

function alignDelta(direction: AlignDirection, union: Rect, bounds: Rect): { dx: number; dy: number } {
  switch (direction) {
    case "left":
      return { dx: union.x - bounds.x, dy: 0 };
    case "hcenter":
      return { dx: union.x + union.width / 2 - (bounds.x + bounds.width / 2), dy: 0 };
    case "right":
      return { dx: union.x + union.width - (bounds.x + bounds.width), dy: 0 };
    case "top":
      return { dx: 0, dy: union.y - bounds.y };
    case "vcenter":
      return { dx: 0, dy: union.y + union.height / 2 - (bounds.y + bounds.height / 2) };
    case "bottom":
      return { dx: 0, dy: union.y + union.height - (bounds.y + bounds.height) };
  }
}

/**
 * Aligns every target against the union of all targets' bounding boxes
 * (`co-motion element align`). Only each container's own translate moves;
 * an unmeasurable target (a `<text>` primitive, or a path with an
 * elliptical arc — `geometry/bbox.ts`'s documented gap) makes the whole
 * command fail, propagating that error untouched.
 */
export function alignElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  direction: AlignDirection,
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (elementIds.length < 2) {
    throw new CoMotionError("對齊至少需要兩個元素");
  }

  const targets = resolveTargets(svgContent, slidePath, elementIds);
  const union = unionRects(targets.map((target) => target.bounds));

  let current = svgContent;
  for (const target of targets) {
    const { dx, dy } = alignDelta(direction, union, target.bounds);
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, target.id);
    const splice = buildTransformSplice(current, node, (parts) => ({
      ...parts,
      translateX: parts.translateX + dx,
      translateY: parts.translateY + dy,
    }));
    current = applySplices(current, [splice]);
  }
  return current;
}

// ---------------------------------------------------------------------------
// element distribute
// ---------------------------------------------------------------------------

export type DistributeAxis = "horizontal" | "vertical";

/**
 * Equalizes the spacing between targets' bounding-box CENTERS along `axis`
 * — not the gaps between their edges (決定 3, settled, do not re-litigate).
 * The first and last target by center coordinate stay fixed; every target
 * in between is repositioned to an equally-spaced center. All centers
 * coinciding is legal and produces zero displacement.
 */
export function distributeElements(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  axis: DistributeAxis,
): string {
  assertSlideCompliant(svgContent, slidePath);
  validateIdList(elementIds);
  if (elementIds.length < 3) {
    throw new CoMotionError("分佈至少需要三個元素");
  }

  const targets = resolveTargets(svgContent, slidePath, elementIds);
  const centerOf = (bounds: Rect): number =>
    axis === "horizontal" ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2;

  const sorted = [...targets].sort((a, b) => centerOf(a.bounds) - centerOf(b.bounds));
  const firstCenter = centerOf(sorted[0].bounds);
  const lastCenter = centerOf(sorted[sorted.length - 1].bounds);
  const step = (lastCenter - firstCenter) / (sorted.length - 1);

  let current = svgContent;
  for (let i = 1; i < sorted.length - 1; i++) {
    const target = sorted[i];
    const desiredCenter = firstCenter + step * i;
    const delta = desiredCenter - centerOf(target.bounds);
    const roots = scanDocument(current);
    const svgRoot = requireSvgRoot(roots);
    const { node } = requireContainer(svgRoot, target.id);
    const splice = buildTransformSplice(current, node, (parts) => ({
      ...parts,
      translateX: axis === "horizontal" ? parts.translateX + delta : parts.translateX,
      translateY: axis === "vertical" ? parts.translateY + delta : parts.translateY,
    }));
    current = applySplices(current, [splice]);
  }
  return current;
}
