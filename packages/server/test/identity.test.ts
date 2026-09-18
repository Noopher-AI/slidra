// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { openPolicy } from "../src/policy/open.js";

/**
 * [E10.T5] Slice C: identity moved into the crate
 * (`crates/slidra/src/server/identity.rs`) — `packages/server`'s own
 * `identity/` (session/routes/anonymous-provider/fake-provider/types) is
 * deleted, and with it the `ServeOptions.identity.providers` injection
 * seam this file used to drive AC2–AC7's claim/sign-in/sign-out/visible-
 * decks scenarios and AC7's second-provider extensibility contract: the
 * crate hard-codes the one production provider (`anonymous`, which never
 * signs in) rather than porting a provider trait/registry for a provider
 * that cannot be registered anywhere in this codebase any more (see
 * `identity.rs`'s own doc comment) — Dev-Leader confirmed this judgement
 * call. Nothing in `packages/server` can inject a `fake`/two-phase test
 * provider through an HTTP surface any more, so those scenarios have no
 * equivalent to keep here; they were covered crate-side already
 * (`crates/slidra/tests/deck_server_lifecycle.rs`'s `identity_*` tests)
 * for the one provider that actually exists.
 *
 * The one case still meaningful at this layer — the crate is reachable at
 * all, over the real forwarding path `/api/identity`/`/api/identity/
 * sign-in` now use — stays, adapted to no longer inject a provider (there
 * is nothing left to inject).
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const slidraBinPath = path.join(rootDir, "target/release/slidra");

let slidraHome: string;
let deckFolder: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-identity-home-"));
  deckFolder = await mkdtemp(path.join(tmpdir(), "slidra-identity-deckfolder-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-identity-static-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(): Promise<RunningServer> {
  const server = await startServe({ policy: openPolicy, port: 0, staticDir: path.join(staticRoot, "dist") });
  servers.push(server);
  return server;
}

function postJson(server: RunningServer, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getJson(server: RunningServer, urlPath: string): Promise<Response> {
  return fetch(`${server.url}${urlPath}`);
}

describe("GET /api/identity, POST /api/identity/sign-in, POST /api/identity/sign-out", () => {
  it("AC1: the anonymous provider reports unavailable, not signed in, and sign-in against it is a clear non-error response", async () => {
    const server = await serve();

    const identityGet = await getJson(server, "/api/identity");
    expect(identityGet.status).toBe(200);
    expect(await identityGet.json()).toEqual({
      identity: null,
      providers: [{ kind: "anonymous", label: "Sign in", available: false }],
    });

    const signIn = await postJson(server, "/api/identity/sign-in", { provider: "anonymous" });
    expect(signIn.status).toBe(200);
    const outcome = (await signIn.json()) as { status: string; message: string };
    expect(outcome.status).toBe("unavailable");
    expect(outcome.message.length).toBeGreaterThan(0);

    // Still anonymous afterwards — an "unavailable" outcome is not a sign-in.
    expect((await (await getJson(server, "/api/identity")).json()) as { identity: unknown }).toMatchObject({ identity: null });

    // Idempotent, always 200 — sign-out never becomes an error even though
    // nothing was ever signed in.
    const signOut = await postJson(server, "/api/identity/sign-out", {});
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ ok: true });
  });

  it("sign-in against an unregistered provider name is a 404", async () => {
    const server = await serve();
    const response = await postJson(server, "/api/identity/sign-in", { provider: "google" });
    expect(response.status).toBe(404);
  });
});
