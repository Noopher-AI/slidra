import { createSlideTable, type TableTheme } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCreateInput {
  id: string;
  slidePath: string;
  rows: number;
  cols: number;
  x: number;
  y: number;
  colWidth?: number;
  theme?: string;
  header?: boolean;
}
export interface TableCreateData {
  elementId: string;
}

export const tableCreateCommand: CommandHandler<TableCreateInput, TableCreateData> = async (input) => {
  const { elementId } = await createSlideTable(input.id, input.slidePath, {
    rows: input.rows,
    cols: input.cols,
    x: input.x,
    y: input.y,
    colWidth: input.colWidth,
    theme: input.theme as TableTheme | undefined,
    header: input.header,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 新增表格 ${elementId}` };
};
