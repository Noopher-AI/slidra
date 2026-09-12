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
 * [E2.T7]/D7.5: jsdom has neither `Element.prototype.animate` nor
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

// [E2.T7]: widened from "enter" | "media" to the full five-family value set
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

/** [E2.T7]/D7.5: see this file's header comment. */
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
  const win = iframe.contentWindow as Window & { __COMOT_PLAN__?: StubPlan };
  const doc = iframe.contentDocument as Document;
  const hideSelectors = plan.hideSelectors ?? Object.fromEntries(plan.hidden.map((id) => [id, `#${id}`]));
  // `<style id="comot-hide">`, PRE-POPULATED with every hidden id's rule, is
  // normally injected by canvas.ts's wrapPlayDocument — it is
  // player-plan.ts's renderHideStyle() output, baked into the srcdoc HTML
  // before this script ever runs. These tests eval the runtime directly,
  // so they must reproduce that same starting state, not an empty shell —
  // the runtime itself never populates this stylesheet's *initial*
  // content, only rewrites it afterwards (D7).
  const initialRules = plan.hidden.map((id) => `${hideSelectors[id]}{opacity:0 !important}`).join("");
  doc.body.innerHTML =
    `<style id="comot-hide">${initialRules}</style>` + elementIds.map((id) => `<div id="${id}"></div>`).join("");
  const animations = stubWebAnimations(win);
  win.__COMOT_PLAN__ = { ...plan, hideSelectors };
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc, animations };
}

function press(win: Window, key: string): void {
  const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  win.document.dispatchEvent(new KeyboardEventCtor("keydown", { key }));
}

/** Whether `<style id="comot-hide">` still carries a rule for `id` — the D7 replacement for reading `el.style.opacity` directly (WAAPI keyframes aren't reflected in `.style` at all). */
function hideStyleContains(doc: Document, id: string): boolean {
  const styleEl = doc.getElementById("comot-hide");
  return !!styleEl && (styleEl.textContent ?? "").indexOf(`#${id}{`) !== -1;
}

function animationsFor(animations: StubAnimation[], id: string): StubAnimation[] {
  return animations.filter((call) => (call.el as HTMLElement).id === id);
}

function lastKeyframe(call: StubAnimation): Record<string, unknown> {
  return call.keyframes[call.keyframes.length - 1];
}

