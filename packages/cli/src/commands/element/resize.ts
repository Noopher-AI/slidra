import { resizeSlideElements, type ResizeAnchor } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementResizeInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  width: number;
  height: number;
  anchor: ResizeAnchor;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementResizeData = Record<string, never>;

export const elementResizeCommand: CommandHandler<ElementResizeInput, ElementResizeData> = async (input) => {
  await resizeSlideElements(input.id, input.slidePath, input.elementIds, input.width, input.height, input.anchor, {
    force: input.force,
  });
  return { ok: true, data: {}, message: `已縮放 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
