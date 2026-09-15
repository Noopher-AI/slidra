// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { createAnonymousProvider } from "../src/identity/anonymous-provider.js";
import { createFakeProvider } from "../src/identity/fake-provider.js";
import { SlidraError } from "../src/slidra/errors.js";
import type { Identity, IdentityProvider, SignInOutcome } from "../src/identity/types.js";

/**
 * [E6.T9]'s public boundary is HTTP (plan §6): every test here starts a
 * real `startServe` (`port: 0`) with injected providers and drives it with
 * `fetch`, exactly like `deck-switch.test.ts`'s own "Seam B" — no test
 * reaches into `session.ts`'s private state or counts `deck meta set`
 * calls.
 */

const execFileAsync = promisify(execFile);
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../target/release/slidra");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(slidraBinPath, [...args, "--json"], { env: process.env });
    return JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch (error) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      return JSON.parse(err.stdout.trim()) as CliEnvelope<T>;
    }
    throw error;
  }
}

let slidraHome: string;
let slidraDir: string;
let deckFolder: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-identity-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-identity-files-"));
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
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(overrides: Partial<Parameters<typeof startServe>[0]> = {}): Promise<RunningServer> {
  const server = await startServe({ port: 0, staticDir: path.join(staticRoot, "dist"), ...overrides });
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

/** Creates an anonymous deck directly in the deck folder via `POST /api/new` — the same path the editor's own "New" action uses. */
async function createAnonymousDeck(server: RunningServer, name: string): Promise<string> {
  const response = await postJson(server, "/api/new", { name });
  expect(response.status).toBe(200);
  const json = (await response.json()) as { fileName: string };
  return json.fileName;
}

async function listDeckFileNames(server: RunningServer, query = ""): Promise<string[]> {
  const response = await getJson(server, `/api/decks${query}`);
  expect(response.status).toBe(200);
  const json = (await response.json()) as { decks: Array<{ fileName: string }> };
  return json.decks.map((d) => d.fileName).sort();
}

describe("GET /api/identity, POST /api/identity/sign-in, POST /api/identity/sign-out", () => {
  it("AC1: anonymous provider reports unavailable, not signed in, and sign-in against it is a clear non-error response", async () => {
    const server = await serve({ identity: { providers: [createAnonymousProvider()] } });

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
  });

  it("AC2: signing in claims every anonymous deck for that identity, reports the count, and the decks stay visible throughout", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    const before = await Promise.all([
      createAnonymousDeck(server, "One"),
      createAnonymousDeck(server, "Two"),
      createAnonymousDeck(server, "Three"),
    ]);
    expect(await listDeckFileNames(server)).toEqual([...before].sort());

    const signIn = await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    expect(signIn.status).toBe(200);
    const outcome = (await signIn.json()) as { status: string; identity: Identity; claimed: number };
    expect(outcome.status).toBe("signed-in");
    expect(outcome.claimed).toBe(3);

    // Same three decks, still visible, after the claim.
    expect(await listDeckFileNames(server)).toEqual([...before].sort());
  });

  it("AC3: switching to a second identity shows only that identity's decks; switching back shows the first identity's decks again", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    const alicesDecks = await Promise.all([createAnonymousDeck(server, "Alpha"), createAnonymousDeck(server, "Beta")]);
    await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    expect(await listDeckFileNames(server)).toEqual([...alicesDecks].sort());

    await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "bob" });
    expect(await listDeckFileNames(server)).toEqual([]);

    const bobsDeck = await postJson(server, "/api/new", { name: "Gamma", owner: "fake:bob" });
    expect(bobsDeck.status).toBe(200);
    expect(await listDeckFileNames(server)).toEqual(["Gamma.slidra"]);

    await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    const backToAlice = await listDeckFileNames(server);
    expect(backToAlice).toEqual([...alicesDecks].sort());
    expect(backToAlice).not.toContain("Gamma.slidra");
  });

  it("AC4: signing out returns to the anonymous view with every anonymous deck visible", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    // Signed in as alice throughout — this deck is created (and stays)
    // owned by "fake:alice", never "Anonymous", so it must NOT resurface
    // after sign-out below (sign-out is not an "unclaim", plan §4).
    await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    await postJson(server, "/api/new", { name: "Alices-own", owner: "fake:alice" });
    expect(await listDeckFileNames(server)).toEqual(["Alices-own.slidra"]);

    const signOut = await postJson(server, "/api/identity/sign-out", {});
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ ok: true });
    expect((await (await getJson(server, "/api/identity")).json()) as { identity: unknown }).toEqual({
      identity: null,
      providers: [{ kind: "fake", label: "Fake sign-in (tests only)", available: true }],
    });

    expect(await listDeckFileNames(server)).toEqual([]);
    const anonAfter = await createAnonymousDeck(server, "Made-after-signout");
    expect(await listDeckFileNames(server)).toEqual([anonAfter]);

    // Idempotent: signing out again while already anonymous is still a plain 200.
    const secondSignOut = await postJson(server, "/api/identity/sign-out", {});
    expect(secondSignOut.status).toBe(200);
  });

  it("re-signing into the identity already current is idempotent (claimed: 0, never re-claims), and a second identity never claims the first's decks", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    await createAnonymousDeck(server, "Unclaimed");
    const firstSignIn = await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    expect((await firstSignIn.json() as { claimed: number }).claimed).toBe(1);

    const sameAgain = await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    expect((await sameAgain.json() as { status: string; claimed: number })).toEqual({
      status: "signed-in",
      identity: { id: "alice", displayName: "alice", avatarUrl: null },
      claimed: 0,
    });

    // bob has nothing to claim: alice's deck is "fake:alice", not "Anonymous", any more.
    const bobSignIn = await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "bob" });
    expect((await bobSignIn.json() as { claimed: number }).claimed).toBe(0);
    expect(await listDeckFileNames(server)).toEqual([]);
  });

  it("claiming the currently-open deck re-snapshots savedAt, so it does not open already \"dirty\" (deck-store.ts's own renameDeck contract, applied to claim)", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    const created = await postJson(server, "/api/new", { name: "Claimed" });
    const { id } = (await created.json()) as { id: string };
    const switched = await postJson(server, "/api/deck/switch", { id });
    expect(switched.status).toBe(200);

    const before = await getJson(server, "/api/save-state");
    expect(await before.json()).toMatchObject({ known: true, dirty: false });

    const signIn = await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });
    expect((await signIn.json()) as { claimed: number }).toMatchObject({ claimed: 1 });

    const after = await getJson(server, "/api/save-state");
    expect(await after.json()).toMatchObject({ known: true, dirty: false });
  });

  it("an explicit ?owner= bypasses identity entirely, even while signed in as someone else", async () => {
    const server = await serve({ identity: { providers: [createFakeProvider()] } });

    await postJson(server, "/api/new", { name: "Explicit", owner: "some-other-tag" });
    await postJson(server, "/api/identity/sign-in", { provider: "fake", identity: "alice" });

    // Alice's own visible set (no ?owner=) does not include it...
    expect(await listDeckFileNames(server)).toEqual([]);
    // ...but an explicit ?owner= for that exact tag still finds it, identity or no identity.
    expect(await listDeckFileNames(server, "?owner=some-other-tag")).toEqual(["Explicit.slidra"]);
  });
});

