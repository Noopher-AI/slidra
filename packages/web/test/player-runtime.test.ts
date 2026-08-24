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

interface StubEffect {
  target: string;
  family: "enter" | "media";
  effect: string;
  start: "on-click";
}
interface StubMediaCue {
  src: string;
  kind: "video" | "audio";
}
interface StubPlan {
  steps: { effects: StubEffect[] }[];
  hidden: string[];
  media?: Record<string, StubMediaCue>;
  startStep?: number;
}

function enter(target: string, effect: "fade" | "appear"): StubEffect {
  return { target, family: "enter", effect, start: "on-click" };
}
function media(target: string): StubEffect {
  return { target, family: "media", effect: "play", start: "on-click" };
}

/** Boots the runtime inside `iframe`'s own window/document with the given plan. */
function boot(plan: StubPlan, elementIds: string[]): { win: Window; doc: Document } {
  const win = iframe.contentWindow as Window & { __COMOT_PLAN__?: StubPlan };
  const doc = iframe.contentDocument as Document;
  doc.body.innerHTML = elementIds.map((id) => `<div id="${id}"></div>`).join("");
  win.__COMOT_PLAN__ = plan;
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc };
}

function press(win: Window, key: string): void {
  const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  win.document.dispatchEvent(new KeyboardEventCtor("keydown", { key }));
}

function opacityOf(doc: Document, id: string): string {
  return (doc.getElementById(id) as HTMLElement).style.opacity;
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

describe("player-runtime.js", () => {
  it("posts ready to the parent as soon as it boots", async () => {
    const { messages, stop } = collectMessages();
    boot({ steps: [], hidden: [] }, []);
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "comot-player", event: "ready" });
  });

  it("ArrowRight 推進一步時，同一步的多個元素一起出現", () => {
    // Hand-built here, bypassing parseEffects/deriveSteps entirely: this
    // is testing the runtime's own contract (apply whatever step it is
    // given), independent of whether today's parser can produce a
    // multi-effect step from a real file (it cannot yet — with-previous is
    // Out of Scope for #23/#26). See the report for that gap.
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade"), enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b", "el-bg"]);

    press(win, "ArrowRight");

    expect(opacityOf(doc, "el-a")).toBe("1");
    expect(opacityOf(doc, "el-b")).toBe("1");
  });

  it("不屬於任何步驟的元素完全不被 runtime 碰觸", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade")] }],
      hidden: ["el-a"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-bg"]);

    press(win, "ArrowRight");

    // el-bg was never in `hidden`, so it starts on screen and the runtime
    // never sets its opacity at all — no inline style was ever written.
    expect((doc.getElementById("el-bg") as HTMLElement).style.opacity).toBe("");
  });

  it("fade 用 transition，appear 是瞬間（沒有 transition）", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade"), enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");

    expect((doc.getElementById("el-a") as HTMLElement).style.transition).toContain("opacity");
    expect((doc.getElementById("el-b") as HTMLElement).style.transition).toBe("none");
  });

  it("逐步推進，一次只套用一步；推進到最後一步再按，改為送出 advance-past-end", async () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "fade")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowRight");
    expect(opacityOf(doc, "el-a")).toBe("1");
    expect(opacityOf(doc, "el-b")).toBe("");

    press(win, "ArrowRight");
    expect(opacityOf(doc, "el-b")).toBe("1");

    press(win, "ArrowRight");
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "comot-player", event: "advance-past-end" });
  });

  it("ArrowLeft 從第 2 步退回第 1 步：第 1 步的元素仍可見，第 2 步的元素恢復隱藏", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    expect(opacityOf(doc, "el-a")).toBe("1");
    expect(opacityOf(doc, "el-b")).toBe("1");

    press(win, "ArrowLeft");

    expect(opacityOf(doc, "el-a")).toBe("1");
    expect(opacityOf(doc, "el-b")).toBe("");
  });

  it("退回時把恢復隱藏的元素之 transition 設為 none，而不是移除（避免作者自訂的 transition 在退回瞬間跑動畫）", () => {
    // jsdom doesn't run CSS transitions, so this only pins the inline style
    // state that makes an instant hide possible (transition:none set before
    // opacity is cleared) — it cannot observe the actual fade/no-fade visual
    // behaviour of a real browser. That is covered by a later e2e unit.
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    press(win, "ArrowLeft");

    const elB = doc.getElementById("el-b") as HTMLElement;
    expect(elB.style.transition).toBe("none");
    expect(elB.style.opacity).toBe("");
  });

  it("plan.startStep 為 -1（預設值）時開機：hidden 目標維持隱藏，與剛抵達投影片時相同", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "appear")] }],
      hidden: ["el-a"],
      startStep: -1,
    };
    const { doc } = boot(plan, ["el-a"]);

    expect(opacityOf(doc, "el-a")).toBe("");
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

  it("退回 fade 步驟不會重新播放更早的 fade（重播時 transition 一律關閉）", () => {
    const plan: StubPlan = {
      steps: [{ effects: [enter("el-a", "fade")] }, { effects: [enter("el-b", "appear")] }],
      hidden: ["el-a", "el-b"],
    };
    const { win, doc } = boot(plan, ["el-a", "el-b"]);

    press(win, "ArrowRight");
    press(win, "ArrowRight");
    press(win, "ArrowLeft");

    expect((doc.getElementById("el-a") as HTMLElement).style.transition).toBe("none");
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

    expect(opacityOf(doc, "el-a")).toBe("1");
    expect(opacityOf(doc, "el-b")).toBe("1");
    expect(messages[messages.length - 1]).toEqual({ source: "comot-player", event: "ready" });
  });

  it("ArrowLeft 在投影片第一步（尚未按過任何鍵）時，送出 retreat-past-start，畫面不變", async () => {
    const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
    const { win, doc } = boot(plan, ["el-a"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowLeft");
    await tick();
    stop();

    expect(opacityOf(doc, "el-a")).toBe("");
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
});
