import { mergeSlideTableCells } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableMergeInput {
  id: string;
  slidePath: string;
  elementId: string;
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  unmerge?: boolean;
}
export type TableMergeData = Record<string, never>;

export const tableMergeCommand: CommandHandler<TableMergeInput, TableMergeData> = async (input) => {
  await mergeSlideTableCells(input.id, input.slidePath, input.elementId, {
    row: input.row,
    col: input.col,
    rowSpan: input.rowSpan,
    colSpan: input.colSpan,
    unmerge: input.unmerge,
  });
  const verb = input.unmerge ? "取消合併" : "合併";
  return { ok: true, data: {}, message: `已${verb} ${input.slidePath} 表格 ${input.elementId} 的儲存格` };
};
