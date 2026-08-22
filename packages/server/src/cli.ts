import { createDefaultRegistry } from "@co-motion/cli";
import { CoMotionError } from "@co-motion/core";
import { startServe } from "./serve.js";
import { commandExistsOnPath, detectAdapters } from "./agent/detect.js";
import { selectAdapter } from "./agent/select.js";
import type { AgentKind } from "./agent/adapters.js";

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

  // Detection runs at startup, before the socket is ever bound (§3): a
  // missing or ambiguous agent must fail loudly and early, never silently
  // discovered on the first chat message.
  const available = await detectAdapters(commandExistsOnPath);
  let adapter;
  try {
    adapter = selectAdapter(available, parsed.agent);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let server;
  try {
    server = await startServe({
      registry,
      presentationId: parsed.presentationId,
      port: parsed.port,
      agent: { kind: adapter.kind, label: adapter.label, command: adapter.command },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`CoMotion 已啟動：${server.url}`);
  console.log(`使用的 agent：${adapter.label}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

function parseServeArgv(
  argv: string[],
): { presentationId: string; port?: number; agent?: AgentKind } | undefined {
  let presentationId: string | undefined;
  let port: number | undefined;
  let agent: AgentKind | undefined;

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
    } else if (arg === "--agent") {
      const value = argv[i + 1];
      if (value !== "claude" && value !== "codex") {
        console.error("--agent 必須是下列其中一個值：claude、codex");
        return undefined;
      }
      agent = value;
      i++;
    } else if (presentationId === undefined) {
      presentationId = arg;
    }
  }

  if (!presentationId) {
    return undefined;
  }
  return { presentationId, port, agent };
}
