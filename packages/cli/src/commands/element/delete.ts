import { deleteSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

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
