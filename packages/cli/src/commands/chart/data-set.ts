import { setSlideChartData } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartDataSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  categories?: string[];
  series?: { name: string; values: number[] }[];
  csv?: string;
  csvAsset?: string;
}
export type ChartDataSetData = Record<string, never>;

export const chartDataSetCommand: CommandHandler<ChartDataSetInput, ChartDataSetData> = async (input) => {
  await setSlideChartData(input.id, input.slidePath, input.elementId, {
    categories: input.categories,
    series: input.series,
    csv: input.csv,
    csvAsset: input.csvAsset,
  });
  return { ok: true, data: {}, message: `已更新 ${input.slidePath} 圖表 ${input.elementId} 的資料` };
};
