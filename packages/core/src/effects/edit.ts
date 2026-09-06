import { CoMotionError, CoMotionNotFoundError } from "../errors.js";
import { escapeXmlAttr } from "../element-text.js";
import { assertSlideCompliant } from "../slide/format.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "../slide/scan.js";
import { formatSvgNumber } from "../svg-number.js";
import {
  assertLegalSeconds,
  defaultDurationFor,
  EFFECTS_NS,
  SUPPORTED_EFFECTS,
  SUPPORTED_STARTS,
  validateEffectItem,
  type Effect,
  type EffectFamily,
  type EffectName,
  type EffectStart,
  type RawEffectAttributes,
} from "./index.js";

/**
 * The splice-only writer for `<comot:effects>` (this ticket's first-ever
 * writer — before this, the list was only ever read, or opaquely carried
 * along by `element-clipboard.ts`/`element-edit.ts`'s dangling-item
 * cleanup, both of which match the tag literally rather than parsing
 * items). Same conventions as `element-edit.ts`/`element-group.ts`: pure
 * `svgContent: string -> string`, `scanDocument` + splice, re-scan fresh
 * before every mutation, small helpers duplicated on purpose rather than
 * shared across modules that other tickets touch in parallel.
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

/** Depth-first search for *any* element (not just `<g>`) carrying `id` — an effect target can be any primitive, a `<g>`, or a media element. */
function findElementById(node: ScannedNode, id: string): ScannedNode | undefined {
  if (attributeValue(node, "id") === id) return node;
  for (const child of node.children) {
    const found = findElementById(child, id);
    if (found) return found;
  }
  return undefined;
}

function locateEffectsList(svgRoot: ScannedNode): { metadata?: ScannedNode; list?: ScannedNode } {
  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  if (!metadata) return {};
  const lists = metadata.children.filter((child) => child.tag === "comot:effects");
  if (lists.length > 1) {
    throw new CoMotionError(
      `這張投影片的 metadata 裡有 ${lists.length} 組效果清單，但一張投影片只能有一份效果清單，簡報已損毀。`,
    );
  }
  return { metadata, list: lists[0] };
}

function requireEffectsList(svgRoot: ScannedNode): ScannedNode {
  const { list } = locateEffectsList(svgRoot);
  if (!list) {
    throw new CoMotionNotFoundError("這張投影片沒有效果清單");
  }
  return list;
}

function effectNodesOf(list: ScannedNode): ScannedNode[] {
  return list.children.filter((child) => child.tag === "comot:effect");
}

