import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";
import { StylePanel } from "./StylePanel.js";

export interface SidePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
  /** 對話 JSX, moved verbatim from App.tsx — this component never reads or writes its state. */
  chat: ReactNode;
}

type TabId = "chat" | "style";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "chat", label: "對話" },
  { id: "style", label: "樣式" },
];

/**
 * 側邊面板分頁化 (NOOP-271/#154). Only one of 對話/樣式 is mounted at a
 * time — a conditional render, not `display:none` (A1 requires the other
 * one absent from the DOM). Selection state lives in `state` (App.tsx owns
 * it); 對話's own draft/messages state stays in App.tsx too (plan §3.4),
 * so switching tabs never loses either side's in-progress input.
 */
export function SidePanel({ state, controller, chat }: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("chat");

  const badgeCount = state.selection.elements.filter((element) => element !== null).length;

  function focusTab(id: TabId): void {
    document.getElementById(`side-panel-tab-${id}`)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = TABS[nextIndex];
    setActiveTab(next.id);
    focusTab(next.id);
  }

  return (
    <div className="side-panel">
      <div className="side-panel-tabs" role="tablist">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            id={`side-panel-tab-${tab.id}`}
            className="side-panel-tab"
            role="tab"
            data-tab={tab.id}
            aria-selected={activeTab === tab.id}
            aria-controls={`side-panel-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
            {tab.id === "style" && badgeCount > 0 && <span className="side-panel-badge">{badgeCount}</span>}
          </button>
        ))}
      </div>
      {activeTab === "chat" ? (
        <div
          className="side-panel-tabpanel"
          role="tabpanel"
          id="side-panel-panel-chat"
          aria-labelledby="side-panel-tab-chat"
        >
          {chat}
        </div>
      ) : (
        <div
          className="side-panel-tabpanel"
          role="tabpanel"
          id="side-panel-panel-style"
          aria-labelledby="side-panel-tab-style"
        >
          <StylePanel state={state} controller={controller} />
        </div>
      )}
    </div>
  );
}
