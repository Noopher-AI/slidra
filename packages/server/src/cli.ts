// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { startServe } from "./serve.js";
import { readAgentSettings } from "./agent/settings.js";
import { isAgentKind, type AgentKind } from "./agent/adapters.js";
import type { AgentSource } from "./agent/manager.js";

/**
 * Entry point for `slidra serve <presentation-id>`.
 *
 * This is invoked from `packages/cli/bin/slidra.js` (plain JS, not part
 * of the compiled `packages/cli` sources) via a runtime-only dynamic
 * import. [E4.T9]/F7: `@slidra/server` no longer depends on
 * `packages/cli` at all — every command it needs now spawns the Rust
 * `slidra` binary (`slidra/`) instead of dispatching against an
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
    console.error("Command serve is missing an argument: presentation-id");
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
      host: parsed.host,
      initialAgent: { kind, source },
      initialModels: settingsModels,
    });
  } catch (error) {
    // Unrelated to agent selection — a missing presentation, a bound port,
    // etc. Still a hard startup failure.
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`Slidra started: ${server.url}`);
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
    console.log("No agent selected yet, chat is not configured; serve's other features work as usual.");
    return;
  }
  const card = status.agents.find((agent) => agent.kind === status.current);
  if (!card) {
    // Unreachable given AgentManager always reports both ADAPTER_SPECS
    // kinds — a thrown error here would mean the two have drifted apart.
    throw new Error(`/api/agent/probe did not report a card for current kind: ${status.current}`);
  }
  if (card.status === "available") {
    console.log(`Using agent: ${card.label}`);
  } else {
    console.log(`Using agent: ${card.label} (not logged in yet, run ${card.loginCommand} in a terminal)`);
  }
}

function parseServeArgv(
  argv: string[],
): { presentationId: string; port?: number; host?: string; agent?: AgentKind } | undefined {
  let presentationId: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let agent: AgentKind | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      const parsedPort = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsedPort)) {
        console.error("--port is missing a valid number");
        return undefined;
      }
      port = parsedPort;
      i++;
    } else if (arg === "--host") {
      // Needed to bind 0.0.0.0 in a container, where the default loopback
      // bind would be unreachable from outside.
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("--host is missing a value");
        return undefined;
      }
      host = value;
      i++;
    } else if (arg === "--agent") {
      const value = argv[i + 1];
      if (!isAgentKind(value)) {
        console.error("--agent must be one of: claude, codex, pi");
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
  return { presentationId, port, host, agent };
}
