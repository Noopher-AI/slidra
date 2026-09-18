// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createServiceClients, type ServiceBootstrap } from "../../packages/web/src/service-clients.js";
import { createRoutingFetch } from "../../packages/web/src/service-routing.js";

export async function browserFetch(serverUrl: string, input: string, init?: RequestInit): Promise<Response> {
  const html = await (await fetch(serverUrl)).text();
  const match = html.match(/<script id="slidra-bootstrap" type="application\/json">([^<]+)<\/script>/);
  if (!match) throw new Error("missing editor bootstrap");
  const clients = createServiceClients(JSON.parse(match[1]!) as ServiceBootstrap);
  return createRoutingFetch(clients)(input, init);
}
