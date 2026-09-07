import { setSlideChartLegend, type ChartLegend } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartLegendSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  legend: ChartLegend;
}
export type ChartLegendSetData = Record<string, never>;

export const chartLegendSetCommand: CommandHandler<ChartLegendSetInput, ChartLegendSetData> = async (input) => {
  await setSlideChartLegend(input.id, input.slidePath, input.elementId, input.legend);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的圖例改為 ${input.legend}` };
};
