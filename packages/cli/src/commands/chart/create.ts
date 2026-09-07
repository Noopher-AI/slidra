import { createSlideChart, type ChartPalette, type ChartType } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartCreateInput {
  id: string;
  slidePath: string;
  type?: ChartType;
  seriesCount?: number;
  categoriesCount?: number;
  palette?: ChartPalette;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface ChartCreateData {
  elementId: string;
}

export const chartCreateCommand: CommandHandler<ChartCreateInput, ChartCreateData> = async (input) => {
  const { elementId } = await createSlideChart(input.id, input.slidePath, {
    type: input.type,
    seriesCount: input.seriesCount,
    categoriesCount: input.categoriesCount,
    palette: input.palette,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 新增圖表 ${elementId}` };
};
