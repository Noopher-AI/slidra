import { readPresentationFile } from "@co-motion/core";
import type { CommandHandler, CommandRegistry, TerminalRenderer } from "../registry.js";

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

/**
 * `cat` mimics the Unix tool: the file's complete original bytes, and
 * nothing else — no status line, no JSON wrapper, no added or stripped
 * newline (ADR-0004).
 */
export const renderCat: TerminalRenderer<CatData> = (data) => data.content;

export function register(registry: CommandRegistry): void {
  registry.register("cat", { handler: catCommand, render: renderCat });
}
