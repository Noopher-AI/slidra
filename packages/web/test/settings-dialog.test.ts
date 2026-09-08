import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsDialog } from "../src/shell/settings/SettingsDialog.js";
import { AgentTab, type AgentTabProps } from "../src/shell/settings/AgentTab.js";
import type { AgentUiStatus } from "../src/agent-status.js";

// SettingsDialog／AgentTab 的公開邊界是 props → renderToStaticMarkup 的字串
// （titlebar.test.ts／export-panel.test.ts 同一個慣例）——不對內部 useState、
// 不對「有沒有呼叫 fetch」寫測試，那是 e2e/agent-settings.test.ts 的範圍
// ([E3.T5] Plan §6.3)。

function agentTabMarkup(overrides: Partial<AgentTabProps> = {}): string {
  const props: AgentTabProps = {
    status: { kind: "unset", agents: [] },
    probing: false,
    editingFrozen: false,
    switchingKind: null,
    switchError: null,
    onSelect: () => {},
    onProbe: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(AgentTab, props));
}

const readyStatus = (source: "cli" | "settings" | "none" = "settings"): AgentUiStatus => ({
  kind: "ready",
  current: "claude",
  label: "Claude Code",
  source,
  agents: [
    {
      kind: "claude",
      label: "Claude Code",
      status: "available",
      loginCommand: "claude auth login",
      inUse: true,
    },
    {
      kind: "codex",
      label: "Codex",
      status: "unauthenticated",
      loginCommand: "codex login",
      inUse: false,
    },
  ],
});

describe("SettingsDialog（[E3.T5] Plan §4.2/§4.3）", () => {
  it("渲染置中對話框骨架：role=dialog、aria-modal、標題，與長度 1 的分頁列（Agent）", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsDialog, {
        onClose: () => {},
        status: { kind: "unset", agents: [] },
        probing: false,
        editingFrozen: false,
        switchingKind: null,
        switchError: null,
        onSelect: () => {},
        onProbe: () => {},
      }),
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("Agent");
    // AgentTab's own content is nested inside — the dialog renders it, not a placeholder.
    expect(markup).toContain("agent-card");
  });
});

describe("AgentTab 卡片狀態機（[E3.T5] Plan §4.4）", () => {
  it("probing：狀態文字為「偵測中…」，依上一次已知結果顯示使用中標記（不清空）", () => {
    const markup = agentTabMarkup({ status: readyStatus(), probing: true });
    expect(markup).toContain("偵測中…");
    expect(markup).toContain("使用中");
  });

  it("unauthenticated 無 detail：「尚未登入」＋ loginCommand 逐字顯示＋複製鈕", () => {
    const markup = agentTabMarkup({
      status: {
        kind: "unset",
        agents: [
          { kind: "claude", label: "Claude Code", status: "unauthenticated", loginCommand: "claude auth login", inUse: false },
          { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login", inUse: false },
        ],
      },
    });
    expect(markup).toContain("尚未登入");
    expect(markup).toContain("codex login");
    expect(markup).toContain("複製");
    expect(markup).not.toContain("偵測失敗");
  });

  it("unauthenticated 帶 detail：「偵測失敗」＋ detail 原文，登入指令仍可複製", () => {
    const markup = agentTabMarkup({
      status: {
        kind: "unset",
        agents: [
          {
            kind: "claude",
            label: "Claude Code",
            status: "unauthenticated",
            loginCommand: "claude auth login",
            detail: "spawn ENOENT",
            inUse: false,
          },
          { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login", inUse: false },
        ],
      },
    });
    expect(markup).toContain("偵測失敗");
    expect(markup).toContain("spawn ENOENT");
    expect(markup).toContain("claude auth login");
  });

  it("available 且 inUse=false：「可用」＋「使用這個」鈕（enabled）", () => {
    const markup = agentTabMarkup({ status: readyStatus() });
    // codex card: available? no — build a status where codex is available and not in use.
    const status: AgentUiStatus = {
      kind: "ready",
      current: "claude",
      label: "Claude Code",
      source: "settings",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login", inUse: true },
        { kind: "codex", label: "Codex", status: "available", loginCommand: "codex login", inUse: false },
      ],
    };
    const markup2 = agentTabMarkup({ status });
    expect(markup2).toContain("使用這個");
    expect(markup2).not.toMatch(/使用這個[^<]*disabled/);
    expect(markup).toContain("可用");
  });

  it("available 且 inUse=true：「可用」＋「使用中」（disabled）＋使用中標記", () => {
    const markup = agentTabMarkup({ status: readyStatus() });
    expect(markup).toContain("可用");
    expect(markup).toContain("使用中");
    expect(markup).toMatch(/disabled[^>]*>\s*使用中|使用中[\s\S]*?disabled/);
  });

  it("unauthenticated 且 inUse=true：「尚未登入」＋使用中標記，不顯示「使用這個」", () => {
    const status: AgentUiStatus = {
      kind: "unauthenticated",
      current: "codex",
      label: "Codex",
      loginCommand: "codex login",
      source: "settings",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login", inUse: false },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login", inUse: true },
      ],
    };
    const markup = agentTabMarkup({ status });
    expect(markup).toContain("尚未登入");
    const codexCardSection = markup.split('data-kind="codex"')[1] ?? "";
    expect(codexCardSection).not.toContain("使用這個");
  });

  it("editingFrozen：「使用這個」disabled 並顯示固定提示", () => {
    const status: AgentUiStatus = {
      kind: "ready",
      current: "claude",
      label: "Claude Code",
      source: "settings",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login", inUse: true },
        { kind: "codex", label: "Codex", status: "available", loginCommand: "codex login", inUse: false },
      ],
    };
    const markup = agentTabMarkup({ status, editingFrozen: true });
    expect(markup).toContain("agent 正在編輯中，請稍候");
  });

  it("source === cli 且 inUse=true：「使用中」旁另外顯示「本次由命令列指定」", () => {
    const markup = agentTabMarkup({ status: readyStatus("cli") });
    expect(markup).toContain("本次由命令列指定");
  });

  it("agents 為空陣列：顯示錯誤列，不畫任何卡片", () => {
    const markup = agentTabMarkup({ status: { kind: "unset", agents: [] } });
    expect(markup).toContain("無法取得 agent 清單");
    expect(markup).not.toContain("agent-card\"");
  });
});
