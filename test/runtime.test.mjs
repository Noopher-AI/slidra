// public/js/player-runtime.js under Node: the script runs in a vm context
// with a small fake DOM that records every Web Animations call, so the step
// clock (playback §3.1), fills and easing (§3.2), retreat (§3.4) and
// triggers (§3.6) are checked without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const RUNTIME = readFileSync(new URL("../public/js/player-runtime.js", import.meta.url), "utf8");

class FakeElement {
  constructor(id, doc) {
    this.id = id;
    this.doc = doc;
    this.attrs = new Map(id ? [["id", id]] : []);
    this.style = {};
    this.parentNode = null;
    this.nodeType = 1;
    this.textContent = "";
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  closest() {
    return null;
  }
  appendChild(child) {
    child.parentNode = this;
    return child;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  getElementsByTagNameNS() {
    return [];
  }
  animate(keyframes, options) {
    const animation = { target: this.id, keyframes, options, cancelled: false, cancel: () => (animation.cancelled = true), finish() {} };
    this.doc.animations.push(animation);
    return animation;
  }
}

/** Boots the runtime on `plan` over elements with the given ids. */
function boot(plan, ids) {
  const posted = [];
  const listeners = { document: {}, window: {} };
  const doc = {
    animations: [],
    elements: new Map(),
    getElementById: (id) => doc.elements.get(id) ?? null,
    addEventListener: (type, fn) => (listeners.document[type] = fn),
    getAnimations: () => doc.animations.filter((a) => !a.cancelled),
    createElement: () => new FakeElement(null, doc),
    createElementNS: () => new FakeElement(null, doc),
    querySelector: () => null,
    activeElement: null,
  };
  doc.body = new FakeElement(null, doc);
  doc.head = new FakeElement(null, doc);
  const hide = new FakeElement("slidra-hide", doc);
  doc.elements.set("slidra-hide", hide);
  for (const id of ids) doc.elements.set(id, new FakeElement(id, doc));
  // Messages are copied out of the vm realm, as postMessage would clone them.
  const parent = { postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) };
  const context = {
    document: doc,
    parent,
    getComputedStyle: () => ({ transform: "none", opacity: "1", display: "inline", visibility: "visible" }),
    setTimeout,
    clearTimeout,
    __SLIDRA_PLAN__: plan,
  };
  context.window = context;
  context.addEventListener = (type, fn) => (listeners.window[type] = fn);
  vm.createContext(context);
  vm.runInContext(RUNTIME, context);
  const send = (command) => listeners.window.message({ data: { source: "slidra-host", command }, source: parent });
  const click = (id) => listeners.document.click({ target: doc.elements.get(id) });
  const press = (key) => listeners.document.keydown({ key, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const hold = (value) => listeners.window.message({ data: { source: "slidra-host", command: "hold-keys", hold: value }, source: parent });
  return { doc, posted, send, click, hide, press, hold };
}

const effect = (target, family, name, start, extra = {}) => ({ target, family, effect: name, start, duration: 0.6, delay: 0, ...extra });
const plan = (steps, extra = {}) => ({
  steps: steps.map((effects) => ({ effects })),
  hidden: [],
  hideSelectors: {},
  media: {},
  stageMedia: {},
  embedIds: [],
  linkIds: [],
  triggers: {},
  triggerIds: [],
  startStep: -1,
  ...extra,
});
const timings = (doc) => doc.animations.map((a) => [a.target, a.options.delay, a.options.duration]);

test("boot reports ready at the opening state", () => {
  const { posted } = boot(plan([]), []);
  assert.deepEqual(posted.at(-1), { source: "slidra-player", event: "ready", step: -1, total: 0 });
});

test("the step clock: on-click at 0, with-previous shares a start, after-previous waits for the end, delay adds (playback §3.1)", () => {
  const { doc, send, posted } = boot(
    plan([
      [
        effect("a", "enter", "fade", "on-click", { duration: 0.5 }),
        effect("b", "emphasis", "pulse", "with-previous", { duration: 1, delay: 0.2 }),
        effect("c", "exit", "fade-out", "after-previous", { duration: 0.3 }),
        effect("d", "enter", "zoom", "after-previous", { duration: 0.4, delay: 0.1 }),
        effect("e", "emphasis", "spin", "with-previous", { duration: 0.2 }),
      ],
    ]),
    ["a", "b", "c", "d", "e"],
  );
  send("advance");
  assert.deepEqual(timings(doc), [
    ["a", 0, 500],
    ["b", 200, 1000],
    ["c", 1200, 300],
    ["d", 1600, 400],
    ["e", 1600, 200],
  ]);
  assert.deepEqual(posted.at(-1), { source: "slidra-player", event: "step", step: 0, total: 1 });
});

test("repeat multiplies an emphasis effect's length on the clock", () => {
  const { doc, send } = boot(plan([[effect("a", "emphasis", "pulse", "on-click", { duration: 0.5, repeat: 3 }), effect("b", "enter", "fade", "after-previous")]]), ["a", "b"]);
  send("advance");
  assert.equal(doc.animations[0].options.iterations, 3);
  assert.equal(doc.animations[1].options.delay, 1500);
});

test("fills and easing: entrances hold their first frame, exits their last, paths are linear (playback §3.2)", () => {
  const { doc, send } = boot(
    plan([
      [
        effect("a", "enter", "fly-down", "on-click"),
        effect("b", "exit", "fly-out-left", "with-previous", { easing: "overshoot" }),
        effect("c", "emphasis", "grow", "with-previous", { easing: "ease-in" }),
        effect("d", "path", "path", "with-previous", { d: "M0 0 L10 0" }),
      ],
    ]),
    ["a", "b", "c", "d"],
  );
  let pathError = null;
  try {
    send("advance");
  } catch (error) {
    pathError = error;
  }
  const byTarget = Object.fromEntries(doc.animations.map((a) => [a.target, a.options]));
  assert.deepEqual([byTarget.a.fill, byTarget.a.easing], ["backwards", "cubic-bezier(0.25, 0.1, 0.25, 1)"]);
  assert.deepEqual([byTarget.b.fill, byTarget.b.easing], ["forwards", "cubic-bezier(0.34, 1.56, 0.64, 1)"]);
  assert.deepEqual([byTarget.c.fill, byTarget.c.easing], ["none", "cubic-bezier(0.42, 0, 1, 1)"]);
  assert.deepEqual(doc.animations.find((a) => a.target === "a").keyframes[0].transform, "translateY(-40px)");
  assert.deepEqual(doc.animations.find((a) => a.target === "b").keyframes[1].transform, "translateX(-40px)");
  // The fake DOM cannot measure a path; the runtime reports that rather than throwing.
  assert.equal(pathError, null);
});

test("an entrance removes its target's pre-hide rule when its step starts", () => {
  const { send, hide } = boot(plan([[effect("a", "enter", "fade", "on-click")], [effect("b", "enter", "fade", "on-click")]], { hidden: ["a", "b"], hideSelectors: { a: "#a", b: "#b" } }), ["a", "b"]);
  assert.equal(hide.textContent, "#a{opacity:0 !important}#b{opacity:0 !important}");
  send("advance");
  assert.equal(hide.textContent, "#b{opacity:0 !important}");
});

test("retreat resets and replays the earlier steps instantly (playback §3.4)", () => {
  const { doc, send, posted, hide } = boot(
    plan([[effect("a", "enter", "fade", "on-click", { duration: 1, delay: 0.5 })], [effect("b", "enter", "zoom", "on-click")]], { hidden: ["a", "b"], hideSelectors: { a: "#a", b: "#b" } }),
    ["a", "b"],
  );
  send("advance");
  send("advance");
  const before = doc.animations.length;
  send("retreat");
  assert.ok(
    doc.animations.slice(0, before).every((a) => a.cancelled),
    "everything running or held is cancelled",
  );
  assert.deepEqual(timings(doc).slice(before), [["a", 0, 0]], "step 0 again, with no duration or delay");
  assert.equal(hide.textContent, "#b{opacity:0 !important}", "b is hidden again");
  assert.deepEqual(posted.at(-1), { source: "slidra-player", event: "step", step: 0, total: 2 });
  send("retreat");
  send("retreat");
  assert.deepEqual(posted.at(-1), { source: "slidra-player", event: "retreat-past-start" });
});

test("advancing past the last step asks the host for the next slide", () => {
  const { send, posted } = boot(plan([[effect("a", "emphasis", "pulse", "on-click")]]), ["a"]);
  send("advance");
  send("advance");
  assert.deepEqual(posted.at(-1), { source: "slidra-player", event: "advance-past-end" });
});

test("a trigger runs its own steps without advancing, and retreat starts it over (playback §3.6)", () => {
  const { doc, send, click, posted } = boot(
    plan([[effect("x", "emphasis", "pulse", "on-click")]], {
      triggers: { t: [{ effects: [effect("a", "enter", "fade", "on-click")] }, { effects: [effect("b", "enter", "fade", "on-click")] }] },
      triggerIds: ["t"],
      hidden: ["a", "b"],
      hideSelectors: { a: "#a", b: "#b" },
    }),
    ["x", "t", "a", "b"],
  );
  const stepMessages = () => posted.filter((m) => m.event === "step").length;
  click("t");
  click("t");
  click("t");
  assert.deepEqual(
    doc.animations.map((a) => a.target),
    ["a", "b"],
  );
  assert.equal(stepMessages(), 0, "a trigger never advances the slide");
  assert.equal(doc.elements.get("t").getAttribute("tabindex"), "0");
  assert.equal(doc.elements.get("t").getAttribute("role"), "button");
  send("advance");
  send("retreat");
  click("t");
  assert.equal(doc.animations.at(-1).target, "a", "retreat reset the trigger to its first step");
});

test("while the host holds the keys, every key goes to the host; a digit holds them at once", () => {
  const { doc, posted, press, hold } = boot(plan([[effect("a", "emphasis", "pulse", "on-click")]]), ["a"]);
  const keys = () => posted.filter((m) => m.event === "key").map((m) => m.key);
  hold(true);
  press("ArrowRight");
  press("Enter");
  assert.deepEqual(keys(), ["ArrowRight", "Enter"]);
  assert.equal(doc.animations.length, 0, "the slide did not advance");
  hold(false);
  press("ArrowRight");
  assert.equal(doc.animations.length, 1);

  // A digit is forwarded and holds the keys before the host has answered, so Enter cannot advance.
  press("4");
  press("Enter");
  assert.deepEqual(keys().slice(-2), ["4", "Enter"]);
  assert.equal(doc.animations.length, 1);
});
