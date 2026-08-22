import { listPresentationFiles } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

export interface ListInput {
  id: string;
}

export interface ListData {
  files: string[];
}

export const listCommand: CommandHandler<ListInput, ListData> = async (input) => {
  const files = await listPresentationFiles(input.id);
  return {
    ok: true,
    data: { files },
    message: `共 ${files.length} 個檔案`,
  };
};
