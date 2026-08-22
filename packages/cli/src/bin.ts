import { CoMotionError } from "@co-motion/core";
import { createDefaultRegistry } from "./commands.js";
import { parseArgv } from "./argv.js";

// EPIPE handling for a downstream pipe closing early (e.g.
// `co-motion cat <id> <path> | head`) is installed in
// packages/cli/bin/co-motion.js, not here. That file is the actual
// executable and is never imported by this package's public API (index.ts
// only re-exports `main` from this module) — so importing @co-motion/cli
// can never install a process.stdout listener. Only running the real CLI
// process can reach it.

/**
 * Entry point for the `co-motion` executable. This is the only place in the
 * package allowed to touch process.argv, process.stdout/stderr, and
 * process.exit — everything below the registry stays free of them so a
 * future `co-motion serve` can call the same dispatch directly.
 */
export async function main(argv: string[]): Promise<number> {
  const registry = createDefaultRegistry();

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    printError(error);
    return 1;
  }

  let result;
  try {
    result = await registry.dispatch(parsed.name, parsed.input);
  } catch (error) {
    printError(error);
    return 1;
  }

  if (result.ok) {
    // A command with a registered renderer gets its exact bytes written
    // as-is (no console.log — that would add a newline `cat` never asked
    // for). Everything else keeps the default status-line-plus-JSON shape.
    const renderer = registry.getRenderer(parsed.name);
    if (renderer) {
      process.stdout.write(renderer(result.data));
    } else {
      console.log(result.message);
      if (result.data !== undefined) {
        console.log(JSON.stringify(result.data, null, 2));
      }
    }
    return 0;
  }

  console.error(result.message);
  return 1;
}

function printError(error: unknown): void {
  if (error instanceof CoMotionError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
}
