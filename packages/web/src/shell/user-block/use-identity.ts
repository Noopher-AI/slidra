// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useState } from "react";
import { claimedMessage, type Identity, type ProviderSummary, type SignInOutcome } from "./identity-view.js";

export interface IdentityState {
  identity: Identity | null;
  providers: ProviderSummary[];
  /** In-flight sign-in/sign-out request — gates the button's `disabled` (plan §4: only a request in flight disables it, "not yet available" never does). */
  pending: boolean;
  /** The last outcome's message: the "not yet available" text, a claim summary, or a two-phase provider's challenge prompt — always shown in the block, never as an alert (plan §4). */
  message: string | null;
  /**
   * Bumped on every identity change (sign-in, switch, sign-out) — [E6.T9]
   * plan §7 decision 8's own contract for Deck Space's deck-list refetch:
   * a caller adds this to its own effect's dependency array to react to an
   * identity change without `<UserBlock>`/`useIdentity` knowing that
   * caller exists.
   */
  epoch: number;
}

export interface UseIdentityResult extends IdentityState {
  /** Signs in with the first registered provider — the only case the shell currently drives from a click (plan §2: no provider-picker UI in scope). A two-phase provider's `pending` outcome surfaces its `message`; completing the challenge is not wired to any UI yet. */
  signIn(): void;
  signOut(): void;
}

const initialState: IdentityState = { identity: null, providers: [], pending: false, message: null, epoch: 0 };

/**
 * Owns `GET /api/identity`'s mount-time load and the sign-in/sign-out
 * requests — `<UserBlock>` itself is pure props-in, so every render state
 * (idle, pending, signed-in, the post-claim message) is expressible
 * without simulating a click, the same reasoning `presentation.ts`'s
 * loader separation follows for `<TitleBar>`.
 *
 * A failed `GET /api/identity` is treated as anonymous with no available
 * provider, silently — same "no error banner for a mount-time GET" rule
 * `App.tsx`'s other mount-time fetches already follow (plan §4).
 */
export function useIdentity(): UseIdentityResult {
  const [state, setState] = useState<IdentityState>(initialState);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/identity");
        if (!response.ok) throw new Error(`GET /api/identity: ${response.status}`);
        const json = (await response.json()) as { identity: Identity | null; providers: ProviderSummary[] };
        if (cancelled) return;
        setState((current) => ({ ...current, identity: json.identity, providers: json.providers }));
      } catch {
        if (cancelled) return;
        setState((current) => ({ ...current, identity: null, providers: [] }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function post(urlPath: string, body: unknown): Promise<unknown> {
    const response = await fetch(urlPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  function signIn(): void {
    setState((current) => {
      const provider = current.providers[0];
      if (!provider || current.pending) return current;
      void (async () => {
        try {
          const outcome = (await post("/api/identity/sign-in", { provider: provider.kind })) as SignInOutcome;
          setState((after) => {
            if (outcome.status === "signed-in") {
              return { ...after, identity: outcome.identity, pending: false, message: claimedMessage(outcome.claimed), epoch: after.epoch + 1 };
            }
            return { ...after, pending: false, message: outcome.message };
          });
        } catch {
          setState((after) => ({ ...after, pending: false, message: "Sign-in failed — try again." }));
        }
      })();
      return { ...current, pending: true };
    });
  }

  function signOut(): void {
    setState((current) => {
      if (current.pending) return current;
      void (async () => {
        try {
          await post("/api/identity/sign-out", {});
        } finally {
          setState((after) => ({ ...after, identity: null, pending: false, message: null, epoch: after.epoch + 1 }));
        }
      })();
      return { ...current, pending: true };
    });
  }

  return { ...state, signIn, signOut };
}
