import { CoMotionError } from "@co-motion/core";
import { createDefaultRegistry } from "./commands.js";
import { parseArgv } from "./argv.js";

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
    console.log(result.message);
    if (result.data !== undefined) {
      console.log(JSON.stringify(result.data, null, 2));
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
