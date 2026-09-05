import type { CommandRegistry } from "../../registry.js";

/**
 * `element insert / delete / move / scale / rotate / style set / order /
 * lock / unlock / group / ungroup / align / distribute / name set / copy /
 * cut / paste / duplicate` (#104). Thin CommandHandler wrappers — every one
 * of these just forwards already-parsed input to `@co-motion/core`'s
 * workspace functions and composes the status message; no coordinate math
 * or splicing lives here (see `@co-motion/core`'s `element-edit.ts` for
 * that). Split one sub-command per file; this module re-exports every
 * handler/type the old single `element.ts` used to export, and registers
 * them all.
 */

export { elementInsertCommand, type ElementInsertInput, type ElementInsertData } from "./insert.js";
export { elementDeleteCommand, type ElementDeleteInput, type ElementDeleteData } from "./delete.js";
export { elementMoveCommand, type ElementMoveInput, type ElementMoveData } from "./move.js";
export { elementScaleCommand, type ElementScaleInput, type ElementScaleData } from "./scale.js";
export { elementRotateCommand, type ElementRotateInput, type ElementRotateData } from "./rotate.js";
export { elementStyleSetCommand, type ElementStyleSetInput, type ElementStyleSetData } from "./style-set.js";
export { elementOrderCommand, type ElementOrderInput, type ElementOrderData } from "./order.js";
export { elementLockCommand, type ElementLockInput, type ElementLockData } from "./lock.js";
export { elementUnlockCommand, type ElementUnlockInput, type ElementUnlockData } from "./unlock.js";
export { elementGroupCommand, type ElementGroupInput, type ElementGroupData } from "./group.js";
export { elementUngroupCommand, type ElementUngroupInput, type ElementUngroupData } from "./ungroup.js";
export { elementAlignCommand, type ElementAlignInput, type ElementAlignData } from "./align.js";
export { elementDistributeCommand, type ElementDistributeInput, type ElementDistributeData } from "./distribute.js";
export { elementNameSetCommand, type ElementNameSetInput, type ElementNameSetData } from "./name-set.js";
export { elementCopyCommand, type ElementCopyInput, type ElementCopyData } from "./copy.js";
export { elementCutCommand, type ElementCutInput, type ElementCutData } from "./cut.js";
export { elementPasteCommand, type ElementPasteInput, type ElementPasteData } from "./paste.js";
export { elementDuplicateCommand, type ElementDuplicateInput, type ElementDuplicateData } from "./duplicate.js";

import { elementInsertCommand } from "./insert.js";
import { elementDeleteCommand } from "./delete.js";
import { elementMoveCommand } from "./move.js";
import { elementScaleCommand } from "./scale.js";
import { elementRotateCommand } from "./rotate.js";
import { elementStyleSetCommand } from "./style-set.js";
import { elementOrderCommand } from "./order.js";
import { elementLockCommand } from "./lock.js";
import { elementUnlockCommand } from "./unlock.js";
import { elementGroupCommand } from "./group.js";
import { elementUngroupCommand } from "./ungroup.js";
import { elementAlignCommand } from "./align.js";
import { elementDistributeCommand } from "./distribute.js";
import { elementNameSetCommand } from "./name-set.js";
import { elementCopyCommand } from "./copy.js";
import { elementCutCommand } from "./cut.js";
import { elementPasteCommand } from "./paste.js";
import { elementDuplicateCommand } from "./duplicate.js";

export function register(registry: CommandRegistry): void {
  registry.register("element insert", { handler: elementInsertCommand, render: null });
  registry.register("element delete", { handler: elementDeleteCommand, render: null });
  registry.register("element move", { handler: elementMoveCommand, render: null });
  registry.register("element scale", { handler: elementScaleCommand, render: null });
  registry.register("element rotate", { handler: elementRotateCommand, render: null });
  registry.register("element style set", { handler: elementStyleSetCommand, render: null });
  registry.register("element order", { handler: elementOrderCommand, render: null });
  registry.register("element group", { handler: elementGroupCommand, render: null });
  registry.register("element ungroup", { handler: elementUngroupCommand, render: null });
  registry.register("element align", { handler: elementAlignCommand, render: null });
  registry.register("element distribute", { handler: elementDistributeCommand, render: null });
  registry.register("element name set", { handler: elementNameSetCommand, render: null });
  registry.register("element copy", { handler: elementCopyCommand, render: null });
  registry.register("element cut", { handler: elementCutCommand, render: null });
  registry.register("element paste", { handler: elementPasteCommand, render: null });
  registry.register("element duplicate", { handler: elementDuplicateCommand, render: null });
  registry.register("element lock", { handler: elementLockCommand, render: null });
  registry.register("element unlock", { handler: elementUnlockCommand, render: null });
}
