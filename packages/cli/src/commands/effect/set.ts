import { setSlideEffect, type EffectName, type EffectStart } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectSetInput {
  id: string;
  slidePath: string;
  index: number;
  effect?: EffectName;
  start?: EffectStart;
  duration?: number;
  delay?: number;
  d?: string;
}
export type EffectSetData = Record<string, never>;

export const effectSetCommand: CommandHandler<EffectSetInput, EffectSetData> = async (input) => {
  await setSlideEffect(input.id, input.slidePath, input.index, {
    effect: input.effect,
    start: input.start,
    duration: input.duration,
    delay: input.delay,
    d: input.d,
  });
  return { ok: true, data: {}, message: `已更新 ${input.slidePath} 的第 ${input.index} 個效果項` };
};
