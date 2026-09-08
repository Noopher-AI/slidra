import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";

/**
 * Guards the pure refactor that split `commands.ts`'s single-function
 * registration body into one `register(registry)` per command family
 * (`./commands/<family>.ts`), plus `./commands/element/*.ts` for the
 * `element` sub-commands.
 *
 * The command-count/name-list assertion this test used to make against a
 * hand-transcribed `EXPECTED_COMMAND_NAMES` array (and the registry's
 * private `definitions` map) has moved to
 * `packages/cli/test/spec-cli-coverage.test.ts`, which compares the
 * registry's own public `names()` against `docs/spec/cli.md` — the
 * document that is now the single regulatory source for the command set,
 * so there is exactly one non-generated place that list can drift from.
 * This file keeps only the renderer-wiring assertion, which
 * `spec-cli-coverage.test.ts` does not cover.
 */
describe("createDefaultRegistry command surface", () => {
  it("gives cat, ls, and slide render a renderer, and every other command no renderer", () => {
    const registry = createDefaultRegistry();
    const withRenderer = new Set(["cat", "ls", "slide render"]);

    for (const name of registry.names()) {
      const renderer = registry.getRenderer(name);
      if (withRenderer.has(name)) {
        expect(renderer, `${name} should have a renderer`).toBeDefined();
      } else {
        expect(renderer, `${name} should not have a renderer`).toBeUndefined();
      }
    }
  });
});
