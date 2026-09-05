import { listPresentationEntries } from "@co-motion/core";
import type { CommandHandler, CommandRegistry, TerminalRenderer } from "../registry.js";

export interface LsInput {
  id: string;
  /** Virtual directory path. Omitted (or undefined) lists the top level. */
  path?: string;
}

export interface LsData {
  entries: string[];
}

export const lsCommand: CommandHandler<LsInput, LsData> = async (input) => {
  const entries = await listPresentationEntries(input.id, input.path);
  return {
    ok: true,
    data: { entries },
    message: `共 ${entries.length} 個項目`,
  };
};

/**
 * `ls` mimics the Unix tool: one entry name per line, nothing else — no
 * count, no summary, no JSON (ADR-0004).
 */
export const renderLs: TerminalRenderer<LsData> = (data) =>
  data.entries.map((entry) => `${entry}\n`).join("");

export function register(registry: CommandRegistry): void {
  registry.register("ls", { handler: lsCommand, render: renderLs });
}
