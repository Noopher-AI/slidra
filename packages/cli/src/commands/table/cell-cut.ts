import { cutTableCells, parseCellRange } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCellCutInput {
  id: string;
  slidePath: string;
  elementId: string;
  /** `r,c:r,c`, parsed by `@co-motion/core`'s `parseCellRange`. */
  range: string;
}
export interface TableCellCutData {
  tsv: string;
}

export const tableCellCutCommand: CommandHandler<TableCellCutInput, TableCellCutData> = async (input) => {
  const { tsv } = await cutTableCells(input.id, input.slidePath, input.elementId, parseCellRange(input.range));
  return { ok: true, data: { tsv }, message: `已剪下 ${input.elementId} 的儲存格範圍 ${input.range}` };
};
