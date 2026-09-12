import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Throws before any server starts if the Rust `comotion` binary is
 * missing — these tests shell out to the built `comotion` CLI (multi-
 * command fake ACP fixture), and a missing binary produces 30s
 * `waitForLog` timeouts instead of a readable failure (NOOP-233 Wave 1
 * integration; [E4.T9]/F7 switched the dependency from the TypeScript CLI
 * bundle to the Rust release binary).
 */
export async function requireCliBuilt(): Promise<void> {
  const binPath = path.join(rootDir, "target/release/comotion");
  try {
    await access(binPath);
  } catch {
    throw new Error("target/release/comotion 不存在，請先執行 npm run build");
  }
}
