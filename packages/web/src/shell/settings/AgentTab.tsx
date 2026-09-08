import { useState } from "react";
import type { AgentKind } from "../../live-reload.js";
import type { AgentCardView, AgentUiStatus } from "../../agent-status.js";

/** How long "已複製" replaces the copy button's label before reverting (Plan §4.4) — a plain millisecond count in TS, not a CSS duration string, so design-contract.test.ts's literal-`ms` scan (which only matches text like `2000ms`) never sees it. */
const COPY_RESET_MS = 2000;

export interface AgentTabProps {
  /** `GET /api/agent` seen through agent-status.ts. `loading`/`error` (no `agents` array yet) render the same "無法取得 agent 清單" row an empty `agents[]` would (Plan §4.4's last row covers the array-shape case; this extends the same fallback to "haven't loaded at all"). */
  status: AgentUiStatus;
  /** True while a `GET /api/agent` or `POST /api/agent/probe` is in flight (Plan §4.4 row 1). */
  probing: boolean;
  /** T5/NOOP-93/#110: agent holds the single-editor lock (Plan §4.4 row 7). */
  editingFrozen: boolean;
  /** The card whose "使用這個" is mid-`POST /api/agent/select` ("切換中…", Plan §4.5 step 1) — `null` when no switch is in flight. */
  switchingKind: AgentKind | null;
  /** The select request's own error strip (409 editing / 400 / 500 / network) — `null` when there is none to show (Plan §4.5 steps 4/5). */
  switchError: string | null;
  onSelect(kind: AgentKind): void;
  onProbe(): void;
}

function cardsFor(status: AgentUiStatus): AgentCardView[] {
  return status.kind === "unset" || status.kind === "unauthenticated" || status.kind === "ready" ? status.agents : [];
}

function sourceFor(status: AgentUiStatus): "cli" | "settings" | "none" | null {
  return status.kind === "unauthenticated" || status.kind === "ready" ? status.source : null;
}

/** One agent card's copy button — local "已複製"/"複製失敗" feedback is this button's own transient UI state, never lifted to props (Plan §6.3: only props→markup is tested at the unit level; this interaction is e2e/agent-settings.test.ts's A1). */
function CopyLoginCommandButton({ loginCommand }: { loginCommand: string }) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(loginCommand);
      setFeedback("copied");
      setTimeout(() => setFeedback("idle"), COPY_RESET_MS);
    } catch {
      // No `document.execCommand` fallback (Plan §4.4) — an honest failure
      // notice instead of pretending the clipboard write worked.
      setFeedback("failed");
    }
  }

  return (
    <span className="agent-card-login">
      <code className="agent-card-login-command">{loginCommand}</code>
      <button type="button" className="agent-card-copy-button" onClick={() => void handleCopy()}>
        {feedback === "copied" ? "已複製" : "複製"}
      </button>
      {feedback === "failed" && <span className="agent-card-copy-error">複製失敗，請手動選取</span>}
    </span>
  );
}

function AgentCard({
  card,
  probing,
  editingFrozen,
  switchingKind,
  source,
  onSelect,
}: {
  card: AgentCardView;
  probing: boolean;
  editingFrozen: boolean;
  switchingKind: AgentKind | null;
  source: "cli" | "settings" | "none" | null;
  onSelect(kind: AgentKind): void;
}) {
  const statusText = probing ? "偵測中…" : card.status === "available" ? "可用" : card.detail ? "偵測失敗" : "尚未登入";
  const switching = switchingKind === card.kind;
  const showUseButton = card.status === "available" && !card.inUse;
  const showInUseButton = card.status === "available" && card.inUse;
  const showLogin = card.status === "unauthenticated";
  const showCliBadge = source === "cli" && card.inUse;

  return (
    <div className="agent-card" data-kind={card.kind}>
      <div className="agent-card-header">
        <span className="agent-card-label">{card.label}</span>
        {card.inUse && <span className="agent-card-in-use-badge">使用中</span>}
        {showCliBadge && <span className="agent-card-cli-badge">本次由命令列指定</span>}
      </div>
      <p className="agent-card-status">{statusText}</p>
      {statusText === "偵測失敗" && card.detail && <p className="agent-card-detail">{card.detail}</p>}
      {showLogin && <CopyLoginCommandButton loginCommand={card.loginCommand} />}
      <div className="agent-card-actions">
        {showUseButton && (
          <>
            <button
              type="button"
              className="agent-card-use-button"
              disabled={probing || editingFrozen || switchingKind !== null}
              onClick={() => onSelect(card.kind)}
            >
              {switching ? "切換中…" : "使用這個"}
            </button>
            {editingFrozen && <p className="agent-card-frozen-hint">agent 正在編輯中，請稍候</p>}
          </>
        )}
        {showInUseButton && (
          <button type="button" className="agent-card-use-button" disabled>
            使用中
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The Agent settings tab's two cards (Plan §4.4). Pure props→markup for the
 * card state machine itself; `onSelect`/`onProbe` are the only escape
 * hatches to the outside world — App.tsx owns the actual
 * `POST /api/agent/select` / `POST /api/agent/probe` calls and the
 * `switchingKind`/`switchError` state those produce (Plan §4.5).
 */
export function AgentTab({ status, probing, editingFrozen, switchingKind, switchError, onSelect, onProbe }: AgentTabProps) {
  const cards = cardsFor(status);
  const source = sourceFor(status);

  return (
    <div className="agent-tab">
      <div className="agent-tab-header">
        <button type="button" className="agent-tab-probe-button" disabled={probing} onClick={onProbe}>
          重新偵測
        </button>
      </div>
      {cards.length === 0 ? (
        <p className="agent-card-error">無法取得 agent 清單</p>
      ) : (
        <div className="agent-card-list">
          {cards.map((card) => (
            <AgentCard
              key={card.kind}
              card={card}
              probing={probing}
              editingFrozen={editingFrozen}
              switchingKind={switchingKind}
              source={source}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {switchError && <p className="agent-tab-switch-error">{switchError}</p>}
    </div>
  );
}
