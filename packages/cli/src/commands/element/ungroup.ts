import { ungroupSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementUngroupInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export type ElementUngroupData = Record<string, never>;

export const elementUngroupCommand: CommandHandler<ElementUngroupInput, ElementUngroupData> = async (input) => {
  await ungroupSlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: {}, message: `已解散 ${input.slidePath} 的 ${input.elementIds.length} 個群組` };
};
