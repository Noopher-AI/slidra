import { setSlideChartOption, type ChartOptionKey } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartOptionSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  key: ChartOptionKey;
  value: string;
}
export type ChartOptionSetData = Record<string, never>;

export const chartOptionSetCommand: CommandHandler<ChartOptionSetInput, ChartOptionSetData> = async (input) => {
  await setSlideChartOption(input.id, input.slidePath, input.elementId, input.key, input.value);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的 ${input.key} 改為 ${input.value}` };
};
