import { duplicateSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementDuplicateInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  dx: number;
  dy: number;
}
export interface ElementDuplicateData {
  elementIds: string[];
}

export const elementDuplicateCommand: CommandHandler<ElementDuplicateInput, ElementDuplicateData> = async (input) => {
  const { elementIds } = await duplicateSlideElements(input.id, input.slidePath, input.elementIds, input.dx, input.dy);
  return { ok: true, data: { elementIds }, message: `已在 ${input.slidePath} 複製出 ${elementIds.length} 個新元素` };
};
