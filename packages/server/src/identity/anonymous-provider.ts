// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { SlidraError } from "../slidra/errors.js";
import type { IdentityProvider, SignInOutcome } from "./types.js";

/**
 * The only provider `cli.ts` ever registers in production ([E6.T9] plan §2
 * scope: "local anonymous, used in production" is itself a provider
 * implementation, not an empty provider list). No real sign-in exists yet
 * — this always answers `unavailable` (AC1) rather than pretending to
 * offer one. Once a real provider (Email Magic Link) ships, this one
 * keeps existing unchanged; it never becomes `available`.
 */
export function createAnonymousProvider(): IdentityProvider {
  return {
    kind: "anonymous",
    label: "Sign in",
    available: false,
    async begin(): Promise<SignInOutcome> {
      return { status: "unavailable", message: "Sign-in isn't available yet." };
    },
    async complete(): Promise<SignInOutcome> {
      throw new SlidraError("this provider has no pending step");
    },
    async signOut(): Promise<void> {},
  };
}
