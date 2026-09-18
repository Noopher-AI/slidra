// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { SlidraError, SlidraNotFoundError } from "./slidra/errors.js";
import type { DeckServerClient } from "./deck-server-client.js";

/**
 * Watches one presentation for changes and calls `onChange` whenever the
 * crate's own `GET /events` ([E10.T5], `crates/slidra/src/server/
 * events.rs`) reports one. [E10.T5] moves the actual watch — deck-file
 * mtime polling with a trailing debounce — into the crate (NOOP-641 Plan
 * §3/§7's decision to avoid a new filesystem-watch dependency); this
 * module used to run `fs.watch` itself, and now instead holds one
 * long-lived HTTP connection to the crate's stream and re-emits what it
 * says. `changes.ts`'s own multiplexing broadcaster (`ChangeBroadcaster`,
 * still fanning out `presentation-changed` alongside `agent-changed`/
 * `editing-frozen`/`save-state`/`deck-changed` to connected browser tabs —
 * every one of those OTHER event kinds is unrelated to this ticket's scope
 * and stays exactly as it was) is unchanged by this — `PresentationWatcher`
 * keeps the exact same public shape, so nothing above this module needed
 * to change at all.
 *
 * `onChange` deliberately carries no payload — not which file, not what
 * changed. `openEventStream` (packages/server/src/sse.ts) implements no
 * event replay, so a reconnecting client must recover by re-reading full
 * state; an event that carried a diff would be unusable after a missed
 * one. Callers are expected to re-read presentation state through the
 * existing read path whenever `onChange` fires.
 */
export interface PresentationWatcher {
  close(): Promise<void>;
}

/** `x-slidra-credential`'s wire shape — same hand-copy `deck-server-client.ts` uses, for the same "no dependency edge into the crate" reason. */
function credentialHeader(workbenchId: string): string {
  return Buffer.from(JSON.stringify({ kind: "editor", workbenchId }), "utf8").toString("base64");
}

/**
 * Starts watching the presentation identified by `id`. Resolves only after
 * the crate has confirmed the id is a real, known workbench (its `GET
 * /events` answers with a 200 stream, not a 404) — the same "an unknown id
 * fails loudly before a stream is ever opened" contract the old `fs.watch`-
 * based version gave via `deckPathFor`.
 *
 * `onError` is called at most once if the underlying connection to the
 * crate itself fails after startup (the crate process died, or the TCP
 * connection drops) — a condition live reload can never recover from on
 * its own. The connection is torn down first, so it stops looking live
 * before the caller is even told; no further `onChange` call can follow.
 */
export async function watchPresentation(
  id: string,
  deckServer: DeckServerClient,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<PresentationWatcher> {
  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(`${deckServer.baseUrl}/events`, {
      headers: { "x-slidra-credential": credentialHeader(id) },
      signal: controller.signal,
    });
  } catch (error) {
    throw new SlidraError(`Error watching presentation files: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) {
    // The crate's own 404 body is `{error: "no presentation found for id:
    // <id>"}` (`workspace::registry::lookup`) — relayed verbatim rather
    // than re-worded, so this failure reads identically to every other
    // route's unknown-id error.
    const body = await response.json().catch(() => null);
    const message = typeof body?.error === "string" ? body.error : "no presentation found for the given id";
    throw new SlidraNotFoundError(message);
  }
  if (response.status !== 200 || !response.body) {
    throw new SlidraError("Error watching presentation files");
  }

  let closed = false;

  // Reads the SSE stream in the background, calling `onChange` on every
  // `event: presentation-changed` frame and `onError` (once) if the stream
  // ends or errors before this side ever closed it. A heartbeat frame
  // (`: \n\n`, no `event:` line) is simply not one of the two markers this
  // parser looks for, so it is silently ignored — exactly its purpose.
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("event: presentation-changed")) {
            onChange();
          }
        }
      }
      if (!closed) {
        closed = true;
        onError(new SlidraError("Error watching presentation files"));
      }
    } catch (error) {
      if (closed) return;
      closed = true;
      if (error instanceof Error && error.name === "AbortError") return;
      onError(new SlidraError("Error watching presentation files"));
    }
  })();

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
