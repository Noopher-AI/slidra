import { setSlideChartType, type ChartType } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartTypeSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  type: ChartType;
}
export type ChartTypeSetData = Record<string, never>;

export const chartTypeSetCommand: CommandHandler<ChartTypeSetInput, ChartTypeSetData> = async (input) => {
  await setSlideChartType(input.id, input.slidePath, input.elementId, input.type);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的類型改為 ${input.type}` };
};
