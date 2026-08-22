import { CoMotionError } from "@co-motion/core";
import { createDefaultRegistry } from "./commands.js";
import { parseArgv } from "./argv.js";

// A downstream pipe closing early (e.g. `co-motion cat <id> <path> | head`)
// makes a later process.stdout.write() fail with EPIPE. Node streams throw
// an unhandled exception for an 'error' event with no listener, which would
// crash the process for what is normal pipeline behaviour, not a real
// failure. Installed once at module load — not inside main() — so calling
// main() repeatedly (e.g. across tests) never registers more than one
// listener on the shared process.stdout.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

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
