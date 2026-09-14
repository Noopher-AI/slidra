// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
const pi: AgentCardView = { kind: "pi", label: "Pi (Local Qwen)", status: "available", loginCommand: "ollama run qwen2.5-coder:7b", inUse: false };
const ready: AgentUiStatus = { kind: "ready", current: "claude", label: "Claude Code", source: "settings", agents: [claude, codex, pi] };
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
    expect(chip(markup({ agent: { kind: "unset", agents: [{ ...claude, inUse: false }, codex, pi] } }), "agent")).toContain("Select agent");
    expect(chip(markup({ switchingKind: "codex" }), "agent")).toContain("Switching…");
    const unauthenticated: AgentUiStatus = { kind: "unauthenticated", current: "codex", label: "Codex", loginCommand: "codex login", source: "settings", agents: [{ ...claude, inUse: false }, { ...codex, inUse: true }, pi] };
    const html = markup({ agent: unauthenticated });
    expect(chip(html, "agent")).toContain("Not signed in");
    // Unauthenticated means there is no session at all: the model chip does not appear.
    expect(html).not.toContain('data-chip="model"');
  });

  it("modelsLocked disables the model chip; the agent chip is disabled while loading; actionError renders as an error row", () => {
    expect(chip(markup({ modelOptions: models, modelId: "sonnet", modelsLocked: true }), "model")).toContain("disabled");
    expect(chip(markup({ agent: { kind: "loading" } }), "agent")).toContain("disabled");
    expect(markup({ actionError: "Failed to switch agent: connection lost" })).toContain('class="chat-status-error"');
  });
});

describe("AgentPicker: agent menu", () => {
  it("one row per agent: the one in use is checked and disabled, an unauthenticated one lists its login command; a re-detect action sits at the bottom", () => {
    const html = markup({ defaultOpen: "agent" });
    const claudeItem = item(html, 'data-kind="claude"');
    expect(claudeItem).toContain('aria-checked="true"');
    expect(claudeItem).toContain("disabled");
    expect(claudeItem).toContain("In use");
    const codexItem = item(html, 'data-kind="codex"');
    expect(codexItem).toContain('aria-checked="false"');
    expect(codexItem).not.toContain("disabled");
    expect(codexItem).toContain("Not signed in · codex login");
    const piItem = item(html, 'data-kind="pi"');
    expect(piItem).toContain("Pi (Local Qwen)");
    expect(piItem).toContain("Available");
    expect(html).toContain("Re-check sign-in status");
  });

  it("editingFrozen disables every row and shows a hint; while probing, every row reads \"detecting…\"; a cli source shows an extra explanatory line", () => {
    const frozen = markup({ defaultOpen: "agent", editingFrozen: true });
    expect(item(frozen, 'data-kind="codex"')).toContain("disabled");
    expect(frozen).toContain("The agent is editing — switching will have to wait");
    expect(markup({ defaultOpen: "agent", probing: true })).toContain("Checking…");
    expect(markup({ defaultOpen: "agent", agent: { ...ready, source: "cli" } })).toContain("Set via the command line for this session");
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
    expect(markup({ defaultOpen: "model" })).toContain("Loading models…");
  });
});
