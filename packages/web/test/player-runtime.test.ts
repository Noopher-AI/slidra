// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Seam C — the runtime applying a plan to the DOM (design doc: "given a
 * step index, which elements should be visible"). player-runtime.js is
 * deliberately plain, import-free JavaScript meant to be inlined into a
 * sandboxed iframe's srcdoc, so it is exercised here the same way
 * production does: evaluated inside a real (nested) window/document, with
 * postMessage as the only channel out — never imported as a module.
 *
 * Every test builds its own iframe so each gets an isolated `window` (fresh
 * keydown listeners, fresh `currentStep` closure state) rather than sharing
 * mutable globals across tests.
 *
 * D7.5: jsdom has neither `Element.prototype.animate` nor
 * `document.getAnimations` (confirmed: `el.animate === undefined`), and the
 * runtime deliberately does not feature-detect either — a real browser
 * always has both, D7.5). `stubWebAnimations` below is this test file's own
 * substitute, installed on every `boot()`: it records every `animate()`
 * call's `{el, keyframes, options}` (the runtime's public boundary to a
 * browser, §6.4) and makes `document.getAnimations()`/`.cancel()` behave
 * consistently with it, so `resetToStep`'s cancel-everything step is
 * testable too. `family: "path"` is NOT covered here — jsdom has no
 * `SVGGeometryElement.getTotalLength`/`getPointAtLength` either, and
 * stubbing those away would stop testing this runtime's own path-sampling
 * math entirely. Path animation is covered by `e2e/object-animation.test.ts`
 * instead, against a real browser.
 */
const runtimeSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/player-runtime.js"),
  "utf8",
);

let iframe: HTMLIFrameElement;

beforeEach(() => {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
});

afterEach(() => {
  iframe.remove();
});

// Widened from "enter" | "media" to the full five-family value set
// (D4), and duration/delay/d/index added — all optional, so every
// pre-existing call site building a bare `{target, family, effect, start}`
// still compiles unchanged.
interface StubEffect {
  target: string;
  family: "enter" | "emphasis" | "exit" | "path" | "media";
  effect: string;
  start: "on-click" | "with-previous" | "after-previous";
  duration?: number;
  delay?: number;
  d?: string;
  index?: number;
}
interface StubMediaCue {
  src: string;
  kind: "video" | "audio";
}
interface StubPlan {
  steps: { effects: StubEffect[] }[];
  hidden: string[];
  hideSelectors?: Record<string, string>;
  media?: Record<string, StubMediaCue>;
  startStep?: number;
  preview?: { effectIndices: number[] | null };
}

function enter(target: string, effect: string, overrides: Partial<StubEffect> = {}): StubEffect {
  return { target, family: "enter", effect, start: "on-click", ...overrides };
}
function emphasis(target: string, effect: string, overrides: Partial<StubEffect> = {}): StubEffect {
  return { target, family: "emphasis", effect, start: "on-click", ...overrides };
}
function exitEffect(target: string, effect: string, overrides: Partial<StubEffect> = {}): StubEffect {
  return { target, family: "exit", effect, start: "on-click", ...overrides };
}
function media(target: string, effect: "play" | "pause" = "play"): StubEffect {
  return { target, family: "media", effect, start: "on-click" };
}

interface StubAnimation {
  el: Element;
  keyframes: Record<string, unknown>[];
  options: { duration?: number; delay?: number; fill?: string; easing?: string };
  cancelled: boolean;
  finished: Promise<void>;
  cancel: () => void;
}

/** D7.5: see this file's header comment. */
function stubWebAnimations(win: Window): StubAnimation[] {
  const calls: StubAnimation[] = [];
  const ElementCtor = (win as unknown as { Element: { prototype: Record<string, unknown> } }).Element;
  ElementCtor.prototype.animate = function (this: Element, keyframes: unknown, options: unknown) {
    const call: StubAnimation = {
      el: this,
      keyframes: keyframes as Record<string, unknown>[],
      options: options as StubAnimation["options"],
      cancelled: false,
      finished: Promise.resolve(),
      cancel: () => {
        call.cancelled = true;
      },
    };
    calls.push(call);
    return call;
  };
  (win.document as unknown as { getAnimations: () => StubAnimation[] }).getAnimations = () =>
    calls.filter((call) => !call.cancelled);
  return calls;
}

