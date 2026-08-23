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

  it("ArrowLeft 完全被忽略：不換步驟，也不送出任何訊息", async () => {
    const plan: StubPlan = { steps: [{ effects: [enter("el-a", "fade")] }], hidden: ["el-a"] };
    const { win, doc } = boot(plan, ["el-a"]);
    const { messages, stop } = collectMessages();

    press(win, "ArrowLeft");
    await tick();
    stop();

    expect(opacityOf(doc, "el-a")).toBe("");
    expect(messages.filter((m) => (m as { event?: string }).event !== "ready")).toEqual([]);
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
