// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { startServe } from "./serve.js";
import { readAgentSettings } from "./agent/settings.js";
import { buildAdapterRegistry, isAgentKind, type AdapterSpec, type AgentKind } from "./agent/adapters.js";
import type { AgentSource } from "./agent/manager.js";
import { openPolicy } from "./policy/open.js";

/**
 * Entry point for `slidra serve <presentation-id>`.
 *
 * This is invoked from `packages/server/bin/slidra-node.js` via a
 * runtime-only dynamic import after the Rust `slidra` binary dispatches
 * the `serve` entry point. `@slidra/server` spawns that same Rust binary
 * for every command it needs instead of dispatching against an in-process
 * registry.
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
  // A broken settings.json must never prevent serve from starting (§4.1's
  // division of labor: settings.ts reports honestly, cli.ts is the one
  // place allowed to catch that and continue with `agent: null`/no declared
  // adapters). Read before `--agent` is parsed (E10.T6/#400 D4): a declared
  // adapter's own id must be as valid a `--agent` value as a bundled kind,
  // and that requires the registry to already exist.
  let settingsAgent: AgentKind | null = null;
  let settingsModels: Partial<Record<AgentKind, string>> = {};
  let adapters: readonly AdapterSpec[] = buildAdapterRegistry([]);
  try {
    const settings = await readAgentSettings();
    settingsAgent = settings.agent;
    settingsModels = settings.models;
    adapters = buildAdapterRegistry(settings.adapters);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  const parsed = parseServeArgv(argv, adapters);
  // NOOP-433: a presentation id is no longer required — "no deck open" is a
  // supported startup state (see ServeOptions.presentationId's own
  // docstring). `parsed` is only undefined for a malformed `--port`/`--host`/
  // `--agent`, each of which has already printed its own specific message.
  if (!parsed) {
    return 1;
  }

  const kind: AgentKind | null = parsed.agent ?? settingsAgent ?? null;
  const source: AgentSource = parsed.agent !== undefined ? "cli" : settingsAgent !== null ? "settings" : "none";

  let server;
  try {
    server = await startServe({
      policy: openPolicy,
      presentationId: parsed.presentationId,
      port: parsed.port,
      host: parsed.host,
      initialAgent: { kind, source },
      initialModels: settingsModels,
      agentManager: { adapters },
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
    // Unreachable given AgentManager always reports a card for every kind
    // in its own registry — a thrown error here would mean the two have
    // drifted apart.
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
  adapters: readonly AdapterSpec[],
): { presentationId?: string; port?: number; host?: string; agent?: AgentKind } | undefined {
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
      if (!isAgentKind(value, adapters)) {
        console.error(`--agent must be one of: ${adapters.map((spec) => spec.kind).join(", ")}`);
        return undefined;
      }
      agent = value;
      i++;
    } else if (presentationId === undefined) {
      presentationId = arg;
    }
  }

  // NOOP-433: presentationId is optional now — "no deck open" is a
  // supported startup state, no longer a parse failure. `--unknown` (not
  // one of the flags above) is still just taken as the id, unchanged.
  return { presentationId, port, host, agent };
}
