import { insertSlideTableRow } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableRowInsertInput {
  id: string;
  slidePath: string;
  elementId: string;
  at: number;
}
export type TableRowInsertData = Record<string, never>;

export const tableRowInsertCommand: CommandHandler<TableRowInsertInput, TableRowInsertData> = async (input) => {
  await insertSlideTableRow(input.id, input.slidePath, input.elementId, input.at);
  return { ok: true, data: {}, message: `已在 ${input.slidePath} 表格 ${input.elementId} 第 ${input.at} 列插入新列` };
};
