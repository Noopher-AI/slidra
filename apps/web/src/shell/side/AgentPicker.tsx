// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import type { AgentKind } from "../../live-reload.js";
import type { AgentCardView, AgentConnection, AgentModelOption, AgentUiStatus } from "../../agent-status.js";
import { useCloseFloatingLayer } from "../use-floating-layer.js";

export interface AgentPickerProps {
  /** `GET /api/agent` seen through agent-status.ts; `loading`/`error` have no card to draw, so the agent pill only shows the connection dot. */
  agent: AgentUiStatus;
  /** Connection state of `/api/chat/stream`, drawn as the dot on the left side of the agent pill. */
  agentConnection: AgentConnection;
  /** True while a `GET /api/agent` or `POST /api/agent/probe` is in flight. */
  probing: boolean;
  /** Agent holds the editing lock: switching agents would kill the session mid-edit, so menu items are locked first. */
  editingFrozen: boolean;
  /** The target currently in `POST /api/agent/select`; null when none. */
  switchingKind: AgentKind | null;
  /** Error from the last switch/probe attempt (409 editing, 400, 500, disconnect); null hides it. */
  actionError: string | null;
  onSelectAgent(kind: AgentKind): void;
  onProbe(): void;
  /** Switchable models (the `models` field of `GET /api/agent`) plus the current id; an empty list means the session hasn't been created yet. */
  modelOptions: readonly AgentModelOption[];
  modelId: string | null;
  /** Blocks model changes while the agent is replying (or stopping); the server enforces this too, this just avoids a wasted click. */
  modelsLocked: boolean;
  onSelectModel(modelId: string): void;
  /** When the model menu opens for the first time and the list is still empty: `POST /api/agent/session` creates the session first. */
  onLoadModels(): void;
  /** For tests: which menu starts open (a pure props->markup test can't open state). */
  defaultOpen?: "agent" | "model" | null;
}

type OpenMenu = "agent" | "model" | null;

function cardsFor(status: AgentUiStatus): AgentCardView[] {
  return status.kind === "unset" || status.kind === "unauthenticated" || status.kind === "ready" ? status.agents : [];
}

// The connection dot's text keeps the exact wording from the old title bar/dialog:
// e2e/helpers/launch.ts waits for the `.agent-dot-connected` text to become the
// agent name before treating the connection as complete; "Agent connected" is the
// transitional state it explicitly skips past.
const CONNECTION_LABEL: Record<AgentConnection, string> = {
  connecting: "Agent connecting…",
  connected: "Agent connected",
  disconnected: "Agent disconnected",
};

function connectionText(connection: AgentConnection, label: string | null): string {
  if (connection === "connected" && label !== null) return label;
  return CONNECTION_LABEL[connection];
}

function cardDetail(card: AgentCardView, probing: boolean): string {
  if (probing) return "Checking…";
  if (card.status === "unauthenticated") return card.detail ? `Check failed: ${card.detail}` : `Not signed in · ${card.loginCommand}`;
  return card.inUse ? "In use" : "Available";
}

/**
 * The two pills below the dialog: agent on the left, model on the right, each
 * popping open a small menu above it when clicked. The pill itself only shows
 * "who's current"; options and details live in the menu — this replaces the
 * gear in the bottom-right of the status bar and the whole Settings dialog.
 * Pure props->markup plus one piece of local state for "which menu is open";
 * all HTTP calls live in App.tsx.
 */
export function AgentPicker({
  agent,
  agentConnection,
  probing,
  editingFrozen,
  switchingKind,
  actionError,
  onSelectAgent,
  onProbe,
  modelOptions,
  modelId,
  modelsLocked,
  onSelectModel,
  onLoadModels,
  defaultOpen = null,
}: AgentPickerProps) {
  const [open, setOpen] = useState<OpenMenu>(defaultOpen);
  const agentRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  useCloseFloatingLayer(open !== null, [agentRef, modelRef], () => setOpen(null));

  const cards = cardsFor(agent);
  const label = agent.kind === "ready" || agent.kind === "unauthenticated" ? agent.label : null;
  const ready = agent.kind === "ready";
  const currentModel = modelOptions.find((option) => option.id === modelId) ?? null;

  function toggle(menu: Exclude<OpenMenu, null>): void {
    if (open === menu) {
      setOpen(null);
      return;
    }
    if (menu === "model" && modelOptions.length === 0) onLoadModels();
    setOpen(menu);
  }

  return (
    <div className="chat-status">
      {actionError && <p className="chat-status-error">{actionError}</p>}
      <div className="chat-chips">
        <div className="chat-chip-wrap" ref={agentRef}>
          <button
            type="button"
            className="chat-chip"
            data-chip="agent"
            aria-haspopup="menu"
            aria-expanded={open === "agent"}
            disabled={switchingKind !== null || cards.length === 0}
            onClick={() => toggle("agent")}
          >
            {/* The `.agent-dot` structure and class names are kept verbatim
                (e2e/helpers/launch.ts relies on the `.agent-dot-connected`
                text to detect connection completion). */}
            <span className={`agent-dot agent-dot-${agentConnection}`}>
              <i />
              {switchingKind !== null ? "Switching…" : agent.kind === "unset" ? "Select agent" : connectionText(agentConnection, label)}
            </span>
            {agent.kind === "unauthenticated" && <span className="chat-chip-badge">Not signed in</span>}
            <span className="chat-chip-caret" aria-hidden="true" />
          </button>
          {open === "agent" && (
            <div className="floating-layer chat-chip-menu" role="menu" aria-label="Agent">
              {cards.map((card) => (
                <button
                  key={card.kind}
                  type="button"
                  role="menuitemradio"
                  className="chat-chip-menu-item"
                  data-kind={card.kind}
                  aria-checked={card.inUse}
                  disabled={card.inUse || editingFrozen}
                  onClick={() => {
                    setOpen(null);
                    onSelectAgent(card.kind);
                  }}
                >
                  <span className="chat-chip-menu-title">{card.label}</span>
                  <span className="chat-chip-menu-detail">{cardDetail(card, probing)}</span>
                </button>
              ))}
              {editingFrozen && <p className="chat-chip-menu-hint">The agent is editing — switching will have to wait</p>}
              {agent.kind === "ready" && agent.source === "cli" && <p className="chat-chip-menu-hint">Set via the command line for this session</p>}
              <button type="button" className="chat-chip-menu-action" disabled={probing} onClick={onProbe}>
                {probing ? "Checking…" : "Re-check sign-in status"}
              </button>
            </div>
          )}
        </div>
        {ready && (
          <div className="chat-chip-wrap" ref={modelRef}>
            <button
              type="button"
              className="chat-chip"
              data-chip="model"
              aria-haspopup="menu"
              aria-expanded={open === "model"}
              title={currentModel?.detail}
              disabled={modelsLocked}
              onClick={() => toggle("model")}
            >
              {currentModel?.name ?? "Model"}
              <span className="chat-chip-caret" aria-hidden="true" />
            </button>
            {open === "model" && (
              <div className="floating-layer chat-chip-menu" role="menu" aria-label="Model">
                {modelOptions.length === 0 ? (
                  <p className="chat-chip-menu-hint">Loading models…</p>
                ) : (
                  modelOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      className="chat-chip-menu-item"
                      data-model={option.id}
                      aria-checked={option.id === modelId}
                      disabled={option.id === modelId}
                      onClick={() => {
                        setOpen(null);
                        onSelectModel(option.id);
                      }}
                    >
                      <span className="chat-chip-menu-title">{option.name}</span>
                      {option.detail && <span className="chat-chip-menu-detail">{option.detail}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
