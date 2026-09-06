import { copySlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementCopyInput {
  id: string;
  slidePath: string;
  elementIds: string[];
}
export interface ElementCopyData {
  /** The system-clipboard exchange-format string this copy produced ([E2.T18] 決定 2) — the same thing a GUI ⌘C would write to `navigator.clipboard`. */
  svg: string;
}

export const elementCopyCommand: CommandHandler<ElementCopyInput, ElementCopyData> = async (input) => {
  const { svg } = await copySlideElements(input.id, input.slidePath, input.elementIds);
  return { ok: true, data: { svg }, message: `已複製 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