function rawAttributesOf(node: ScannedNode): RawEffectAttributes {
  return {
    target: attributeValue(node, "target"),
    family: attributeValue(node, "family"),
    effect: attributeValue(node, "effect"),
    start: attributeValue(node, "start"),
    duration: attributeValue(node, "duration"),
    delay: attributeValue(node, "delay"),
    d: attributeValue(node, "d"),
  };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/**
 * Reads a slide's effect list (`co-motion effect list` and every other
 * `effect` command's own lookup). Unlike `packages/web/src/effects.ts`'s
 * `parseEffects` — which treats a slide with no effect list as legal and
 * empty, for rendering purposes — every `effect` command except `add`
 * requires the list to already exist (4.3): there being nothing to list,
 * remove, move, or set is reported as `CoMotionNotFoundError`, not a quiet
 * empty result.
 */
export function readEffectList(svgContent: string, slidePath: string): Effect[] {
  assertSlideCompliant(svgContent, slidePath);
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const list = requireEffectsList(svgRoot);
  return effectNodesOf(list).map((node, index) => {
    const raw = rawAttributesOf(node);
    const targetExists = raw.target !== null && raw.target !== "" ? !!findElementById(svgRoot, raw.target) : false;
    return validateEffectItem(raw, index, targetExists);
  });
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddEffectInput {
  family: EffectFamily;
  effect: EffectName;
  /** Defaults to "on-click". Ignored (forced to "with-previous") for every `elementIds` entry after the first (D5 / feature "群組動畫"). */
  start?: EffectStart;
  duration?: number;
  delay?: number;
  d?: string;
  /** 1-based insertion position; defaults to appending at the end (D6). */
  index?: number;
}

function serializeEffect(item: {
  target: string;
  family: EffectFamily;
  effect: EffectName;
  start: EffectStart;
  duration: number;
  delay: number;
  d?: string;
}): string {
  const parts = [
    `target="${escapeXmlAttr(item.target)}"`,
    `family="${item.family}"`,
    `effect="${item.effect}"`,
    `start="${item.start}"`,
    `duration="${formatSvgNumber(item.duration)}"`,
    `delay="${formatSvgNumber(item.delay)}"`,
  ];
  if (item.d !== undefined) parts.push(`d="${escapeXmlAttr(item.d)}"`);
  return `<comot:effect ${parts.join(" ")}/>`;
}

function validateInsertIndex(requested: number | undefined, currentLength: number): number {
  if (requested === undefined) return currentLength + 1;
  if (!Number.isInteger(requested) || requested < 1 || requested > currentLength + 1) {
    throw new CoMotionError("--index 超出範圍");
  }
  return requested;
}

/** Rewrites `<comot:effects>`'s `xmlns:comot` to the correct value when it is missing or wrong (a previous, buggy `element-clipboard.ts` paste could have written `https://schemas.comotion.app/effects` — D2). */
function withCorrectedNamespace(svgContent: string, list: ScannedNode): string {
  const nsAttr = attributeOf(list, "xmlns:comot");
  if (nsAttr) {
    if (nsAttr.value === EFFECTS_NS) return svgContent;
    return svgContent.slice(0, nsAttr.start) + `xmlns:comot="${EFFECTS_NS}"` + svgContent.slice(nsAttr.end);
  }
  const insertAt = list.start + 1 + "comot:effects".length;
  return svgContent.slice(0, insertAt) + ` xmlns:comot="${EFFECTS_NS}"` + svgContent.slice(insertAt);
}

function insertEffectItems(svgContent: string, itemsMarkup: string, requestedIndex: number | undefined): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { metadata, list } = locateEffectsList(svgRoot);

  if (!list) {
    validateInsertIndex(requestedIndex, 0);
    if (!metadata) {
      const block = `<metadata><comot:effects xmlns:comot="${EFFECTS_NS}">${itemsMarkup}</comot:effects></metadata>`;
      return svgContent.slice(0, svgRoot.contentStart) + block + svgContent.slice(svgRoot.contentStart);
    }
    const block = `<comot:effects xmlns:comot="${EFFECTS_NS}">${itemsMarkup}</comot:effects>`;
    return svgContent.slice(0, metadata.contentStart) + block + svgContent.slice(metadata.contentStart);
  }

  const fixed = withCorrectedNamespace(svgContent, list);
  const refreshedRoots = scanDocument(fixed);
  const refreshedSvgRoot = requireSvgRoot(refreshedRoots);
  const { list: refreshedList } = locateEffectsList(refreshedSvgRoot);
  const items = effectNodesOf(refreshedList!);
  const index = validateInsertIndex(requestedIndex, items.length);
  const insertAt = index === items.length + 1 ? refreshedList!.contentEnd : items[index - 1].start;
  return fixed.slice(0, insertAt) + itemsMarkup + fixed.slice(insertAt);
}

/**
 * Adds one effect item per `elementIds` entry (`co-motion effect add`). All
 * ids are confirmed present before any byte is written (all-or-nothing,
 * like `deleteElements`). A single id — whether it names a plain element or
 * a group `<g>` — produces exactly one item; more than one id produces one
 * item per id, the first carrying `input.start` (or "on-click") and every
 * other one forced to "with-previous" (D5, feature "群組動畫"'s
 * multiple-loose-elements case; a single group id already gets the "one
 * item" behaviour for free, since it is just one id).
 */
export function addEffects(
  svgContent: string,
  slidePath: string,
  elementIds: readonly string[],
  input: AddEffectInput,
): string {
  assertSlideCompliant(svgContent, slidePath);
  if (elementIds.length === 0) {
    throw new CoMotionError("元素清單不可為空");
  }

  const family = input.family;
  const allowed = SUPPORTED_EFFECTS[family];
  if (!allowed) {
    throw new CoMotionError(`family 值「${family}」尚未實作。`);
  }
  if (!allowed.includes(input.effect)) {
    throw new CoMotionError(`effect 值「${input.effect}」尚未實作。`);
  }
  const start = input.start ?? "on-click";
  if (!SUPPORTED_STARTS.includes(start)) {
    throw new CoMotionError(`start 值「${start}」尚未實作。`);
  }
  if (family === "path" && !input.d) {
    throw new CoMotionError("family 是 path，但沒有給 d，無法新增效果。");
  }
  const duration = input.duration ?? defaultDurationFor(family);
  assertLegalSeconds(duration, "新增效果", "duration");
  const delay = input.delay ?? 0;
  assertLegalSeconds(delay, "新增效果", "delay");

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  for (const id of elementIds) {
    if (!findElementById(svgRoot, id)) {
      throw new CoMotionNotFoundError(`找不到元素：${id}`);
    }
  }

  const itemsMarkup = elementIds
    .map((id, i) =>
      serializeEffect({
        target: id,
        family,
        effect: input.effect,
        start: i === 0 ? start : "with-previous",
        duration,
        delay,
        d: input.d,
      }),
    )
    .join("");

  return insertEffectItems(svgContent, itemsMarkup, input.index);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/** Removes the effect items at `indices` (1-based, `co-motion effect remove`). Every index is confirmed in range before anything is removed. */
export function removeEffects(svgContent: string, slidePath: string, indices: readonly number[]): string {
  assertSlideCompliant(svgContent, slidePath);
  if (indices.length === 0) {
    throw new CoMotionError("必須指定至少一個要移除的效果項");
  }

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const list = requireEffectsList(svgRoot);
  const items = effectNodesOf(list);
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      throw new CoMotionError(`效果項編號超出範圍：${index}`);
    }
  }

  // Largest index first, so removing one never shifts the byte offset of
  // an index not yet processed.
  const descending = [...new Set(indices)].sort((a, b) => b - a);
  let current = svgContent;
  for (const index of descending) {
    const freshRoots = scanDocument(current);
    const freshSvgRoot = requireSvgRoot(freshRoots);
    const freshList = requireEffectsList(freshSvgRoot);
    const node = effectNodesOf(freshList)[index - 1];
    current = current.slice(0, node.start) + current.slice(node.end);
  }
  return current;
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

/** Swaps the effect item at `index` (1-based) with its neighbour (`co-motion effect move`). A move past either end is a tolerated no-op, mirroring `element order`'s boundary handling. */
export function moveEffect(svgContent: string, slidePath: string, index: number, direction: "up" | "down"): string {
  assertSlideCompliant(svgContent, slidePath);
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const list = requireEffectsList(svgRoot);
  const items = effectNodesOf(list);
  if (!Number.isInteger(index) || index < 1 || index > items.length) {
    throw new CoMotionError(`效果項編號超出範圍：${index}`);
  }

  const otherIndex = direction === "up" ? index - 1 : index + 1;
  if (otherIndex < 1 || otherIndex > items.length) {
    return svgContent;
  }

  const first = items[Math.min(index, otherIndex) - 1];
  const second = items[Math.max(index, otherIndex) - 1];
  const firstText = svgContent.slice(first.start, first.end);
  const secondText = svgContent.slice(second.start, second.end);
  return applySplices(svgContent, [
    { start: first.start, end: first.end, text: secondText },
    { start: second.start, end: second.end, text: firstText },
  ]);
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export interface SetEffectInput {
  effect?: EffectName;
  start?: EffectStart;
  duration?: number;
  delay?: number;
  d?: string;
}

function attrSplice(node: ScannedNode, name: string, value: string): Splice {
  const existing = attributeOf(node, name);
  const escaped = escapeXmlAttr(value);
  if (existing) {
    return { start: existing.start, end: existing.end, text: `${name}="${escaped}"` };
  }
  const insertAt = node.start + 1 + node.tag.length;
  return { start: insertAt, end: insertAt, text: ` ${name}="${escaped}"` };
}

/**
 * Changes one or more of an effect item's mutable attributes
 * (`co-motion effect set`). `family` is never settable here — switching
 * families is a `remove` + `add` (4.3) — so `effect` may only be reassigned
 * to another name already legal for the item's existing `family`, and `d`
 * may only be set on an item whose family is already `"path"`.
 */
export function setEffect(svgContent: string, slidePath: string, index: number, input: SetEffectInput): string {
  assertSlideCompliant(svgContent, slidePath);
  if (
    input.effect === undefined &&
    input.start === undefined &&
    input.duration === undefined &&
    input.delay === undefined &&
    input.d === undefined
  ) {
    throw new CoMotionError("effect set 至少要指定一個要改的欄位");
  }

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const list = requireEffectsList(svgRoot);
  const items = effectNodesOf(list);
  if (!Number.isInteger(index) || index < 1 || index > items.length) {
    throw new CoMotionError(`效果項編號超出範圍：${index}`);
  }
  const node = items[index - 1];
  const family = attributeValue(node, "family") as EffectFamily | null;
  if (!family || !SUPPORTED_EFFECTS[family]) {
    throw new CoMotionError("這個效果項的 family 已損毀，無法修改");
  }

  if (input.effect !== undefined && !SUPPORTED_EFFECTS[family].includes(input.effect)) {
    throw new CoMotionError(`effect 值「${input.effect}」不屬於 family「${family}」，family 無法用 set 變更，請改用 remove + add。`);
  }
  if (input.start !== undefined && !SUPPORTED_STARTS.includes(input.start)) {
    throw new CoMotionError(`start 值「${input.start}」尚未實作。`);
  }
  if (input.d !== undefined && family !== "path") {
    throw new CoMotionError(`只有 family="path" 的效果項可以設定 d`);
  }
  if (input.duration !== undefined) assertLegalSeconds(input.duration, "effect set", "duration");
  if (input.delay !== undefined) assertLegalSeconds(input.delay, "effect set", "delay");

  const splices: Splice[] = [];
  if (input.effect !== undefined) splices.push(attrSplice(node, "effect", input.effect));
  if (input.start !== undefined) splices.push(attrSplice(node, "start", input.start));
  if (input.duration !== undefined) splices.push(attrSplice(node, "duration", formatSvgNumber(input.duration)));
  if (input.delay !== undefined) splices.push(attrSplice(node, "delay", formatSvgNumber(input.delay)));
  if (input.d !== undefined) splices.push(attrSplice(node, "d", input.d));

  return applySplices(svgContent, splices);
}

// ---------------------------------------------------------------------------
// dangling-target cleanup (used by element-group.ts's group/ungroup)
// ---------------------------------------------------------------------------

/**
 * Removes every effect item whose `target` is in `targetIds` — used by
 * `element-group.ts` when grouping (each new member's own effects are
 * cleared) or ungrouping (the dissolved group's own effect is cleared).
 * A slide with no effect list at all is a legal no-op (returns unchanged,
 * `removedCount: 0`) rather than `CoMotionNotFoundError` — group/ungroup on
 * a slide with no animations anywhere is the common case, not an error.
 */
export function removeEffectsTargeting(
  svgContent: string,
  slidePath: string,
  targetIds: ReadonlySet<string>,
): { updated: string; removedCount: number } {
  assertSlideCompliant(svgContent, slidePath);
  if (targetIds.size === 0) return { updated: svgContent, removedCount: 0 };

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { list } = locateEffectsList(svgRoot);
  if (!list) return { updated: svgContent, removedCount: 0 };

  const splices: Splice[] = [];
  let removedCount = 0;
  for (const node of effectNodesOf(list)) {
    const target = attributeValue(node, "target");
    if (target !== null && targetIds.has(target)) {
      splices.push({ start: node.start, end: node.end, text: "" });
      removedCount++;
    }
  }
  return { updated: applySplices(svgContent, splices), removedCount };
}
