import { deleteElements } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `co-motion element delete` (#74, AC2/AC3): deletes one or more elements
 * from a single slide in one write, one undo step. Clears any effect entry
 * targeting a deleted element or one of a deleted group's descendants.
 */

export interface ElementDeleteInput {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
  elementIds: string[];
}

export interface ElementDeleteData {
  deleted: string[];
  clearedEffects: number;
}

export const elementDeleteCommand: CommandHandler<ElementDeleteInput, ElementDeleteData> = async (input) => {
  const { deleted, clearedEffects } = await deleteElements(input.id, input.slidePath, input.elementIds);
  return {
    ok: true,
    data: { deleted, clearedEffects },
    message: `已刪除 ${deleted.length} 個元素，並清除 ${clearedEffects} 個效果項`,
  };
};
