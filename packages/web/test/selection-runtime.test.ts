import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ADR-0011 / #56 — selection-runtime.js is deliberately plain, import-free
 * JavaScript meant to be inlined into a sandboxed iframe's srcdoc (same
 * posture as player-runtime.js), so it is exercised the same way: evaluated
 * inside a real (nested) window/document, with postMessage as the only
 * channel out — never imported as a module.
 */
const runtimeSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/selection-runtime.js"),
  "utf8",
);

const COLORS = { accent: "rgb(224, 58, 86)", handle: "rgb(32, 31, 30)" };

let iframe: HTMLIFrameElement;

beforeEach(() => {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
});

afterEach(() => {
  iframe.remove();
});

/** Boots the runtime inside `iframe`'s own window/document with the given body markup. */
function boot(bodyMarkup: string, colors: typeof COLORS = COLORS): { win: Window; doc: Document } {
  const win = iframe.contentWindow as Window & { __COMOT_SELECTION_COLORS__?: typeof COLORS };
  const doc = iframe.contentDocument as Document;
  doc.body.innerHTML = bodyMarkup;
  win.__COMOT_SELECTION_COLORS__ = colors;
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc };
}

/**
 * Collects every `comot-selection` message posted to the outer (test)
 * window, excluding `"viewport"` (NOOP-91 §4.1) — jsdom's own async iframe
 * load can fire the runtime's `load` listener at an unpredictable point
 * relative to a test's click, and these tests are about hit resolution and
 * the select/clear contract, not the viewport report.
 */
function collectMessages(): { messages: unknown[]; stop: () => void } {
  const messages: unknown[] = [];
  const handler = (event: MessageEvent) => {
    if ((event.data as { event?: unknown })?.event === "viewport") return;
    messages.push(event.data);
  };
  window.addEventListener("message", handler);
  return { messages, stop: () => window.removeEventListener("message", handler) };
}

/** Dispatches a real click event that bubbles, so document's listener sees it. */
function click(doc: Document, el: Element): void {
  const win = doc.defaultView as Window;
  const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
}

/** Dispatches a real dblclick event that bubbles, so document's listener sees it. */
function dblclick(doc: Document, el: Element): void {
  const win = doc.defaultView as Window;
  const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  el.dispatchEvent(new MouseEventCtor("dblclick", { bubbles: true }));
}

/** Dispatches a real Escape keydown on `win`, where the runtime's own listener is registered. */
function pressEscape(win: Window): void {
  const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape" }));
}

/** Every `.group-frame` element inside `doc`'s shadow-hosted overlay — one per level of `groupPath` currently on screen (NOOP-149 r2's box pool). */
function groupFrameEls(doc: Document): HTMLElement[] {
  const host = doc.body.children[1];
  return [...host.shadowRoot!.querySelectorAll<HTMLElement>(".group-frame")];
}

/** The `.group-frame` boxes actually showing (`display:block`), outermost first. */
function visibleGroupFrames(doc: Document): HTMLElement[] {
  return groupFrameEls(doc).filter((el) => el.style.display === "block");
}

