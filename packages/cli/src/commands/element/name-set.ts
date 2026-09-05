import { setSlideElementName } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementNameSetInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  name: string;
}
export type ElementNameSetData = Record<string, never>;

export const elementNameSetCommand: CommandHandler<ElementNameSetInput, ElementNameSetData> = async (input) => {
  await setSlideElementName(input.id, input.slidePath, input.elementIds, input.name);
  return { ok: true, data: {}, message: `已設定 ${input.slidePath} 的 ${input.elementIds.length} 個元素的顯示名稱` };
};
