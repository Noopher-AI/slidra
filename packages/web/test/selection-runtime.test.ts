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
  // jsdom has no layout engine and does not implement elementFromPoint at all,
  // but the runtime's hit-tolerance ring (selection-runtime.js) calls it when
  // an exact hit misses. jsdom's honest answer for "what's at this point" is
  // "nothing", so shim it to null. This only fills an environment gap — it
  // does not change the production code path, which real browsers implement.
  // The ring's own pixel-tolerance behavior is covered by e2e/visual-qa, not here.
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
  win.__COMOT_SELECTION_COLORS__ = colors;
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc };
}

/**
 * Collects every `comot-selection` message posted to the outer (test)
 * window, excluding `"viewport"` (NOOP-91 §4.1) — jsdom's own async iframe
 * load can fire the runtime's `load` listener at an unpredictable point
 * relative to a test's click, and these tests are about hit resolution and
 * the select/clear contract, not the viewport report — and excluding
 * `"runtime-ready"` (NOOP-83 §2.1(c)) for the same reason it needs the same
 * treatment: `boot()` always runs before this function is called, so the
 * `postMessage` it fires at the very end of the runtime's IIFE is still
 * in-flight (postMessage delivery is asynchronous) when the listener below
 * attaches, and is delivered before whatever the test itself triggers next
 * — deterministically the first message every caller of `boot()` would
 * otherwise see, and irrelevant to what every test in this file asserts.
 * `"bounds"` (NOOP-90/T2 §4.6) is excluded the same way: `updateBoxes()`
 * fires it on every selection change alongside `select`/`clear`, and it has
 * its own dedicated assertions further down this file.
 */
