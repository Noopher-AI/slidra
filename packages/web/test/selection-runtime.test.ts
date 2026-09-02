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
});
