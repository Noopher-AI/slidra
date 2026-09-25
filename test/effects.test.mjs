import { test } from "node:test";
import assert from "node:assert/strict";
import { EffectError, cssEscapeId, deriveSteps, enterTargets, validateEffect, validateTransition } from "../public/js/effects.js";

const raw = (target, family, effect, start, extra = {}) => ({ target, family, effect, start, duration: null, delay: null, d: null, ...extra });

test("defaults: 0.6 s for animations, 0 for media, 0 delay", () => {
  assert.equal(validateEffect(raw("a", "enter", "fade", "on-click"), 0, true).duration, 0.6);
  assert.equal(validateEffect(raw("a", "media", "play", "on-click"), 0, true).duration, 0);
  assert.equal(validateEffect(raw("a", "enter", "fade", "on-click"), 0, true).delay, 0);
});

test("rejects malformed effects", () => {
  assert.throws(() => validateEffect(raw("a", "enter", "spin", "on-click"), 0, true), EffectError);
  assert.throws(() => validateEffect(raw("a", "wobble", "fade", "on-click"), 0, true), EffectError);
  assert.throws(() => validateEffect(raw("a", "enter", "fade", "later"), 0, true), EffectError);
  assert.throws(() => validateEffect(raw("a", "enter", "fade", "on-click"), 0, false), /does not exist/);
  assert.throws(() => validateEffect(raw("a", "path", "path", "on-click"), 0, true), /no d/);
  assert.throws(() => validateEffect(raw("a", "enter", "fade", "on-click", { duration: "" }), 0, true), /not a valid number/);
  assert.throws(() => validateEffect(raw("a", "enter", "fade", "on-click", { delay: "-1" }), 0, true), /not a valid number/);
  assert.throws(() => validateEffect(raw("a", "__proto__", "fade", "on-click"), 0, true), EffectError);
});

test("steps open at every on-click; the first effect must be on-click", () => {
  const effects = [
    raw("a", "enter", "fade", "on-click"),
    raw("b", "enter", "zoom", "with-previous"),
    raw("c", "emphasis", "pulse", "on-click"),
    raw("d", "exit", "fade-out", "after-previous"),
  ].map((r, i) => validateEffect(r, i, true));
  const steps = deriveSteps(effects);
  assert.deepEqual(steps.map((s) => s.effects.map((e) => e.target)), [["a", "b"], ["c", "d"]]);
  assert.throws(() => deriveSteps([validateEffect(raw("a", "enter", "fade", "with-previous"), 0, true)]), /corrupted/);
});

test("only targets whose first effect is enter start hidden", () => {
  const effects = [
    raw("a", "exit", "fade-out", "on-click"),
    raw("a", "enter", "fade", "on-click"),
    raw("b", "enter", "fade", "on-click"),
    raw("b", "exit", "zoom-out", "on-click"),
  ].map((r, i) => validateEffect(r, i, true));
  assert.deepEqual(enterTargets(effects), ["b"]);
});

test("transitions validate and default", () => {
  assert.deepEqual(validateTransition({}), { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } });
  assert.deepEqual(validateTransition({ enter: "slide", "enter-duration": "1.2" }).enter, { effect: "slide", duration: 1.2 });
  assert.throws(() => validateTransition({ enter: "spiral" }), EffectError);
});

test("cssEscapeId never emits a raw '<' and escapes leading digits", () => {
  assert.equal(cssEscapeId("el-abc_DEF9"), "el-abc_DEF9");
  assert.equal(cssEscapeId("1a"), "\\31 a");
  assert.ok(!cssEscapeId("x</style><script>").includes("<"));
});