/** Boots the runtime inside `iframe`'s own window/document with the given plan. */
function boot(plan: StubPlan, elementIds: string[]): { win: Window; doc: Document; animations: StubAnimation[] } {
  const win = iframe.contentWindow as Window & { __SLIDRA_PLAN__?: StubPlan };
  const doc = iframe.contentDocument as Document;
  const hideSelectors = plan.hideSelectors ?? Object.fromEntries(plan.hidden.map((id) => [id, `#${id}`]));
  // `<style id="slidra-hide">`, PRE-POPULATED with every hidden id's rule, is
  // normally injected by canvas.ts's wrapPlayDocument — it is
  // player-plan.ts's renderHideStyle() output, baked into the srcdoc HTML
  // before this script ever runs. These tests eval the runtime directly,
  // so they must reproduce that same starting state, not an empty shell —
  // the runtime itself never populates this stylesheet's *initial*
  // content, only rewrites it afterwards (D7).
  const initialRules = plan.hidden.map((id) => `${hideSelectors[id]}{opacity:0 !important}`).join("");
  doc.body.innerHTML =
    `<style id="slidra-hide">${initialRules}</style>` + elementIds.map((id) => `<div id="${id}"></div>`).join("");
  const animations = stubWebAnimations(win);
  win.__SLIDRA_PLAN__ = { ...plan, hideSelectors };
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc, animations };
}

function press(win: Window, key: string): void {
  const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  win.document.dispatchEvent(new KeyboardEventCtor("keydown", { key }));
}

/** Whether `<style id="slidra-hide">` still carries a rule for `id` — the D7 replacement for reading `el.style.opacity` directly (WAAPI keyframes aren't reflected in `.style` at all). */
function hideStyleContains(doc: Document, id: string): boolean {
  const styleEl = doc.getElementById("slidra-hide");
  return !!styleEl && (styleEl.textContent ?? "").indexOf(`#${id}{`) !== -1;
}

function animationsFor(animations: StubAnimation[], id: string): StubAnimation[] {
  return animations.filter((call) => (call.el as HTMLElement).id === id);
}

function lastKeyframe(call: StubAnimation): Record<string, unknown> {
  return call.keyframes[call.keyframes.length - 1];
}

