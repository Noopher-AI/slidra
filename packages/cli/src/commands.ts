import { CommandRegistry } from "./registry.js";
import { newCommand } from "./commands/new.js";
import { openCommand } from "./commands/open.js";
import { packCommand } from "./commands/pack.js";
import { readCommand } from "./commands/read.js";
import { listCommand } from "./commands/list.js";

/**
 * Builds the registry that both the one-shot `co-motion` bin and the future
 * `co-motion serve` dispatch on top of (ADR-0002).
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register("new", newCommand);
  registry.register("open", openCommand);
  registry.register("pack", packCommand);
  registry.register("read", readCommand);
  registry.register("list", listCommand);
  return registry;
}
