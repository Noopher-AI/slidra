// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar, type TitleBarProps } from "../src/shell/TitleBar.js";

// TitleBar's public boundary is props → the rendered string (same convention
// as export-panel.test.ts). The agent connection indicator (.agent-dot) has
// moved below the chat panel, so those assertions moved to chat-panel-status.test.ts.
function markup(): string {
  const props: TitleBarProps = {
    deckName: "deck.slidra",
    savedStatusText: "Saved",
    editingFrozen: false,
    onUndo: () => {},
    onRedo: () => {},
    onNew: () => {},
    onOpenFile: () => {},
    onSave: () => {},
    exportOpen: false,
    onExportToggle: () => {},
    onExportClose: () => {},
    onExportPick: () => {},
    exportState: { kind: "idle" },
    onExportDismiss: () => {},
    onPlay: () => {},
    onPlayFromStart: () => {},
    canPlay: true,
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
});
