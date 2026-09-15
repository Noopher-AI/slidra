// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { SlidraError } from "../slidra/errors.js";
import type { IdentityProvider, SignInOutcome } from "./types.js";

/**
 * Test-only identity provider ([E6.T9] plan §7 decision 7): only ever
 * injected through `ServeOptions.identity.providers`, never registered by
 * `cli.ts`. Signs in synchronously from a body of `{identity: "<id>"}` —
 * no network, no persistence, no pending step. `displayName` is just the
 * id (a real provider would carry a human name) and `avatarUrl` is always
 * null, so tests exercising the user block's avatar fallback don't need a
 * second fixture.
 */
export function createFakeProvider(): IdentityProvider {
  return {
    kind: "fake",
    label: "Fake sign-in (tests only)",
    available: true,
    async begin(req: Record<string, unknown>): Promise<SignInOutcome> {
      const id = req.identity;
      if (typeof id !== "string" || id.length === 0) {
        throw new SlidraError('fake provider requires a string "identity" field');
      }
      return { status: "signed-in", identity: { id, displayName: id, avatarUrl: null } };
    },
    async complete(): Promise<SignInOutcome> {
      throw new SlidraError("this provider has no pending step");
    },
    async signOut(): Promise<void> {},
  };
}