function collectMessages(): { messages: unknown[]; stop: () => void } {
  const messages: unknown[] = [];
  const handler = (event: MessageEvent) => {
    const eventName = (event.data as { event?: unknown })?.event;
    if (eventName === "viewport" || eventName === "runtime-ready" || eventName === "bounds") return;
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

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Sends a `begin-text-edit` host command the same way canvas.ts's
 * `enterTextEdit` does, entering the runtime's in-place editing mode for
 * `id`. Dispatched as a manually-constructed `MessageEvent` rather than a
 * real `win.postMessage(...)` call: jsdom does not wire up
 * `iframe.contentWindow.parent`/`.top` for a plainly `appendChild`'d
 * iframe (verified directly — `win.parent !== window` here, and a real
 * cross-window `postMessage` delivers with `event.source` matching
 * neither `window` nor `win.parent`), so the runtime's own
 * `event.source !== parentWindow` guard (ADR-0011's host-authenticity
 * check — this is the one thing selection-runtime.js's message listener
 * checks that player-runtime.js's does not) would silently drop every
 * such message. Setting `source: win.parent` explicitly on a
 * synthesized event reproduces exactly what a real embedding's
 * `postMessage` would deliver, without weakening that guard.
 */
async function beginTextEdit(win: Window, id: string, text: string): Promise<void> {
  const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  win.dispatchEvent(
    new MessageEventCtor("message", {
      data: { source: "comot-host", command: "begin-text-edit", id, text },
      source: win.parent as unknown as MessageEventSource,
    }),
  );
  await tick();
}

/**
 * Sends a `preview-textbox` host command the same way canvas.ts's
 * `textboxPreviewMessage`/`postToFrame` pair does (NOOP-65r3 §2c) — same
 * synthesized-`MessageEvent` reasoning as `beginTextEdit` above.
 */
async function sendPreviewTextbox(win: Window, id: string, markup: unknown, width?: number): Promise<void> {
  const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  win.dispatchEvent(
    new MessageEventCtor("message", {
      data: { source: "comot-host", command: "preview-textbox", id, markup, width },
      source: win.parent as unknown as MessageEventSource,
    }),
  );
  await tick();
}

/** The content `<text>`'s own outerHTML, for asserting on the rebuilt tspan tree. */
function contentTextOuterHtml(doc: Document, id: string): string {
  return doc.getElementById(id)!.querySelector("text")!.outerHTML;
}

/** The hidden `<textarea>` the runtime uses to capture keystrokes while editing — lazily created by `ensureTextarea()`, so only present once an edit session has started. */
function editTextarea(doc: Document): HTMLTextAreaElement {
  const host = doc.body.children[doc.body.children.length - 1];
  return host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
}

/** Dispatches a real pointerdown that bubbles, with the given client coordinates and pointerId — same shape the runtime's own pointerdown/pointermove/pointerup listeners read. */
function pointerdownAt(doc: Document, el: Element, clientX: number, clientY: number, pointerId = 1): void {
  const win = doc.defaultView as Window;
  const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
  el.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, button: 0, pointerId, clientX, clientY }));
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

    // First dblclick enters "outer" and (NOOP-149r3) resolves the
    // newly-entered scope's own selection through the same
    // outermost-within-scope rule a click/drag hit-test uses — that lands
    // on "middle" (a group, not yet entered), not "leaf". "middle" being
    // selected-but-not-entered is exactly the same situation a plain click
    // on a group produces, so it gets the same one-frame preview on top of
    // "outer"'s own entered-scope frame: 2 frames, not 1.
    dblclick(doc, leaf);
    expect(visibleGroupFrames(doc)).toHaveLength(2);

    // Second dblclick enters "middle" itself; its own selection resolves
    // to "leaf" (not a group), so no extra preview frame — still 2, now
    // both actually entered.
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

/**
 * ADR-0017 / NOOP-272 — in-place editing's caret/selection state machine.
 * jsdom has no layout engine and implements neither `getScreenCTM` nor
 * `getNumberOfChars` at all (verified directly against jsdom, not just
 * assumed), so `indexAtPoint()` always resolves to `null` here — every
 * geometry-dependent assertion (actual caret x, selection block rects) is
 * an e2e concern (e2e/text-edit.test.ts), never a jsdom one. What jsdom
 * CAN exercise without any layout: the parts of the state machine that
 * don't need a resolved index at all — the IME composition guard around
 * Esc, and that a pointerdown landing inside the edited element never
 * falls through to the plain element-gesture code path it used to hit
 * before ADR-0017 (this only used to `return`; it now branches into
 * text-selection first, so this guards against a future edit
 * accidentally letting it fall through into `gesture = {...}`).
 */
describe("selection-runtime.js — in-place editing (ADR-0017)", () => {
  it("組字期間按 Esc 不 commit、不離開編輯；組字結束後 Esc 才 commit", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);
    const { messages, stop } = collectMessages();

    ta.dispatchEvent(new (win as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent("compositionstart", { bubbles: true }));
    pressEscape(win);
    await tick();
    expect(messages).toHaveLength(0);

    ta.dispatchEvent(new (win as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent("compositionend", { bubbles: true }));
    pressEscape(win);
    await tick();
    expect(messages).toContainEqual({ source: "comot-selection", event: "text-edit-commit", id: "el-text" });
    stop();
  });

  it("組字期間 pointerdown 落在被編輯元素之外，仍然 commit 並離開編輯（既有行為不受本次修改影響）", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g><rect id="outside"/></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);
    ta.dispatchEvent(new (win as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent("compositionstart", { bubbles: true }));
    const { messages, stop } = collectMessages();

    pointerdownAt(doc, doc.getElementById("outside")!, 0, 0);
    await tick();

    expect(messages).toContainEqual({ source: "comot-selection", event: "text-edit-commit", id: "el-text" });
    stop();
  });

  it("編輯中：pointerdown 落在被編輯元素內部不會發出 gesture-start、select 或 clear", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const { messages, stop } = collectMessages();

    pointerdownAt(doc, doc.getElementById("el-text")!, 5, 5);
    await tick();

    expect(messages.filter((m) => (m as { event?: string }).event === "gesture-start")).toHaveLength(0);
    expect(messages.filter((m) => (m as { event?: string }).event === "select")).toHaveLength(0);
    expect(messages.filter((m) => (m as { event?: string }).event === "clear")).toHaveLength(0);
    stop();
  });

  it("編輯中 click／dblclick 仍被忽略，不觸發選取", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-text")!);
    dblclick(doc, doc.getElementById("el-text")!);
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("編輯中按 Enter（無修飾鍵）不呼叫 preventDefault（NOOP-65 決定 A：讓瀏覽器原生插入換行），不 commit、不離開編輯", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-comot-text-width="400"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    const event = new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true, bubbles: true });
    ta.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(messages).toHaveLength(0);
    stop();
  });

  it("編輯中按 ⌘Enter／Ctrl+Enter：preventDefault，不插入換行、不 commit、不離開編輯", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-comot-text-width="400"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    const cmdEnter = new KeyboardEventCtor("keydown", { key: "Enter", metaKey: true, cancelable: true, bubbles: true });
    ta.dispatchEvent(cmdEnter);
    const ctrlEnter = new KeyboardEventCtor("keydown", { key: "Enter", ctrlKey: true, cancelable: true, bubbles: true });
    ta.dispatchEvent(ctrlEnter);
    await tick();

    expect(cmdEnter.defaultPrevented).toBe(true);
    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect(messages).toHaveLength(0);
    stop();
  });

  it("貼上含 \\r\\n 的內容正規化成 \\n，不是被拿掉（NOOP-65 §4.4：pasted 多行文字合法）", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-comot-text-width="400"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);

    ta.value = "a\r\nb\rc";
    ta.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    await tick();

    expect(ta.value).toBe("a\nb\nc");
  });
});

