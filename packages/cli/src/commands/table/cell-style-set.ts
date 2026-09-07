import { setSlideTableCellStyle, type CellStyleAttr } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCellStyleSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  row: number;
  col: number;
  rowEnd?: number;
  colEnd?: number;
  attr: string;
  value: string;
}
export type TableCellStyleSetData = Record<string, never>;

export const tableCellStyleSetCommand: CommandHandler<TableCellStyleSetInput, TableCellStyleSetData> = async (input) => {
  await setSlideTableCellStyle(input.id, input.slidePath, input.elementId, {
    row: input.row,
    col: input.col,
    rowEnd: input.rowEnd,
    colEnd: input.colEnd,
    attr: input.attr as CellStyleAttr,
    value: input.value,
  });
  return { ok: true, data: {}, message: `已更新 ${input.slidePath} 表格 ${input.elementId} 儲存格範圍的 ${input.attr}` };
};
