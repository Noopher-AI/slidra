import { CommandRegistry } from "./registry.js";
import { register as registerNew } from "./commands/new.js";
import { register as registerOpen } from "./commands/open.js";
import { register as registerPack } from "./commands/pack.js";
import { register as registerCat } from "./commands/cat.js";
import { register as registerLs } from "./commands/ls.js";
import { register as registerTextSet } from "./commands/text-set.js";
import { register as registerTextStyle } from "./commands/text-style.js";
import { register as registerTextList } from "./commands/text-list.js";
import { register as registerTextbox } from "./commands/textbox.js";
import { register as registerConvert } from "./commands/convert.js";
import { register as registerUndo } from "./commands/undo.js";
import { register as registerRedo } from "./commands/redo.js";
import { register as registerElement } from "./commands/element/index.js";
import { register as registerSlideRender } from "./commands/slide-render.js";
import { register as registerAssetImport } from "./commands/asset-import.js";
import { register as registerSlide } from "./commands/slide.js";
import { register as registerTemplate } from "./commands/template.js";
import { register as registerPresentation } from "./commands/presentation.js";
import { register as registerComment } from "./commands/comment.js";

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
 *
 * Each command family owns its own `register(registry)` function,
 * colocated with its handlers in `./commands/<family>.ts` (or
 * `./commands/element/index.ts` for the many-sub-command `element` family)
 * — this function just runs all of them against one registry.
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const register of [
    registerNew,
    registerOpen,
    registerPack,
    registerCat,
    registerLs,
    registerTextSet,
    registerTextStyle,
    registerTextList,
    registerTextbox,
    registerConvert,
    registerUndo,
    registerRedo,
    registerElement,
    registerSlideRender,
    registerAssetImport,
    registerSlide,
    registerTemplate,
    registerPresentation,
    registerComment,
  ]) {
    register(registry);
  }
  return registry;
}
