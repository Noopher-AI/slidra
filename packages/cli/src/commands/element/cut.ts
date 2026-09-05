import { cutSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementCutInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementCutData = Record<string, never>;

export const elementCutCommand: CommandHandler<ElementCutInput, ElementCutData> = async (input) => {
  await cutSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已剪下 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
