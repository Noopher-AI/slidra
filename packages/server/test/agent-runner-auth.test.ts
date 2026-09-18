// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { isRunnerRoute, runnerSessionAuthorized } from "../src/agent-runner-auth.js";

describe("runnerSessionAuthorized", () => {
  it("classifies only runner-owned API families", () => {
    expect(isRunnerRoute("/api/chat/stream")).toBe(true);
    expect(isRunnerRoute("/api/agent")).toBe(true);
    expect(isRunnerRoute("/api/export/jobs/1")).toBe(true);
    expect(isRunnerRoute("/api/events")).toBe(true);
    expect(isRunnerRoute("/api/presentation")).toBe(false);
    expect(isRunnerRoute("/api/chatty")).toBe(false);
  });

  it("accepts only the dedicated session header", () => {
    expect(runnerSessionAuthorized({ "x-slidra-runner-session": "session-1" }, "session-1")).toBe(true);
    expect(runnerSessionAuthorized({ "x-slidra-runner-session": "wrong" }, "session-1")).toBe(false);
    expect(runnerSessionAuthorized({}, "session-1")).toBe(false);
  });

  it("does not treat cookies, query values, or duplicated headers as credentials", () => {
    expect(runnerSessionAuthorized({ cookie: "x-slidra-runner-session=session-1" }, "session-1")).toBe(false);
    expect(runnerSessionAuthorized({ "x-slidra-runner-session": ["session-1", "session-1"] }, "session-1")).toBe(false);
  });
});
