import { copyTableCells, parseCellRange } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCellCopyInput {
  id: string;
  slidePath: string;
  elementId: string;
  /** `r,c:r,c`, parsed by `@co-motion/core`'s `parseCellRange`. */
  range: string;
}
export interface TableCellCopyData {
  tsv: string;
}

export const tableCellCopyCommand: CommandHandler<TableCellCopyInput, TableCellCopyData> = async (input) => {
  const { tsv } = await copyTableCells(input.id, input.slidePath, input.elementId, parseCellRange(input.range));
  return { ok: true, data: { tsv }, message: `已複製 ${input.elementId} 的儲存格範圍 ${input.range}` };
};