/** Collects every `slidra-player` message posted to the outer (test) window. */
function collectMessages(): { messages: unknown[]; stop: () => void } {
  const messages: unknown[] = [];
  const handler = (event: MessageEvent) => messages.push(event.data);
  window.addEventListener("message", handler);
  return { messages, stop: () => window.removeEventListener("message", handler) };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("player-runtime.js", () => {
  it("posts ready to the parent as soon as it boots", async () => {
    const { messages, stop } = collectMessages();
    boot({ steps: [], hidden: [] }, []);
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-player", event: "ready" });
  });

  it("ArrowRight advances one step: multiple elements in the same step appear together (each fires its own el.animate, keyframes end at opacity 1)", () => {
    // Hand-built here, bypassing parseEffects/deriveSteps entirely: this
    // is testing the runtime's own contract (apply whatever step it is
    // given), independent of what today's parser can produce from a real
    // file.
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade"), enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-b", "el-bg"]);

    press(win, "ArrowRight");

    expect(animationsFor(animations, "el-a")).toHaveLength(1);
    expect(animationsFor(animations, "el-b")).toHaveLength(1);
    expect(lastKeyframe(animationsFor(animations, "el-a")[0]).opacity).toBe(1);
    expect(lastKeyframe(animationsFor(animations, "el-b")[0]).opacity).toBe(1);
  });

  it("elements that belong to no step are never touched by the runtime", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade")] }],
      hidden: ["el-a"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-bg"]);

    press(win, "ArrowRight");

    // el-bg was never in `hidden` and never named by any step: no
    // el.animate() call is ever made for it.
    expect(animationsFor(animations, "el-bg")).toHaveLength(0);
  });

  it("effect.duration/delay pass through (converted to milliseconds) into el.animate's options", () => {
    const plan: StubPlan = {
      steps: [
        { effects: [enter("el-a", "fade", { duration: 0.4, delay: 0.1 }), enter("el-b", "appear", { duration: 0 })] },
      ],
      hidden: ["el-a", "el-b"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");

    expect(animationsFor(animations, "el-a")[0].options).toMatchObject({ duration: 400, delay: 100 });
    expect(animationsFor(animations, "el-b")[0].options).toMatchObject({ duration: 0 });
  });

  it("within the same step, with-previous aligns to the previous effect's start and after-previous to its end (each one's own delay stacks on top)", () => {
    const plan: StubPlan = {
      steps: [
        {
          effects: [
            enter("el-a", "fade", { duration: 0.4, delay: 0.1 }),
            enter("el-b", "fade", { start: "after-previous", duration: 0.2, delay: 0.05 }),
            enter("el-c", "fade", { start: "with-previous", duration: 0.3 }),
            enter("el-d", "fade", { start: "after-previous", duration: 0.1 }),
          ],
        },
      ],
      hidden: ["el-a", "el-b", "el-c", "el-d"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-b", "el-c", "el-d"]);

    press(win, "ArrowRight");

    // a: starts at 0.1, ends at 0.5. b (after a): 0.5 + 0.05 = 0.55, ends 0.75.
    // c (with b): starts with b at 0.55. d (after c): 0.55 + 0.3 = 0.85.
    expect(animationsFor(animations, "el-a")[0].options).toMatchObject({ delay: 100 });
    expect(animationsFor(animations, "el-b")[0].options).toMatchObject({ delay: 550 });
    expect(animationsFor(animations, "el-c")[0].options).toMatchObject({ delay: 550 });
    expect(animationsFor(animations, "el-d")[0].options).toMatchObject({ delay: 850 });
  });

  it("advances one step at a time, applying only one step per press; pressing again past the last step posts advance-past-end instead", async () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "fade")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-b"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowRight");
    expect(animationsFor(animations, "el-a")).toHaveLength(1);
    expect(animationsFor(animations, "el-b")).toHaveLength(0);

    press(win, "ArrowRight");
    expect(animationsFor(animations, "el-b")).toHaveLength(1);

    press(win, "ArrowRight");
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-player", event: "advance-past-end" });
  });

  it("ArrowLeft retreats from step 2 to step 1: step 1's elements stay revealed, step 2's elements go back to hidden", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    expect(hideStyleContains(doc, "el-a")).toBe(false);
    expect(hideStyleContains(doc, "el-b")).toBe(false);

    press(win, "ArrowLeft");

    expect(hideStyleContains(doc, "el-a")).toBe(false);
    expect(hideStyleContains(doc, "el-b")).toBe(true);
  });

  it("retreating cancels every in-progress animation and rewrites the hide stylesheet back to the full hidden set (D7's 'known-clean starting point' extended to WAAPI)", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc, animations } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    const beforeRetreat = animations.slice();
    press(win, "ArrowLeft");

    // Every animation created before the retreat must now be cancelled — a
    // lingering `fill` hold (exit/path) is exactly the kind of state a
    // retreat must not carry across (the "known-clean starting point" invariant).
    // The replay itself creates its own fresh (duration:0) calls, which are
    // legitimately still active — only the pre-retreat snapshot is checked.
    expect(beforeRetreat.length).toBeGreaterThan(0);
    expect(beforeRetreat.every((call) => call.cancelled)).toBe(true);
    expect(hideStyleContains(doc, "el-b")).toBe(true);
  });

  it("booting with plan.startStep at -1 (the default): hidden targets stay hidden, same as just arriving at the slide", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      startStep: -1,
    };
    const { doc, animations } = boot(plan, ["el-a"]);

    expect(hideStyleContains(doc, "el-a")).toBe(true);
    expect(animations).toHaveLength(0);
  });

  it("on the retreat-replay path, media effects are skipped and no media element is created", () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }, { effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["el-video", "el-a"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    expect(doc.body.querySelectorAll("video")).toHaveLength(1);

    press(win, "ArrowLeft");

    // Retreating past the media step tears the overlay down and does not
    // recreate it on replay (media is skipped entirely during replay).
    expect(doc.body.querySelectorAll("video")).toHaveLength(0);
  });

  it("advancing back to the same media step after retreating still plays the media (proving the skip only happens on the replay path)", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [media("el-video")] }],
      hidden: ["el-a"],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["el-a", "el-video"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    expect(doc.body.querySelectorAll("video")).toHaveLength(1);

    press(win, "ArrowLeft");
    expect(doc.body.querySelectorAll("video")).toHaveLength(0);

    press(win, "ArrowRight");

    expect(doc.body.querySelectorAll("video")).toHaveLength(1);
  });

  it("retreating before media has started playing: pause() lets play()'s promise reject with AbortError only after teardown, and it is not misreported as an error", async () => {
    // Reachability (defect found in review of ae34c98): ArrowRight onto a
    // media step, ArrowRight onto an ordinary step, then ArrowLeft while the
    // browser has not yet settled the play() promise. jsdom doesn't
    // implement media playback, so play()/pause() are stubbed on the
    // iframe's own HTMLMediaElement.prototype — pause() rejects the pending
    // play() promise with AbortError, and because rejection only notifies
    // .catch handlers as a microtask, that rejection genuinely arrives after
    // resetToStep's synchronous teardown (mark, pause(), removeChild) has
    // already finished, the same order a real browser delivers it in.
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }, { effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win } = boot(plan, ["el-video", "el-a"]);

    let rejectPlay!: (err: unknown) => void;
    const pendingPlay = new Promise((_resolve, reject) => {
      rejectPlay = reject;
    });
    const MediaProto = (win as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement
      .prototype;
    MediaProto.play = () => pendingPlay as unknown as Promise<void>;
    MediaProto.pause = () => {
      const err = new Error("The play() request was interrupted by a call to pause().");
      err.name = "AbortError";
      rejectPlay(err);
    };

    const { messages, stop } = collectMessages();
    press(win, "ArrowRight");
    press(win, "ArrowRight");
    press(win, "ArrowLeft");
    // Two ticks, not one: post() goes through parent.postMessage, which is
    // itself queued as a task rather than delivered synchronously from the
    // promise-rejection microtask, so a single setTimeout(0) can resolve
    // before that delivery task runs. Two ticks give any (wrongly) posted
    // error time to actually arrive before the assertion below checks for
    // its absence — otherwise this test could pass for the wrong reason.
    await tick();
    await tick();
    stop();

    expect(messages).not.toContainEqual(expect.objectContaining({ event: "error" }));
  });

  it("play()'s promise rejects with a non-AbortError: an error is still posted even if the element was just torn down by a retreat", async () => {
    // Complementary to the test above: without this, suppressing AbortError
    // could quietly degrade into suppressing every rejection.
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }, { effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win } = boot(plan, ["el-video", "el-a"]);

    let rejectPlay!: (err: unknown) => void;
    const pendingPlay = new Promise((_resolve, reject) => {
      rejectPlay = reject;
    });
    const MediaProto = (win as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement
      .prototype;
    MediaProto.play = () => pendingPlay as unknown as Promise<void>;
    MediaProto.pause = () => {
      rejectPlay(new Error("NotSupportedError: no supported source was found"));
    };

    const { messages, stop } = collectMessages();
    press(win, "ArrowRight");
    press(win, "ArrowRight");
    press(win, "ArrowLeft");
    await tick();
    await tick();
    stop();

    expect(messages).toContainEqual(expect.objectContaining({ event: "error" }));
  });

  it("play() rejects with AbortError but the element was never torn down by a retreat: an error is still posted", async () => {
    // The other half of the same complementary guard: an AbortError alone
    // is not sufficient to suppress — only an AbortError on an element this
    // runtime itself tore down.
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }],
      hidden: [],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win } = boot(plan, ["el-video"]);

    const MediaProto = (win as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement
      .prototype;
    MediaProto.play = () => {
      const err = new Error("aborted for an unrelated reason");
      err.name = "AbortError";
      return Promise.reject(err);
    };

    const { messages, stop } = collectMessages();
    press(win, "ArrowRight");
    // Two ticks for the same reason as the tests above: the rejection
    // settles as a microtask, but the resulting post() only reaches this
    // window as a separately queued task.
    await tick();
    await tick();
    stop();

    expect(messages).toContainEqual(expect.objectContaining({ event: "error" }));
  });

  it("during retreat-replay, every el.animate call uses duration 0 (the earlier effect's original animation duration is not replayed)", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade", { duration: 0.4 })] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, animations } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    press(win, "ArrowLeft");

    const forA = animationsFor(animations, "el-a");
    // One live call (real duration) plus one replay call (duration 0).
    expect(forA).toHaveLength(2);
    expect(forA[0].options.duration).toBe(400);
    expect(forA[1].options.duration).toBe(0);
  });

  it("booting with plan.startStep set to the last step's index: lands directly in the state where that step is already fully applied", async () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
      startStep: 1,
    };
    const { messages, stop } = collectMessages();
    const { doc } = boot(plan, ["el-a", "el-b"]);
    await tick();
    stop();

    expect(hideStyleContains(doc, "el-a")).toBe(false);
    expect(hideStyleContains(doc, "el-b")).toBe(false);
    expect(messages[messages.length - 1]).toEqual({ source: "slidra-player", event: "ready" });
  });

  it("ArrowLeft on the slide's first step (no key pressed yet) posts retreat-past-start and leaves the view unchanged", async () => {
    const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
    const { win, doc, animations } = boot(plan, ["el-a"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowLeft");
    await tick();
    stop();

    expect(hideStyleContains(doc, "el-a")).toBe(true);
    expect(animations).toHaveLength(0);
    expect(messages).toContainEqual({ source: "slidra-player", event: "retreat-past-start" });
  });

  it("a slide with no steps: the very first ArrowRight immediately posts advance-past-end", async () => {
    const { win } = boot({ steps: [], hidden: [] }, []);
    const { messages, stop } = collectMessages();

    press(win, "ArrowRight");
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-player", event: "advance-past-end" });
  });

  // §3.8/§4.5: Space/PageDown mirror ArrowRight ("advance one step"),
  // PageUp mirrors ArrowLeft ("retreat one step"), Escape posts a new "exit-play"
  // event canvas.ts decides how to act on (the runtime itself has no notion
  // of fullscreen). Existing ArrowRight/ArrowLeft behaviour must not regress.
  describe("Space / PageDown / PageUp / Escape", () => {
    it("Space advances one step, fully synonymous with ArrowRight (elements of the same step appear together)", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc, animations } = boot(plan, ["el-a"]);

      press(win, " ");

      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(hideStyleContains(doc, "el-a")).toBe(false);
    });

    it("PageDown advances one step, fully synonymous with ArrowRight", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc, animations } = boot(plan, ["el-a"]);

      press(win, "PageDown");

      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(hideStyleContains(doc, "el-a")).toBe(false);
    });

    it("PageUp retreats one step, fully synonymous with ArrowLeft", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "fade")] }], hidden: ["el-a", "el-b"] };
      const { win, doc } = boot(plan, ["el-a", "el-b"]);
      press(win, "ArrowRight");
      press(win, "ArrowRight");

      press(win, "PageUp");

      expect(hideStyleContains(doc, "el-a")).toBe(false);
      expect(hideStyleContains(doc, "el-b")).toBe(true);
    });

    it("pressing Space / PageDown again on the slide's last step posts advance-past-end (the same code path as ArrowRight, not a second advance mechanism)", async () => {
      const { win } = boot({ steps: [], hidden: [] }, []);
      const { messages, stop } = collectMessages();

      press(win, " ");
      await tick();
      stop();

      expect(messages).toContainEqual({ source: "slidra-player", event: "advance-past-end" });
    });

    it("Escape posts exit-play — it's not advance/retreat, and it doesn't directly change any step state", async () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc } = boot(plan, ["el-a"]);
      const { messages, stop } = collectMessages();

      press(win, "Escape");
      await tick();
      stop();

      expect(messages).toContainEqual({ source: "slidra-player", event: "exit-play" });
      // Escape itself does not change reveal state — that's the parent document's concern, not the runtime's effect-advance.
      expect(hideStyleContains(doc, "el-a")).toBe(true);
    });

    it("existing ArrowRight / ArrowLeft do not regress from the new key bindings: both still advance/retreat as before", () => {
      const plan: StubPlan = {
        steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "fade")] }],
        hidden: ["el-a", "el-b"],
      };
      const { win, doc, animations } = boot(plan, ["el-a", "el-b"]);

      press(win, "ArrowRight");
      press(win, "ArrowRight");
      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(hideStyleContains(doc, "el-b")).toBe(false);

      press(win, "ArrowLeft");
      expect(hideStyleContains(doc, "el-a")).toBe(false);
      expect(hideStyleContains(doc, "el-b")).toBe(true);
    });
  });

  it("advancing to a step with a media effect creates a <video> aligned to the placeholder element, with src set to the original data-slidra-media value", () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }],
      hidden: [],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["el-video"]);

    press(win, "ArrowRight");

    const created = doc.body.querySelectorAll("video");
    expect(created).toHaveLength(1);
    expect(created[0].getAttribute("src")).toBe("assets/intro.webm");
  });

  it("advancing to a step with a media effect creates an <audio> element (not <video>)", () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("el-audio")] }],
      hidden: [],
      media: { "el-audio": { src: "assets/narration.oga", kind: "audio" } },
    };
    const { win, doc } = boot(plan, ["el-audio"]);

    press(win, "ArrowRight");

    expect(doc.body.querySelectorAll("audio")).toHaveLength(1);
    expect(doc.body.querySelectorAll("video")).toHaveLength(0);
  });

  it("advancing to the same media target twice does not create a second media element (idempotence)", () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }, { effects: [media("el-video")] }],
      hidden: [],
      media: { "el-video": { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["el-video"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");

    expect(doc.body.querySelectorAll("video")).toHaveLength(1);
  });

  // Element ids come straight from
  // untrusted slide content (ADR-0007) — nothing stops a legal id from
  // being "constructor". A plain `{}` for mediaElements already has an
  // inherited, truthy `constructor` property (Object.prototype's own)
  // *before this target was ever reached the first time* — so the
  // idempotence guard `if (mediaElements[target]) return;` short-circuits
  // on the very first press, and playMedia() returns immediately without
  // creating any element and without posting any error. The step silently
  // does nothing, which is exactly the failure shape this project forbids
  // (design doc's settled decision #12: errors must surface, never fail
  // silently) — and this is not a contrived edge case, "constructor" is a
  // perfectly legal SVG id an author could genuinely pick.
  it('when the target id is exactly "constructor", media is still created and played correctly (not silently skipped by mistaking the inherited property for an existing entry)', () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("constructor")] }],
      hidden: [],
      media: { constructor: { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["constructor"]);

    press(win, "ArrowRight");

    expect(doc.body.querySelectorAll("video")).toHaveLength(1);
  });

  it("posts an error event instead of throwing when plan.media has no config for the target", async () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("el-video")] }],
      hidden: [],
      media: {},
    };
    const { win } = boot(plan, ["el-video"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowRight");
    await tick();
    stop();

    expect(messages).toContainEqual(
      expect.objectContaining({ source: "slidra-player", event: "error", message: expect.stringContaining("el-video") }),
    );
  });

  it("takes focus back to its own window when it receives a focus command from the host", async () => {
    const { win } = boot({ steps: [], hidden: [] }, []);
    let called = false;
    // jsdom does not implement a real Window.focus(); stubbing it out lets
    // this test assert the runtime called it, without the noisy
    // "Not implemented" console warning a real call would print.
    (win as unknown as { focus: () => void }).focus = () => {
      called = true;
    };

    win.postMessage({ source: "slidra-host", command: "focus" }, "*");
    await tick();

    expect(called).toBe(true);
  });

  // ------------------------------------------------------------------
  // emphasis/exit families, and Preview (D8).
  // ------------------------------------------------------------------

  it("emphasis effects do not affect hidden state; keyframes are a there-and-back transform sequence", () => {
    const plan: StubPlan = { steps: [{ effects: [emphasis("el-a", "pulse")] }], hidden: [] };
    const { win, doc, animations } = boot(plan, ["el-a"]);

    press(win, "ArrowRight");

    expect(hideStyleContains(doc, "el-a")).toBe(false);
    const call = animationsFor(animations, "el-a")[0];
    expect(String(call.keyframes[0].transform)).toContain("scale(1)");
    expect(String(call.keyframes[call.keyframes.length - 1].transform)).toContain("scale(1)");
    expect(call.options.fill).toBe("none");
  });

  it("D12: an exit effect's target starts out not hidden, and el.animate ends with fill: forwards holding at opacity 0", () => {
    const plan: StubPlan = {
      steps: [{ effects: [exitEffect("el-a", "fade-out")] }],
      hidden: [], // this target's only effect is exit — never pre-hidden.
    };
    const { win, doc, animations } = boot(plan, ["el-a"]);

    expect(hideStyleContains(doc, "el-a")).toBe(false);

    press(win, "ArrowRight");

    const call = animationsFor(animations, "el-a")[0];
    expect(call.options.fill).toBe("forwards");
    expect(lastKeyframe(call).opacity).toBe(0);
  });

  describe("Preview (D8)", () => {
    it("when plan.preview.effectIndices is given, only those effect indices play, then preview-done is posted once done", async () => {
      const plan: StubPlan = {
        steps: [
          { effects: [enter("el-a", "appear", { duration: 0, index: 0 })] },
          { effects: [enter("el-b", "appear", { duration: 0, index: 1 })] },
        ],
        hidden: ["el-a", "el-b"],
        preview: { effectIndices: [1] },
      };
      const { animations } = boot(plan, ["el-a", "el-b"]);
      const { messages, stop } = collectMessages();

      await wait(100);
      stop();

      expect(animationsFor(animations, "el-a")).toHaveLength(0);
      expect(animationsFor(animations, "el-b")).toHaveLength(1);
      expect(messages).toContainEqual({ source: "slidra-player", event: "preview-done" });
      // "ready" is still the boot sequence's own last message — preview-done
      // is a distinct, later message, not a replacement for it.
      expect(messages[0]).toEqual({ source: "slidra-player", event: "ready" });
    });

    it("when plan.preview.effectIndices is null, plays every step of the whole deck in order, then posts preview-done", async () => {
      const plan: StubPlan = {
        steps: [
          { effects: [enter("el-a", "appear", { duration: 0, index: 0 })] },
          { effects: [enter("el-b", "appear", { duration: 0, index: 1 })] },
        ],
        hidden: ["el-a", "el-b"],
        preview: { effectIndices: null },
      };
      const { animations } = boot(plan, ["el-a", "el-b"]);
      const { messages, stop } = collectMessages();

      // Two steps at duration:0 plus one fixed inter-step gap — a generous
      // upper bound, not a tight timing assertion.
      await wait(800);
      stop();

      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(animationsFor(animations, "el-b")).toHaveLength(1);
      expect(messages).toContainEqual({ source: "slidra-player", event: "preview-done" });
    });

    it("posts preview-done immediately when preview has an empty list (no steps)", async () => {
      const plan: StubPlan = { steps: [], hidden: [], preview: { effectIndices: null } };
      boot(plan, []);
      const { messages, stop } = collectMessages();

      await wait(100);
      stop();

      expect(messages).toContainEqual({ source: "slidra-player", event: "preview-done" });
    });
  });
});
