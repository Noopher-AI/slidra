import type { AgentKind } from "./live-reload.js";

/**
 * [E3.T5] NOOP-230 §4.4's `GET /api/agent` / `POST /api/agent/probe`
 * response, restated here as the exact shape this module parses (never
 * imported from `@co-motion/server` — the browser bundle must never depend
 * on a Node-only package, same rule `ExportFormat`/`AgentKind` in
 * live-reload.ts already follow).
 */
/**
 * 對話框下方那顆狀態燈的三態，從 `/api/chat/stream` 的 `streamReady` 推導
 * （App.tsx）。以前住在 TitleBar，`.agent-dot` 搬到對話框下面之後，型別跟
 * 著搬到這裡——它描述的是 agent 狀態，不是標題列。
 */
export type AgentConnection = "connecting" | "connected" | "disconnected";

export type AgentSource = "cli" | "settings" | "none";
export type AgentAvailability = "available" | "unauthenticated";

export interface AgentResponseCard {
  kind: AgentKind;
  label: string;
  status: AgentAvailability;
  loginCommand: string;
  detail?: string;
}

export interface AgentResponse {
  current: AgentKind | null;
  source: AgentSource;
  agents: AgentResponseCard[];
}

/**
 * One agent card, translated for the chat panel's `AgentPicker` (its menu drives off
 * this, plus the two external booleans `probing`/`editingFrozen` that this
 * module knows nothing about). `inUse` is derived here (`kind ===
 * response.current`) so callers never recompute it.
 */
export interface AgentCardView {
  kind: AgentKind;
  label: string;
  status: AgentAvailability;
  loginCommand: string;
  detail?: string;
  inUse: boolean;
}

/**
 * The titlebar/chat-panel-facing agent state (Plan §4.1). `loading` is this
 * module's caller's own initial value before the first `GET /api/agent`
 * resolves — `fromAgentResponse` itself never produces it.
 */
export type AgentUiStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unset"; agents: AgentCardView[] }
  | {
      kind: "unauthenticated";
      current: AgentKind;
      label: string;
      loginCommand: string;
      /** [E3.T5] §4.4's "本次由命令列指定" badge reads this — `true` only while `source === "cli"` and this agent is the current one. */
      source: AgentSource;
      agents: AgentCardView[];
    }
  | {
      kind: "ready";
      current: AgentKind;
      label: string;
      /** Same as above. */
      source: AgentSource;
      agents: AgentCardView[];
    };

function toCardView(card: AgentResponseCard, current: AgentKind | null): AgentCardView {
  return {
    kind: card.kind,
    label: card.label,
    status: card.status,
    loginCommand: card.loginCommand,
    detail: card.detail,
    inUse: card.kind === current,
  };
}

function isValidCard(value: unknown): value is AgentResponseCard {
  if (typeof value !== "object" || value === null) return false;
  const { kind, label, status, loginCommand, detail } = value as Record<string, unknown>;
  if (kind !== "claude" && kind !== "codex") return false;
  if (typeof label !== "string") return false;
  if (status !== "available" && status !== "unauthenticated") return false;
  if (typeof loginCommand !== "string") return false;
  if (detail !== undefined && typeof detail !== "string") return false;
  return true;
}

/**
 * Parses `GET /api/agent` / `POST /api/agent/probe`'s JSON body into
 * {@link AgentUiStatus}. A malformed response returns `null` — the caller
 * keeps its previous value rather than this function fabricating one
 * (errors over fallbacks, same rule `live-reload.ts`'s own parsers follow).
 */
/**
 * #303: `GET /api/agent`'s `turnRunning` — whether the agent is inside an
 * author turn right now. A tab opened or reloaded mid-turn sets `working`
 * from this so Stop shows immediately, instead of waiting for the next
 * `chat-chunk`. A missing or non-boolean field reads as "not running".
 */
/** 對話框下方顯示的模型；`detail` 是 adapter 自己的說明，掛在 tooltip 上。 */
export interface AgentModelView {
  name: string;
  detail?: string;
}

/**
 * `GET /api/agent`'s `model` — the model the live ACP session runs on, as
 * the adapter named it. Null until a session exists (it is established on
 * the first message) and for any adapter that reports no model at all;
 * the chat panel then shows no model rather than a guessed one.
 */
export function modelFrom(data: unknown): AgentModelView | null {
  if (typeof data !== "object" || data === null) return null;
  const model = (data as Record<string, unknown>).model;
  if (typeof model !== "object" || model === null) return null;
  const { name, detail } = model as Record<string, unknown>;
  if (typeof name !== "string" || name === "") return null;
  return typeof detail === "string" && detail !== "" ? { name, detail } : { name };
}

/** 對話框下方模型選單的一列：`GET /api/agent` 的 `models[]`。 */
export interface AgentModelOption {
  id: string;
  name: string;
  detail?: string;
}

/**
 * `GET /api/agent`'s `models` + `modelId` — every model the live session can
 * switch to and which one it is on. `options` is empty until a session
 * exists or when the adapter offers no choice; the chat panel then shows the
 * plain model name (or nothing) instead of a picker.
 */
export function modelOptionsFrom(data: unknown): { current: string | null; options: AgentModelOption[] } {
  if (typeof data !== "object" || data === null) return { current: null, options: [] };
  const { models, modelId } = data as Record<string, unknown>;
  const options: AgentModelOption[] = [];
  if (Array.isArray(models)) {
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, name, detail } = entry as Record<string, unknown>;
      if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") continue;
      options.push(typeof detail === "string" && detail !== "" ? { id, name, detail } : { id, name });
    }
  }
  const current = typeof modelId === "string" && options.some((option) => option.id === modelId) ? modelId : null;
  return { current, options };
}

export function turnRunningFrom(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return (data as Record<string, unknown>).turnRunning === true;
}

export function fromAgentResponse(data: unknown): AgentUiStatus | null {
  if (typeof data !== "object" || data === null) return null;
  const { current, source, agents } = data as Record<string, unknown>;
  if (current !== null && current !== "claude" && current !== "codex") return null;
  if (source !== "cli" && source !== "settings" && source !== "none") return null;
  if (!Array.isArray(agents) || !agents.every(isValidCard)) return null;

  const views = agents.map((card) => toCardView(card, current));

  if (current === null) return { kind: "unset", agents: views };

  const currentCard = agents.find((card) => card.kind === current);
  if (!currentCard) return null;

  if (currentCard.status === "unauthenticated") {
    return {
      kind: "unauthenticated",
      current,
      label: currentCard.label,
      loginCommand: currentCard.loginCommand,
      source,
      agents: views,
    };
  }

  return { kind: "ready", current, label: currentCard.label, source, agents: views };
}
