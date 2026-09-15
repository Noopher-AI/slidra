// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { avatarInitial, displayNameOf, type Identity, type ProviderSummary } from "./identity-view.js";

export interface UserBlockProps {
  identity: Identity | null;
  providers: ProviderSummary[];
  /** A sign-in/sign-out request in flight — the only condition that disables the button (plan §4: "not yet available" never does, or AC1's "activating it gives a clear response" could never fire). */
  pending: boolean;
  message: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
}

/**
 * The left rail's bottom-mounted identity block (plan §1/§7 decision 8):
 * same component, same props, at the same position in the editor's
 * `<Rail>` and Deck Space's own left column — never two implementations to
 * keep in sync. Pure props-in, no fetch of its own (`use-identity.ts` owns
 * that) — every render state below is reachable from props alone, which is
 * what lets `identity.test.ts`'s sibling `user-block.test.ts` cover them
 * with `renderToStaticMarkup` instead of a browser.
 */
export function UserBlock({ identity, providers, pending, message, onSignIn, onSignOut }: UserBlockProps) {
  if (identity !== null) {
    return (
      <div className="user-block">
        <span className="user-block-avatar">
          {identity.avatarUrl !== null ? (
            <img className="user-block-avatar-image" src={identity.avatarUrl} alt="" />
          ) : (
            <span className="user-block-avatar-fallback" aria-hidden="true">
              {avatarInitial(identity)}
            </span>
          )}
        </span>
        <span className="user-block-name">{displayNameOf(identity)}</span>
        <button type="button" className="user-block-signout" disabled={pending} onClick={onSignOut}>
          Sign out
        </button>
        {message !== null && <div className="user-block-message">{message}</div>}
      </div>
    );
  }

  // AC1: no provider list yet (mount-time GET still in flight, or it
  // failed) reads the same as "no available provider" — a disabled-look
  // badge, never a crash on `providers[0]`.
  const provider = providers[0];
  const available = provider?.available ?? false;

  return (
    <div className="user-block">
      <button
        type="button"
        className="user-block-signin"
        // Never the `disabled` attribute for "not yet available" — AC1
        // requires a click here to still reach the server and show its
        // response, which an actually-disabled button could never do.
        aria-disabled={available ? undefined : "true"}
        disabled={pending}
        onClick={onSignIn}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {!available && <span className="user-block-hint">Not yet available</span>}
      {message !== null && <div className="user-block-message">{message}</div>}
    </div>
  );
}
