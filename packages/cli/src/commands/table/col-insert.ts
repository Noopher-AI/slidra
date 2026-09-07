import { insertSlideTableColumn } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableColInsertInput {
  id: string;
  slidePath: string;
  elementId: string;
  at: number;
}
export type TableColInsertData = Record<string, never>;

export const tableColInsertCommand: CommandHandler<TableColInsertInput, TableColInsertData> = async (input) => {
  await insertSlideTableColumn(input.id, input.slidePath, input.elementId, input.at);
  return { ok: true, data: {}, message: `已在 ${input.slidePath} 表格 ${input.elementId} 第 ${input.at} 欄插入新欄` };
};
