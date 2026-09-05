import { moveSlideElements } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementMoveInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  dx: number;
  dy: number;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementMoveData = Record<string, never>;

export const elementMoveCommand: CommandHandler<ElementMoveInput, ElementMoveData> = async (input) => {
  await moveSlideElements(input.id, input.slidePath, input.elementIds, input.dx, input.dy, { force: input.force });
  return { ok: true, data: {}, message: `已搬移 ${input.slidePath} 的 ${input.elementIds.length} 個元素` };
};
