import { setSlideTable } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  from?: string;
  markdown?: string;
  markdownFile?: string;
}
export type TableSetData = Record<string, never>;

export const tableSetCommand: CommandHandler<TableSetInput, TableSetData> = async (input) => {
  await setSlideTable(input.id, input.slidePath, input.elementId, {
    from: input.from,
    markdown: input.markdown,
    markdownFile: input.markdownFile,
  });
  return { ok: true, data: {}, message: `已重寫 ${input.slidePath} 表格 ${input.elementId} 的內容` };
};
