import { CommandRegistry } from "./registry.js";
import { newCommand } from "./commands/new.js";
import { openCommand } from "./commands/open.js";
import { packCommand } from "./commands/pack.js";
import { catCommand, renderCat } from "./commands/cat.js";
import { lsCommand, renderLs } from "./commands/ls.js";
import { textSetCommand } from "./commands/text-set.js";
import { textBoxAddCommand, textBoxWidthCommand } from "./commands/textbox.js";
import { convertCommand } from "./commands/convert.js";
import { undoCommand } from "./commands/undo.js";
import { redoCommand } from "./commands/redo.js";
import {
  elementInsertCommand,
  elementDeleteCommand,
  elementMoveCommand,
  elementScaleCommand,
  elementRotateCommand,
  elementStyleSetCommand,
  elementOrderCommand,
} from "./commands/element.js";

/**
 * Builds the registry that both the one-shot `co-motion` bin and the future
 * `co-motion serve` dispatch on top of (ADR-0002).
 *
 * `cat`/`ls` are the presentation's only read surface. `text set` is the
 * first write command (ticket #3) — every write, like every read, goes
 * through a semantic command, never raw file access (ADR-0002, ADR-0004).
 *
 * Every registration names its `render` explicitly: `null` for the default
 * status-line-plus-JSON output, or a colocated renderer for commands that
 * mimic a Unix tool's raw output. This is the single place a future command
 * author must confront the rendering question — `register`'s `render`
 * field is required, not optional.
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register("new", { handler: newCommand, render: null });
  registry.register("open", { handler: openCommand, render: null });
  registry.register("pack", { handler: packCommand, render: null });
  registry.register("cat", { handler: catCommand, render: renderCat });
  registry.register("ls", { handler: lsCommand, render: renderLs });
  registry.register("text set", { handler: textSetCommand, render: null });
  registry.register("textbox add", { handler: textBoxAddCommand, render: null });
  registry.register("textbox width", { handler: textBoxWidthCommand, render: null });
  registry.register("convert", { handler: convertCommand, render: null });
  registry.register("undo", { handler: undoCommand, render: null });
  registry.register("redo", { handler: redoCommand, render: null });
  registry.register("element insert", { handler: elementInsertCommand, render: null });
  registry.register("element delete", { handler: elementDeleteCommand, render: null });
  registry.register("element move", { handler: elementMoveCommand, render: null });
  registry.register("element scale", { handler: elementScaleCommand, render: null });
  registry.register("element rotate", { handler: elementRotateCommand, render: null });
  registry.register("element style set", { handler: elementStyleSetCommand, render: null });
  registry.register("element order", { handler: elementOrderCommand, render: null });
  return registry;
}
