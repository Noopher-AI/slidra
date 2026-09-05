import { reorderSlideElements, type OrderDirection } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementOrderInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  direction: OrderDirection;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementOrderData = Record<string, never>;

export const elementOrderCommand: CommandHandler<ElementOrderInput, ElementOrderData> = async (input) => {
  await reorderSlideElements(input.id, input.slidePath, input.elementIds, input.direction, { force: input.force });
  return { ok: true, data: {}, message: `已調整 ${input.slidePath} 的 ${input.elementIds.length} 個元素的疊置順序` };
};
