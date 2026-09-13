// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { fromAgentResponse, modelOptionsFrom } from "../src/agent-status.js";

// agent-status.ts's public boundary is the pure conversion `GET /api/agent`
// JSON → AgentUiStatus | null — no React, no fetch.

describe("fromAgentResponse", () => {
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

  it("current already logged in → ready, with that card's inUse true", () => {
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

  it("current not logged in → unauthenticated, carrying loginCommand", () => {
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

  it("keeps a card's detail (e.g. a detected anomaly) unchanged", () => {
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

  it("passes source through unchanged (used to detect a CLI-specified override)", () => {
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

  it("agents with missing fields (malformed) → null, rather than fabricating a fake status", () => {
    expect(
      fromAgentResponse({
        current: null,
        source: "none",
        agents: [{ kind: "claude", label: "Claude Code" }],
      }),
    ).toBeNull();
  });

  it("the whole payload not being an object → null", () => {
    expect(fromAgentResponse(null)).toBeNull();
    expect(fromAgentResponse("not-an-object")).toBeNull();
    expect(fromAgentResponse(undefined)).toBeNull();
  });
});

describe("modelOptionsFrom (chat-panel model picker)", () => {
  it("reads models[] and modelId, keeping detail only when present", () => {
    expect(
      modelOptionsFrom({
        modelId: "b",
        models: [{ id: "a", name: "A" }, { id: "b", name: "B", detail: "the good one" }],
      }),
    ).toEqual({ current: "b", options: [{ id: "a", name: "A" }, { id: "b", name: "B", detail: "the good one" }] });
  });

  it("current is null when modelId is not one of the options; malformed rows are dropped", () => {
    expect(modelOptionsFrom({ modelId: "zzz", models: [{ id: "a", name: "A" }, { id: "" }, "junk"] })).toEqual({
      current: null,
      options: [{ id: "a", name: "A" }],
    });
    expect(modelOptionsFrom({})).toEqual({ current: null, options: [] });
    expect(modelOptionsFrom(null)).toEqual({ current: null, options: [] });
  });
});
