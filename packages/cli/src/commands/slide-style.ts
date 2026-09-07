import { setSlidePageStyle } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

/** `co-motion slide style set` (#200 §4.3/§4.4): the slide's Page style — background/accent colour. */

export interface SlideStyleSetInput {
  id: string;
  slidePath: string;
  background?: string;
  accent?: string;
}

export type SlideStyleSetData = Record<string, never>;

export const slideStyleSetCommand: CommandHandler<SlideStyleSetInput, SlideStyleSetData> = async (input) => {
  await setSlidePageStyle(input.id, input.slidePath, { background: input.background, accent: input.accent });
  return { ok: true, data: {}, message: `已設定 ${input.slidePath} 的頁面樣式` };
};

export function register(registry: CommandRegistry): void {
  registry.register("slide style set", { handler: slideStyleSetCommand, render: null });
}