describe("selection-runtime.js — Enter 進入就地編輯（NOOP-65 §4.4，鍵盤等同雙擊）", () => {
  it("未編輯、選取恰好一個文字框，按 Enter（無修飾鍵）送出 dblclick-textbox", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-comot-text-width="400"><text>Hi</text></g></svg>');
    click(doc, doc.getElementById("el-box")!);
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toContainEqual({ source: "comot-selection", event: "dblclick-textbox", id: "el-box" });
    stop();
  });

  it("未選取任何元素時按 Enter 是 no-op", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-comot-text-width="400"><text>Hi</text></g></svg>');
    void doc;
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("選取 2 個以上元素時按 Enter 是 no-op", async () => {
    const { doc, win } = boot(
      '<svg><g id="el-a" data-comot-text-width="400"><text>A</text></g><g id="el-b" data-comot-text-width="400"><text>B</text></g></svg>',
    );
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    click(doc, doc.getElementById("el-a")!);
    doc.getElementById("el-b")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("選取的不是文字元素時按 Enter 是 no-op", async () => {
    const { doc, win } = boot('<svg><rect id="el-rect" width="10" height="10"/></svg>');
    click(doc, doc.getElementById("el-rect")!);
    await tick();
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("⌘Enter／Shift+Enter 等帶修飾鍵的 Enter 不觸發進入編輯", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-comot-text-width="400"><text>Hi</text></g></svg>');
    click(doc, doc.getElementById("el-box")!);
    await tick();
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", metaKey: true, cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", shiftKey: true, cancelable: true }));
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });
});

