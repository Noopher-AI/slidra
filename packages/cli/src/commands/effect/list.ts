import { deriveSteps, listSlideEffects, type Effect, type SlideTransition, type Step } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectListInput {
  id: string;
  slidePath: string;
}
export interface EffectListData {
  effects: Effect[];
  /** [E4.T7]: the step plan this command's `data` now carries so callers
   * (the player, step-by-step export) no longer derive it themselves —
   * `packages/web/src/player-plan.ts`'s former `deriveSteps` call. */
  steps: Step[];
  transition: SlideTransition;
}

export const effectListCommand: CommandHandler<EffectListInput, EffectListData> = async (input) => {
  const { effects, transition } = await listSlideEffects(input.id, input.slidePath);
  // `effect move`/`set`/`remove` take a 1-based index; the core `Effect.index`
  // is 0-based (array position), so translate it here for round-trip use.
  const oneBased = effects.map((effect) => ({ ...effect, index: effect.index + 1 }));
  const steps = deriveSteps(oneBased);
  return {
    ok: true,
    data: { effects: oneBased, steps, transition },
    message: `${input.slidePath} 有 ${effects.length} 個效果項`,
  };
};