/**
 * AC7's own fixture — a second `IdentityProvider`, built entirely in this
 * test file (`packages/server/src/` gets zero lines of change for it),
 * that actually uses the two-phase shape `fake`/`anonymous` never
 * exercise: `begin()` returns `pending`, and only a matching `complete()`
 * call signs in. Proves the interface itself, not just its always-
 * synchronous implementations, carries the real four routes end to end.
 */
function createTwoPhaseTestProvider(): IdentityProvider {
  const pendingChallenges = new Map<string, string>();
  let counter = 0;
  return {
    kind: "two-phase",
    label: "Two-phase (test)",
    available: true,
    async begin(req: Record<string, unknown>): Promise<SignInOutcome> {
      const id = req.identity;
      if (typeof id !== "string" || id.length === 0) {
        throw new SlidraError('two-phase test provider requires a string "identity" field');
      }
      const challengeId = `challenge-${++counter}`;
      pendingChallenges.set(challengeId, id);
      return { status: "pending", challengeId, message: "Enter the code we just made up." };
    },
    async complete(challengeId: string, proof: string): Promise<SignInOutcome> {
      const id = pendingChallenges.get(challengeId);
      if (!id) throw new SlidraError(`unknown challenge: ${challengeId}`);
      pendingChallenges.delete(challengeId);
      if (proof !== "correct-code") throw new SlidraError("wrong code");
      return { status: "signed-in", identity: { id, displayName: id, avatarUrl: null } };
    },
    async signOut(): Promise<void> {},
  };
}

describe("AC7: a second provider is only an IdentityProvider implementation — no route/session/claim/web change", () => {
  it("runs sign-in -> claim -> list -> switch -> sign-out through the same four identity/deck routes as the fake provider", async () => {
    const server = await serve({ identity: { providers: [createTwoPhaseTestProvider()] } });

    await createAnonymousDeck(server, "Pending-claim");

    const begin = await postJson(server, "/api/identity/sign-in", { provider: "two-phase", identity: "alice" });
    expect(begin.status).toBe(200);
    const pending = (await begin.json()) as { status: string; challengeId: string; message: string };
    expect(pending.status).toBe("pending");
    expect(pending.challengeId.length).toBeGreaterThan(0);
    expect(pending.message.length).toBeGreaterThan(0);
    // Nothing signed in yet, mid-challenge.
    expect((await (await getJson(server, "/api/identity")).json()) as { identity: unknown }).toMatchObject({ identity: null });

    const complete = await postJson(server, "/api/identity/sign-in", {
      provider: "two-phase",
      challengeId: pending.challengeId,
      proof: "correct-code",
    });
    expect(complete.status).toBe(200);
    const signedIn = (await complete.json()) as { status: string; identity: Identity; claimed: number };
    expect(signedIn.status).toBe("signed-in");
    expect(signedIn.identity.id).toBe("alice");
    expect(signedIn.claimed).toBe(1);
    expect(await listDeckFileNames(server)).toEqual(["Pending-claim.slidra"]);

    // Switch to a second identity through the same two-phase dance.
    const begin2 = await postJson(server, "/api/identity/sign-in", { provider: "two-phase", identity: "bob" });
    const pending2 = (await begin2.json()) as { challengeId: string };
    await postJson(server, "/api/identity/sign-in", {
      provider: "two-phase",
      challengeId: pending2.challengeId,
      proof: "correct-code",
    });
    expect(await listDeckFileNames(server)).toEqual([]);

    const signOut = await postJson(server, "/api/identity/sign-out", {});
    expect(signOut.status).toBe(200);
    expect((await (await getJson(server, "/api/identity")).json()) as { identity: unknown }).toMatchObject({ identity: null });
  });
});
