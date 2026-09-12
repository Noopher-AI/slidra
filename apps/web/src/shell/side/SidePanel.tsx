// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { KeyboardEvent, ReactNode } from "react";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { StylePagePanel } from "./StylePagePanel.js";
import { StyleObjectPanel } from "./StyleObjectPanel.js";
import { AnimatePagePanel } from "./AnimatePagePanel.js";
import { AnimateObjectPanel } from "./AnimateObjectPanel.js";

export type SideId = "chat" | "style" | "animate";
export type SubId = "page" | "object";

export interface SidePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
  /**
   * Style › Page's Width/Height fields need the current canvas size — this
   * comes from `project.json` (App.tsx's `presentationInfo`), not from
   * `CanvasState` (`Stage.tsx`'s `canvasSize` prop draws on the same data,
   * for the same reason).
   */
  canvasSize: { width: number; height: number } | null;
  /** The chat UI (ChatPanel.tsx), passed through as-is — App.tsx still owns its messages/draft state, so switching tabs never loses it. */
  chat: ReactNode;
  /**
   * D10: controlled — App.tsx is the single source of truth. Both the
   * Dock's Add animation and the context bar's Edit animation need to be
   * able to switch the right column to Animate › Object; both live inside
   * `Stage`, while `SidePanel` sits outside `Stage`, so the state has to
   * live in their common ancestor (App.tsx). The auto-switch effect keyed
   * on whether there's a selection also lives in App.tsx — this component
   * only handles rendering and the user's click/keyboard interaction.
   */
  side: SideId;
  sub: SubId;
  onSideChange(id: SideId): void;
  onSubChange(id: SubId): void;
}

const SIDE_TABS: ReadonlyArray<{ id: SideId; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "style", label: "Style" },
  { id: "animate", label: "Animate" },
];

/**
 * The right column (New v3 skeleton): 3 main tabs (Chat/Style/Animate) plus
 * the Page/Object sub-tab state machine underneath Style/Animate
 * (02-DESIGN_DOC.md §4.4).
 *
 * The sub-tab's auto-switch is keyed purely on the boolean "is there a
 * selection" (the `hasSelection` effect), not on "is the current tab
 * style/animate" — this way, no matter which main tab the user happens to
 * be on, a selection change always prepares the sub-tab state ahead of
 * time; by the time the user switches to style/animate, the correct
 * sub-tab is already showing, with no extra check needed for "was there a
 * selection at the moment of switching tabs." This is exactly the literal
 * meaning of the spec's "auto-switch to object when there's a selection;
 * disable and auto-return to page when there isn't" — it doesn't restrict
 * that to "only takes effect while already on style/animate." The main tab
 * (`side`) is never touched by this effect: the spec explicitly states
 * "changing selection while side=chat does not auto-switch side," so side
 * is left entirely under the user's own click control.
 */
export function SidePanel({ state, controller, canvasSize, chat, side, sub, onSideChange, onSubChange }: SidePanelProps) {
  const hasSelection = state.selection.ids.length > 0;

  function focusSideTab(id: SideId): void {
    document.getElementById(`side-panel-tab-${id}`)?.focus();
  }

  function handleSideKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % SIDE_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + SIDE_TABS.length) % SIDE_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SIDE_TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = SIDE_TABS[nextIndex];
    onSideChange(next.id);
    focusSideTab(next.id);
  }

  const showSub = side === "style" || side === "animate";

  return (
    <div className="side-panel">
      <div className="side-panel-tabs" role="tablist" aria-label="Side panel">
        {SIDE_TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            id={`side-panel-tab-${tab.id}`}
            className="side-panel-tab"
            role="tab"
            data-tab={tab.id}
            aria-selected={side === tab.id}
            aria-controls={`side-panel-panel-${tab.id}`}
            tabIndex={side === tab.id ? 0 : -1}
            onClick={() => onSideChange(tab.id)}
            onKeyDown={(event) => handleSideKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {showSub && (
        <div className="side-panel-subtabs" role="tablist" aria-label="Page / Object">
          <button
            type="button"
            className="side-panel-subtab"
            role="tab"
            data-subtab="page"
            aria-selected={sub === "page"}
            onClick={() => onSubChange("page")}
          >
            Page
          </button>
          <button
            type="button"
            className="side-panel-subtab"
            role="tab"
            data-subtab="object"
            aria-selected={sub === "object"}
            disabled={!hasSelection}
            onClick={() => onSubChange("object")}
          >
            Object
          </button>
        </div>
      )}
      <div
        className="side-panel-tabpanel"
        role="tabpanel"
        id={`side-panel-panel-${side}`}
        aria-labelledby={`side-panel-tab-${side}`}
      >
        {side === "chat" && chat}
        {side === "style" &&
          (sub === "page" ? (
            <StylePagePanel
              pageStyle={state.pageStyle}
              backgroundImage={state.backgroundImage}
              canvasSize={canvasSize}
              controller={controller}
            />
          ) : (
            <StyleObjectPanel state={state} controller={controller} />
          ))}
        {side === "animate" &&
          (sub === "page" ? (
            <AnimatePagePanel state={state} controller={controller} />
          ) : (
            <AnimateObjectPanel state={state} controller={controller} />
          ))}
      </div>
    </div>
  );
}
