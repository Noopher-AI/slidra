// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { IncomingMessage, ServerResponse } from "node:http";
import { SlidraError, SlidraNotFoundError } from "../slidra/errors.js";
import type { IdentitySession } from "./session.js";

/**
 * The identity HTTP routes ([E6.T9]): `GET /api/identity`,
 * `POST /api/identity/sign-in`, `POST /api/identity/sign-out`. `GET
 * /api/decks` stays in `open-endpoint.ts` — it existed before this
 * feature ([E6.T2]) and only gains an optional visibility-resolver
 * parameter (see `serve.ts`'s wiring), not a new file.
 *
 * Same 400/404/500 wording convention as `open-endpoint.ts:78-117`
 * (`sendStoreError`/`handleNewPost`) — a different module because these
 * routes speak to `IdentitySession`, not `DeckStore`, but the shape of
 * "not valid JSON" / "must be a JSON object" / "<field> must be a string"
 * is deliberately identical so the two route families read as one system.
 */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendIdentityError(res: ServerResponse, error: unknown, fallbackMessage: string): void {
  if (error instanceof SlidraNotFoundError) {
    sendJson(res, 404, { error: error.message });
    return;
  }
  if (error instanceof SlidraError) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : fallbackMessage });
}

/** `GET /api/identity` — current identity (`null` when anonymous) plus every registered provider's availability, for the user block's initial render (AC1). */
export function handleIdentityGet(session: IdentitySession, res: ServerResponse): void {
  sendJson(res, 200, { identity: session.currentIdentity(), providers: session.providers() });
}

/**
 * `POST /api/identity/sign-in` — body `{provider, ...}`. A body carrying a
 * string `challengeId` continues a two-phase provider's pending step
 * (`session.complete`) instead of starting a new one (`session.signIn`) —
 * the interface's two-phase shape (plan §3/§7 decision 3) needs no second
 * route for this, one request body branches on which step it is.
 */
export async function handleIdentitySignIn(session: IdentitySession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    const raw = await readTextBody(req);
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "Request body must be a JSON object" });
    return;
  }
  const body = parsed as Record<string, unknown>;
  const provider = body.provider;
  if (typeof provider !== "string" || provider.length === 0) {
    sendJson(res, 400, { error: "provider must be a string" });
    return;
  }

  try {
    const challengeId = body.challengeId;
    const outcome =
      typeof challengeId === "string"
        ? await session.complete(provider, challengeId, typeof body.proof === "string" ? body.proof : "")
        : await session.signIn(provider, body);
    sendJson(res, 200, outcome);
  } catch (error) {
    sendIdentityError(res, error, "Sign-in failed");
  }
}

/** `POST /api/identity/sign-out` — always 200, idempotent, never an "unclaim" (plan §4: claimed decks stay claimed). */
export async function handleIdentitySignOut(session: IdentitySession, res: ServerResponse): Promise<void> {
  await session.signOut();
  sendJson(res, 200, { ok: true });
}
