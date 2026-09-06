import { listSlideEffects, type Effect } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectListInput {
  id: string;
  slidePath: string;
}
export interface EffectListData {
  effects: Effect[];
}

export const effectListCommand: CommandHandler<EffectListInput, EffectListData> = async (input) => {
  const effects = await listSlideEffects(input.id, input.slidePath);
  return { ok: true, data: { effects }, message: `${input.slidePath} 有 ${effects.length} 個效果項` };
};
