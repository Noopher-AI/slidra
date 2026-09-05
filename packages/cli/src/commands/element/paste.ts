import { pasteSlideClipboard } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementPasteInput {
  id: string;
  slidePath: string;
  dx: number;
  dy: number;
}
export interface ElementPasteData {
  elementIds: string[];
}

export const elementPasteCommand: CommandHandler<ElementPasteInput, ElementPasteData> = async (input) => {
  const { elementIds } = await pasteSlideClipboard(input.id, input.slidePath, input.dx, input.dy);
  return { ok: true, data: { elementIds }, message: `已貼上 ${elementIds.length} 個元素到 ${input.slidePath}` };
};
