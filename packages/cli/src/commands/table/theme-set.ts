import { setSlideTableTheme, type TableTheme } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableThemeSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  theme: string;
}
export type TableThemeSetData = Record<string, never>;

export const tableThemeSetCommand: CommandHandler<TableThemeSetInput, TableThemeSetData> = async (input) => {
  await setSlideTableTheme(input.id, input.slidePath, input.elementId, input.theme as TableTheme);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 表格 ${input.elementId} 的主題改為 ${input.theme}` };
};