describe("selection-runtime.js", () => {
  it("點一個帶 id 的元素會回報 select，帶上它的 id 與 data-comot-name", async () => {
    const { doc } = boot('<svg><rect id="el-a" data-comot-name="標題"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-a")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "comot-selection", event: "select", id: "el-a", name: "標題", additive: false }]);
    stop();
  });

  it("點一個只有 id、沒有 data-comot-name 的元素，name 回報為 null", async () => {
    const { doc } = boot('<svg><rect id="el-b"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-b")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "comot-selection", event: "select", id: "el-b", name: null, additive: false }]);
    stop();
  });

  it("點沒有 id 祖先的空白處會回報 clear", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.querySelector("svg")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "comot-selection", event: "clear" }]);
    stop();
  });

  it("命中判定會沿祖先鏈往上找最近帶 id 的元素", async () => {
    const { doc } = boot('<svg><g id="el-group"><circle id="inner"></circle></g></svg>');
    doc.getElementById("inner")!.removeAttribute("id");
    const { messages, stop } = collectMessages();

    click(doc, doc.querySelector("circle")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "comot-selection", event: "select", id: "el-group", name: null, additive: false }]);
    stop();
  });

  it("選取框畫在 shadow root 裡，light DOM 只看得到一個 host、host 底下沒有 .sel", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);

    const hosts = doc.body.children;
    // slide markup (<svg>) + exactly one shadow host appended after it.
    expect(hosts.length).toBe(2);
    const host = hosts[1];
    expect(host.shadowRoot).not.toBeNull();
    expect(host.querySelector(".sel")).toBeNull();
    expect(host.shadowRoot!.querySelector(".sel")).not.toBeNull();
  });

  it("四角：shadow root 裡只有 .sel 加一個 i 子元素，沒有 b 或 u", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);

    const host = doc.body.children[1];
    const sel = host.shadowRoot!.querySelector(".sel")!;
    expect(sel.tagName.toLowerCase()).toBe("div");
    expect([...sel.children].map((c) => c.tagName.toLowerCase())).toEqual(["i"]);
  });

  it("host 用 inline !important 鎖住 display/visibility/opacity/z-index，不吃外部樣式", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);

    const host = doc.body.children[1] as HTMLElement;
    expect(host.style.getPropertyPriority("display")).toBe("important");
    expect(host.style.getPropertyPriority("visibility")).toBe("important");
    expect(host.style.getPropertyPriority("opacity")).toBe("important");
    expect(host.style.getPropertyPriority("z-index")).toBe("important");
    expect(host.style.display).toBe("block");
    expect(host.style.visibility).toBe("visible");
    expect(host.style.opacity).toBe("1");
  });

  it("重點色與 handle 色來自注入的 window.__COMOT_SELECTION_COLORS__，不是寫死在檔案裡的色碼", async () => {
    const customColors = { accent: "rgb(1, 2, 3)", handle: "rgb(4, 5, 6)" };
    const { doc } = boot('<svg><rect id="el-a"/></svg>', customColors);

    click(doc, doc.getElementById("el-a")!);

    const host = doc.body.children[1];
    const styleText = host.shadowRoot!.querySelector("style")!.textContent!;
    expect(styleText).toContain("rgb(1, 2, 3)");
    expect(styleText).toContain("rgb(4, 5, 6)");
    expect(runtimeSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("再點一次空白處會清掉選取框（display 變回 none，而不是只拿掉屬性）", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);
    const host = doc.body.children[1];
    const box = host.shadowRoot!.querySelector(".sel") as HTMLElement;
    expect(box.style.display).toBe("block");

    click(doc, doc.querySelector("svg")!);
    expect(box.style.display).toBe("none");
  });

  it("單選一個非群組元素：沒有任何 .group-frame 顯示", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);

    expect(visibleGroupFrames(doc)).toHaveLength(0);
  });

  it("單選一個群組元素（本身帶 id 的子元素）：顯示一個 .group-frame", async () => {
    const { doc } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    click(doc, doc.getElementById("el-group")!);

    expect(visibleGroupFrames(doc)).toHaveLength(1);
  });

  it("雙擊進入群組編輯：顯示一個 .group-frame", async () => {
    const { doc } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    dblclick(doc, doc.getElementById("el-child")!);

    expect(visibleGroupFrames(doc)).toHaveLength(1);
  });

  it("按 Esc 從群組編輯退到頂層且未選取任何群組：.group-frame 全部收起", async () => {
    const { doc, win } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    dblclick(doc, doc.getElementById("el-child")!);
    expect(visibleGroupFrames(doc)).toHaveLength(1);

    pressEscape(win);

    expect(visibleGroupFrames(doc)).toHaveLength(0);
  });

  it("三層巢狀群組逐層進入：每進一層 .group-frame 累加一個，由外而內堆疊", async () => {
    const { doc } = boot('<svg><g id="outer"><g id="middle"><rect id="leaf"/></g></g></svg>');
    const leaf = doc.getElementById("leaf")!;

    dblclick(doc, leaf);
    expect(visibleGroupFrames(doc)).toHaveLength(1);

    dblclick(doc, leaf);
    expect(visibleGroupFrames(doc)).toHaveLength(2);
  });

  it("三層巢狀群組逐層退出：Esc 每次只收掉最內層的 .group-frame，外層保留", async () => {
    const { doc, win } = boot('<svg><g id="outer"><g id="middle"><rect id="leaf"/></g></g></svg>');
    const leaf = doc.getElementById("leaf")!;

    dblclick(doc, leaf);
    dblclick(doc, leaf);
    expect(visibleGroupFrames(doc)).toHaveLength(2);

    pressEscape(win);
    expect(visibleGroupFrames(doc)).toHaveLength(1);

    pressEscape(win);
    expect(visibleGroupFrames(doc)).toHaveLength(0);
  });
});
