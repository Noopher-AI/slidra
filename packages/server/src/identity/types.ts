// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * `IdentityProvider`'s public boundary ([E6.T9] plan §3/§7 decision 3): a
 * signed-in user, however the provider that signed them in identifies
 * itself. `avatarUrl` is nullable on purpose — most providers (`fake`, a
 * future email-only one) have no picture to offer, and the user block
 * falls back to an initial rather than treating that as an error.
 */
export interface Identity {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * What a provider's `begin()`/`complete()` step produced. Three shapes,
 * never a caller-visible error for the first two:
 * - `signed-in`: the identity to switch to.
 * - `pending`: a two-phase provider's first step (Email Magic Link's
 *   shape, plan §7 decision 3) — the caller must call `complete()` with
 *   `challengeId` and whatever proof the provider asked for in `message`.
 * - `unavailable`: the provider exists but is not offering sign-in right
 *   now (production's `anonymous` provider, until a real one ships) — AC1
 *   requires this to be a clear, non-error response, not a thrown error.
 */
export type SignInOutcome =
  | { status: "signed-in"; identity: Identity }
  | { status: "pending"; challengeId: string; message: string }
  | { status: "unavailable"; message: string };

/**
 * The interface every identity provider implements — AC7's contract:
 * adding a second provider is implementing this interface and adding it to
 * `ServeOptions.identity.providers`, nothing else changes (routes,
 * session, claim logic, and the web `UserBlock` are all provider-agnostic).
 * Two-phase by construction so Email Magic Link fits without reshaping the
 * interface later: a provider that signs in synchronously (`anonymous`,
 * `fake`) simply never returns `pending` from `begin()`, and its
 * `complete()` always throws — there is no pending step to complete.
 */
export interface IdentityProvider {
  readonly kind: string;
  readonly label: string;
  readonly available: boolean;
  begin(req: Record<string, unknown>): Promise<SignInOutcome>;
  complete(challengeId: string, proof: string): Promise<SignInOutcome>;
  signOut(identity: Identity): Promise<void>;
}
