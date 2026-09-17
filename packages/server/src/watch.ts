// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { watch as fsWatch } from "node:fs";
import { SlidraError } from "./slidra/errors.js";
import { deckPathFor } from "./slidra/home.js";

/**
 * Watches one presentation's deck file for filesystem changes and
 * calls `onChange` (debounced, coalesced) whenever something changes.
 * Ported originally from `packages/core`'s `watch.ts`, and updated for
 * `spec/rfcs/0001-sqlite-container-format.md`: the deck is a single file
 * now, not a directory, so this watches `deckPathFor(id)` itself
 * (non-recursive) rather than `fs.watch(workDir, { recursive: true })`.
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

/**
 * SQLite's `journal_mode=DELETE` (`crates/slidra/src/deck.rs`) creates a
 * `<deckname>-journal` sibling for the duration of one write transaction
 * and unlinks it the moment that transaction commits. It is coordination,
 * never content, so a change to it must not reach `onChange`: `serve`
 * answers a live-reload notification by re-reading the presentation
 * *through the CLI*, which opens (and briefly journals) the same deck
 * again, which would notify again — a loop that never settles. Its visible
 * symptom is the editor reloading constantly, which drops the author's
 * selection the instant they click an element. The CLI's own
 * per-deck advisory lock (`workspace::lock`) no longer lives beside the
 * deck at all (`<SLIDRA_HOME>/locks/`), so it is never in this watcher's
 * path to begin with.
 */
function isCoordinationFile(filename: string | Buffer | null): boolean {
  if (filename === null) return false;
  const name = typeof filename === "string" ? filename : filename.toString("utf-8");
  return name.endsWith("-journal");
}

// Trailing debounce window: a single logical edit (e.g. `text set`) can
// produce more than one raw filesystem event, and this coalesces them into
// one `onChange` call without swallowing distinct, separately-timed edits.
const DEBOUNCE_MS = 100;

/**
 * Starts watching the presentation identified by `id`. Resolves only after
 * the id has been confirmed to exist, so a caller awaiting this gets the
 * same explicit unknown-id failure every other read would.
 *
 * `onError` is called at most once if the underlying `fs.watch` handle
 * itself fails after startup — a condition live reload can never recover
 * from on its own. The watcher closes itself first, so it stops looking
 * like a live watcher before the caller is even told; no further
 * `onChange` call can follow.
 */
export async function watchPresentation(
  id: string,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<PresentationWatcher> {
  const deckPath = await deckPathFor(id);

  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const scheduleNotify = (): void => {
    if (closed) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, DEBOUNCE_MS);
    // Must be unref'd: a live setTimeout keeps the Node event loop alive,
    // which would hang the test suite and stop `slidra serve` from ever
    // exiting on Ctrl-C.
    debounceTimer.unref();
  };

  let watcher: ReturnType<typeof fsWatch>;
  try {
    watcher = fsWatch(deckPath, (_event, filename) => {
      if (isCoordinationFile(filename)) return;
      scheduleNotify();
    });
  } catch {
    // `fs.watch` throws synchronously (not just via its `error` event) when
    // the target has vanished or become unreadable between id resolution
    // above and this call. That raw error's message very likely embeds the
    // real deck path (ADR-0003), exactly like the asynchronous
    // `error` event handled below, so it gets the same sanitised treatment.
    throw new SlidraError("Error watching presentation files");
  }

  watcher.on("error", () => {
    if (closed) return;
    // Stop first: no further `onChange` must ever fire from a watcher that
    // has already failed.
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher.close();
    // The underlying error object very likely embeds the real work
    // directory path (ADR-0003) — it is never logged or rethrown verbatim.
    onError(new SlidraError("Error watching presentation files"));
  });

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher.close();
    },
  };
}
