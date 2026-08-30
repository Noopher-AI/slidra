import {
  deleteSlideElements,
  insertSlideElement,
  lockSlideElements,
  moveSlideElements,
  reorderSlideElements,
  rotateSlideElements,
  scaleSlideElements,
  setSlideElementStyle,
  unlockSlideElements,
  type InsertElementInput,
  type OrderDirection,
} from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `element insert / delete / move / scale / rotate / style set / order`
 * (#104). Thin CommandHandler wrappers — every one of these just forwards
 * already-parsed input to `@co-motion/core`'s workspace functions and
 * composes the status message; no coordinate math or splicing lives here
 * (see `@co-motion/core`'s `element-edit.ts` for that).
 */

export interface ElementInsertInput {
  id: string;
  slidePath: string;
  kind: InsertElementInput["kind"];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  d?: string;
  fill?: string;
  href?: string;
  media?: string;
}

export interface ElementInsertData {
  elementId: string;
}

export const elementInsertCommand: CommandHandler<ElementInsertInput, ElementInsertData> = async (input) => {
  const { elementId } = await insertSlideElement(input.id, input.slidePath, {
    kind: input.kind,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
    d: input.d,
    fill: input.fill,
    href: input.href,
    media: input.media,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 新增元素 ${elementId}` };
};

export interface ElementDeleteInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementDeleteData = Record<string, never>;

export const elementDeleteCommand: CommandHandler<ElementDeleteInput, ElementDeleteData> = async (input) => {
  await deleteSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已刪除 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};

export interface ElementMoveInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  dx: number;
  dy: number;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementMoveData = Record<string, never>;

export const elementMoveCommand: CommandHandler<ElementMoveInput, ElementMoveData> = async (input) => {
  await moveSlideElements(input.id, input.slidePath, input.elementIds, input.dx, input.dy, { force: input.force });
  return { ok: true, data: {}, message: `已搬移 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};

export interface ElementScaleInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  factor: number;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementScaleData = Record<string, never>;

export const elementScaleCommand: CommandHandler<ElementScaleInput, ElementScaleData> = async (input) => {
  await scaleSlideElements(input.id, input.slidePath, input.elementIds, input.factor, { force: input.force });
  return { ok: true, data: {}, message: `已縮放 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};

export interface ElementRotateInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  degrees: number;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementRotateData = Record<string, never>;

export const elementRotateCommand: CommandHandler<ElementRotateInput, ElementRotateData> = async (input) => {
  await rotateSlideElements(input.id, input.slidePath, input.elementIds, input.degrees, { force: input.force });
  return { ok: true, data: {}, message: `已旋轉 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};

export interface ElementStyleSetInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  attr: string;
  value: string;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementStyleSetData = Record<string, never>;

export const elementStyleSetCommand: CommandHandler<ElementStyleSetInput, ElementStyleSetData> = async (input) => {
  await setSlideElementStyle(input.id, input.slidePath, input.elementIds, input.attr, input.value, {
    force: input.force,
  });
  return {
    ok: true,
    data: {},
    message: `已設定 ${input.slidePath} 的 ${input.elementIds.length} 個元素的 ${input.attr}`,
  };
};

export interface ElementOrderInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  direction: OrderDirection;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementOrderData = Record<string, never>;

export const elementOrderCommand: CommandHandler<ElementOrderInput, ElementOrderData> = async (input) => {
  await reorderSlideElements(input.id, input.slidePath, input.elementIds, input.direction, { force: input.force });
  return { ok: true, data: {}, message: `已調整 ${input.slidePath} 的 ${input.elementIds.length} 個元素的疊置順序` };
};

export interface ElementLockInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementLockData = Record<string, never>;

export const elementLockCommand: CommandHandler<ElementLockInput, ElementLockData> = async (input) => {
  await lockSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已鎖定 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};

export interface ElementUnlockInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementUnlockData = Record<string, never>;

export const elementUnlockCommand: CommandHandler<ElementUnlockInput, ElementUnlockData> = async (input) => {
  await unlockSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已解除鎖定 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
