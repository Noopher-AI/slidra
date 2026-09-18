// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeckCard, type DeckCardProps } from "../src/shell/deck-space/DeckCard.js";
import { DeckSpace, type DeckSpaceProps } from "../src/shell/deck-space/DeckSpace.js";
import type { DeckSummary } from "../src/shell/deck-space/deck-api.js";
import type { UserBlockProps } from "../src/shell/user-block/UserBlock.js";

// Same convention as titlebar.test.ts/icons.test.ts: the public boundary is
// props → the rendered string. Both components here are deliberately
// presentational (plan §7 decision 3 — every fetch/mutation lives in
// Workspace.tsx instead), so every planned behavior is reachable this way,
// with no need to wait on an effect or mock `fetch`.

const BASE_DECK: DeckSummary = {
  fileName: "deck.slidra",
  name: "My Deck",
  slideCount: 3,
  owner: "Anonymous",
  id: "abc123",
  lastModified: Date.UTC(2026, 0, 15, 12, 0, 0),
};

function cardMarkup(overrides: Partial<DeckCardProps> = {}): string {
  const props: DeckCardProps = {
    deck: BASE_DECK,
    isCurrent: false,
    onOpen: () => {},
    onRename: async () => null,
    onDelete: async () => null,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(DeckCard, props));
}

const BASE_USER_BLOCK: UserBlockProps = {
  identity: null,
  providers: [],
  pending: false,
  message: null,
  onSignIn: () => {},
  onSignOut: () => {},
};

function spaceMarkup(overrides: Partial<DeckSpaceProps> = {}): string {
  const props: DeckSpaceProps = {
    decks: null,
    currentDeckFileName: null,
    canClose: false,
    onClose: () => {},
    errorMessage: null,
    onNewDeck: () => {},
    onOpenFile: () => {},
    onOpenCard: () => {},
    onRename: async () => null,
    onDelete: async () => null,
    userBlock: BASE_USER_BLOCK,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(DeckSpace, props));
}

describe("DeckCard", () => {
  // ① AC2: the card's three required elements, plus lazy-loading the
  // thumbnail (a 50-deck folder must not eagerly fetch every image, AC6).
  it("renders a thumbnail placeholder until credentialed bytes load, plus the deck metadata", () => {
    const rendered = cardMarkup();
    expect(rendered).toContain('class="deck-card-thumb-placeholder"');
    expect(rendered).not.toContain('src="/api/decks/thumbnail');
    expect(rendered).toContain(">My Deck<");
    const expectedModified = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(BASE_DECK.lastModified),
    );
    expect(rendered).toContain(`>${expectedModified}<`);
  });

  // ② plan §4's behavior table: a legal deck with no declared name (or one
  // the CLI could not read) falls back to the file name — never a
  // fabricated "Untitled".
  it("falls back to the file name when the deck has no name", () => {
    const rendered = cardMarkup({ deck: { ...BASE_DECK, name: null } });
    expect(rendered).toContain(">deck.slidra<");
    expect(rendered).not.toContain(">My Deck<");
  });

  // ⑤ plan §4: the currently-open deck's Rename/Delete are disabled, with
  // an explanatory title, rather than reachable and then refused by the
  // server.
  it("disables Rename and Delete on the current card, with an explanatory title", () => {
    const rendered = cardMarkup({ isCurrent: true });
    expect(rendered).toContain(">Current<");
    const renameMatch = rendered.match(/<button[^>]*aria-label="Rename"[^>]*>/);
    const deleteMatch = rendered.match(/<button[^>]*aria-label="Delete"[^>]*>/);
    expect(renameMatch?.[0]).toContain("disabled");
    expect(renameMatch?.[0]).toContain('title="Currently open — enter another deck first"');
    expect(deleteMatch?.[0]).toContain("disabled");
    expect(deleteMatch?.[0]).toContain('title="Currently open — enter another deck first"');
  });
});

describe("DeckSpace", () => {
  // ③ AC4/AC7: New deck + Open file (the toolbar) and Rename + Delete (the
  // first card) — the four action buttons AC7's layout check counts.
  it("renders all four action buttons: New deck, Open file, Rename, and Delete", () => {
    const rendered = spaceMarkup({ decks: [BASE_DECK] });
    expect(rendered).toContain(">New deck<");
    expect(rendered).toContain(">Open file<");
    expect(rendered).toContain('aria-label="Rename"');
    expect(rendered).toContain('aria-label="Delete"');
  });

  // ④ plan §4: an empty deck folder is a legal empty state with a way to
  // create the first deck — never an error.
  it("shows an empty state (with its own New deck action) for an empty deck folder, no error", () => {
    const rendered = spaceMarkup({ decks: [] });
    expect(rendered).toContain("No decks yet.");
    expect(rendered).not.toContain('class="deck-card"');
    expect(rendered).not.toContain('role="alert"');
  });
});
