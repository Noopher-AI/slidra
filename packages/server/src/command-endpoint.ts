// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeCommandArgv } from "./slidra/argv.js";
import { runJsonCommand } from "./slidra/command.js";

/**
 * `POST /api/command` — the front end's only write path.
 *
 * Direct manipulation on the canvas (drag, handles, snapping) has to end in
 * a real command, and previously the server had no route that could run
 * one: `POST` was 405 for everything except `/api/chat`. This module is
 * that route, and it is deliberately the narrowest thing that can work.
 *
 * Two properties carry the whole security posture, and both are structural
 * rather than remembered:
 *
 *  1. A NAME WHITELIST, checked BEFORE `registry.dispatch` is reached at
 *     all. Every registered command is reachable through the registry —
 *     `open`, `pack`, `new`, `convert` included — so an endpoint that
 *     forwarded an arbitrary `name` would hand any script that can reach
 *     this origin the entire CLI. The check is not a filter over the
 *     registry's contents; it is a fixed list this module owns.
 *
 *  2. THE PRESENTATION ID IS THE SERVER'S. Whatever `id` the client put in
 *     `input` is discarded and overwritten with the id this server was
 *     started on. A `serve` process is bound to exactly one presentation,
 *     so a request that could name another one would let a page reach
 *     outside the deck it is displaying.
 *
 * Freeze/lock gates are explicitly NOT here: those are layered on top of
 * this route separately.
 */

/**
 * The only commands this endpoint will run. Each entry was added as a
 * given panel needed it, not as a convenience — the Ribbon's "Common" tab
 * is what added `slide add` / `element copy` / `element cut` /
 * `element paste` / `element insert` / `textbox add` / `element align` /
 * `element distribute` / `element order` to the original four, in-place text
 * editing added `text set`, and the style panel added `element style set` —
 * the command layer's own gatekeeping logic still validates which
 * attributes are settable.
 */
export const COMMAND_WHITELIST: readonly string[] = [
  "element move",
  "element scale",
  "element rotate",
  "textbox width",
  "text set",
  "slide add",
  // Page management and speaker notes added these four.
  "slide delete",
  "slide duplicate",
  "slide move",
  "slide notes set",
  "element copy",
  "element cut",
  "element paste",
  "element insert",
  "textbox add",
  "element align",
  "element distribute",
  "element order",
  "element style set",
  // [E2.T11] replaces the presentation-wide `presentation transition set`
  // with the per-slide `slide transition set`.
  "slide transition set",
  // The template-management dialog added these four.
  "template add",
  "template list",
  "template rename",
  "template delete",
  // The plan-confirmation dialog: "Discard" deletes the plan/ draft
  // directly, without going through the agent; `plan list` lets the front
  // end check whether a draft exists even with no SSE event to trigger it.
  // Reading the plan file itself goes through `/api/files/`.
  "plan list",
  "plan delete",
  // Stage selection and direct manipulation added these three: the corner
  // handles send `element resize` (a new command); Delete/Backspace and the
  // element context menu's Delete send `element delete`; Cmd+D and the
  // context menu's Duplicate send `element duplicate` — the latter two
  // commands already existed in the registry, just never allowed through
  // this endpoint before, so without these three entries this whitelist
  // itself would 403 them.
  "element resize",
  "element delete",
  "element duplicate",
  // The Dock's Group/Ungroup buttons added these two.
  "element group",
  "element ungroup",
  // The Video/Image/Audio insert panel's caption field: the caption lands
  // as `data-slidra-name`, going through the existing `element name set`
  // command.
  "element name set",
  // The Animate panel / timeline / scenario bar's Edit animation added
  // these four; `effect list` is not among them — the GUI's list state
  // goes through the ordinary file-read path (`GET /api/files/`), which
  // does not need the command endpoint.
  "effect add",
  "effect remove",
  "effect move",
  "effect set",
  // The comment box / pinned context added these three — creating,
  // editing, and deleting a comment are all write paths for the GUI;
  // `comment list` need not be added since the front end reads comments
  // through `/api/raw/`, not through this endpoint.
  "comment add",
  "comment edit",
  "comment delete",
  // The clipboard added these three: Cmd+C/Cmd+X/Cmd+V on a cell range
  // route through to the table command family (only these three
  // cell-range commands are covered so far).
  "table cell copy",
  "table cell cut",
  "table cell paste",
  // The Table insert panel, cell editing/styling/merging/column-width
  // dragging, and the Style > Object tab's table section and Refresh
  // button.
  "table create",
  "table cell set",
  "table cell style set",
  "table merge",
  "table col width",
  "table col insert",
  "table col delete",
  "table row insert",
  "table row delete",
  "table theme set",
  "table header set",
  "table bind",
  "table refresh",
  "table set",
  // The chart insert panel, its data window, and its eight commands.
  "chart create",
  "chart data set",
  "chart type set",
  "chart palette set",
  "chart axis set",
  "chart stack set",
  "chart legend set",
  "chart option set",
  // The style panel added these three: text-box alignment, slide style
  // (background/accent color), and canvas size.
  "textbox align",
  "slide style set",
  "presentation canvas set",
  // The manual background-image control panel: upload/select/clear the
  // background image, adjust opacity.
  "slide background set",
];

