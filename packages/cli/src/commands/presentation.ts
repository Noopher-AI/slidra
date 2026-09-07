import { setPresentationCanvas } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

// [E2.T11] removed `presentation transition set`; page transitions are now
// per-slide (`slide transition set`, see ./slide.ts).

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
  registry.register("presentation canvas set", { handler: presentationCanvasSetCommand, render: null });
}
