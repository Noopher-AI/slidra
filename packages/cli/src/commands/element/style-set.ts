import { setSlideElementStyle } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementStyleSetInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  attr: string;
  value: string;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}
export type ElementStyleSetData = Record<string, never>;

export const elementStyleSetCommand: CommandHandler<ElementStyleSetInput, ElementStyleSetData> = async (input) => {
  await setSlideElementStyle(input.id, input.slidePath, input.elementIds, input.attr, input.value, {
    force: input.force,
  });
  return {
    ok: true,
    data: {},
    message: `已設定 ${input.slidePath} 的 ${input.elementIds.length} 個元素的 ${input.attr}`,
  };
};
