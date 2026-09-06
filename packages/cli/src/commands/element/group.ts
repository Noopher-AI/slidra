import { groupSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementGroupInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export interface ElementGroupData {
  elementId: string;
  /** [E2.T7]: how many effect items were removed because they targeted a now-grouped member directly — the GUI surfaces this as a toast. */
  removedEffects: number;
}

export const elementGroupCommand: CommandHandler<ElementGroupInput, ElementGroupData> = async (input) => {
  const { elementId, removedEffects } = await groupSlideElements(input.id, input.slidePath, input.elementIds);
  const suffix = removedEffects > 0 ? `，並移除 ${removedEffects} 個成員自身的動畫效果` : "";
  return {
    ok: true,
    data: { elementId, removedEffects },
    message: `已將 ${input.slidePath} 的 ${input.elementIds.length} 個元素群組為 ${elementId}${suffix}`,
  };
};
