import { startServe } from "./serve.js";
import { readAgentSettings } from "./agent/settings.js";
import type { AgentKind } from "./agent/adapters.js";
import type { AgentSource } from "./agent/manager.js";

/**
 * Entry point for `comotion serve <presentation-id>`.
 *
 * This is invoked from `packages/cli/bin/comotion.js` (plain JS, not part
 * of the compiled `packages/cli` sources) via a runtime-only dynamic
 * import. [E4.T9]/F7: `@comotion/server` no longer depends on
 * `packages/cli` at all — every command it needs now spawns the Rust
 * `comotion` binary (`comotion/`) instead of dispatching against an
 * in-process registry.
 *
 * NOOP-230: serve now always starts, whether or not an agent is selected —
 * "no agent" is a supported state (chat stays gated off with a 409 until
 * one is picked), not a startup failure. What used to be startup-time
 * detection + selection (`detect.ts`/`select.ts`, both removed) is now just
 * resolving *which kind, if any, and why* (`--agent` > `settings.json` >
 * neither) — actually spawning and probing login status is
 * `AgentManager`'s job, inside `startServe`.
 */
export async function runServeCli(argv: string[]): Promise<number> {
  const parsed = parseServeArgv(argv);
  if (!parsed) {
    console.error("命令 serve 缺少參數：presentation-id");
    return 1;
  }

  // A broken settings.json must never prevent serve from starting (§4.1's
  // division of labor: settings.ts reports honestly, cli.ts is the one
  // place allowed to catch that and continue with `agent: null`).
  let settingsAgent: AgentKind | null = null;
  let settingsModels: Partial<Record<AgentKind, string>> = {};
  try {
    const settings = await readAgentSettings();
    settingsAgent = settings.agent;
    settingsModels = settings.models;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  const kind: AgentKind | null = parsed.agent ?? settingsAgent ?? null;
  const source: AgentSource = parsed.agent !== undefined ? "cli" : settingsAgent !== null ? "settings" : "none";

  let server;
  try {
    server = await startServe({
      presentationId: parsed.presentationId,
      port: parsed.port,
      initialAgent: { kind, source },
      initialModels: settingsModels,
    });
  } catch (error) {
    // Unrelated to agent selection — a missing presentation, a bound port,
    // etc. Still a hard startup failure.
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`CoMotion 已啟動：${server.url}`);
  await printAgentStatusLine(server.url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

/**
 * Prints exactly one line describing the agent serve started with — via
 * the server's own `POST /api/agent/probe` (the same endpoint the frontend
 * uses), rather than reaching into `AgentManager` directly: `startServe`'s
 * return value intentionally exposes nothing beyond `{ port, url, close }`,
 * and by this point the server is already listening, so this is a real,
 * already-live probe, not a separate code path that could drift from what
 * the UI itself would show.
 */
async function printAgentStatusLine(serverUrl: string): Promise<void> {
  const response = await fetch(`${serverUrl}/api/agent/probe`, { method: "POST" });
  const status = (await response.json()) as {
    current: AgentKind | null;
    agents: Array<{ kind: AgentKind; label: string; status: "available" | "unauthenticated"; loginCommand: string }>;
  };
  if (status.current === null) {
    console.log("尚未選擇 agent，聊天功能待設定；serve 其餘功能照常。");
    return;
  }
  const card = status.agents.find((agent) => agent.kind === status.current);
  if (!card) {
    // Unreachable given AgentManager always reports both ADAPTER_SPECS
    // kinds — a thrown error here would mean the two have drifted apart.
    throw new Error(`/api/agent/probe did not report a card for current kind: ${status.current}`);
  }
  if (card.status === "available") {
    console.log(`使用的 agent：${card.label}`);
  } else {
    console.log(`使用的 agent：${card.label}（尚未登入，請在終端機執行 ${card.loginCommand}）`);
  }
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
