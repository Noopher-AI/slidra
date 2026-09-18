// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { timingSafeEqual } from "node:crypto";

export const RUNNER_SESSION_HEADER = "x-slidra-runner-session";
/** Routes owned by the browser-facing agent runner rather than the deck server. */
export function isRunnerRoute(pathname: string): boolean {
  return ["/api/chat", "/api/agent", "/api/export", "/api/events"].some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}


/** Exact, header-only authentication seam for the agent runner HTTP service. */
export function runnerSessionAuthorized(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string,
): boolean {
  const supplied = headers[RUNNER_SESSION_HEADER];
  if (typeof supplied !== "string" || supplied.length === 0 || expectedToken.length === 0) return false;
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expectedToken);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
