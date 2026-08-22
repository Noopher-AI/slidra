import { readPresentationFile } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

export interface CatInput {
  id: string;
  /** Virtual path, e.g. "project.json" or "slides/001.svg". */
  path: string;
}

export interface CatData {
  content: string;
}

export const catCommand: CommandHandler<CatInput, CatData> = async (input) => {
  const content = await readPresentationFile(input.id, input.path);
  return {
    ok: true,
    data: { content },
    message: `已讀取：${input.path}`,
  };
};
