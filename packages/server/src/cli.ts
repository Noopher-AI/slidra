import { createDefaultRegistry } from "@co-motion/cli";
import { CoMotionError } from "@co-motion/core";
import { startServe } from "./serve.js";

/**
 * Entry point for `co-motion serve <presentation-id>`.
 *
 * This is invoked from `packages/cli/bin/co-motion.js` (plain JS, not part
 * of the compiled `@co-motion/cli` sources) via a runtime-only dynamic
 * import. `@co-motion/server` depends on `@co-motion/cli` for the command
 * registry, so `@co-motion/cli`'s own TypeScript sources must never import
 * `@co-motion/server` back — that would make the project-reference graph
 * circular. Routing through the untyped bin shim is what keeps the two
 * packages' build graph acyclic while still sharing one `co-motion` binary.
 */
export async function runServeCli(argv: string[]): Promise<number> {
  const parsed = parseServeArgv(argv);
  if (!parsed) {
    console.error("命令 serve 缺少參數：presentation-id");
    return 1;
  }

  const registry = createDefaultRegistry();

  let server;
  try {
    server = await startServe({ registry, presentationId: parsed.presentationId, port: parsed.port });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`CoMotion 已啟動：${server.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

function parseServeArgv(argv: string[]): { presentationId: string; port?: number } | undefined {
  let presentationId: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      const parsedPort = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsedPort)) {
        console.error("--port 缺少有效的數值");
        return undefined;
      }
      port = parsedPort;
      i++;
    } else if (presentationId === undefined) {
      presentationId = arg;
    }
  }

  if (!presentationId) {
    return undefined;
  }
  return { presentationId, port };
}
