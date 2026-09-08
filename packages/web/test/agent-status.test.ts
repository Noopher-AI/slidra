import { describe, expect, it } from "vitest";
import { fromAgentResponse } from "../src/agent-status.js";

// agent-status.ts's public boundary is the pure conversion `GET /api/agent`
// JSON → AgentUiStatus | null ([E3.T5] Plan §6.3) — no React, no fetch.

describe("fromAgentResponse ([E3.T5] Plan §4.1)", () => {
  it("current === null → unset, carrying both cards", () => {
    const result = fromAgentResponse({
      current: null,
      source: "none",
      agents: [
        { kind: "claude", label: "Claude Code", status: "unauthenticated", loginCommand: "claude auth login" },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login" },
      ],
    });

    expect(result).toEqual({
      kind: "unset",
      agents: [
        {
          kind: "claude",
          label: "Claude Code",
          status: "unauthenticated",
          loginCommand: "claude auth login",
          detail: undefined,
          inUse: false,
        },
        {
          kind: "codex",
          label: "Codex",
          status: "unauthenticated",
          loginCommand: "codex login",
          detail: undefined,
          inUse: false,
        },
      ],
    });
  });

  it("current 已登入 → ready，該卡 inUse 為 true", () => {
    const result = fromAgentResponse({
      current: "claude",
      source: "settings",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login" },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login" },
      ],
    });

    expect(result?.kind).toBe("ready");
    if (result?.kind !== "ready") throw new Error("expected ready");
    expect(result.current).toBe("claude");
    expect(result.label).toBe("Claude Code");
    expect(result.agents.find((a) => a.kind === "claude")?.inUse).toBe(true);
    expect(result.agents.find((a) => a.kind === "codex")?.inUse).toBe(false);
  });

  it("current 未登入 → unauthenticated，帶 loginCommand", () => {
    const result = fromAgentResponse({
      current: "codex",
      source: "cli",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login" },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login" },
      ],
    });

    expect(result).toMatchObject({
      kind: "unauthenticated",
      current: "codex",
      label: "Codex",
      loginCommand: "codex login",
    });
  });

  it("卡片帶 detail（偵測異常）時原樣保留", () => {
    const result = fromAgentResponse({
      current: null,
      source: "none",
      agents: [
        {
          kind: "claude",
          label: "Claude Code",
          status: "unauthenticated",
          loginCommand: "claude auth login",
          detail: "spawn ENOENT",
        },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login" },
      ],
    });

    expect(result?.kind).toBe("unset");
    if (result?.kind !== "unset") throw new Error("expected unset");
    expect(result.agents.find((a) => a.kind === "claude")?.detail).toBe("spawn ENOENT");
  });

  it("source 原樣透出（§4.4「本次由命令列指定」判斷用）", () => {
    const result = fromAgentResponse({
      current: "claude",
      source: "cli",
      agents: [
        { kind: "claude", label: "Claude Code", status: "available", loginCommand: "claude auth login" },
        { kind: "codex", label: "Codex", status: "unauthenticated", loginCommand: "codex login" },
      ],
    });

    expect(result?.kind).toBe("ready");
    if (result?.kind !== "ready") throw new Error("expected ready");
    expect(result.source).toBe("cli");
  });

  it("agents 缺欄位（malformed）→ null，不編一個假狀態", () => {
    expect(
      fromAgentResponse({
        current: null,
        source: "none",
        agents: [{ kind: "claude", label: "Claude Code" }],
      }),
    ).toBeNull();
  });

  it("整包不是物件 → null", () => {
    expect(fromAgentResponse(null)).toBeNull();
    expect(fromAgentResponse("not-an-object")).toBeNull();
    expect(fromAgentResponse(undefined)).toBeNull();
  });
});