/**
 * Hard cap on the request body. A drag's command input is a few hundred
 * bytes; 64 KiB is orders of magnitude of headroom and still small enough
 * that a stream of oversized bodies cannot grow this process's memory. The
 * limit is enforced WHILE reading (the socket is destroyed the moment it is
 * exceeded), not after buffering the whole thing, which would defeat the
 * point of having a limit.
 */
export const MAX_COMMAND_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

function readLimitedBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return; // Drain the rest without buffering any of it.
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        // Stop ACCUMULATING immediately — but do not destroy the socket
        // here. Destroying it mid-request races the 400 this rejection is
        // about to produce, and the client sees an ECONNRESET instead of
        // the explicit refusal (measured, not assumed). The remaining
        // bytes are read and thrown away, so memory stays bounded by
        // `limit` plus one chunk either way.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Runs one whitelisted command against this server's own presentation.
 *
 * Check order matters and is asserted by the tests: body size, then JSON
 * syntax, then `name`'s type, then the whitelist, then `input`'s shape.
 * The whitelist sits ahead of input validation so a non-whitelisted name is
 * always answered 403 — never 400 — regardless of what the body carried
 * alongside it, which keeps "was this command refused?" a question with one
 * answer.
 *
 * Failure mapping follows `/api/files/`'s existing narrow rule (ticket
 * #14): only a `failureKind` that positively proves absence is a 404.
 * A missing kind is "not proven absent", i.e. 500.
 *
 * Resolves to whether the command actually wrote to the deck (NOOP-422):
 * `true` only for a 200 response — the caller (`serve.ts`) uses this to
 * decide whether to schedule a continuous-save write-back, and every
 * refusal/failure path above resolves `false` without having touched the
 * deck at all.
 */
export async function handleCommandPost(presentationId: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let raw: string;
  try {
    raw = await readLimitedBody(req, MAX_COMMAND_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 400, { error: `Request body too large (limit ${MAX_COMMAND_BODY_BYTES} bytes)` });
      return false;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return false;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return false;
  }
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "Request body must be an object" });
    return false;
  }

  const { name, input } = body as { name?: unknown; input?: unknown };
  if (typeof name !== "string") {
    sendJson(res, 400, { error: "name must be a string" });
    return false;
  }
  if (!COMMAND_WHITELIST.includes(name)) {
    sendJson(res, 403, { error: `This endpoint does not accept command: ${name}` });
    return false;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    sendJson(res, 400, { error: "input must be an object" });
    return false;
  }

  // The client's own `id`, if it sent one, is overwritten here — never
  // merged, never trusted. This spread order is the enforcement.
  const resolvedInput = { ...(input as Record<string, unknown>), id: presentationId };

  let result: Awaited<ReturnType<typeof runJsonCommand>>;
  try {
    const { argv, cleanup } = await encodeCommandArgv(name, resolvedInput);
    try {
      result = await runJsonCommand(argv);
    } finally {
      await cleanup();
    }
  } catch (error) {
    // A thrown error out of encoding/spawning is a bug or an unclassified
    // failure, never a user-facing "not found".
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Command execution failed" });
    return false;
  }

  if (!result.ok) {
    const status = result.failureKind === "not-found" ? 404 : 500;
    sendJson(res, status, { error: result.message, failureKind: result.failureKind ?? null });
    return false;
  }

  sendJson(res, 200, { ok: true, data: result.data ?? {}, message: result.message });
  return true;
}