// NOOP-328/NOOP-334: the postMessage-protocol boundary contract that makes
// the host-side !viewport guards (canvas.ts) rarely matter in practice —
// reportViewport() must fire synchronously, immediately before "gesture-start"
// is posted, so send-order delivery guarantees the host already has a
// viewport by the time it processes the gesture. Removing that
// reportViewport() call (leaving viewport reporting wired to "load"/"resize"
// only, as before NOOP-328) must fail this test.
describe("selection-runtime.js 的手勢起點：viewport 必須早於 gesture-start 送出", () => {
  it("拖曳超過門檻觸發手勢時，緊接在 gesture-start 之前送出的是 viewport 訊息", async () => {
    const { win, doc } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const host = doc.querySelector("[data-comot-selection-host]") as HTMLElement;
    const handleEl = host.shadowRoot!.querySelector('[data-comot-handle="nw"]') as HTMLElement;
    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    handleEl.dispatchEvent(
      new PointerEventCtor("pointerdown", { bubbles: true, composed: true, pointerId: 1, clientX: 100, clientY: 100, button: 0 }),
    );
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 110, clientY: 110 }));
    // postMessage delivery is async even within the same window (jsdom
    // queues it as a task) — give it a tick before reading `messages`.
    // jsdom's own iframe "load" can also fire the runtime's load-wired
    // reportViewport() at an unpredictable point (see collectMessages'
    // own comment above), so this may capture extra leading "viewport"
    // messages; that's fine — see the assertion below for why.
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.removeEventListener("message", handler);

    // Only the last two messages matter: the gesture's own reportViewport()
    // call and its post({event:"gesture-start", ...}) happen back-to-back,
    // synchronously, inside the same pointermove handler invocation — with
    // nothing else able to post a message in between — so send-order
    // delivery guarantees this pair is adjacent regardless of whether (or
    // when) "load"'s own viewport report also fired. Remove the guarded
    // reportViewport() call and the message directly before "gesture-start"
    // stops being "viewport" (or disappears entirely).
    const lastTwo = messages.slice(-2).map((message) => message.event);
    expect(lastTwo).toEqual(["viewport", "gesture-start"]);
  });
});

/** Sends the host's `"selection"` command the same authenticated-source way `beginTextEdit` above sends `"begin-text-edit"`. */
async function sendSelectionCommand(win: Window, ids: string[]): Promise<void> {
  const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  win.dispatchEvent(
    new MessageEventCtor("message", {
      data: { source: "comot-host", command: "selection", ids, handles: ids.length === 1 ? "full" : "move-only" },
      source: win.parent as unknown as MessageEventSource,
    }),
  );
  await tick();
}

describe("selection-runtime.js — bounds 事件（NOOP-90/T2 §4.6）", () => {
  it("回報每個選取元素的祖先鏈，最外層在前；union 是所有選取元素的聯集", async () => {
    const { win } = boot(
      '<svg><g id="el-outer" data-comot-name="外層"><g id="el-inner"><rect id="el-leaf"/></g></g></svg>',
    );
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    await sendSelectionCommand(win, ["el-leaf"]);

    window.removeEventListener("message", handler);
    const bounds = messages.filter((m) => m.event === "bounds").pop() as any;
    expect(bounds.items).toEqual([
      {
        id: "el-leaf",
        rect: { x: 0, y: 0, width: 0, height: 0 },
        ancestors: [
          { id: "el-outer", name: "外層" },
          { id: "el-inner", name: null },
        ],
      },
    ]);
    expect(bounds.union).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("清空選取時回報空 items 與 null union", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    await sendSelectionCommand(win, []);

    window.removeEventListener("message", handler);
    const bounds = messages.filter((m) => m.event === "bounds").pop() as any;
    expect(bounds.items).toEqual([]);
    expect(bounds.union).toBeNull();
  });

  it("選取的 id 在 DOM 中已不存在時，該筆略過，不拋錯", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    await sendSelectionCommand(win, ["el-does-not-exist"]);

    window.removeEventListener("message", handler);
    const bounds = messages.filter((m) => m.event === "bounds").pop() as any;
    expect(bounds.items).toEqual([]);
    expect(bounds.union).toBeNull();
  });
});

