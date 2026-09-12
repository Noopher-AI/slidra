import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPicker, type AgentPickerProps } from "../src/shell/side/AgentPicker.js";
import type { AgentCardView, AgentUiStatus } from "../src/agent-status.js";

// 對話框下方的兩顆膠囊與它們的選單：純 props→markup（`defaultOpen` 讓靜態
// 渲染也看得到選單內容）。按下去的 HTTP 呼叫在 App.tsx，屬 e2e 的範圍。

const claude: AgentCardView = { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login", inUse: true };
const codex: AgentCardView = { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login", inUse: false };
const ready: AgentUiStatus = { kind: "ready", current: "claude", label: "Claude Code", source: "settings", agents: [claude, codex] };
const models = [{ id: "default", name: "Default (recommended)", detail: "Opus 4.6" }, { id: "sonnet", name: "Sonnet" }];

function markup(overrides: Partial<AgentPickerProps> = {}): string {
  const props: AgentPickerProps = {
    agent: ready,
    agentConnection: "connected",
    probing: false,
    editingFrozen: false,
    switchingKind: null,
    actionError: null,
    onSelectAgent: () => {},
    onProbe: () => {},
    modelOptions: [],
    modelId: null,
    modelsLocked: false,
    onSelectModel: () => {},
    onLoadModels: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(AgentPicker, props));
}

function chip(html: string, name: string): string {
  const index = html.indexOf(`data-chip="${name}"`);
  return html.slice(html.lastIndexOf("<button", index), html.indexOf("</button>", index));
}

function item(html: string, attr: string): string {
  const index = html.indexOf(attr);
  return html.slice(html.lastIndexOf("<button", index), html.indexOf("</button>", index));
}

describe("AgentPicker：膠囊（選單關著）", () => {
  it("agent 膠囊裝著連線燈與 agent 名稱，模型膠囊寫目前的模型；兩者都不展開選單", () => {
    const html = markup({ modelOptions: models, modelId: "sonnet" });
    const agentChip = chip(html, "agent");
    expect(agentChip).toContain("agent-dot-connected");
    expect(agentChip).toContain("Claude Code");
    expect(agentChip).toContain('aria-expanded="false"');
    expect(chip(html, "model")).toContain("Sonnet");
    expect(html).not.toContain("chat-chip-menu");
  });

  it("連線中／未選 agent／切換中：膠囊文字跟著變；未登入時帶「未登入」徽章", () => {
    expect(chip(markup({ agentConnection: "connecting" }), "agent")).toContain("Agent connecting…");
    expect(chip(markup({ agent: { kind: "unset", agents: [{ ...claude, inUse: false }, codex] } }), "agent")).toContain("選擇 agent");
    expect(chip(markup({ switchingKind: "codex" }), "agent")).toContain("切換中…");
    const unauthenticated: AgentUiStatus = { kind: "unauthenticated", current: "codex", label: "Codex", loginCommand: "codex login", source: "settings", agents: [{ ...claude, inUse: false }, { ...codex, inUse: true }] };
    const html = markup({ agent: unauthenticated });
    expect(chip(html, "agent")).toContain("未登入");
    // 未登入沒有 session 可言：模型膠囊不出現。
    expect(html).not.toContain('data-chip="model"');
  });

  it("modelsLocked 鎖住模型膠囊；loading 時 agent 膠囊停用；actionError 顯示成錯誤列", () => {
    expect(chip(markup({ modelOptions: models, modelId: "sonnet", modelsLocked: true }), "model")).toContain("disabled");
    expect(chip(markup({ agent: { kind: "loading" } }), "agent")).toContain("disabled");
    expect(markup({ actionError: "切換 agent 失敗：連線已中斷" })).toContain('class="chat-status-error"');
  });
});

describe("AgentPicker：agent 選單", () => {
  it("每個 agent 一列：使用中的打勾且停用，未登入的列出登入指令；底部有重新偵測", () => {
    const html = markup({ defaultOpen: "agent" });
    const claudeItem = item(html, 'data-kind="claude"');
    expect(claudeItem).toContain('aria-checked="true"');
    expect(claudeItem).toContain("disabled");
    expect(claudeItem).toContain("使用中");
    const codexItem = item(html, 'data-kind="codex"');
    expect(codexItem).toContain('aria-checked="false"');
    expect(codexItem).not.toContain("disabled");
    expect(codexItem).toContain("未登入 · codex login");
    expect(html).toContain("重新偵測登入狀態");
  });

  it("editingFrozen 停用所有列並顯示提示；probing 時每列寫「偵測中…」；cli 來源另有一行說明", () => {
    const frozen = markup({ defaultOpen: "agent", editingFrozen: true });
    expect(item(frozen, 'data-kind="codex"')).toContain("disabled");
    expect(frozen).toContain("agent 正在編輯中，切換請稍候");
    expect(markup({ defaultOpen: "agent", probing: true })).toContain("偵測中…");
    expect(markup({ defaultOpen: "agent", agent: { ...ready, source: "cli" } })).toContain("本次由命令列指定");
  });
});

describe("AgentPicker：模型選單", () => {
  it("每個模型一列，名稱加說明，目前的那列打勾且停用", () => {
    const html = markup({ defaultOpen: "model", modelOptions: models, modelId: "sonnet" });
    expect(item(html, 'data-model="sonnet"')).toContain('aria-checked="true"');
    expect(item(html, 'data-model="default"')).toContain("Opus 4.6");
    expect(item(html, 'data-model="default"')).not.toContain("disabled");
  });

  it("清單還沒載入時顯示載入中", () => {
    expect(markup({ defaultOpen: "model" })).toContain("載入模型清單…");
  });
});
