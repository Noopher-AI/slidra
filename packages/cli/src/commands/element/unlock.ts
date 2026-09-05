import { unlockSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementUnlockInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementUnlockData = Record<string, never>;

export const elementUnlockCommand: CommandHandler<ElementUnlockInput, ElementUnlockData> = async (input) => {
  await unlockSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已解除鎖定 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