// [E2.T7]/D9: the stage's animation number badges need bounds for every
// element that has an effect, not just the current selection — a separate
// on-demand command from `bounds`, deliberately never folded into that
// per-drag-frame path (see selection-runtime.js's own comment on
// reportMeasured).
describe("selection-runtime.js — measure 指令（[E2.T7]/D9）", () => {
  async function sendMeasureCommand(win: Window, ids: string[]): Promise<void> {
    const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
    win.dispatchEvent(
      new MessageEventCtor("message", {
        data: { source: "comot-host", command: "measure", ids },
        source: win.parent as unknown as MessageEventSource,
      }),
    );
    await tick();
  }

  it("回報每個給定 id（不限於目前選取）的 getBoundingClientRect()", async () => {
    const { win } = boot('<svg><rect id="el-a"/><rect id="el-b"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    await sendMeasureCommand(win, ["el-a", "el-b"]);

    window.removeEventListener("message", handler);
    const measured = messages.filter((m) => m.event === "measured").pop() as any;
    expect(measured.items).toEqual([
      { id: "el-a", rect: { x: 0, y: 0, width: 0, height: 0 } },
      { id: "el-b", rect: { x: 0, y: 0, width: 0, height: 0 } },
    ]);
  });

  it("給定的 id 在 DOM 中不存在時，該筆略過，不拋錯", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    await sendMeasureCommand(win, ["el-nope"]);

    window.removeEventListener("message", handler);
    const measured = messages.filter((m) => m.event === "measured").pop() as any;
    expect(measured.items).toEqual([]);
  });
});

describe("selection-runtime.js — 多選畫單一虛線聯集框（05-INTERACTIONS.feature「多選」）", () => {
  it("⇧點第二個元素後，shadow root 裡只有一個 .sel-multi 顯示，不是每個元素各一個", async () => {
    const { doc } = boot('<svg><rect id="el-a"/><rect id="el-b"/></svg>');

    click(doc, doc.getElementById("el-a")!);
    const win = doc.defaultView as Window;
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    doc.getElementById("el-b")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();

    const host = doc.body.children[doc.body.children.length - 1];
    const boxes = [...host.shadowRoot!.querySelectorAll<HTMLElement>(".sel-multi")];
    expect(boxes.length).toBe(1);
    expect(boxes[0].style.display).toBe("block");
  });

  it("⇧點取消回到單選後，.sel-multi 收起", async () => {
    const { doc } = boot('<svg><rect id="el-a"/><rect id="el-b"/></svg>');
    click(doc, doc.getElementById("el-a")!);
    const win = doc.defaultView as Window;
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    doc.getElementById("el-b")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();

    // Shift-click el-b again removes it from the selection, back to a single el-a.
    doc.getElementById("el-b")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();

    const host = doc.body.children[doc.body.children.length - 1];
    const box = host.shadowRoot!.querySelector(".sel-multi") as HTMLElement;
    expect(box.style.display).toBe("none");
  });
});

