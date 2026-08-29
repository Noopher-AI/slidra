import { CoMotionError } from "./errors.js";
import { composeMatrices, decomposeMatrix, formatTransform, multiplyMatrix, parseTransform, type Matrix, type TransformParts } from "./geometry/transform.js";
import { assertSlideCompliant } from "./slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";

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

  return { sourceSlidePath: slidePath, elements, effects };
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

const EFFECTS_XMLNS = "https://schemas.comotion.app/effects";

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
