import { useRef, useState } from "react";
import type { AgentKind } from "../../live-reload.js";
import type { AgentCardView, AgentConnection, AgentModelOption, AgentUiStatus } from "../../agent-status.js";
import { useCloseFloatingLayer } from "../use-floating-layer.js";

export interface AgentPickerProps {
  /** `GET /api/agent` seen through agent-status.ts；`loading`／`error` 沒有卡片可畫，agent 膠囊只顯示連線燈。 */
  agent: AgentUiStatus;
  /** `/api/chat/stream` 的連線狀態，畫在 agent 膠囊左側那顆燈上。 */
  agentConnection: AgentConnection;
  /** True while a `GET /api/agent` or `POST /api/agent/probe` is in flight. */
  probing: boolean;
  /** agent 持有編輯鎖：切換 agent 會殺掉正在編輯的 session，選單裡的項目先鎖住。 */
  editingFrozen: boolean;
  /** 正在 `POST /api/agent/select` 的目標；沒有就是 null。 */
  switchingKind: AgentKind | null;
  /** 上一次切換／偵測失敗的錯誤（409 editing、400、500、斷線）；null 就不顯示。 */
  actionError: string | null;
  onSelectAgent(kind: AgentKind): void;
  onProbe(): void;
  /** 可切換的模型（`GET /api/agent` 的 `models`）與目前的 id；清單為空代表 session 還沒建。 */
  modelOptions: readonly AgentModelOption[];
  modelId: string | null;
  /** agent 回覆中（或停止中）不讓作者改模型；server 也會擋，這只是不讓人白按。 */
  modelsLocked: boolean;
  onSelectModel(modelId: string): void;
  /** 模型選單第一次打開、清單還是空的時候：`POST /api/agent/session` 先把 session 建起來。 */
  onLoadModels(): void;
  /** 測試用：一開始就展開哪個選單（純 props→markup 的測試打不開 state）。 */
  defaultOpen?: "agent" | "model" | null;
}

type OpenMenu = "agent" | "model" | null;

function cardsFor(status: AgentUiStatus): AgentCardView[] {
  return status.kind === "unset" || status.kind === "unauthenticated" || status.kind === "ready" ? status.agents : [];
}

// 連線燈的文字逐字沿用舊的標題列／對話框：e2e/helpers/launch.ts 等到
// `.agent-dot-connected` 的文字變成 agent 名稱才算連線完成，中間的
// "Agent connected" 是它明說要跳過的過渡態。
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
  if (probing) return "偵測中…";
  if (card.status === "unauthenticated") return card.detail ? `偵測失敗：${card.detail}` : `未登入 · ${card.loginCommand}`;
  return card.inUse ? "使用中" : "可用";
}

/**
 * 對話框下方的兩顆膠囊：左邊是 agent、右邊是模型，各自按了往上彈一個小
 * 選單。膠囊平時只寫「目前是誰」，選項與說明都收在選單裡——這取代了狀態列
 * 右下角的齒輪與整個 Settings 對話框。純 props→markup 加一個「哪個選單開
 * 著」的本地 state；所有 HTTP 呼叫都在 App.tsx。
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
            {/* `.agent-dot` 的結構與 class 逐字沿用（e2e/helpers/launch.ts 靠
                `.agent-dot-connected` 的文字判斷連線完成）。 */}
            <span className={`agent-dot agent-dot-${agentConnection}`}>
              <i />
              {switchingKind !== null ? "切換中…" : agent.kind === "unset" ? "選擇 agent" : connectionText(agentConnection, label)}
            </span>
            {agent.kind === "unauthenticated" && <span className="chat-chip-badge">未登入</span>}
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
              {editingFrozen && <p className="chat-chip-menu-hint">agent 正在編輯中，切換請稍候</p>}
              {agent.kind === "ready" && agent.source === "cli" && <p className="chat-chip-menu-hint">本次由命令列指定</p>}
              <button type="button" className="chat-chip-menu-action" disabled={probing} onClick={onProbe}>
                {probing ? "偵測中…" : "重新偵測登入狀態"}
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
              {currentModel?.name ?? "模型"}
              <span className="chat-chip-caret" aria-hidden="true" />
            </button>
            {open === "model" && (
              <div className="floating-layer chat-chip-menu" role="menu" aria-label="模型">
                {modelOptions.length === 0 ? (
                  <p className="chat-chip-menu-hint">載入模型清單…</p>
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