describe("selection-runtime.js — 元素上按右鍵（右鍵選單已移除，項目併入父文件的情境列）", () => {
  it("在未選取的元素上按右鍵：選取它、壓掉瀏覽器原生選單，不再回報 contextmenu 事件", async () => {
    const { win, doc } = boot('<svg><rect id="el-a" data-comot-name="矩形"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const event = new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 24 });
    doc.getElementById("el-a")!.dispatchEvent(event);
    await tick();

    window.removeEventListener("message", handler);
    expect(event.defaultPrevented).toBe(true);
    expect(messages).toContainEqual({ source: "comot-selection", event: "select", id: "el-a", name: "矩形", additive: false });
    expect(messages.some((m) => m.event === "contextmenu")).toBe(false);
  });

  it("在空白處按右鍵：no-op，不壓掉原生選單、不發任何事件", async () => {
    const { win, doc } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const event = new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    doc.querySelector("svg")!.dispatchEvent(event);
    await tick();

    window.removeEventListener("message", handler);
    expect(event.defaultPrevented).toBe(false);
    expect(messages.some((m) => m.event === "select" || m.event === "contextmenu")).toBe(false);
  });
});

describe("selection-runtime.js — 鍵盤中繼 stage-key（NOOP-90/T2 §4.4）", () => {
  it("白名單鍵（含修飾鍵）在編輯與手勢之外會被中繼；沒有修飾鍵的 a/d 不會", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "a", metaKey: true, cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Delete", cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "]", metaKey: true, shiftKey: true, cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "a", cancelable: true }));
    await tick();

    window.removeEventListener("message", handler);
    const relayed = messages.filter((m) => m.event === "stage-key");
    expect(relayed).toEqual([
      { source: "comot-selection", event: "stage-key", key: "a", meta: true, ctrl: false, shift: false, alt: false },
      { source: "comot-selection", event: "stage-key", key: "Delete", meta: false, ctrl: false, shift: false, alt: false },
      { source: "comot-selection", event: "stage-key", key: "]", meta: true, ctrl: false, shift: true, alt: false },
    ]);
  });

  it("⌘Z 與 ⇧⌘Z 會被中繼（#198）；沒有修飾鍵的 z 不會", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "z", metaKey: true, cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Z", ctrlKey: true, shiftKey: true, cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "z", cancelable: true }));
    await tick();

    window.removeEventListener("message", handler);
    const relayed = messages.filter((m) => m.event === "stage-key");
    expect(relayed).toEqual([
      { source: "comot-selection", event: "stage-key", key: "z", meta: true, ctrl: false, shift: false, alt: false },
      { source: "comot-selection", event: "stage-key", key: "Z", meta: false, ctrl: true, shift: true, alt: false },
    ]);
  });

  it("編輯期間不中繼任何白名單鍵", async () => {
    const { win } = boot('<svg><g id="el-text"><text font-size="20">Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Delete", cancelable: true }));
    await tick();

    window.removeEventListener("message", handler);
    expect(messages.some((m) => m.event === "stage-key")).toBe(false);
  });
});

// NOOP-65r3 §2d/C1/C5 — `applyPreviewTextbox` now takes a finished markup
// STRING (core's own `renderTextBoxContent` output), not a `{ text, y }[]`
// the runtime used to reconstruct into a hard-coded `x="0"` tspan with no
// `data-comot-break`/nested runs (NOOP-65r2 FAIL 1). These two tests are
// the first coverage this channel has ever had (`grep -rln
// "preview-textbox|applyPreviewTextbox"` was empty before this ticket).
describe("selection-runtime.js 的文字框 preview 通道（NOOP-65r3）", () => {
  it("收到 markup 後，內容 <text> 的子節點含 data-comot-break、非零 x、巢狀 run tspan", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-comot-text-width="400"><text>Hi</text></g></svg>');

    await sendPreviewTextbox(
      win,
      "el-text",
      '<tspan x="12.5" y="16" data-comot-break="1">粗<tspan font-weight="bold">體字</tspan></tspan><tspan x="12.5" y="34">下一段</tspan>',
      220,
    );

    const html = contentTextOuterHtml(doc, "el-text");
    expect(html).toContain('data-comot-break="1"');
    expect(html).toContain('x="12.5"');
    expect(html).toContain('<tspan font-weight="bold">體字</tspan>');
    expect(html).toContain("下一段");
    expect(doc.getElementById("el-text")!.getAttribute("data-comot-text-width")).toBe("220");
  });

  it("markup 不是字串、或解析失敗時，DOM 完全不動", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-comot-text-width="400"><text>Hi</text></g></svg>');
    const before = contentTextOuterHtml(doc, "el-text");

    await sendPreviewTextbox(win, "el-text", 12345, 999); // wrong type
    expect(contentTextOuterHtml(doc, "el-text")).toBe(before);
    expect(doc.getElementById("el-text")!.getAttribute("data-comot-text-width")).toBe("400");

    await sendPreviewTextbox(win, "el-text", "<tspan>unterminated", 999); // fails to parse as SVG
    expect(contentTextOuterHtml(doc, "el-text")).toBe(before);
    expect(doc.getElementById("el-text")!.getAttribute("data-comot-text-width")).toBe("400");
  });
});
