import { groupSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementGroupInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export interface ElementGroupData {
  elementId: string;
}

export const elementGroupCommand: CommandHandler<ElementGroupInput, ElementGroupData> = async (input) => {
  const { elementId } = await groupSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: { elementId }, message: `已將 ${input.slidePath} 的 ${input.elementIds.length} 個元素群組為 ${elementId}` };
};
