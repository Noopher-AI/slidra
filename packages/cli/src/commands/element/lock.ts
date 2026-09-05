import { lockSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementLockInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementLockData = Record<string, never>;

export const elementLockCommand: CommandHandler<ElementLockInput, ElementLockData> = async (input) => {
  await lockSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已鎖定 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
