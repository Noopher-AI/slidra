import { access, constants } from "node:fs/promises";
import path from "node:path";
import { ADAPTER_SPECS, type AdapterSpec } from "./adapters.js";

/**
 * Checks whether an executable named `command` is reachable on PATH.
 * Injected everywhere detection happens so tests never depend on what
 * happens to be installed on the machine running the suite — the same
 * injection point lets tests report an adapter as "present" and point its
 * spawn at the fake ACP agent fixture instead of a real one.
 */
export type CommandExists = (command: string) => Promise<boolean>;

/**
 * Real, PATH-scanning implementation. Checks each directory in `PATH` for
 * an executable file named `command`, exactly the lookup `child_process`
 * itself performs when spawning by bare command name — so "detected" and
 * "spawnable" never disagree.
 */
export const commandExistsOnPath: CommandExists = async (command) => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      await access(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not in this directory — keep looking.
    }
  }
  return false;
};

/**
 * Probes for both known adapters and returns the ones that are present.
 * Detection runs once, at `serve` startup (§3): failures must be loud and
 * early, never discovered lazily on the first chat message.
 */
export async function detectAdapters(commandExists: CommandExists): Promise<AdapterSpec[]> {
  const present: AdapterSpec[] = [];
  for (const spec of ADAPTER_SPECS) {
    if (await commandExists(spec.command)) {
      present.push(spec);
    }
  }
  return present;
}
