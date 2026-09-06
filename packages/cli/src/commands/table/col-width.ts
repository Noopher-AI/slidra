import { setSlideTableColWidth } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableColWidthInput {
  id: string;
  slidePath: string;
  elementId: string;
  col: number;
  width: number;
}
export type TableColWidthData = Record<string, never>;

export const tableColWidthCommand: CommandHandler<TableColWidthInput, TableColWidthData> = async (input) => {
  await setSlideTableColWidth(input.id, input.slidePath, input.elementId, input.col, input.width);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 表格 ${input.elementId} 第 ${input.col} 欄寬度改為 ${input.width}` };
};
