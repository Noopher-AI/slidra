import { describe, expect, it } from "vitest";
import { detectAdapters } from "../../src/agent/detect.js";

// detectAdapters probes the ACP *adapters* (`claude-code-acp`,
// `codex-acp`), never the underlying CLIs (`claude`, `codex`) — probing
// the wrong name would report an agent as available and then fail at
// spawn time. `commandExists` is injected so this never depends on what
// happens to be installed on the machine running the suite.
describe("detectAdapters", () => {
  it("reports only the adapters the injected probe finds", async () => {
    const commandExists = async (command: string) => command === "claude-code-acp";

    const found = await detectAdapters(commandExists);

    expect(found.map((spec) => spec.kind)).toEqual(["claude"]);
  });

  it("probes for the adapter executables, not the underlying agent CLIs", async () => {
    const probed: string[] = [];
    const commandExists = async (command: string) => {
      probed.push(command);
      return false;
    };

    await detectAdapters(commandExists);

    expect(probed).toEqual(["claude-code-acp", "codex-acp"]);
    expect(probed).not.toContain("claude");
    expect(probed).not.toContain("codex");
  });

  it("returns an empty list when nothing is found", async () => {
    const found = await detectAdapters(async () => false);
    expect(found).toEqual([]);
  });
});
