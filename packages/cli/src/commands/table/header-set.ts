import { setSlideTableHeader } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableHeaderSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  header: boolean;
}
export type TableHeaderSetData = Record<string, never>;

export const tableHeaderSetCommand: CommandHandler<TableHeaderSetInput, TableHeaderSetData> = async (input) => {
  await setSlideTableHeader(input.id, input.slidePath, input.elementId, input.header);
  return {
    ok: true,
    data: {},
    message: `已將 ${input.slidePath} 表格 ${input.elementId} 的表頭${input.header ? "開啟" : "關閉"}`,
  };
};
