import { setElementText } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

export interface TextSetInput {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
  elementId: string;
  newText: string;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}

export type TextSetData = Record<string, never>;

export const textSetCommand: CommandHandler<TextSetInput, TextSetData> = async (input) => {
  await setElementText(input.id, input.slidePath, input.elementId, input.newText, { force: input.force });
  return {
    ok: true,
    data: {},
    message: `已更新 ${input.slidePath} 的元素 ${input.elementId}`,
  };
};
