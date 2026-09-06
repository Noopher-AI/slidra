import { moveSlideEffect } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface EffectMoveInput {
  id: string;
  slidePath: string;
  index: number;
  direction: "up" | "down";
}
export type EffectMoveData = Record<string, never>;

export const effectMoveCommand: CommandHandler<EffectMoveInput, EffectMoveData> = async (input) => {
  await moveSlideEffect(input.id, input.slidePath, input.index, input.direction);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 的第 ${input.index} 個效果項${input.direction === "up" ? "上移" : "下移"}` };
};
