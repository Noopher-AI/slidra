import { readFile } from "node:fs/promises";
import { CoMotionError, pasteSlideClipboard } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementPasteInput {
  id: string;
  slidePath: string;
  dx: number;
  dy: number;
  /** A system-clipboard exchange-format string ([E2.T18] 決定 2 — the GUI's own ⌘V sends this). When given, pastes this directly and never touches the presentation's internal clipboard file. */
  svg?: string;
  /** CLI-only: a local filesystem path to read `svg` from (`--svg-file`). Mutually redundant with `svg` — when both are given, `svg` wins. */
  svgFile?: string;
}
export interface ElementPasteData {
  elementIds: string[];
}

export const elementPasteCommand: CommandHandler<ElementPasteInput, ElementPasteData> = async (input) => {
  const svg = input.svg ?? (input.svgFile !== undefined ? await readSvgFile(input.svgFile) : undefined);
  const { elementIds } = await pasteSlideClipboard(input.id, input.slidePath, input.dx, input.dy, svg);
  return { ok: true, data: { elementIds }, message: `已貼上 ${elementIds.length} 個元素到 ${input.slidePath}` };
};

async function readSvgFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    throw new CoMotionError(`找不到來源檔案：${filePath}`);
  }
}
