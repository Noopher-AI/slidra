import type { CommandRegistry } from "../../registry.js";

/**
 * `chart create / data set / type set / palette set / axis set / stack
 * set / legend set / option set` (E2.T12, #204) — same shape as
 * `commands/effect/index.ts`: thin `CommandHandler` wrappers over
 * `@co-motion/core`'s workspace functions. Every write re-derives the
 * whole `<comot:chart>`, patches it, and re-renders the embedded `<svg>`
 * (`chart/edit.ts`) — the GUI never writes the `<svg>` half directly.
 */

export { chartCreateCommand, type ChartCreateInput, type ChartCreateData } from "./create.js";
export { chartDataSetCommand, type ChartDataSetInput, type ChartDataSetData } from "./data-set.js";
export { chartTypeSetCommand, type ChartTypeSetInput, type ChartTypeSetData } from "./type-set.js";
export { chartPaletteSetCommand, type ChartPaletteSetInput, type ChartPaletteSetData } from "./palette-set.js";
export { chartAxisSetCommand, type ChartAxisSetInput, type ChartAxisSetData } from "./axis-set.js";
export { chartStackSetCommand, type ChartStackSetInput, type ChartStackSetData } from "./stack-set.js";
export { chartLegendSetCommand, type ChartLegendSetInput, type ChartLegendSetData } from "./legend-set.js";
export { chartOptionSetCommand, type ChartOptionSetInput, type ChartOptionSetData } from "./option-set.js";

import { chartCreateCommand } from "./create.js";
import { chartDataSetCommand } from "./data-set.js";
import { chartTypeSetCommand } from "./type-set.js";
import { chartPaletteSetCommand } from "./palette-set.js";
import { chartAxisSetCommand } from "./axis-set.js";
import { chartStackSetCommand } from "./stack-set.js";
import { chartLegendSetCommand } from "./legend-set.js";
import { chartOptionSetCommand } from "./option-set.js";

export function register(registry: CommandRegistry): void {
  registry.register("chart create", { handler: chartCreateCommand, render: null });
  registry.register("chart data set", { handler: chartDataSetCommand, render: null });
  registry.register("chart type set", { handler: chartTypeSetCommand, render: null });
  registry.register("chart palette set", { handler: chartPaletteSetCommand, render: null });
  registry.register("chart axis set", { handler: chartAxisSetCommand, render: null });
  registry.register("chart stack set", { handler: chartStackSetCommand, render: null });
  registry.register("chart legend set", { handler: chartLegendSetCommand, render: null });
  registry.register("chart option set", { handler: chartOptionSetCommand, render: null });
}
