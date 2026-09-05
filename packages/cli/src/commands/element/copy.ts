import { copySlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementCopyInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementCopyData = Record<string, never>;

export const elementCopyCommand: CommandHandler<ElementCopyInput, ElementCopyData> = async (input) => {
  await copySlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已複製 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
