import { distributeSlideElements, type DistributeAxis } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementDistributeInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  axis: DistributeAxis;
}
export type ElementDistributeData = Record<string, never>;

export const elementDistributeCommand: CommandHandler<ElementDistributeInput, ElementDistributeData> = async (input) => {
  await distributeSlideElements(input.id, input.slidePath, input.elementIds, input.axis);
  return { ok: true, data: {}, message: `已分佈 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
