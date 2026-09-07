import { setSlideChartStack } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartStackSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  stacked: boolean;
}
export type ChartStackSetData = Record<string, never>;

export const chartStackSetCommand: CommandHandler<ChartStackSetInput, ChartStackSetData> = async (input) => {
  await setSlideChartStack(input.id, input.slidePath, input.elementId, input.stacked);
  return {
    ok: true,
    data: {},
    message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的堆疊${input.stacked ? "開啟" : "關閉"}`,
  };
};
