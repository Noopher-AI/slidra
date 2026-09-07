import { deleteSlideTableColumn } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableColDeleteInput {
  id: string;
  slidePath: string;
  elementId: string;
  at: number;
}
export type TableColDeleteData = Record<string, never>;

export const tableColDeleteCommand: CommandHandler<TableColDeleteInput, TableColDeleteData> = async (input) => {
  await deleteSlideTableColumn(input.id, input.slidePath, input.elementId, input.at);
  return { ok: true, data: {}, message: `已刪除 ${input.slidePath} 表格 ${input.elementId} 的第 ${input.at} 欄` };
};
