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
  // `effect move`/`set`/`remove` take a 1-based index; the core `Effect.index`
  // is 0-based (array position), so translate it here for round-trip use.
  const oneBased = effects.map((effect) => ({ ...effect, index: effect.index + 1 }));
  return { ok: true, data: { effects: oneBased }, message: `${input.slidePath} 有 ${effects.length} 個效果項` };
};
