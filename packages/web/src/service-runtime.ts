// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createServiceClients, readBootstrap, type ServiceClients } from "./service-clients.js";
import { createRoutingFetch, type BrowserFetch } from "./service-routing.js";

interface FetchHost {
  fetch: BrowserFetch;
}

export interface ServiceRuntime {
  clients: ServiceClients;
  stop(): void;
}

let active: ServiceRuntime | undefined;

export function getServiceClients(): ServiceClients {
  if (!active) throw new Error("Slidra service runtime has not started");
  return active.clients;
}

/** Starts once per page load. Reloading the page receives and consumes a fresh bootstrap. */
export function startServiceRuntime(
  source: Pick<Document, "getElementById"> = document,
  host: FetchHost = globalThis,
): ServiceRuntime {
  if (active) return active;
  const originalFetch = host.fetch;
  const nativeFetch: BrowserFetch = originalFetch.bind(host);
  const clients = createServiceClients(readBootstrap(source), nativeFetch);
  host.fetch = createRoutingFetch(clients, nativeFetch);

  const runtime: ServiceRuntime = {
    clients,
    stop() {
      if (active !== runtime) return;
      host.fetch = originalFetch;
      active = undefined;
    },
  };
  active = runtime;
  return runtime;
}
