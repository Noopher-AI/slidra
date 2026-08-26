import { addTextBox, setTextBoxWidth } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `co-motion textbox add` / `co-motion textbox width` (#76, W1-R5/W1-R9).
 *
 * AC1 (amended): these two commands are the whole of #76's write surface —
 * `textbox add` creates a text box with a declared width, `textbox width`
 * changes it. Inline typing on the stage is a later unit (#75).
 */

/**
 * `--font-family` defaults to the one font this project bundles (#71):
 * every presentation has it, so a text box created with no `--font-family`
 * never fails to resolve. `--font-size` defaults to 24 user units — a
 * reasonable body-text size on a 1280-wide slide; no ticket or ADR names a
 * default, so this is a judgement call, easily overridden by the flag.
 */
const DEFAULT_FONT_FAMILY = "Noto Sans TC";
const DEFAULT_FONT_SIZE = 24;

export interface TextBoxAddInput {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize?: number;
  fontFamily?: string;
}

export interface TextBoxAddData {
  elementId: string;
  lines: number;
}

export const textBoxAddCommand: CommandHandler<TextBoxAddInput, TextBoxAddData> = async (input) => {
  const { elementId, lines } = await addTextBox(input.id, input.slidePath, {
    x: input.x,
    y: input.y,
    width: input.width,
    text: input.text,
    fontSize: input.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: input.fontFamily ?? DEFAULT_FONT_FAMILY,
  });
  return {
    ok: true,
    data: { elementId, lines },
    message: `已在 ${input.slidePath} 建立文字框 ${elementId}（${lines} 行）`,
  };
};

export interface TextBoxWidthInput {
  id: string;
  slidePath: string;
  elementId: string;
  width: number;
}

export interface TextBoxWidthData {
  lines: number;
}

export const textBoxWidthCommand: CommandHandler<TextBoxWidthInput, TextBoxWidthData> = async (input) => {
  const { lines } = await setTextBoxWidth(input.id, input.slidePath, input.elementId, input.width);
  return {
    ok: true,
    data: { lines },
    message: `已調整 ${input.elementId} 的文字框寬度（重新換行為 ${lines} 行）`,
  };
};
