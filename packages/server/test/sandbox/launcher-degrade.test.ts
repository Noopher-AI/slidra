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

  it("a real dependency failure (bwrap/socat/rg not on PATH) degrades instead of throwing", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      launcher = await createSandboxLauncher();
    } finally {
      process.env.PATH = originalPath;
    }
    expectDegraded(launcher, "write isolation failed to start");
  });

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
    }
  });
});
