// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it } from "vitest";
import { createSandboxLauncher, type SandboxLauncher } from "../../src/sandbox/launcher.js";

/**
 * NOOP-425 D8: startup must never fail because write isolation could not be
 * established — every one of these is a real path to "degraded", not a
 * mocked one. `SandboxLauncher`'s own invariant (`launcher.ts`'s docstring):
 * `degradedReason` is non-null exactly when `active` is false.
 */
function expectDegraded(launcher: SandboxLauncher, reasonSubstring: string): void {
  expect(launcher.active).toBe(false);
  expect(launcher.degradedReason).not.toBeNull();
  expect(launcher.degradedReason).toContain(reasonSubstring);
}

let launcher: SandboxLauncher | undefined;

afterEach(async () => {
  await launcher?.dispose();
  launcher = undefined;
  delete process.env.SLIDRA_SANDBOX;
  delete process.env.SLIDRA_SANDBOX_BIN;
});

describe("createSandboxLauncher", () => {
  it("SLIDRA_SANDBOX=off forces the passthrough launcher, with a reason naming the escape hatch", async () => {
    process.env.SLIDRA_SANDBOX = "off";
    launcher = await createSandboxLauncher();
    expectDegraded(launcher, "SLIDRA_SANDBOX=off");
  });

  it("an unsupported platform (Windows) degrades with a reason, never throws", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      launcher = await createSandboxLauncher();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expectDegraded(launcher, "Windows");
  });

  // Only meaningful on the platform that actually dispatches to
  // landlock-launcher.ts — on any other platform this would just exercise
  // the same off/Windows/passthrough path the other tests already cover,
  // for the wrong reason, so it is skipped rather than silently passing.
  it.skipIf(process.platform !== "linux")(
    "a real dependency failure (the Landlock helper binary missing) degrades instead of throwing",
    async () => {
      process.env.SLIDRA_SANDBOX_BIN = "/nonexistent/slidra-sandbox-exec";
      launcher = await createSandboxLauncher();
      expectDegraded(launcher, "write isolation failed to start");
    },
  );

  it("the passthrough launcher's wrap() returns the spawn unchanged", async () => {
    process.env.SLIDRA_SANDBOX = "off";
    launcher = await createSandboxLauncher();
    const wrapped = await launcher.wrap(
      { command: "echo", args: ["hi"], env: { FOO: "bar" }, cwd: "/tmp" },
      { allowWrite: [], denyWrite: [], denyRead: [] },
    );
    expect(wrapped).toEqual({ command: "echo", args: ["hi"], env: { FOO: "bar" }, shell: false, cwd: "/tmp" });
  });

  it("never throws, and active/degradedReason are always consistent with each other", async () => {
    launcher = await createSandboxLauncher();
    if (launcher.active) {
      expect(launcher.degradedReason).toBeNull();
    } else {
      expect(launcher.degradedReason).not.toBeNull();
      // A degraded launcher enforces nothing — `enforces` must never claim
      // a capability `active: false` already disclaims.
      expect(launcher.enforces.write).toBe(false);
      expect(launcher.enforces.network).toBe(false);
    }
  });
});
