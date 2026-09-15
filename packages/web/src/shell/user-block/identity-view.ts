// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * `@slidra/server`'s identity wire shapes, restated here rather than
 * imported ([E6.T9] — same convention as `live-reload.ts`'s own
 * `SaveStateWire`: the browser bundle never depends on the Node-only
 * server package).
 */
export interface Identity {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ProviderSummary {
  kind: string;
  label: string;
  available: boolean;
}

export type SignInOutcome =
  | { status: "signed-in"; identity: Identity; claimed: number }
  | { status: "pending"; challengeId: string; message: string }
  | { status: "unavailable"; message: string };

/** Falls back to the identity's id when `displayName` is empty — the user block must never render an empty name row (plan §4's `<UserBlock>` behavior table). */
export function displayNameOf(identity: Identity): string {
  return identity.displayName.length > 0 ? identity.displayName : identity.id;
}

/** The circular-avatar fallback's single letter, used whenever `avatarUrl` is null — never a broken image or an empty box. */
export function avatarInitial(identity: Identity): string {
  return displayNameOf(identity).slice(0, 1).toUpperCase();
}

/** "Claimed N decks" / "No decks to claim" — shown right after a claim; `claimed === 0` is its own message, never hidden (plan §4). */
export function claimedMessage(claimed: number): string {
  return claimed === 0 ? "No decks to claim" : `Claimed ${claimed} deck${claimed === 1 ? "" : "s"}`;
}
