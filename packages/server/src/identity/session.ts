// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { SlidraNotFoundError } from "../slidra/errors.js";
import { claimAnonymous, isAnonymousOwner, type DeckListEntry, type DeckStore } from "../storage/deck-store.js";
import type { Identity, IdentityProvider, SignInOutcome } from "./types.js";

export interface ProviderSummary {
  kind: string;
  label: string;
  available: boolean;
}

/** `SignInOutcome` plus the claim side effect's count — only ever present on `status: "signed-in"`. */
export type IdentityOutcome = SignInOutcome & { claimed?: number };

/**
 * The one place "who is currently signed in" lives — in-process memory
 * only ([E6.T9] plan §2/§7 decision 6: no `settings.json` write, no
 * cookie; a `serve` restart returns to anonymous by design). Every
 * `IdentityProvider` registered with it is wrapped in the same claim
 * policy (plan §7 decisions 4/5):
 *
 * - a `signed-in` outcome tags the identity `${kind}:${id}` and reassigns
 *   every currently-anonymous deck (`isAnonymousOwner` — see below) onto
 *   that tag ("claim");
 * - re-signing into the identity already current is a no-op (`claimed: 0`,
 *   never re-claims — idempotent, matches the plan's behavior table);
 * - the visible deck set for `GET /api/decks` (no `?owner=`) is always the
 *   union of anonymous decks (`isAnonymousOwner`: the literal
 *   `ANONYMOUS_OWNER` tag or `owner: null` — [E6.T14r2] Plan §7 decision 1)
 *   and the current tag, so decks stay visible through the moment they're
 *   claimed rather than blinking away.
 */
export interface IdentitySession {
  providers(): ProviderSummary[];
  currentIdentity(): Identity | null;
  signIn(kind: string, body: Record<string, unknown>): Promise<IdentityOutcome>;
  complete(kind: string, challengeId: string, proof: string): Promise<IdentityOutcome>;
  signOut(): Promise<void>;
  visibleDecks(): Promise<DeckListEntry[]>;
}

export function createIdentitySession(providers: readonly IdentityProvider[], store: DeckStore): IdentitySession {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider] as const));
  let current: { kind: string; identity: Identity } | null = null;

  function ownerTag(kind: string, identity: Identity): string {
    return `${kind}:${identity.id}`;
  }

  function requireProvider(kind: string): IdentityProvider {
    const provider = byKind.get(kind);
    if (!provider) throw new SlidraNotFoundError(`no identity provider: ${kind}`);
    return provider;
  }

  // A claim failure partway through (deck-store.ts's claimAnonymous)
  // surfaces to the caller as a thrown error — but `current` is already
  // updated to the new identity before the claim call below, deliberately:
  // the decks the claim already reassigned are real, permanent ownership
  // changes that are never rolled back (deck-store.ts's own contract), so
  // reverting the identity switch on top of that would hide decks the
  // *new* identity now legitimately owns behind the *old* one.
  async function applyOutcome(kind: string, outcome: SignInOutcome): Promise<IdentityOutcome> {
    if (outcome.status !== "signed-in") return outcome;
    if (current !== null && current.kind === kind && current.identity.id === outcome.identity.id) {
      return { ...outcome, claimed: 0 };
    }
    current = { kind, identity: outcome.identity };
    const claimed = await claimAnonymous(ownerTag(kind, outcome.identity));
    return { ...outcome, claimed };
  }

  return {
    providers(): ProviderSummary[] {
      return providers.map((provider) => ({ kind: provider.kind, label: provider.label, available: provider.available }));
    },

    currentIdentity(): Identity | null {
      return current?.identity ?? null;
    },

    async signIn(kind: string, body: Record<string, unknown>): Promise<IdentityOutcome> {
      const provider = requireProvider(kind);
      const outcome = await provider.begin(body);
      return applyOutcome(kind, outcome);
    },

    async complete(kind: string, challengeId: string, proof: string): Promise<IdentityOutcome> {
      const provider = requireProvider(kind);
      const outcome = await provider.complete(challengeId, proof);
      return applyOutcome(kind, outcome);
    },

    async signOut(): Promise<void> {
      if (current === null) return;
      const provider = byKind.get(current.kind);
      const identity = current.identity;
      current = null;
      await provider?.signOut(identity);
    },

    async visibleDecks(): Promise<DeckListEntry[]> {
      const all = await store.list();
      const tag = current === null ? null : ownerTag(current.kind, current.identity);
      return all
        .filter((entry) => isAnonymousOwner(entry.owner) || (tag !== null && entry.owner === tag))
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
    },
  };
}
