// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar, type TitleBarProps } from "../src/shell/TitleBar.js";

// TitleBar's public boundary is props → the rendered string (same convention
// as export-panel.test.ts). The agent connection indicator (.agent-dot) has
// moved below the chat panel, so those assertions moved to chat-panel-status.test.ts.
function markup(overrides: Partial<TitleBarProps> = {}): string {
  const props: TitleBarProps = {
    deckName: "deck.slidra",
    savedStatusText: "Saved",
    editingFrozen: false,
    onUndo: () => {},
    onRedo: () => {},
    onOpenDeckSpace: () => {},
    exportOpen: false,
    onExportToggle: () => {},
    onExportClose: () => {},
    onExportPick: () => {},
    exportState: { kind: "idle" },
    onExportDismiss: () => {},
    onPlay: () => {},
    onPlayFromStart: () => {},
    canPlay: true,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(TitleBar, props));
}

describe("TitleBar", () => {
  // [E6.T4] AC5: New/Open/Save are gone — Deck Space now owns deck
  // creation/open (and continuous save already replaced manual Save, see
  // the NOOP-422 comment this test absorbs below).
  it("renders a Deck Space button and neither New, Open nor Save", () => {
    const rendered = markup();
    expect(rendered).toContain(">Deck Space</button>");
    expect(rendered).not.toContain(">New</button>");
    expect(rendered).not.toContain(">Open</button>");
    expect(rendered).not.toContain(">Save</button>");
    expect(rendered).not.toContain("⌘S");
  });

  it("no longer renders the connection indicator in the title bar", () => {
    expect(markup()).not.toContain("agent-dot");
  });

  // NOOP-422 §4(c): the three save-status phases each get their own text.
  it.each([
    ["Saved", "Saved"],
    ["Saving…", "Saving…"],
    ["Save failed", "Save failed"],
  ])("shows %s in the title bar's status text", (savedStatusText, expectedText) => {
    const rendered = markup({ savedStatusText });
    expect(rendered).toContain(`>${expectedText}<`);
  });
});
