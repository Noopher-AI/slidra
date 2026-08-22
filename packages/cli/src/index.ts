export { CommandRegistry, UnknownCommandError } from "./registry.js";
export type { CommandFailureKind, CommandHandler, CommandResult } from "./registry.js";
export { createDefaultRegistry } from "./commands.js";
export { parseArgv } from "./argv.js";
export type { ParsedCommand } from "./argv.js";
export { main } from "./bin.js";
