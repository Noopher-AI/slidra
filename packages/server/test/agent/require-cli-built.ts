import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Throws before any server starts if the Rust `slidra` binary is
 * missing — these tests shell out to the built `slidra` CLI (multi-
 * command fake ACP fixture), and a missing binary produces 30s
 * `waitForLog` timeouts instead of a readable failure (the dependency
 * was switched from the TypeScript CLI bundle to the Rust release binary).
 */
export async function requireCliBuilt(): Promise<void> {
  const binPath = path.join(rootDir, "target/release/slidra");
  try {
    await access(binPath);
  } catch {
    throw new Error("target/release/slidra does not exist, run npm run build first");
  }
}
