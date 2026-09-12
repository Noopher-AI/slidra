import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar, type TitleBarProps } from "../src/shell/TitleBar.js";

// TitleBar 的公開邊界是 props → 渲染出的字串（export-panel.test.ts 同一個
// 慣例）。agent 連線指示（.agent-dot）已經搬到對話框下面，那組斷言跟著搬到
// chat-panel-status.test.ts。
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
  it("New 鈕排在 Open 左邊", () => {
    const rendered = markup();
    expect(rendered).toContain(">New</button>");
    expect(rendered.indexOf(">New</button>")).toBeLessThan(rendered.indexOf(">Open</button>"));
  });

  it("連線指示已經不在標題列", () => {
    expect(markup()).not.toContain("agent-dot");
  });
});
