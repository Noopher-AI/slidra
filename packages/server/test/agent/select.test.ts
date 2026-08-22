import { describe, expect, it } from "vitest";
import { selectAdapter } from "../../src/agent/select.js";
import { ADAPTER_SPECS, type AdapterSpec } from "../../src/agent/adapters.js";

const claude = ADAPTER_SPECS.find((spec) => spec.kind === "claude")!;
const codex = ADAPTER_SPECS.find((spec) => spec.kind === "codex")!;

// Pure decision logic (no subprocess, no filesystem): every row of the
// ticket's §3 behaviour table for "which agent does serve use", each as
// its own test so a failure names exactly which row broke.
describe("selectAdapter", () => {
  it("fails loudly, naming both npm packages, when neither adapter is present", () => {
    expect(() => selectAdapter([], undefined)).toThrow(/@zed-industries\/claude-code-acp/);
    expect(() => selectAdapter([], undefined)).toThrow(/@zed-industries\/codex-acp/);
  });

  it("uses the one adapter present when --agent was not given", () => {
    const found: AdapterSpec[] = [claude];
    expect(selectAdapter(found, undefined)).toBe(claude);
  });

  it("errors, listing the valid values, when both are present and --agent was not given", () => {
    expect(() => selectAdapter([claude, codex], undefined)).toThrow(/claude/);
    expect(() => selectAdapter([claude, codex], undefined)).toThrow(/codex/);
  });

  it("picks the requested adapter when it is present, even if another is too", () => {
    expect(selectAdapter([claude, codex], "codex")).toBe(codex);
  });

  it("errors naming what is missing and how to install it when --agent names an adapter that is not present", () => {
    expect(() => selectAdapter([claude], "codex")).toThrow(/codex-acp/);
    expect(() => selectAdapter([claude], "codex")).toThrow(/@zed-industries\/codex-acp/);
  });
});
