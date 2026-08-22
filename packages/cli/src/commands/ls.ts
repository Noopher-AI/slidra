import { listPresentationEntries } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

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
