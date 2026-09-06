import { ungroupSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementUngroupInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export interface ElementUngroupData {
  /** The dissolved groups' direct children — the GUI reselects these (D2). */
  elementIds: string[];
  /** [E2.T7]: how many effect items were removed because they targeted one of the dissolved groups directly — the GUI surfaces this as a toast. */
  removedEffects: number;
}

export const elementUngroupCommand: CommandHandler<ElementUngroupInput, ElementUngroupData> = async (input) => {
  const { elementIds, removedEffects } = await ungroupSlideElements(input.id, input.slidePath, input.elementIds);
  const suffix = removedEffects > 0 ? `，並移除 ${removedEffects} 個群組動畫效果` : "";
  return {
    ok: true,
    data: { elementIds, removedEffects },
    message: `已解散 ${input.slidePath} 的 ${input.elementIds.length} 個群組${suffix}`,
  };
};
