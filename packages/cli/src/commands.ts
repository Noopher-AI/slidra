import { CommandRegistry } from "./registry.js";
import { newCommand } from "./commands/new.js";
import { openCommand } from "./commands/open.js";
import { packCommand } from "./commands/pack.js";
import { catCommand } from "./commands/cat.js";
import { lsCommand } from "./commands/ls.js";

/**
 * Builds the registry that both the one-shot `co-motion` bin and the future
 * `co-motion serve` dispatch on top of (ADR-0002).
 *
 * `cat`/`ls` are the presentation's only read surface, and there is no
 * write command registered here at all (ADR-0004) — not disabled, absent.
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register("new", newCommand);
  registry.register("open", openCommand);
  registry.register("pack", packCommand);
  registry.register("cat", catCommand);
  registry.register("ls", lsCommand);
  return registry;
}
