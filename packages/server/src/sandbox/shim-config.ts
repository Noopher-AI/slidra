// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { randomBytes } from "node:crypto";

/**
 * What every agent process needs to reach `shim-endpoint.ts`'s
 * `POST /api/agent/exec`: a shared secret (checked in constant time on
 * every request) and the server's own base URL. One value per `serve`
 * process, not one per `AgentChatSession` — `agent/session.ts` may only be
 * touched at its two plan-authorized call sites, and threading a
 * per-session value through would need a constructor parameter that
 * ripples into `agent/manager.ts`'s `buildSession()`. Every session in one
 * `serve` process already shares its one sandbox root and one launcher the
 * same way.
 */
export interface ShimConfig {
  readonly token: string;
  readonly baseUrl: string;
}

export function createShimToken(): string {
  return randomBytes(32).toString("hex");
}

let currentConfig: ShimConfig | undefined;

export function setShimConfig(config: ShimConfig | undefined): void {
  currentConfig = config;
}

export function getShimConfig(): ShimConfig | undefined {
  return currentConfig;
}
