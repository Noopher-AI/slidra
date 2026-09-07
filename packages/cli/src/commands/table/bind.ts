import { bindSlideTableSource } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableBindInput {
  id: string;
  slidePath: string;
  elementId: string;
  source: string;
  templateRow?: number;
}
export type TableBindData = Record<string, never>;

export const tableBindCommand: CommandHandler<TableBindInput, TableBindData> = async (input) => {
  await bindSlideTableSource(input.id, input.slidePath, input.elementId, input.source, input.templateRow);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 表格 ${input.elementId} 綁定到 ${input.source}` };
};
