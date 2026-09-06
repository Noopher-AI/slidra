import type { CommandRegistry } from "../../registry.js";

/**
 * `effect add / remove / move / set / list` ([E2.T7], NOOP-66/#206) — the
 * first-ever write path for `<comot:effects>` (before this ticket, the
 * list was only ever read by `packages/web/src/effects.ts`, or swept
 * along opaquely by `element delete`'s dangling-item cleanup). Same shape
 * as `commands/element/index.ts`: thin `CommandHandler` wrappers over
 * `@co-motion/core`'s workspace functions.
 */

export { effectAddCommand, type EffectAddInput, type EffectAddData } from "./add.js";
export { effectRemoveCommand, type EffectRemoveInput, type EffectRemoveData } from "./remove.js";
export { effectMoveCommand, type EffectMoveInput, type EffectMoveData } from "./move.js";
export { effectSetCommand, type EffectSetInput, type EffectSetData } from "./set.js";
export { effectListCommand, type EffectListInput, type EffectListData } from "./list.js";

import { effectAddCommand } from "./add.js";
import { effectRemoveCommand } from "./remove.js";
import { effectMoveCommand } from "./move.js";
import { effectSetCommand } from "./set.js";
import { effectListCommand } from "./list.js";

export function register(registry: CommandRegistry): void {
  registry.register("effect add", { handler: effectAddCommand, render: null });
  registry.register("effect remove", { handler: effectRemoveCommand, render: null });
  registry.register("effect move", { handler: effectMoveCommand, render: null });
  registry.register("effect set", { handler: effectSetCommand, render: null });
  registry.register("effect list", { handler: effectListCommand, render: null });
}
