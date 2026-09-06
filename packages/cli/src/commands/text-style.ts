import { setSlideTextRunStyle } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

/**
 * `co-motion text style set` (NOOP-65 §4.2). Sets or clears
 * `font-weight`/`font-style` over a half-open `[rangeStart, rangeEnd)`
 * character range of a text box's content string.
 */
export interface TextStyleSetInput {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
  elementId: string;
  rangeStart: number;
  rangeEnd: number;
  /** `"normal"` clears the attribute; `undefined` (flag absent) leaves it untouched. */
  fontWeight?: string;
  /** `"normal"` clears the attribute; `undefined` (flag absent) leaves it untouched. */
  fontStyle?: string;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}

export interface TextStyleSetData {
  runs: number;
}

export const textStyleSetCommand: CommandHandler<TextStyleSetInput, TextStyleSetData> = async (input) => {
  const { runs } = await setSlideTextRunStyle(
    input.id,
    input.slidePath,
    input.elementId,
    input.rangeStart,
    input.rangeEnd,
    { fontWeight: input.fontWeight, fontStyle: input.fontStyle },
    { force: input.force },
  );
  return {
    ok: true,
    data: { runs },
    message: `已設定 ${input.elementId} 第 ${input.rangeStart}–${input.rangeEnd} 個字元的樣式（${runs} 個片段）`,
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("text style set", { handler: textStyleSetCommand, render: null });
}
