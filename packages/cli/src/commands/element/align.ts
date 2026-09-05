import { alignSlideElements, type AlignDirection } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementAlignInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  direction: AlignDirection;
}
export type ElementAlignData = Record<string, never>;

export const elementAlignCommand: CommandHandler<ElementAlignInput, ElementAlignData> = async (input) => {
  await alignSlideElements(input.id, input.slidePath, input.elementIds, input.direction);
  return { ok: true, data: {}, message: `已對齊 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
