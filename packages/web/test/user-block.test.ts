// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserBlock, type UserBlockProps } from "../src/shell/user-block/UserBlock.js";
import { Rail, type RailProps } from "../src/shell/Rail.js";
import { DeckSpace, type DeckSpaceProps } from "../src/shell/deck-space/DeckSpace.js";

// UserBlock's public boundary is props → the rendered string (same
// convention as titlebar.test.ts/export-panel.test.ts) — every render
// state (AC1's unavailable badge, AC5's signed-in three-piece, the avatar
// fallbacks) is reachable from props alone, `use-identity.ts`'s fetches
// are never exercised here.
function userBlockMarkup(overrides: Partial<UserBlockProps> = {}): string {
  const props: UserBlockProps = {
    identity: null,
    providers: [],
    pending: false,
    message: null,
    onSignIn: () => {},
    onSignOut: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(UserBlock, props));
}

describe("UserBlock", () => {
  it("AC1: signed out with no available provider shows Sign in, aria-disabled (never the disabled attribute), and a not-yet-available hint", () => {
    const rendered = userBlockMarkup({ providers: [{ kind: "anonymous", label: "Sign in", available: false }] });
    expect(rendered).toContain(">Sign in<");
    expect(rendered).toContain('aria-disabled="true"');
    expect(rendered).not.toContain('disabled=""');
    expect(rendered).toContain("Not yet available");
  });

  it("AC5: signed in renders the avatar, display name, and a Sign out button together", () => {
    const rendered = userBlockMarkup({
      identity: { id: "alice", displayName: "Alice", avatarUrl: "https://example.com/alice.png" },
    });
    expect(rendered).toContain("Alice");
    expect(rendered).toContain(">Sign out</button>");
    expect(rendered).toContain('<img class="user-block-avatar-image" src="https://example.com/alice.png"');
  });

  it("falls back to an initial when avatarUrl is null — never a broken image or an empty box", () => {
    const rendered = userBlockMarkup({ identity: { id: "alice", displayName: "Alice", avatarUrl: null } });
    expect(rendered).not.toContain("<img");
    expect(rendered).toContain(">A<");
  });

  it('falls back to the identity id when displayName is ""', () => {
    const rendered = userBlockMarkup({ identity: { id: "alice-id", displayName: "", avatarUrl: null } });
    expect(rendered).toContain("alice-id");
    expect(rendered).toContain(">A<");
  });
});

function railMarkup(overrides: Partial<RailProps> = {}): string {
  const props: RailProps = {
    containerRef: createRef<HTMLElement>(),
    slideCount: 0,
    slides: [],
    currentIndex: -1,
    runCommand: async () => undefined,
    runPageCommand: async () => undefined,
    contextMenuRequest: null,
    onCloseContextMenu: () => {},
    onDraftWithAgent: () => {},
    pageSource: "slides",
    editingFrozen: false,
    onEnterMasterMode: () => {},
    onExitMasterMode: () => {},
    onApplyTemplateToSlides: () => {},
    userBlock: { identity: null, providers: [], pending: false, message: null, onSignIn: () => {}, onSignOut: () => {} },
    ...overrides,
  };
  return renderToStaticMarkup(createElement(Rail, props));
}

describe("Rail — AC6①: the user block mounts at the bottom of the rail", () => {
  it("renders .user-block after .overview, the same slot in every mode", () => {
    const rendered = railMarkup();
    expect(rendered).toContain('class="overview"');
    expect(rendered).toContain('class="user-block"');
    expect(rendered.indexOf('class="overview"')).toBeLessThan(rendered.indexOf('class="user-block"'));
  });
});

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
    userBlock: { identity: null, providers: [], pending: false, message: null, onSignIn: () => {}, onSignOut: () => {} },
    ...overrides,
  };
  return renderToStaticMarkup(createElement(DeckSpace, props));
}

describe("DeckSpace — AC6②: the user block mounts in the existing .deck-space-user-slot", () => {
  it("renders .user-block inside .deck-space-user-slot", () => {
    const rendered = spaceMarkup();
    expect(rendered).toContain('class="deck-space-user-slot"');
    expect(rendered).toContain('class="user-block"');
    expect(rendered.indexOf('class="deck-space-user-slot"')).toBeLessThan(rendered.indexOf('class="user-block"'));
  });
});
