import { test } from "node:test";
import assert from "node:assert/strict";
import { EffectError, cssEscapeId, deriveSteps, deriveTriggers, enterTargets, validateEffect, validateTransition } from "../lib/viewer/effects.js";

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
  const effects = [raw("a", "enter", "fade", "on-click"), raw("b", "enter", "zoom", "with-previous"), raw("c", "emphasis", "pulse", "on-click"), raw("d", "exit", "fade-out", "after-previous")].map(
    (r, i) => validateEffect(r, i, true),
  );
  const steps = deriveSteps(effects);
  assert.deepEqual(
    steps.map((s) => s.effects.map((e) => e.target)),
    [
      ["a", "b"],
      ["c", "d"],
    ],
  );
  assert.throws(() => deriveSteps([validateEffect(raw("a", "enter", "fade", "with-previous"), 0, true)]), /corrupted/);
});

test("only targets whose first effect is enter start hidden", () => {
  const effects = [raw("a", "exit", "fade-out", "on-click"), raw("a", "enter", "fade", "on-click"), raw("b", "enter", "fade", "on-click"), raw("b", "exit", "zoom-out", "on-click")].map((r, i) =>
    validateEffect(r, i, true),
  );
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

const withAttrs = (target, family, effect, start, extra) =>
  validateEffect(raw(target, family, effect, start, { easing: null, repeat: null, by: null, stagger: null, trigger: null, ...extra }), 0, true, true);

test("new fly directions, easing, repeat, builds", () => {
  assert.equal(withAttrs("a", "enter", "fly-down", "on-click", {}).effect, "fly-down");
  assert.equal(withAttrs("a", "exit", "fly-out-right", "on-click", {}).effect, "fly-out-right");
  assert.equal(withAttrs("a", "enter", "fade", "on-click", { easing: "overshoot" }).easing, "overshoot");
  assert.equal(withAttrs("a", "emphasis", "pulse", "on-click", { repeat: "3" }).repeat, 3);
  const build = withAttrs("a", "enter", "fade", "on-click", { by: "word" });
  assert.deepEqual([build.by, build.stagger], ["word", 0.1]);
  assert.equal(withAttrs("a", "exit", "fade-out", "on-click", { by: "letter", stagger: "0.02" }).stagger, 0.02);
  assert.equal(withAttrs("a", "enter", "fade", "on-click", {}).easing, undefined, "no easing attribute: the runtime picks the family default");
});

test("rejects bad or misplaced options", () => {
  /** @type {[string, string, Record<string, string>, RegExp][]} */
  const bad = [
    ["enter", "fade", { easing: "bouncy" }, /unknown easing/],
    ["media", "play", { easing: "linear" }, /takes no easing/],
    ["emphasis", "pulse", { repeat: "0" }, /positive integer/],
    ["emphasis", "pulse", { repeat: "1.5" }, /positive integer/],
    ["enter", "fade", { repeat: "2" }, /only emphasis/],
    ["enter", "fade", { by: "sentence" }, /unknown by/],
    ["emphasis", "pulse", { by: "word" }, /only enter and exit/],
    ["enter", "fade", { stagger: "0.1" }, /stagger but no by/],
    ["enter", "fade", { by: "word", stagger: "-1" }, /not a valid number/],
    ["enter", "fade", { trigger: "" }, /empty trigger/],
  ];
  for (const [family, effect, extra, pattern] of bad) assert.throws(() => withAttrs("a", family, effect, "on-click", extra), pattern, JSON.stringify(extra));
  assert.throws(() => validateEffect(raw("a", "enter", "fade", "on-click", { trigger: "el-x" }), 0, true, false), /trigger points at an element that does not exist/);
});

test("triggered effects leave the slide's steps and form their own", () => {
  const effects = [
    raw("a", "enter", "fade", "on-click", { trigger: "t1" }),
    raw("b", "enter", "fade", "on-click"),
    raw("c", "emphasis", "pulse", "after-previous", { trigger: "t1" }),
    raw("d", "enter", "fade", "on-click", { trigger: "t1" }),
    raw("e", "enter", "zoom", "on-click", { trigger: "t2" }),
  ].map((r, i) => validateEffect(r, i, true, true));
  assert.deepEqual(
    deriveSteps(effects).map((s) => s.effects.map((e) => e.target)),
    [["b"]],
  );
  const triggers = deriveTriggers(effects);
  assert.deepEqual(Object.keys(triggers), ["t1", "t2"]);
  assert.deepEqual(
    triggers.t1.map((s) => s.effects.map((e) => e.target)),
    [["a", "c"], ["d"]],
  );
  assert.equal(Object.getPrototypeOf(triggers), null);
  // A trigger's own list must open with on-click; the slide's list is judged without triggered effects.
  assert.throws(() => deriveTriggers([validateEffect(raw("a", "enter", "fade", "with-previous", { trigger: "t" }), 0, true, true)]), /corrupted/);
  assert.deepEqual(deriveSteps([validateEffect(raw("a", "enter", "fade", "with-previous", { trigger: "t" }), 0, true, true)]), []);
  assert.deepEqual(enterTargets(effects), ["a", "b", "d", "e"], "a triggered entrance starts hidden too");
});
