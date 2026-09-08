import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar, type AgentConnection, type TitleBarProps } from "../src/shell/TitleBar.js";

// TitleBar 的公開邊界是 props → 渲染出的字串（export-panel.test.ts 同一個
// 慣例）。agentStatusText 沒有 export，這裡不直接測它，只測外部看得到的
// class token 與可見文字。
function markupFor(agentConnection: AgentConnection, agentLabel: string | null): string {
  const props: TitleBarProps = {
    deckName: "deck.comot",
    savedStatusText: "Saved",
    agentConnection,
    agentLabel,
    editingFrozen: false,
    onUndo: () => {},
    onRedo: () => {},
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

describe("TitleBar agent 連線指示（NOOP-233 Wave 1 整合驗證）", () => {
  it("connected 且已取得 label：顯示 agent-dot-connected 與 label，不顯示泛用連線文案", () => {
    const markup = markupFor("connected", "Claude Code");
    expect(markup).toContain("agent-dot-connected");
    expect(markup).toContain("Claude Code");
    expect(markup).not.toContain("Agent connected");
  });

  it("connected 但 label 尚未取得（GET /api/agent 還沒回來）：顯示 agent-dot-connected 與泛用連線文案", () => {
    const markup = markupFor("connected", null);
    expect(markup).toContain("agent-dot-connected");
    expect(markup).toContain("Agent connected");
  });

  it("connecting：顯示 agent-dot-connecting 與連線中文案", () => {
    const markup = markupFor("connecting", null);
    expect(markup).toContain("agent-dot-connecting");
    expect(markup).toContain("Agent connecting…");
  });

  it("disconnected：顯示 agent-dot-disconnected 與斷線文案", () => {
    const markup = markupFor("disconnected", null);
    expect(markup).toContain("agent-dot-disconnected");
    expect(markup).toContain("Agent disconnected");
  });
});
