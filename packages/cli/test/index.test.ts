import { describe, expect, it } from "vitest";

// Importing the package's public API (createDefaultRegistry, main, etc.)
// must never install process-global state. The EPIPE handler belongs only
// to the real executable in packages/cli/bin/co-motion.js, which this
// module never touches — so this listener count must be unchanged by the
// import alone, in a process that has not run the CLI.
describe("importing @co-motion/cli's public API", () => {
  it("installs no process.stdout error listener", async () => {
    const before = process.stdout.listenerCount("error");

    await import("../src/index.js");

    const after = process.stdout.listenerCount("error");
    expect(after).toBe(before);
  });
});
