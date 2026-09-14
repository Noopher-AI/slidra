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
    onNew: () => {},
    onOpenFile: () => {},
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
  it("positions the New button to the left of Open", () => {
    const rendered = markup();
    expect(rendered).toContain(">New</button>");
    expect(rendered.indexOf(">New</button>")).toBeLessThan(rendered.indexOf(">Open</button>"));
  });

  it("no longer renders the connection indicator in the title bar", () => {
    expect(markup()).not.toContain("agent-dot");
  });

  // NOOP-422 (AC1): continuous save replaced the manual Save button — no
  // keyboard shortcut, and no button anywhere in this component.
  it("renders no Save button and no ⌘S title", () => {
    const rendered = markup();
    expect(rendered).not.toContain(">Save</button>");
    expect(rendered).not.toContain("⌘S");
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
