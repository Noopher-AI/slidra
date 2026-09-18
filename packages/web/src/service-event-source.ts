// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { DeckEvent, DeckSubscription, ServiceClients } from "./service-clients.js";
import { getServiceClients } from "./service-runtime.js";

type Listener = (event: Event) => void;

/** The EventSource subset consumed by live-reload.ts and chat-stream.ts, backed by credentialed fetch. */
class CredentialedEventSource {
  readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private subscriptions: DeckSubscription[] = [];
  private closed = false;

  constructor(start: (sink: CredentialedEventSource) => DeckSubscription[]) {
    queueMicrotask(() => {
      if (!this.closed) this.subscriptions = start(this);
    });
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", "");
  }

  fail(): void {
    this.readyState = 0;
    this.dispatch("error", "");
  }

  event(event: DeckEvent): void {
    this.dispatch(event.type, event.data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
    for (const subscription of this.subscriptions) subscription.stop();
    this.subscriptions = [];
  }

  private dispatch(type: string, data: string): void {
    const event = type === "open" || type === "error" ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function asEventSource(source: CredentialedEventSource): EventSource {
  return source as unknown as EventSource;
}

export function createAgentEventSource(
  path: string,
  clients: ServiceClients = getServiceClients(),
): EventSource {
  return asEventSource(
    new CredentialedEventSource((sink) => [
      clients.agentRunner.subscribe(path, {
        onOpen: () => sink.open(),
        onEvent: (event) => sink.event(event),
        onError: () => sink.fail(),
      }),
    ]),
  );
}

/** Deck changes come from Rust; non-deck UI events temporarily remain on the Agent runner until T10. */
export function createDeckAndRunnerEventSource(
  clients: ServiceClients = getServiceClients(),
): EventSource {
  return asEventSource(
    new CredentialedEventSource((sink) => [
      clients.deck.subscribe({
        onOpen: () => sink.open(),
        onEvent: (event) => sink.event(event),
        onError: () => sink.fail(),
      }),
      clients.agentRunner.subscribe("/api/events", {
        onEvent: (event) => {
          if (event.type !== "presentation-changed") sink.event(event);
        },
        onError: () => sink.fail(),
      }),
    ]),
  );
}
