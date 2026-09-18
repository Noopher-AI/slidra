// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export const BOOTSTRAP_ELEMENT_ID = "slidra-bootstrap";

export interface ServiceBootstrap {
  workbenchId: string | null;
  deck: {
    url: string;
    credential: string;
  };
  agentRunner: {
    url: string;
    sessionToken: string;
  };
}

export interface ServiceClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface DeckEvent {
  type: string;
  data: string;
}

export interface DeckSubscription {
  stop(): void;
}

export interface DeckSubscriptionOptions {
  onEvent(event: DeckEvent): void;
  onOpen?(): void;
  onError?(error: unknown): void;
  reconnectMs?: number;
}

export interface DeckServiceClient extends ServiceClient {
  subscribe(options: DeckSubscriptionOptions): DeckSubscription;
}

export interface EventServiceClient extends ServiceClient {
  subscribe(path: string, options: DeckSubscriptionOptions): DeckSubscription;
}

export interface ServiceClients {
  workbenchId: string | null;
  deck: DeckServiceClient;
  agentRunner: EventServiceClient;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBootstrap(value: unknown): value is ServiceBootstrap {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ServiceBootstrap>;
  return (
    (candidate.workbenchId === null || nonEmpty(candidate.workbenchId)) &&
    typeof candidate.deck === "object" &&
    candidate.deck !== null &&
    nonEmpty(candidate.deck.url) &&
    nonEmpty(candidate.deck.credential) &&
    typeof candidate.agentRunner === "object" &&
    candidate.agentRunner !== null &&
    nonEmpty(candidate.agentRunner.url) &&
    nonEmpty(candidate.agentRunner.sessionToken)
  );
}

/** Consumes the one credential-bearing DOM node. Its contents never remain in the live DOM. */
export function readBootstrap(source: Pick<Document, "getElementById">): ServiceBootstrap {
  const node = source.getElementById(BOOTSTRAP_ELEMENT_ID);
  if (!node) throw new Error("Missing Slidra service bootstrap");
  const text = node.textContent ?? "";
  node.remove();

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid Slidra service bootstrap");
  }
  if (!isBootstrap(value)) throw new Error("Invalid Slidra service bootstrap");
  return value;
}

function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

function withHeader(init: RequestInit | undefined, name: string, value: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(name, value);
  return { ...init, headers };
}
function deliverFrames(buffer: string, onEvent: (event: DeckEvent) => void): string {
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary < 0) return rest;
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice("event:".length).trimStart();
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length > 0) onEvent({ type, data: data.join("\n") });
  }
}

function subscribeToService(
  baseUrl: string,
  path: string,
  headerName: string,
  credential: string,
  fetchImpl: Fetch,
  options: DeckSubscriptionOptions,
): DeckSubscription {
  let active = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const reconnectMs = options.reconnectMs ?? 500;

  async function connect(): Promise<void> {
    controller = new AbortController();
    try {
      const response = await fetchImpl(
        endpoint(baseUrl, path),
        withHeader({ signal: controller.signal }, headerName, credential),
      );
      if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
      options.onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = deliverFrames(buffer + decoder.decode(value, { stream: true }), options.onEvent);
      }
    } catch (error) {
      if (active) options.onError?.(error);
    } finally {
      if (active) reconnectTimer = setTimeout(() => void connect(), reconnectMs);
    }
  }

  void connect();
  return {
    stop() {
      active = false;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      controller?.abort();
    },
  };
}


export function createServiceClients(
  bootstrap: ServiceBootstrap,
  fetchImpl: Fetch = globalThis.fetch.bind(globalThis),
): ServiceClients {
  return {
    workbenchId: bootstrap.workbenchId,
    deck: {
      fetch(path, init) {
        const deckPath = path.startsWith("/api/") ? path.slice("/api".length) : path;
        return fetchImpl(
          endpoint(bootstrap.deck.url, deckPath),
          withHeader(init, "x-slidra-credential", bootstrap.deck.credential),
        );
      },
      subscribe(options) {
        return subscribeToService(bootstrap.deck.url, "/events", "x-slidra-credential", bootstrap.deck.credential, fetchImpl, options);
      },
    },
    agentRunner: {
      fetch(path, init) {
        return fetchImpl(
          endpoint(bootstrap.agentRunner.url, path),
          withHeader(init, "x-slidra-runner-session", bootstrap.agentRunner.sessionToken),
        );
      },
      subscribe(path, options) {
        return subscribeToService(
          bootstrap.agentRunner.url,
          path,
          "x-slidra-runner-session",
          bootstrap.agentRunner.sessionToken,
          fetchImpl,
          options,
        );
      },
    },
  };
}
