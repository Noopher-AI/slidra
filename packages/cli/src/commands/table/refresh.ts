import { refreshSlideTableSource } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableRefreshInput {
  id: string;
  slidePath: string;
  elementId: string;
}
export type TableRefreshData = Record<string, never>;

export const tableRefreshCommand: CommandHandler<TableRefreshInput, TableRefreshData> = async (input) => {
  await refreshSlideTableSource(input.id, input.slidePath, input.elementId);
  return { ok: true, data: {}, message: `已重新展開 ${input.slidePath} 表格 ${input.elementId} 的綁定資料` };
};
