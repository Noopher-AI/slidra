import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkgDir = new URL("../packages/slidra-player/", import.meta.url);

test("the <slidra-player> bundle is one self-contained ES module", async () => {
  await import("../tools/build-element.mjs");
  const pkg = JSON.parse(readFileSync(new URL("package.json", pkgDir), "utf8"));
  const entry = new URL(pkg.exports["."], pkgDir);
  assert.ok(existsSync(entry), "exports points at the built file");
  const bundle = readFileSync(entry, "utf8");
  assert.doesNotMatch(bundle, /\bimport\s*[{(*"']/, "no imports left: everything is bundled");
  assert.doesNotMatch(bundle, /__SLIDRA_RUNTIME__/, "the runtime placeholder was replaced");
  assert.match(bundle, /customElements\.define/);
  assert.match(bundle, /slidra-player/);
  // The slide runtime travels inside, as a string the player writes into each sandboxed frame.
  assert.ok(bundle.includes("__SLIDRA_PLAN__"), "the slide runtime is inlined");
  assert.deepEqual(pkg.files, ["dist/", "README.md"]);
  assert.equal(pkg.license, "MIT");
});
