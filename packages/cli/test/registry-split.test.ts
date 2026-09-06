import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * Guards the pure refactor that split `commands.ts`'s single-function
 * registration body into one `register(registry)` per command family
 * (`./commands/<family>.ts`), plus `./commands/element/*.ts` for the
 * `element` sub-commands. This list is transcribed by hand, one
 * `registry.register(...)` call at a time, from the registrations that
 * used to live directly in `createDefaultRegistry()` — it is the contract
 * that the split must not add, drop, or rename a single command.
 */
const EXPECTED_COMMAND_NAMES = [
  "new",
  "open",
  "pack",
  "cat",
  "ls",
  "text set",
  "text style set",
  "text list set",
  "textbox add",
  "textbox width",
  "convert",
  "undo",
  "redo",
  "element insert",
  "element delete",
  "element move",
  "element scale",
  "element resize",
  "element rotate",
  "element style set",
  "element order",
  "element group",
  "element ungroup",
  "element align",
  "element distribute",
  "element name set",
  "element copy",
  "element cut",
  "element paste",
  "element duplicate",
  "slide render",
  "asset import",
  "element lock",
  "element unlock",
  "slide add",
  "slide delete",
  "slide duplicate",
  "slide move",
  "slide notes set",
  "template add",
  "template list",
  "template rename",
  "template delete",
  "presentation transition set",
  // [E2.T7]: the effect command family (NOOP-66/#206).
  "effect add",
  "effect remove",
  "effect move",
  "effect set",
  "effect list",
  "comment add",
  "comment edit",
  "comment delete",
  "comment list",
  // E2.T14: the table command family (#203), including the four commands
  // §0(a) of the plan added beyond #203's original architecture comment
  // (row/col insert/delete) to give every cell-context-menu item in
  // docs/design/docs/05-INTERACTIONS.feature a matching CLI command.
  "table create",
  "table cell set",
  "table cell style set",
  "table merge",
  "table col width",
  "table col insert",
  "table col delete",
  "table row insert",
  "table row delete",
  "table theme set",
  "table header set",
  "table bind",
  "table refresh",
  "table set",
];

/** Reads the registry's private definition map without changing registry.ts's public API. */
function registeredNames(registry: CommandRegistry): string[] {
  const definitions = (registry as unknown as { definitions: Map<string, unknown> }).definitions;
  return Array.from(definitions.keys());
}

describe("createDefaultRegistry command surface", () => {
  it("registers exactly the 67 known command names — no more, no fewer", () => {
    const registry = createDefaultRegistry();
    const actual = [...registeredNames(registry)].sort();
    const expected = [...EXPECTED_COMMAND_NAMES].sort();

    expect(EXPECTED_COMMAND_NAMES.length).toBe(67);
    expect(new Set(actual).size).toBe(actual.length); // sanity: no duplicate registrations
    expect(actual).toEqual(expected);
  });

  it("gives cat, ls, and slide render a renderer, and every other command no renderer", () => {
    const registry = createDefaultRegistry();
    const withRenderer = new Set(["cat", "ls", "slide render"]);

    for (const name of EXPECTED_COMMAND_NAMES) {
      const renderer = registry.getRenderer(name);
      if (withRenderer.has(name)) {
        expect(renderer, `${name} should have a renderer`).toBeDefined();
      } else {
        expect(renderer, `${name} should not have a renderer`).toBeUndefined();
      }
    }
  });
});
