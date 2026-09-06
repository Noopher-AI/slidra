import { addSlideEffects, type EffectFamily, type EffectName, type EffectStart } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectAddInput {
  id: string;
  slidePath: string;
  elementIds: string[];
  family: EffectFamily;
  effect: EffectName;
  start?: EffectStart;
  duration?: number;
  delay?: number;
  d?: string;
  index?: number;
}
export type EffectAddData = Record<string, never>;

export const effectAddCommand: CommandHandler<EffectAddInput, EffectAddData> = async (input) => {
  await addSlideEffects(input.id, input.slidePath, input.elementIds, {
    family: input.family,
    effect: input.effect,
    start: input.start,
    duration: input.duration,
    delay: input.delay,
    d: input.d,
    index: input.index,
  });
  return {
    ok: true,
    data: {},
    message: `已在 ${input.slidePath} 為 ${input.elementIds.length} 個元素新增 ${input.family}/${input.effect} 效果`,
  };
};
