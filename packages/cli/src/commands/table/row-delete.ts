import { deleteSlideTableRow } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableRowDeleteInput {
  id: string;
  slidePath: string;
  elementId: string;
  at: number;
}
export type TableRowDeleteData = Record<string, never>;

export const tableRowDeleteCommand: CommandHandler<TableRowDeleteInput, TableRowDeleteData> = async (input) => {
  await deleteSlideTableRow(input.id, input.slidePath, input.elementId, input.at);
  return { ok: true, data: {}, message: `已刪除 ${input.slidePath} 表格 ${input.elementId} 的第 ${input.at} 列` };
};
