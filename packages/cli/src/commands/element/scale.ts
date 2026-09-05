import { scaleSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

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
