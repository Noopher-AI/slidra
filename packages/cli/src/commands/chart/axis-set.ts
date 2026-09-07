import { setSlideChartAxis, type ChartAxesMode } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartAxisSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  axes: ChartAxesMode;
  right: string[];
}
export type ChartAxisSetData = Record<string, never>;

export const chartAxisSetCommand: CommandHandler<ChartAxisSetInput, ChartAxisSetData> = async (input) => {
  await setSlideChartAxis(input.id, input.slidePath, input.elementId, input.axes, input.right);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的軸改為 ${input.axes}` };
};
