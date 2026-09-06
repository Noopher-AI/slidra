import type { CommandRegistry } from "../../registry.js";

/**
 * `table cell copy / cut / paste` ([E2.T18], soft dependency on [E2.T14]/#203's
 * table container shape). Deliberately only these three commands — the rest
 * of the `table` family (`create`／`cell set`／`merge`／`col width`／`theme
 * set`／`header set`／`bind`／`refresh`／`set`) is [E2.T14]'s; registering
 * them here would collide with that ticket's own `table` command file when
 * both land, so this module only ever owns the `table cell *` names.
 */

export { tableCellCopyCommand, type TableCellCopyInput, type TableCellCopyData } from "./cell-copy.js";
export { tableCellCutCommand, type TableCellCutInput, type TableCellCutData } from "./cell-cut.js";
export { tableCellPasteCommand, type TableCellPasteInput, type TableCellPasteData } from "./cell-paste.js";

import { tableCellCopyCommand } from "./cell-copy.js";
import { tableCellCutCommand } from "./cell-cut.js";
import { tableCellPasteCommand } from "./cell-paste.js";

export function register(registry: CommandRegistry): void {
  registry.register("table cell copy", { handler: tableCellCopyCommand, render: null });
  registry.register("table cell cut", { handler: tableCellCutCommand, render: null });
  registry.register("table cell paste", { handler: tableCellPasteCommand, render: null });
}