/** Collects every `comot-player` message posted to the outer (test) window. */
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

    expect(messages).toContainEqual({ source: "comot-player", event: "ready" });
  });

  it("ArrowRight 推進一步時，同一步的多個元素一起出現（各自送出 el.animate，keyframes 最終 opacity 為 1）", () => {
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

  it("不屬於任何步驟的元素完全不被 runtime 碰觸", () => {
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

  it("effect.duration/delay 原樣（換算成毫秒）傳給 el.animate 的 options", () => {
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

  it("同一步裡 with-previous 對齊前一個的起點、after-previous 對齊前一個的終點（各自的 delay 再疊上去）", () => {
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

  it("逐步推進，一次只套用一步；推進到最後一步再按，改為送出 advance-past-end", async () => {
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

    expect(messages).toContainEqual({ source: "comot-player", event: "advance-past-end" });
  });

  it("ArrowLeft 從第 2 步退回第 1 步：第 1 步的元素仍解除隱藏，第 2 步的元素恢復隱藏", () => {
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

  it("退回時取消所有進行中的動畫，並把 hide 樣式表重新寫回完整的隱藏集合（D7 的「已知乾淨起點」延伸到 WAAPI）", () => {
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
    // retreat must not carry across (#46's "known-clean starting point").
    // The replay itself creates its own fresh (duration:0) calls, which are
    // legitimately still active — only the pre-retreat snapshot is checked.
    expect(beforeRetreat.length).toBeGreaterThan(0);
    expect(beforeRetreat.every((call) => call.cancelled)).toBe(true);
    expect(hideStyleContains(doc, "el-b")).toBe(true);
  });

  it("plan.startStep 為 -1（預設值）時開機：hidden 目標維持隱藏，與剛抵達投影片時相同", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      startStep: -1,
    };
    const { doc, animations } = boot(plan, ["el-a"]);

    expect(hideStyleContains(doc, "el-a")).toBe(true);
    expect(animations).toHaveLength(0);
  });

  it("退回重播的路徑上，media 效果被跳過，不建立媒體元素", () => {
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

  it("退回之後再前進到同一個 media 步驟，media 仍會播放（證明跳過只發生在重播路徑上）", () => {
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

  it("退回時媒體尚未開始播放：pause() 讓 play() 承諾在拆除之後才以 AbortError 回絕，不誤報成 error", async () => {
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

  it("play() 承諾以非 AbortError 回絕：即使該元素剛被 retreat 拆除，仍要送出 error", async () => {
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

  it("play() 以 AbortError 回絕，但該元素從未被 retreat 拆除過：仍要送出 error", async () => {
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

  it("退回重播時，每個 el.animate 呼叫都用 duration 0（不重播更早效果原本的動畫時長）", () => {
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

  it("開機時 plan.startStep 設為最後一步索引：直接落在該步驟已全部套用的狀態", async () => {
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
    expect(messages[messages.length - 1]).toEqual({ source: "comot-player", event: "ready" });
  });

  it("ArrowLeft 在投影片第一步（尚未按過任何鍵）時，送出 retreat-past-start，畫面不變", async () => {
    const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
    const { win, doc, animations } = boot(plan, ["el-a"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowLeft");
    await tick();
    stop();

    expect(hideStyleContains(doc, "el-a")).toBe(true);
    expect(animations).toHaveLength(0);
    expect(messages).toContainEqual({ source: "comot-player", event: "retreat-past-start" });
  });

  it("沒有步驟的投影片：第一次 ArrowRight 就直接送出 advance-past-end", async () => {
    const { win } = boot({ steps: [], hidden: [] }, []);
    const { messages, stop } = collectMessages();

    press(win, "ArrowRight");
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "comot-player", event: "advance-past-end" });
  });

  // [E2.T11] §3.8/§4.5: Space/PageDown mirror ArrowRight (「前進一步」),
  // PageUp mirrors ArrowLeft (「後退一步」), Escape posts a new "exit-play"
  // event canvas.ts decides how to act on (the runtime itself has no notion
  // of fullscreen). Existing ArrowRight/ArrowLeft behaviour must not regress.
  describe("Space／PageDown／PageUp／Escape ([E2.T11])", () => {
    it("Space 推進一步，跟 ArrowRight 完全同義（同一步的元素一起出現）", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc, animations } = boot(plan, ["el-a"]);

      press(win, " ");

      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(hideStyleContains(doc, "el-a")).toBe(false);
    });

    it("PageDown 推進一步，跟 ArrowRight 完全同義", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc, animations } = boot(plan, ["el-a"]);

      press(win, "PageDown");

      expect(animationsFor(animations, "el-a")).toHaveLength(1);
      expect(hideStyleContains(doc, "el-a")).toBe(false);
    });

    it("PageUp 退回一步，跟 ArrowLeft 完全同義", () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "fade")] }], hidden: ["el-a", "el-b"] };
      const { win, doc } = boot(plan, ["el-a", "el-b"]);
      press(win, "ArrowRight");
      press(win, "ArrowRight");

      press(win, "PageUp");

      expect(hideStyleContains(doc, "el-a")).toBe(false);
      expect(hideStyleContains(doc, "el-b")).toBe(true);
    });

    it("在投影片最後一步再按 Space／PageDown：送出 advance-past-end（跟 ArrowRight 同一條路徑，不建立第二個推進機制）", async () => {
      const { win } = boot({ steps: [], hidden: [] }, []);
      const { messages, stop } = collectMessages();

      press(win, " ");
      await tick();
      stop();

      expect(messages).toContainEqual({ source: "comot-player", event: "advance-past-end" });
    });

    it("Escape 送出 exit-play——不是 advance/retreat，也不直接改變任何步驟狀態", async () => {
      const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
      const { win, doc } = boot(plan, ["el-a"]);
      const { messages, stop } = collectMessages();

      press(win, "Escape");
      await tick();
      stop();

      expect(messages).toContainEqual({ source: "comot-player", event: "exit-play" });
      // Escape 本身不改變揭露狀態——它是父文件的事，不是 runtime 的效果推進。
      expect(hideStyleContains(doc, "el-a")).toBe(true);
    });

    it("既有的 ArrowRight／ArrowLeft 不因新鍵位而回歸：兩者仍照原行為推進/退回", () => {
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

  it("推進到 media 效果的步驟時，建立對齊佔位元素的 <video>，src 是原始 data-comot-media 值", () => {
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

  it("推進到 media 效果的步驟時，建立 <audio>（不是 <video>）", () => {
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

  it("同一 media 目標被推進兩次時，不建立第二個媒體元素（idempotence）", () => {
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

  // Codex review gate round 1, P2: element ids come straight from
  // untrusted slide content (ADR-0010) — nothing stops a legal id from
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
  it('target id 恰好是 "constructor" 時，media 仍正確建立並播放（不是被繼承屬性誤判成已存在而靜默跳過）', () => {
    const plan: StubPlan = {
      steps: [{ effects: [media("constructor")] }],
      hidden: [],
      media: { constructor: { src: "assets/intro.webm", kind: "video" } },
    };
    const { win, doc } = boot(plan, ["constructor"]);

    press(win, "ArrowRight");

    expect(doc.body.querySelectorAll("video")).toHaveLength(1);
  });

  it("plan.media 沒有該目標的設定時，送出 error 事件而不是拋例外", async () => {
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
      expect.objectContaining({ source: "comot-player", event: "error", message: expect.stringContaining("el-video") }),
    );
  });

  it("收到 host 的 focus 指令時，把焦點拿回自己的 window", async () => {
    const { win } = boot({ steps: [], hidden: [] }, []);
    let called = false;
    // jsdom does not implement a real Window.focus(); stubbing it out lets
    // this test assert the runtime called it, without the noisy
    // "Not implemented" console warning a real call would print.
    (win as unknown as { focus: () => void }).focus = () => {
      called = true;
    };

    win.postMessage({ source: "comot-host", command: "focus" }, "*");
    await tick();

    expect(called).toBe(true);
  });

  // ------------------------------------------------------------------
  // [E2.T7]: emphasis/exit families, and Preview (D8).
  // ------------------------------------------------------------------

  it("emphasis 效果不影響 hidden，keyframes 是 transform 的來回關鍵影格", () => {
    const plan: StubPlan = { steps: [{ effects: [emphasis("el-a", "pulse")] }], hidden: [] };
    const { win, doc, animations } = boot(plan, ["el-a"]);

    press(win, "ArrowRight");

    expect(hideStyleContains(doc, "el-a")).toBe(false);
    const call = animationsFor(animations, "el-a")[0];
    expect(String(call.keyframes[0].transform)).toContain("scale(1)");
    expect(String(call.keyframes[call.keyframes.length - 1].transform)).toContain("scale(1)");
    expect(call.options.fill).toBe("none");
  });

  it("D12：exit 效果的 target 一開始不在 hidden，el.animate 用 fill: forwards 收尾在 opacity 0", () => {
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

  describe("Preview（D8）", () => {
    it("plan.preview.effectIndices 給定時，只播放那幾個效果索引，完成後送出 preview-done", async () => {
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
      expect(messages).toContainEqual({ source: "comot-player", event: "preview-done" });
      // "ready" is still the boot sequence's own last message — preview-done
      // is a distinct, later message, not a replacement for it.
      expect(messages[0]).toEqual({ source: "comot-player", event: "ready" });
    });

    it("plan.preview.effectIndices 為 null 時，依序播放整份簡報每一步，最後送出 preview-done", async () => {
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
      expect(messages).toContainEqual({ source: "comot-player", event: "preview-done" });
    });

    it("preview 為空清單（沒有步驟）時，立刻送出 preview-done", async () => {
      const plan: StubPlan = { steps: [], hidden: [], preview: { effectIndices: null } };
      boot(plan, []);
      const { messages, stop } = collectMessages();

      await wait(100);
      stop();

      expect(messages).toContainEqual({ source: "comot-player", event: "preview-done" });
    });
  });
});
