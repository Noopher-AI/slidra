import { removeSlideEffects } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectRemoveInput {
  id: string;
  slidePath: string;
  indices: number[];
}
export type EffectRemoveData = Record<string, never>;

export const effectRemoveCommand: CommandHandler<EffectRemoveInput, EffectRemoveData> = async (input) => {
  await removeSlideEffects(input.id, input.slidePath, input.indices);
  return { ok: true, data: {}, message: `已移除 ${input.slidePath} 的 ${input.indices.length} 個效果項` };
};
