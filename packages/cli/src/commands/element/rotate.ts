import { rotateSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

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
