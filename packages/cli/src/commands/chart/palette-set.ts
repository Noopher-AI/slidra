import { setSlideChartPalette, type ChartPalette } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ChartPaletteSetInput {
  id: string;
  slidePath: string;
  elementId: string;
  palette: ChartPalette;
  colors: { name: string; color: string }[];
}
export type ChartPaletteSetData = Record<string, never>;

export const chartPaletteSetCommand: CommandHandler<ChartPaletteSetInput, ChartPaletteSetData> = async (input) => {
  const colorOverrides = new Map(input.colors.map((c) => [c.name, c.color]));
  await setSlideChartPalette(input.id, input.slidePath, input.elementId, input.palette, colorOverrides);
  return { ok: true, data: {}, message: `已將 ${input.slidePath} 圖表 ${input.elementId} 的調色盤改為 ${input.palette}` };
};
