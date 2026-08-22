import { readPresentationFile } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

export interface ReadInput {
  id: string;
  /** Container-relative virtual path, e.g. "project.json" or "slides/001.svg". */
  path: string;
}

export interface ReadData {
  content: string;
}

export const readCommand: CommandHandler<ReadInput, ReadData> = async (input) => {
  const content = await readPresentationFile(input.id, input.path);
  return {
    ok: true,
    data: { content },
    message: `已讀取：${input.path}`,
  };
};
