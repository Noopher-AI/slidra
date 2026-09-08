import { useEffect, useState, type MouseEvent } from "react";
import { AgentTab, type AgentTabProps } from "./AgentTab.js";

interface SettingsTabDef {
  id: string;
  label: string;
}

/** [E3.T5] Plan §2 邊界 1: this ticket ships exactly one tab. A length-1 array (not a hardcoded single element) is enough to render the tab list generically — no registration mechanism for tabs that don't exist yet. */
const SETTINGS_TABS: SettingsTabDef[] = [{ id: "agent", label: "Agent" }];

export interface SettingsDialogProps extends AgentTabProps {
  onClose(): void;
}

/**
 * The settings dialog shell (Plan §3.6/D2): a centred modal over a full
 * mask, closed by Esc or a mousedown directly on the mask — copied from
 * `shell/rail/OutlineModal.tsx`'s own mechanism rather than
 * `useCloseFloatingLayer` (that hook is for anchored popovers whose own
 * mask isn't the entire viewport; here the mask itself already *is* "click
 * outside").
 */
export function SettingsDialog({ onClose, ...agentTabProps }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState(SETTINGS_TABS[0].id);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function onMaskMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="settings-dialog-mask" onMouseDown={onMaskMouseDown}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="settings-dialog">
        <div className="settings-dialog-header">
          <h2 className="settings-dialog-title">Settings</h2>
          <button type="button" className="settings-dialog-close" aria-label="Close" autoFocus onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-dialog-body">
          <nav className="settings-tabs" role="tablist" aria-label="Settings tabs">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className="settings-tab"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="settings-tab-panel" role="tabpanel">
            {activeTab === "agent" && <AgentTab {...agentTabProps} />}
          </div>
        </div>
      </div>
    </div>
  );
}
