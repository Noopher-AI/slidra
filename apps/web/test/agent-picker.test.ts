import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPicker, type AgentPickerProps } from "../src/shell/side/AgentPicker.js";
import type { AgentCardView, AgentUiStatus } from "../src/agent-status.js";

// The two chips below the chat box and their menus: pure props→markup
// (`defaultOpen` lets a static render still show the menu contents). The
// HTTP calls fired on click live in App.tsx and are covered by e2e.

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

describe("AgentPicker: chips (menu closed)", () => {
  it("the agent chip carries the connection light and agent name, the model chip shows the current model; neither expands a menu", () => {
    const html = markup({ modelOptions: models, modelId: "sonnet" });
    const agentChip = chip(html, "agent");
    expect(agentChip).toContain("agent-dot-connected");
    expect(agentChip).toContain("Claude Code");
    expect(agentChip).toContain('aria-expanded="false"');
    expect(chip(html, "model")).toContain("Sonnet");
    expect(html).not.toContain("chat-chip-menu");
  });

  it("connecting / no agent selected / switching: the chip text updates accordingly; an unauthenticated state carries a badge", () => {
    expect(chip(markup({ agentConnection: "connecting" }), "agent")).toContain("Agent connecting…");
    expect(chip(markup({ agent: { kind: "unset", agents: [{ ...claude, inUse: false }, codex] } }), "agent")).toContain("選擇 agent");
    expect(chip(markup({ switchingKind: "codex" }), "agent")).toContain("切換中…");
    const unauthenticated: AgentUiStatus = { kind: "unauthenticated", current: "codex", label: "Codex", loginCommand: "codex login", source: "settings", agents: [{ ...claude, inUse: false }, { ...codex, inUse: true }] };
    const html = markup({ agent: unauthenticated });
    expect(chip(html, "agent")).toContain("未登入");
    // Unauthenticated means there is no session at all: the model chip does not appear.
    expect(html).not.toContain('data-chip="model"');
  });

  it("modelsLocked disables the model chip; the agent chip is disabled while loading; actionError renders as an error row", () => {
    expect(chip(markup({ modelOptions: models, modelId: "sonnet", modelsLocked: true }), "model")).toContain("disabled");
    expect(chip(markup({ agent: { kind: "loading" } }), "agent")).toContain("disabled");
    expect(markup({ actionError: "切換 agent 失敗：連線已中斷" })).toContain('class="chat-status-error"');
  });
});

describe("AgentPicker: agent menu", () => {
  it("one row per agent: the one in use is checked and disabled, an unauthenticated one lists its login command; a re-detect action sits at the bottom", () => {
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

  it("editingFrozen disables every row and shows a hint; while probing, every row reads \"detecting…\"; a cli source shows an extra explanatory line", () => {
    const frozen = markup({ defaultOpen: "agent", editingFrozen: true });
    expect(item(frozen, 'data-kind="codex"')).toContain("disabled");
    expect(frozen).toContain("agent 正在編輯中，切換請稍候");
    expect(markup({ defaultOpen: "agent", probing: true })).toContain("偵測中…");
    expect(markup({ defaultOpen: "agent", agent: { ...ready, source: "cli" } })).toContain("本次由命令列指定");
  });
});

describe("AgentPicker: model menu", () => {
  it("one row per model, name plus description, the current row is checked and disabled", () => {
    const html = markup({ defaultOpen: "model", modelOptions: models, modelId: "sonnet" });
    expect(item(html, 'data-model="sonnet"')).toContain('aria-checked="true"');
    expect(item(html, 'data-model="default"')).toContain("Opus 4.6");
    expect(item(html, 'data-model="default"')).not.toContain("disabled");
  });

  it("shows a loading state before the list has loaded", () => {
    expect(markup({ defaultOpen: "model" })).toContain("載入模型清單…");
  });
});
