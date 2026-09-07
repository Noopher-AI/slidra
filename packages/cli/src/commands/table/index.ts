import type { CommandRegistry } from "../../registry.js";

/**
 * `table create / cell set / cell style set / merge / col width / col
 * insert / col delete / row insert / row delete / theme set / header set /
 * bind / refresh / set` (E2.T14, #203) — same shape as
 * `commands/chart/index.ts`/`commands/effect/index.ts`: thin
 * `CommandHandler` wrappers over `@co-motion/core`'s workspace functions.
 * Every write re-derives the whole `TableModel`, patches it, and
 * re-renders the whole container (`table/edit.ts`) — the GUI never writes
 * table markup directly.
 *
 * `table cell copy / cut / paste` ([E2.T18]) live alongside them: the
 * cell-range clipboard commands over the same table container shape.
 */

export { tableCreateCommand, type TableCreateInput, type TableCreateData } from "./create.js";
export { tableCellSetCommand, type TableCellSetInput, type TableCellSetData } from "./cell-set.js";
export { tableCellStyleSetCommand, type TableCellStyleSetInput, type TableCellStyleSetData } from "./cell-style-set.js";
export { tableMergeCommand, type TableMergeInput, type TableMergeData } from "./merge.js";
export { tableColWidthCommand, type TableColWidthInput, type TableColWidthData } from "./col-width.js";
export { tableColInsertCommand, type TableColInsertInput, type TableColInsertData } from "./col-insert.js";
export { tableColDeleteCommand, type TableColDeleteInput, type TableColDeleteData } from "./col-delete.js";
export { tableRowInsertCommand, type TableRowInsertInput, type TableRowInsertData } from "./row-insert.js";
export { tableRowDeleteCommand, type TableRowDeleteInput, type TableRowDeleteData } from "./row-delete.js";
export { tableThemeSetCommand, type TableThemeSetInput, type TableThemeSetData } from "./theme-set.js";
export { tableHeaderSetCommand, type TableHeaderSetInput, type TableHeaderSetData } from "./header-set.js";
export { tableBindCommand, type TableBindInput, type TableBindData } from "./bind.js";
export { tableRefreshCommand, type TableRefreshInput, type TableRefreshData } from "./refresh.js";
export { tableSetCommand, type TableSetInput, type TableSetData } from "./set.js";
export { tableCellCopyCommand, type TableCellCopyInput, type TableCellCopyData } from "./cell-copy.js";
export { tableCellCutCommand, type TableCellCutInput, type TableCellCutData } from "./cell-cut.js";
export { tableCellPasteCommand, type TableCellPasteInput, type TableCellPasteData } from "./cell-paste.js";

import { tableCreateCommand } from "./create.js";
import { tableCellSetCommand } from "./cell-set.js";
import { tableCellStyleSetCommand } from "./cell-style-set.js";
import { tableMergeCommand } from "./merge.js";
import { tableColWidthCommand } from "./col-width.js";
import { tableColInsertCommand } from "./col-insert.js";
import { tableColDeleteCommand } from "./col-delete.js";
import { tableRowInsertCommand } from "./row-insert.js";
import { tableRowDeleteCommand } from "./row-delete.js";
import { tableThemeSetCommand } from "./theme-set.js";
import { tableHeaderSetCommand } from "./header-set.js";
import { tableBindCommand } from "./bind.js";
import { tableRefreshCommand } from "./refresh.js";
import { tableSetCommand } from "./set.js";
import { tableCellCopyCommand } from "./cell-copy.js";
import { tableCellCutCommand } from "./cell-cut.js";
import { tableCellPasteCommand } from "./cell-paste.js";

export function register(registry: CommandRegistry): void {
  registry.register("table create", { handler: tableCreateCommand, render: null });
  registry.register("table cell set", { handler: tableCellSetCommand, render: null });
  registry.register("table cell style set", { handler: tableCellStyleSetCommand, render: null });
  registry.register("table merge", { handler: tableMergeCommand, render: null });
  registry.register("table col width", { handler: tableColWidthCommand, render: null });
  registry.register("table col insert", { handler: tableColInsertCommand, render: null });
  registry.register("table col delete", { handler: tableColDeleteCommand, render: null });
  registry.register("table row insert", { handler: tableRowInsertCommand, render: null });
  registry.register("table row delete", { handler: tableRowDeleteCommand, render: null });
  registry.register("table theme set", { handler: tableThemeSetCommand, render: null });
  registry.register("table header set", { handler: tableHeaderSetCommand, render: null });
  registry.register("table bind", { handler: tableBindCommand, render: null });
  registry.register("table refresh", { handler: tableRefreshCommand, render: null });
  registry.register("table set", { handler: tableSetCommand, render: null });
  registry.register("table cell copy", { handler: tableCellCopyCommand, render: null });
  registry.register("table cell cut", { handler: tableCellCutCommand, render: null });
  registry.register("table cell paste", { handler: tableCellPasteCommand, render: null });
}
