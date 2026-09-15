// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-487 (Review): the env-ordering fix in `srt-launcher.ts` lives on a
 * code path only macOS ever dispatches to, so the real-enforcement test in
 * `os-enforcement.test.ts` — which goes through `createSandboxLauncher()` —
 * exercises `landlock-launcher.ts` on Linux and stays green even with the
 * fix reverted. `main`'s CI is Linux-only today, so without this file a
 * regression of the exact bug this PR fixes reaches macOS unchallenged.
 *
 * This is the one place `srt`'s own module is mocked, and only to stand in
 * for a macOS-only dependency (`SandboxManager.initialize()` requires
 * bwrap/socat on Linux): the assertion is about `wrap()`'s own merge of the
 * caller's env into the runtime's, which is pure logic in this module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const wrapWithSandboxArgv = vi.fn();

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async () => undefined,
    wrapWithSandboxArgv: (...args: unknown[]) => wrapWithSandboxArgv(...args) as unknown,
    reset: async () => undefined,
  },
}));

import { createSrtLauncher } from "../../src/sandbox/srt-launcher.js";

const EMPTY_POLICY = { allowWrite: [], denyWrite: [], denyRead: [] };

beforeEach(() => {
  wrapWithSandboxArgv.mockReset();
  // What `srt` 0.0.76 actually returns on the macOS branch: `process.env`
  // verbatim, i.e. the PARENT's values, including a `PATH` the caller
  // deliberately replaced.
  wrapWithSandboxArgv.mockResolvedValue({
    argv: ["/bin/sh", "-c", "sandbox-exec ..."],
    env: { PATH: "/parent/bin", PARENT_ONLY: "from-parent", SHARED: "parent-value" },
  });
});

describe("createSrtLauncher().wrap()", () => {
  it("lets the caller's own env win over the runtime's, and keeps the runtime's for keys the caller left alone", async () => {
    const launcher = await createSrtLauncher();
    try {
      const wrapped = await launcher.wrap(
        {
          command: "sh",
          args: ["-c", "slidra"],
          env: { PATH: "/sandbox-root/bin:/parent/bin", SHARED: "caller-value", CALLER_ONLY: "from-caller" },
        },
        EMPTY_POLICY,
      );

      // The whole point of the CLI-sandbox shim: `agent/manager.ts` puts
      // `<sandboxRoot>/bin` first in PATH and that must survive wrapping.
      expect(wrapped.env?.PATH).toBe("/sandbox-root/bin:/parent/bin");
      expect(wrapped.env?.SHARED).toBe("caller-value");
      expect(wrapped.env?.CALLER_ONLY).toBe("from-caller");
      expect(wrapped.env?.PARENT_ONLY).toBe("from-parent");
    } finally {
      await launcher.dispose();
    }
  });

  it("treats an empty string the caller set as a value, not as 'unset' to fall back from", async () => {
    const launcher = await createSrtLauncher();
    try {
      const wrapped = await launcher.wrap(
        { command: "sh", args: ["-c", "true"], env: { SHARED: "" } },
        EMPTY_POLICY,
      );
      expect(wrapped.env?.SHARED).toBe("");
    } finally {
      await launcher.dispose();
    }
  });
});
