import { cutSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementCutInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export interface ElementCutData {
  /** Same meaning as `element copy`'s `svg` — see `ElementCopyData`. */
  svg: string;
}

export const elementCutCommand: CommandHandler<ElementCutInput, ElementCutData> = async (input) => {
  const { svg } = await cutSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: { svg }, message: `已剪下 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
