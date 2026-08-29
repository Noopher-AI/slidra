import { setTransition } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/** `presentation transition set` (T3): stores the presentation's slide transition — this ticket does not play it back. */

export interface PresentationTransitionSetInput {
  id: string;
  name: string;
}
export type PresentationTransitionSetData = Record<string, never>;

export const presentationTransitionSetCommand: CommandHandler<
  PresentationTransitionSetInput,
  PresentationTransitionSetData
> = async (input) => {
  await setTransition(input.id, input.name);
  return { ok: true, data: {}, message: `已設定轉場效果為 ${input.name}` };
};
