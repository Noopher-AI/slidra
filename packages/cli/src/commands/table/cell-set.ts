import { setSlideTableCellText } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCellSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  row: number;
  col: number;
  text: string;
}
export type TableCellSetData = Record<string, never>;

export const tableCellSetCommand: CommandHandler<TableCellSetInput, TableCellSetData> = async (input) => {
  await setSlideTableCellText(input.id, input.slidePath, input.elementId, input.row, input.col, input.text);
  return { ok: true, data: {}, message: `已更新 ${input.slidePath} 表格 ${input.elementId} 儲存格 (${input.row},${input.col})` };
};
