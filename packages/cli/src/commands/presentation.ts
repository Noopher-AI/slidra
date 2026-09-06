import { setTransition, setPresentationCanvas } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

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

/**
 * `presentation canvas set` (#200 §4.3): resizes the page. Deliberately
 * never occupies an undo step (`setPresentationCanvas`'s own doc comment) —
 * the acceptance criteria's one named exception to "Undo 可回退".
 */
export interface PresentationCanvasSetInput {
  id: string;
  width: number;
  height: number;
}
export interface PresentationCanvasSetData {
  width: number;
  height: number;
}

export const presentationCanvasSetCommand: CommandHandler<PresentationCanvasSetInput, PresentationCanvasSetData> = async (
  input,
) => {
  const { width, height } = await setPresentationCanvas(input.id, input.width, input.height);
  return { ok: true, data: { width, height }, message: `已設定頁面尺寸為 ${width}×${height}` };
};

export function register(registry: CommandRegistry): void {
  registry.register("presentation transition set", { handler: presentationTransitionSetCommand, render: null });
  registry.register("presentation canvas set", { handler: presentationCanvasSetCommand, render: null });
}
