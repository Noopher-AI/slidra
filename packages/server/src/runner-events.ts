// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ServerResponse } from "node:http";
import { SlidraError } from "./slidra/errors.js";
import { openEventStream, type EventStream } from "./sse.js";

/** Runner-owned UI events. Deck changes use the crate `/events` stream directly. */
export interface ChangeBroadcaster {
  handleConnection(res: ServerResponse): Promise<void>;
  broadcast(event: string, data: unknown): void;
  dispose(): Promise<void>;
  retarget(nextId: string | null): Promise<void>;
}

export function createChangeBroadcaster(): ChangeBroadcaster {
  const streams = new Set<EventStream>();
  let disposed = false;

  return {
    async handleConnection(res) {
      if (disposed) throw new SlidraError("Server is shutting down");
      const stream = openEventStream(res);
      streams.add(stream);
      res.once("close", () => streams.delete(stream));
    },
    broadcast(event, data) {
      for (const stream of streams) {
        if (stream.closed) streams.delete(stream);
        else stream.send(event, data);
      }
    },
    async dispose() {
      disposed = true;
      for (const stream of streams) stream.close();
      streams.clear();
    },
    async retarget(_nextId) {
      // Runner events are not deck subscriptions. Kept as a temporary
      // DeckSession adapter until the launcher removes that state machine.
    },
  };
}
