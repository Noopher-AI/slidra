// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

type StageMediaTable = Record<string, { src: string; kind: "video" | "audio" }>;

/** Boots the runtime inside `iframe`'s own window/document with the given body markup. `media` ([E2.T17] plan §4.4) seeds `window.__SLIDRA_SELECTION_MEDIA__` the same way canvas.ts's wrapSelectionDocument does — defaulting to an empty table so every pre-existing call site (no media in play) is unaffected. */
function boot(
  bodyMarkup: string,
  colors: typeof COLORS = COLORS,
  media: StageMediaTable = {},
): { win: Window; doc: Document } {
  const win = iframe.contentWindow as Window & {
    __SLIDRA_SELECTION_COLORS__?: typeof COLORS;
    __SLIDRA_SELECTION_MEDIA__?: StageMediaTable;
  };
  const doc = iframe.contentDocument as Document;
  doc.body.innerHTML = bodyMarkup;
  // jsdom has no layout engine and does not implement elementFromPoint at all,
  // but the runtime's hit-tolerance ring (selection-runtime.js) calls it when
  // an exact hit misses. jsdom's honest answer for "what's at this point" is
  // "nothing", so shim it to null. This only fills an environment gap — it
  // does not change the production code path, which real browsers implement.
  // The ring's own pixel-tolerance behavior is covered by e2e/visual-qa, not here.
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
  win.__SLIDRA_SELECTION_COLORS__ = colors;
  win.__SLIDRA_SELECTION_MEDIA__ = media;
  (win as unknown as { eval: (source: string) => void }).eval(runtimeSource);
  return { win, doc };
}

/** Fires the runtime's `window.addEventListener("load", buildMediaOverlays)` (plan §4.4) — jsdom does not reliably fire a real `load` event for an iframe document built via `innerHTML`, so tests that need the media layer built dispatch it explicitly, the same way other tests dispatch synthetic keydown/click events on `win`. */
function fireLoad(win: Window): void {
  win.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("load"));
}

/**
 * Collects every `slidra-selection` message posted to the outer (test)
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
 * its own dedicated assertions further down this file. `"element-bounds"`
 * (F8) joins the same exclusion for the same reason:
 * `reportElementBounds()` fires once, unconditionally, at the very end of
 * the runtime's own IIFE — before `boot()` even returns — so it is exactly
 * as deterministically-first-and-irrelevant as `"runtime-ready"`.
 */
function collectMessages(): { messages: unknown[]; stop: () => void } {
  const messages: unknown[] = [];
  const handler = (event: MessageEvent) => {
    const eventName = (event.data as { event?: unknown })?.event;
    if (eventName === "viewport" || eventName === "runtime-ready" || eventName === "bounds" || eventName === "element-bounds") return;
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
      data: { source: "slidra-host", command: "begin-text-edit", id, text },
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
  it("reports select with the id and data-slidra-name of a clicked element with an id", async () => {
    const { doc } = boot('<svg><rect id="el-a" data-slidra-name="Title"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-a")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "slidra-selection", event: "select", id: "el-a", name: "Title", additive: false }]);
    stop();
  });

  it("reports name as null for an element with an id but no data-slidra-name", async () => {
    const { doc } = boot('<svg><rect id="el-b"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-b")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "slidra-selection", event: "select", id: "el-b", name: null, additive: false }]);
    stop();
  });

  it("reports clear when clicking blank space with no ancestor id", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');
    const { messages, stop } = collectMessages();

    click(doc, doc.querySelector("svg")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "slidra-selection", event: "clear" }]);
    stop();
  });

  it("hit-testing walks up the ancestor chain to the nearest element with an id", async () => {
    const { doc } = boot('<svg><g id="el-group"><circle id="inner"></circle></g></svg>');
    doc.getElementById("inner")!.removeAttribute("id");
    const { messages, stop } = collectMessages();

    click(doc, doc.querySelector("circle")!);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ source: "slidra-selection", event: "select", id: "el-group", name: null, additive: false }]);
    stop();
  });

  it("draws the selection box inside a shadow root, so the light DOM only sees the host with no .sel underneath", async () => {
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

  it("locks display/visibility/opacity/z-index on the host with inline !important, immune to outside styles", async () => {
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

  it("takes the accent and handle colors from injected window.__SLIDRA_SELECTION_COLORS__, not hardcoded color codes", async () => {
    const customColors = { accent: "rgb(1, 2, 3)", handle: "rgb(4, 5, 6)" };
    const { doc } = boot('<svg><rect id="el-a"/></svg>', customColors);

    click(doc, doc.getElementById("el-a")!);

    const host = doc.body.children[1];
    const styleText = host.shadowRoot!.querySelector("style")!.textContent!;
    expect(styleText).toContain("rgb(1, 2, 3)");
    expect(styleText).toContain("rgb(4, 5, 6)");
    expect(runtimeSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("clicking blank space again clears the selection box (display goes back to none, not just an attribute removal)", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);
    const host = doc.body.children[1];
    const box = host.shadowRoot!.querySelector(".sel") as HTMLElement;
    expect(box.style.display).toBe("block");

    click(doc, doc.querySelector("svg")!);
    expect(box.style.display).toBe("none");
  });

  it("selecting a single non-group element shows no .group-frame", async () => {
    const { doc } = boot('<svg><rect id="el-a"/></svg>');

    click(doc, doc.getElementById("el-a")!);

    expect(visibleGroupFrames(doc)).toHaveLength(0);
  });

  it("selecting a single group element (a child with its own id) shows one .group-frame", async () => {
    const { doc } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    click(doc, doc.getElementById("el-group")!);

    expect(visibleGroupFrames(doc)).toHaveLength(1);
  });

  it("double-clicking into group edit mode shows one .group-frame", async () => {
    const { doc } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    dblclick(doc, doc.getElementById("el-child")!);

    expect(visibleGroupFrames(doc)).toHaveLength(1);
  });

  it("pressing Esc to leave group edit mode back to the top level with nothing selected collapses all .group-frame boxes", async () => {
    const { doc, win } = boot('<svg><g id="el-group"><rect id="el-child"/></g></svg>');

    dblclick(doc, doc.getElementById("el-child")!);
    expect(visibleGroupFrames(doc)).toHaveLength(1);

    pressEscape(win);

    expect(visibleGroupFrames(doc)).toHaveLength(0);
  });

  it("entering three levels of nested groups one at a time adds one .group-frame per level, stacked outermost-first", async () => {
    const { doc } = boot('<svg><g id="outer"><g id="middle"><rect id="leaf"/></g></g></svg>');
    const leaf = doc.getElementById("leaf")!;

    // First dblclick enters "outer" and resolves the
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

  it("exiting three levels of nested groups one Esc at a time collapses only the innermost .group-frame each time, outer ones remain", async () => {
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
 * ADR-0017 — in-place editing's caret/selection state machine.
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
  it("Esc during IME composition does not commit or leave editing; Esc after composition ends commits", async () => {
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
    expect(messages).toContainEqual({ source: "slidra-selection", event: "text-edit-commit", id: "el-text" });
    stop();
  });

  it("a pointerdown outside the edited element during IME composition still commits and leaves editing (unchanged behavior)", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g><rect id="outside"/></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);
    ta.dispatchEvent(new (win as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent("compositionstart", { bubbles: true }));
    const { messages, stop } = collectMessages();

    pointerdownAt(doc, doc.getElementById("outside")!, 0, 0);
    await tick();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "text-edit-commit", id: "el-text" });
    stop();
  });

  it("while editing, a pointerdown inside the edited element does not emit gesture-start, select, or clear", async () => {
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

  it("click/dblclick while editing are still ignored and do not trigger selection", async () => {
    const { doc, win } = boot('<svg><g id="el-text"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const { messages, stop } = collectMessages();

    click(doc, doc.getElementById("el-text")!);
    dblclick(doc, doc.getElementById("el-text")!);
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("Enter (no modifier) while editing does not call preventDefault (letting the browser insert a native newline), and does not commit or leave editing", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');
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

  it("Cmd+Enter/Ctrl+Enter while editing: preventDefault, no newline inserted, no commit, no leaving editing", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');
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

  it("pasted content with \\r\\n is normalized to \\n, not stripped (multi-line pasted text is valid)", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    const ta = editTextarea(doc);

    ta.value = "a\r\nb\rc";
    ta.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    await tick();

    expect(ta.value).toBe("a\nb\nc");
  });
});

describe("selection-runtime.js — Enter to enter in-place editing (keyboard equivalent of double-click)", () => {
  it("not editing, exactly one text box selected: Enter (no modifier) sends dblclick-textbox", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-slidra-text-width="400"><text>Hi</text></g></svg>');
    click(doc, doc.getElementById("el-box")!);
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "dblclick-textbox", id: "el-box" });
    stop();
  });

  it("Enter is a no-op when nothing is selected", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-slidra-text-width="400"><text>Hi</text></g></svg>');
    void doc;
    const { messages, stop } = collectMessages();
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", cancelable: true }));
    await tick();

    expect(messages).toHaveLength(0);
    stop();
  });

  it("Enter is a no-op when 2 or more elements are selected", async () => {
    const { doc, win } = boot(
      '<svg><g id="el-a" data-slidra-text-width="400"><text>A</text></g><g id="el-b" data-slidra-text-width="400"><text>B</text></g></svg>',
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

  it("Enter is a no-op when the selected element is not a text element", async () => {
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

  it("Enter with a modifier held (Cmd+Enter, Shift+Enter, etc.) does not trigger entering edit mode", async () => {
    const { doc, win } = boot('<svg><g id="el-box" data-slidra-text-width="400"><text>Hi</text></g></svg>');
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

// The postMessage-protocol boundary contract that makes the host-side
// !viewport guards (canvas.ts) rarely matter in practice — reportViewport()
// must fire synchronously, immediately before "gesture-start" is posted, so
// send-order delivery guarantees the host already has a viewport by the time
// it processes the gesture. Removing that reportViewport() call (leaving
// viewport reporting wired to "load"/"resize" only) must fail this test.
describe("selection-runtime.js gesture start: viewport must be sent before gesture-start", () => {
  it("when a drag crosses the threshold to trigger a gesture, the message right before gesture-start is viewport", async () => {
    const { win, doc } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const handleEl = host.shadowRoot!.querySelector('[data-slidra-handle="nw"]') as HTMLElement;
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

// wrapSelectionDocument() (canvas.ts) places this runtime's <script> before
// bodyMarkup, so the IIFE-end reportElementBounds() call always fires before
// the root <svg> exists and reports an empty map — the only later trigger
// was document.fonts.ready, which can take seconds (or never fire for
// shape-only slides). A marquee that starts in that window used to race an
// empty elementBoundsById on the host, silently selecting nothing. Same fix
// shape as the viewport report above: send element-bounds synchronously,
// immediately before gesture-start, so postMessage's own
// send-order-is-delivery-order guarantee closes the race.
describe("selection-runtime.js marquee gesture start: element-bounds must be sent before gesture-start", () => {
  it("when a drag crosses the threshold to trigger a marquee gesture, the message right before gesture-start is element-bounds, and the one before that is viewport", async () => {
    const { win, doc } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');
    // Let boot()'s own IIFE-end post({event:"runtime-ready"})/reportElementBounds()
    // AND jsdom's own native iframe "load" (which also wires to
    // reportElementBounds()) get delivered to nobody before the listener
    // below attaches — verified empirically that jsdom's real "load" fires
    // and finishes delivering its messages within 2 macrotask ticks of
    // boot() here (never later; a 3rd/4th tick added nothing). Skipping
    // this drain lets a leftover element-bounds from EITHER source
    // coincidentally land in the "last three" slice checked below and mask
    // a real regression — verified directly: removing the marquee-branch
    // reportElementBounds() call did NOT fail this test without draining
    // both sources first.
    await tick();
    await tick();

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    // pointerdown on the <svg> root itself (not the rect) is a miss —
    // findSelectable() stops the walk at the outermost <svg> before ever
    // assigning `outermost` — so this starts a marquee, not a move gesture.
    const svg = doc.querySelector("svg") as SVGSVGElement;
    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    svg.dispatchEvent(
      new PointerEventCtor("pointerdown", { bubbles: true, composed: true, pointerId: 1, clientX: 10, clientY: 10, button: 0 }),
    );
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
    // postMessage delivery is async even within the same window (jsdom
    // queues it as a task) — give it a tick before reading `messages`.
    await tick();

    window.removeEventListener("message", handler);

    // Only the last three messages matter, for the same send-order reason
    // the sibling viewport/gesture-start test above only checks its last
    // two: the marquee branch's reportElementBounds() + reportViewport() +
    // post({event:"gesture-start"}) happen back-to-back, synchronously,
    // inside the same pointermove handler invocation, with nothing else
    // able to post a message in between.
    const lastThree = messages.slice(-3).map((message) => message.event);
    expect(lastThree).toEqual(["element-bounds", "viewport", "gesture-start"]);
  });

  it("a non-marquee (move) gesture start does not send an extra element-bounds — only viewport comes right before gesture-start", async () => {
    const { win, doc } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const rect = doc.querySelector("#el-a") as SVGRectElement;
    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    rect.dispatchEvent(
      new PointerEventCtor("pointerdown", { bubbles: true, composed: true, pointerId: 1, clientX: 10, clientY: 10, button: 0 }),
    );
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
    await tick();

    window.removeEventListener("message", handler);

    const lastTwo = messages.slice(-2).map((message) => message.event);
    expect(lastTwo).toEqual(["viewport", "gesture-start"]);
  });
});

// The IIFE-end reportElementBounds() call always races an unparsed <svg>
// (see the describe block above), and document.fonts.ready can take seconds
// or never resolve for a shape-only slide — this "load" listener is the
// fast, reliable path: as soon as the iframe's document has finished
// parsing, the host gets a real bounds report without waiting on fonts at all.
describe("selection-runtime.js element-bounds: a follow-up report fires on the load event", () => {
  it("firing the iframe's load event sends an extra element-bounds report", async () => {
    const { win } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);
    await tick();
    const countBeforeLoad = messages.filter((m) => m.event === "element-bounds").length;

    fireLoad(win);
    await tick();

    window.removeEventListener("message", handler);
    const countAfterLoad = messages.filter((m) => m.event === "element-bounds").length;

    // At least one MORE element-bounds report arrived once "load" fired —
    // stated as a delta rather than an absolute count because boot()'s own
    // IIFE-end call, and jsdom's own (unpredictable-timing) native iframe
    // load, can already have contributed some before this test's explicit
    // fireLoad() call.
    expect(countAfterLoad).toBeGreaterThan(countBeforeLoad);
  });
});

/** Sends the host's `"selection"` command the same authenticated-source way `beginTextEdit` above sends `"begin-text-edit"`. */
async function sendSelectionCommand(win: Window, ids: string[]): Promise<void> {
  const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  win.dispatchEvent(
    new MessageEventCtor("message", {
      data: { source: "slidra-host", command: "selection", ids, handles: ids.length === 1 ? "full" : "move-only" },
      source: win.parent as unknown as MessageEventSource,
    }),
  );
  await tick();
}

/** Flushes the iframe window's own `requestAnimationFrame` queue (`win`, not the outer test window) — `scheduleHoverMove`/`scheduleGestureMove` schedule against whichever window they run in. */
async function flushRaf(win: Window): Promise<void> {
  await new Promise((resolve) => (win as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame(resolve));
}

describe("selection-runtime.js — stage-hover relay (hover pass-through for the context bar)", () => {
  it("with a selection and no gesture/stage-pan/text-select-drag, pointermove sends stage-hover after rAF throttling", async () => {
    const { win } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');
    await sendSelectionCommand(win, ["el-a"]);
    const { messages, stop } = collectMessages();

    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 50, clientY: 60 }));
    await flushRaf(win);
    await tick();

    stop();
    expect(messages).toEqual([{ source: "slidra-selection", event: "stage-hover", point: { x: 50, y: 60 } }]);
  });

  it("pointermove does not send stage-hover when nothing is selected", async () => {
    const { win } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');
    const { messages, stop } = collectMessages();

    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 50, clientY: 60 }));
    await flushRaf(win);
    await tick();

    stop();
    expect(messages.filter((m) => (m as { event?: string }).event === "stage-hover")).toEqual([]);
  });

  it("pointermove does not send stage-hover while a gesture is in progress (pointerdown already started on the same pointer)", async () => {
    const { win, doc } = boot('<svg viewBox="0 0 1280 720"><rect id="el-a" width="160" height="100"/></svg>');
    await sendSelectionCommand(win, ["el-a"]);
    const { messages, stop } = collectMessages();

    const rect = doc.querySelector("#el-a") as SVGRectElement;
    pointerdownAt(doc, rect, 10, 10);
    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 50, clientY: 60 }));
    await flushRaf(win);
    await tick();

    stop();
    expect(messages.filter((m) => (m as { event?: string }).event === "stage-hover")).toEqual([]);
  });
});

describe("selection-runtime.js — bounds event", () => {
  it("reports each selected element's ancestor chain, outermost first; union is the union of all selected elements", async () => {
    const { win } = boot(
      '<svg><g id="el-outer" data-slidra-name="Outer"><g id="el-inner"><rect id="el-leaf"/></g></g></svg>',
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
          { id: "el-outer", name: "Outer" },
          { id: "el-inner", name: null },
        ],
      },
    ]);
    expect(bounds.union).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("reports empty items and a null union when the selection is cleared", async () => {
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

  it("skips an entry without throwing when a selected id no longer exists in the DOM", async () => {
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

// The stage's animation number badges need bounds for every element that
// has an effect, not just the current selection — a separate on-demand
// command from `bounds`, deliberately never folded into that per-drag-frame
// path (see selection-runtime.js's own comment on reportMeasured).
describe("selection-runtime.js — measure command", () => {
  async function sendMeasureCommand(win: Window, ids: string[]): Promise<void> {
    const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
    win.dispatchEvent(
      new MessageEventCtor("message", {
        data: { source: "slidra-host", command: "measure", ids },
        source: win.parent as unknown as MessageEventSource,
      }),
    );
    await tick();
  }

  it("reports getBoundingClientRect() for each given id (not limited to the current selection)", async () => {
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

  it("skips an entry without throwing when a given id does not exist in the DOM", async () => {
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

describe("selection-runtime.js — multi-select draws a single dashed union box", () => {
  it("shift-clicking a second element shows exactly one .sel-multi in the shadow root, not one per element", async () => {
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

  it(".sel-multi collapses after shift-clicking back down to a single selection", async () => {
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

describe("selection-runtime.js — right-click on an element (its context menu was removed, its items folded into the parent document's context bar)", () => {
  it("right-clicking an unselected element selects it, suppresses the browser's native menu, and no longer reports a contextmenu event", async () => {
    const { win, doc } = boot('<svg><rect id="el-a" data-slidra-name="Rectangle"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const event = new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 24 });
    doc.getElementById("el-a")!.dispatchEvent(event);
    await tick();

    window.removeEventListener("message", handler);
    expect(event.defaultPrevented).toBe(true);
    expect(messages).toContainEqual({ source: "slidra-selection", event: "select", id: "el-a", name: "Rectangle", additive: false });
    expect(messages.some((m) => m.event === "contextmenu")).toBe(false);
  });

  it("right-clicking blank space is a no-op: does not suppress the native menu, does not emit any event", async () => {
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

describe("selection-runtime.js — keyboard relay stage-key", () => {
  it("whitelisted keys (with modifiers) are relayed outside of editing/gesture; unmodified a/d are not", async () => {
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
      { source: "slidra-selection", event: "stage-key", key: "a", code: "", meta: true, ctrl: false, shift: false, alt: false },
      { source: "slidra-selection", event: "stage-key", key: "Delete", code: "", meta: false, ctrl: false, shift: false, alt: false },
      { source: "slidra-selection", event: "stage-key", key: "]", code: "", meta: true, ctrl: false, shift: true, alt: false },
    ]);
  });

  it("Cmd+Shift+BracketRight/BracketLeft (a real keyboard sends }/{ plus a code) are also relayed as stage-key, with code included", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(
      new KeyboardEventCtor("keydown", { key: "}", code: "BracketRight", metaKey: true, shiftKey: true, cancelable: true }),
    );
    win.dispatchEvent(
      new KeyboardEventCtor("keydown", { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true, cancelable: true }),
    );
    await tick();

    window.removeEventListener("message", handler);
    const relayed = messages.filter((m) => m.event === "stage-key");
    expect(relayed).toEqual([
      { source: "slidra-selection", event: "stage-key", key: "}", code: "BracketRight", meta: true, ctrl: false, shift: true, alt: false },
      { source: "slidra-selection", event: "stage-key", key: "{", code: "BracketLeft", meta: true, ctrl: false, shift: true, alt: false },
    ]);
  });

  it("Cmd+Z and Shift+Cmd+Z are relayed; unmodified z is not", async () => {
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
      { source: "slidra-selection", event: "stage-key", key: "z", code: "", meta: true, ctrl: false, shift: false, alt: false },
      { source: "slidra-selection", event: "stage-key", key: "Z", code: "", meta: false, ctrl: true, shift: true, alt: false },
    ]);
  });

  it("ArrowLeft/ArrowRight are relayed even without a modifier (used for changing slides)", async () => {
    const { win } = boot('<svg><rect id="el-a"/></svg>');
    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowLeft", cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowRight", cancelable: true }));
    await tick();

    window.removeEventListener("message", handler);
    const relayed = messages.filter((m) => m.event === "stage-key");
    expect(relayed).toEqual([
      { source: "slidra-selection", event: "stage-key", key: "ArrowLeft", code: "", meta: false, ctrl: false, shift: false, alt: false },
      { source: "slidra-selection", event: "stage-key", key: "ArrowRight", code: "", meta: false, ctrl: false, shift: false, alt: false },
    ]);
  });

  it("no whitelisted key is relayed while editing (including ArrowLeft/ArrowRight — arrow keys move the caret during in-place editing, they don't change slides)", async () => {
    const { win } = boot('<svg><g id="el-text"><text font-size="20">Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");

    const messages: { event?: string }[] = [];
    const handler = (event: MessageEvent) => messages.push(event.data as { event?: string });
    window.addEventListener("message", handler);

    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Delete", cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowLeft", cancelable: true }));
    win.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowRight", cancelable: true }));
    await tick();

    window.removeEventListener("message", handler);
    expect(messages.some((m) => m.event === "stage-key")).toBe(false);
  });
});

// F8: the browser has no font-metrics engine any more — entering/typing in
// a text box now repaints "one hard-break paragraph = one <tspan>" entirely
// locally (renderTextBoxLines/applyTextEditContent), zero measurement, no
// host round trip at all. These three tests replace the old
// `preview-textbox`/`applyPreviewTextbox` channel's coverage (deleted along
// with the channel itself).
describe("selection-runtime.js text box in-place edit repaint (F8)", () => {
  function tspanCount(doc: Document, id: string): number {
    return doc.getElementById(id)!.querySelectorAll("text > tspan").length;
  }

  it("after begin-text-edit, <text>'s direct tspan count equals text.split(\"\\n\").length", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');

    await beginTextEdit(win, "el-text", "Line one\nLine two\nLine three");

    expect(tspanCount(doc, "el-text")).toBe(3);
    const tspans = doc.getElementById("el-text")!.querySelectorAll("text > tspan");
    // data-slidra-break marks a line FOLLOWED by "\n" (textLineRanges()'s
    // own contract) — every line except the last one, not every line
    // except the first (the visual y/dy split is the opposite: only the
    // FIRST line gets an explicit y, the rest get a relative dy).
    expect(tspans[0].textContent).toBe("Line one");
    expect(tspans[0].getAttribute("data-slidra-break")).toBe("1");
    expect(tspans[1].textContent).toBe("Line two");
    expect(tspans[1].getAttribute("data-slidra-break")).toBe("1");
    expect(tspans[2].textContent).toBe("Line three");
    expect(tspans[2].getAttribute("data-slidra-break")).toBeNull();
  });

  it("tspan count follows new \\n's in text-edit-input — no command is called, purely a local repaint", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');
    await beginTextEdit(win, "el-text", "Hi");
    expect(tspanCount(doc, "el-text")).toBe(1);

    const ta = editTextarea(doc);
    ta.value = "a\nb\nc";
    ta.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    await tick();

    expect(tspanCount(doc, "el-text")).toBe(3);
  });

  it("begin-text-edit's markup field is no longer accepted — even if sent it is ignored, only text is used", async () => {
    const { doc, win } = boot('<svg><g id="el-text" data-slidra-text-width="400"><text>Hi</text></g></svg>');
    const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;

    win.dispatchEvent(
      new MessageEventCtor("message", {
        data: { source: "slidra-host", command: "begin-text-edit", id: "el-text", text: "Real content", markup: "<tspan>Should not appear</tspan>", width: 999 },
        source: win.parent as unknown as MessageEventSource,
      }),
    );
    await tick();

    const html = contentTextOuterHtml(doc, "el-text");
    expect(html).toContain("Real content");
    expect(html).not.toContain("Should not appear");
  });

  // F-04: a plain `<text>` (no data-slidra-text-width — e.g. a slide title)
  // used to be repainted with a bare `textContent =`, which SVG never
  // breaks on "\n" — Enter's hard break was invisible until Esc committed
  // and the SVG-side re-layout (render_plain_text_content) split it into
  // tspans for real. Both branches now share renderTextBoxLines.
  it("a plain <text> (no data-slidra-text-width) with \\n also repaints into multiple tspans, marking the first line's data-slidra-break", async () => {
    const { doc, win } = boot('<svg><g id="el-plain"><text x="640" y="330" text-anchor="middle">Hi</text></g></svg>');

    await beginTextEdit(win, "el-plain", "a\nb");

    const tspans = doc.getElementById("el-plain")!.querySelectorAll("text > tspan");
    expect(tspans.length).toBe(2);
    expect(tspans[0].textContent).toBe("a");
    expect(tspans[0].getAttribute("data-slidra-break")).toBe("1");
    expect(tspans[0].getAttribute("x")).toBe("640");
    expect(tspans[0].getAttribute("y")).toBe("330");
    expect(tspans[1].textContent).toBe("b");
    expect(tspans[1].getAttribute("data-slidra-break")).toBeNull();
  });

  it("a plain <text> still a single line has only 1 tspan, with x/y taken from <text> itself — no visual shift allowed", async () => {
    const { doc, win } = boot('<svg><g id="el-plain"><text x="640" y="330" text-anchor="middle">Hi</text></g></svg>');

    await beginTextEdit(win, "el-plain", "Hi");

    const tspans = doc.getElementById("el-plain")!.querySelectorAll("text > tspan");
    expect(tspans.length).toBe(1);
    expect(tspans[0].getAttribute("x")).toBe("640");
    expect(tspans[0].getAttribute("y")).toBe("330");
    expect(tspans[0].textContent).toBe("Hi");
  });
});

// Table cell click/dblclick/contextmenu, the table-cells /
// preview-table-cols host<->runtime channel. A table's cells carry no `id`
// — `findSelectable` always resolves to the table container itself,
// exactly like every other content inside it.
describe("selection-runtime.js — table cell interactions", () => {
  const TABLE = `
    <svg>
      <g id="el-tbl" data-slidra-type="table">
        <g data-slidra-cell="0,0"><rect width="10" height="10"/><text>a</text></g>
        <g data-slidra-cell="0,1"><rect width="10" height="10"/><text>b</text></g>
        <g data-slidra-cell="1,0" data-slidra-repeat="row" display="none"><rect width="10" height="10"/><text>{{ x }}</text></g>
        <g data-slidra-cell="2,0" data-slidra-generated="1"><rect width="10" height="10"/><text>gen</text></g>
      </g>
    </svg>`;

  it("clicking a cell emits select (the table itself) and table-cell-click (that cell)", async () => {
    const { doc } = boot(TABLE);
    const { messages, stop } = collectMessages();
    const cell = doc.querySelector('[data-slidra-cell="0,1"]')!;
    click(doc, cell);
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "select", id: "el-tbl", name: null, additive: false });
    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-click", id: "el-tbl", row: 0, col: 1, additive: false });
  });

  it("shift-click: table-cell-click's additive is true", async () => {
    const { doc, win } = boot(TABLE);
    const { messages, stop } = collectMessages();
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    doc.querySelector('[data-slidra-cell="0,0"]')!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: true });
  });

  it("shift-clicking a second cell of an already-selected table keeps the table itself selected (no re-emitted select, not mistaken for a toggle-off) — only table-cell-click reports the new cell (a regression caught by manual browser smoke testing)", async () => {
    const { doc } = boot(TABLE);
    click(doc, doc.querySelector('[data-slidra-cell="0,0"]')!);
    await tick();

    const { messages, stop } = collectMessages();
    const win = doc.defaultView as Window;
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    doc.querySelector('[data-slidra-cell="0,1"]')!.dispatchEvent(new MouseEventCtor("click", { bubbles: true, shiftKey: true }));
    await tick();
    stop();

    expect(messages.some((m: any) => m.event === "select")).toBe(false);
    expect(messages.some((m: any) => m.event === "clear")).toBe(false);
    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-click", id: "el-tbl", row: 0, col: 1, additive: true });
  });

  it("double-clicking a plain cell: table-cell-dblclick reports its own row/col, without entering group edit", async () => {
    const { doc } = boot(TABLE);
    const { messages, stop } = collectMessages();
    dblclick(doc, doc.querySelector('[data-slidra-cell="0,1"]')!);
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-dblclick", id: "el-tbl", row: 0, col: 1, atRow: 0 });
    expect(messages.some((m: any) => m.event === "group-path")).toBe(false);
  });

  it("double-clicking a table cell nested two groups deep drills all the way down in one double-click, selecting the table (groupPath is the full chain) and reporting table-cell-dblclick", async () => {
    const grouped = TABLE.replace('<g id="el-tbl"', '<g id="el-outer"><g id="el-grp"><g id="el-tbl"').replace(/<\/svg>\s*$/, "</g></g></svg>");
    const { doc } = boot(grouped);
    const { messages, stop } = collectMessages();
    dblclick(doc, doc.querySelector('[data-slidra-cell="0,1"]')!);
    await tick();
    stop();

    const events = messages.map((m: any) => m.event);
    expect(events.indexOf("select")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("table-cell-dblclick")).toBeGreaterThan(events.indexOf("select"));
    expect(messages).toContainEqual(expect.objectContaining({ event: "select", id: "el-tbl", groupPath: ["el-outer", "el-grp"] }));
    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-dblclick", id: "el-tbl", row: 0, col: 1, atRow: 0 });
  });

  it("double-clicking a generated cell: table-cell-dblclick reports the row of its template row (double-click always edits the template row)", async () => {
    const { doc } = boot(TABLE);
    const { messages, stop } = collectMessages();
    dblclick(doc, doc.querySelector('[data-slidra-cell="2,0"]')!);
    await tick();
    stop();

    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-dblclick", id: "el-tbl", row: 1, col: 0, atRow: 2 });
  });

  it("right-clicking a cell: table-cell-contextmenu reports row/col/x/y and suppresses the native menu", async () => {
    const { win, doc } = boot(TABLE);
    const { messages, stop } = collectMessages();
    const MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const event = new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true, clientX: 7, clientY: 9 });
    doc.querySelector('[data-slidra-cell="0,0"]')!.dispatchEvent(event);
    await tick();
    stop();

    expect(event.defaultPrevented).toBe(true);
    expect(messages).toContainEqual({ source: "slidra-selection", event: "table-cell-contextmenu", id: "el-tbl", row: 0, col: 0, x: 7, y: 9 });
  });

  async function sendHostCommand(win: Window, command: Record<string, unknown>): Promise<void> {
    const MessageEventCtor = (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
    win.dispatchEvent(
      new MessageEventCtor("message", {
        data: { source: "slidra-host", ...command },
        source: win.parent as unknown as MessageEventSource,
      }),
    );
    await tick();
  }

  it("table-cells command: reports each cell's rect and the table's own box", async () => {
    const { win } = boot(TABLE);
    const { messages, stop } = collectMessages();
    await sendHostCommand(win, { command: "table-cells", id: "el-tbl" });
    stop();

    const reported = messages.find((m: any) => m.event === "table-cells") as any;
    expect(reported).toBeDefined();
    expect(reported.id).toBe("el-tbl");
    expect(reported.cells.length).toBe(4);
    expect(reported.cells.map((c: any) => `${c.row},${c.col}`).sort()).toEqual(["0,0", "0,1", "1,0", "2,0"]);
  });

  it("table-cells command: silently reports nothing when the id doesn't exist or isn't a table (skipped, no throw)", async () => {
    const { win } = boot(TABLE);
    const { messages, stop } = collectMessages();
    await sendHostCommand(win, { command: "table-cells", id: "el-nope" });
    stop();
    expect(messages.some((m: any) => m.event === "table-cells")).toBe(false);
  });

  it("preview-table-cols: changes each cell's rect width and transform x, without touching the text content", async () => {
    const { doc, win } = boot(TABLE);
    await sendHostCommand(win, { command: "preview-table-cols", id: "el-tbl", cols: [50, 30] });

    const cellA = doc.querySelector('[data-slidra-cell="0,0"]')!;
    const cellB = doc.querySelector('[data-slidra-cell="0,1"]')!;
    expect(cellA.querySelector("rect")!.getAttribute("width")).toBe("50");
    expect(cellB.querySelector("rect")!.getAttribute("width")).toBe("30");
    expect(cellA.getAttribute("transform")).toBe("translate(0 0)");
    expect(cellB.getAttribute("transform")).toBe("translate(50 0)");
    expect(cellA.querySelector("text")!.textContent).toBe("a");
  });

  it("preview-table-cols: bad input (an array containing a negative number, or a non-array) leaves the DOM completely untouched", async () => {
    const { doc, win } = boot(TABLE);
    const before = doc.querySelector('[data-slidra-cell="0,0"]')!.querySelector("rect")!.getAttribute("width");

    await sendHostCommand(win, { command: "preview-table-cols", id: "el-tbl", cols: [50, -1] });
    await sendHostCommand(win, { command: "preview-table-cols", id: "el-tbl", cols: "not-an-array" });

    expect(doc.querySelector('[data-slidra-cell="0,0"]')!.querySelector("rect")!.getAttribute("width")).toBe(before);
  });

  /** Dispatches a real keydown on `win` with the given modifiers — same shape `pressEscape` above uses for its one key. */
  function pressKey(win: Window, key: string, modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}): void {
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    win.dispatchEvent(
      new KeyboardEventCtor("keydown", {
        key,
        metaKey: Boolean(modifiers.meta),
        ctrlKey: Boolean(modifiers.ctrl),
        shiftKey: Boolean(modifiers.shift),
        cancelable: true,
      }),
    );
  }

  // The behavior table: `tableRangeId` null vs set changes
  // Delete/Backspace/Escape's routing, and unlocks Tab/⌘B relaying at all —
  // every row keyed off "bit-for-bit unchanged from current behavior" when
  // the flag is null.
  describe("selection-runtime.js — keyboard relay for the table-range flag", () => {
    it("H2: when tableRangeId is null (default), Delete still sends stage-key (no regression from current behavior)", async () => {
      const { win } = boot(TABLE);
      const { messages, stop } = collectMessages();
      pressKey(win, "Delete");
      await tick();
      stop();

      expect(messages).toContainEqual({
        source: "slidra-selection",
        event: "stage-key",
        key: "Delete",
        code: "",
        meta: false,
        ctrl: false,
        shift: false,
        alt: false,
      });
      expect(messages.some((m: any) => m.event === "table-key")).toBe(false);
    });

    it("H3: after a table-range command sets an id, Delete sends table-key, not stage-key", async () => {
      const { win } = boot(TABLE);
      await sendHostCommand(win, { command: "table-range", id: "el-tbl" });
      const { messages, stop } = collectMessages();
      pressKey(win, "Delete");
      await tick();
      stop();

      expect(messages).toContainEqual({
        source: "slidra-selection",
        event: "table-key",
        id: "el-tbl",
        key: "Delete",
        meta: false,
        ctrl: false,
        shift: false,
      });
      expect(messages.some((m: any) => m.event === "stage-key")).toBe(false);
    });

    it("H4: when tableRangeId is not null, Escape sends table-key and not clear; when null, it still sends clear", async () => {
      const { doc, win } = boot(TABLE);
      click(doc, doc.querySelector('[data-slidra-cell="0,0"]')!); // selects el-tbl, so a later Escape-without-range would otherwise clear it
      await tick();

      await sendHostCommand(win, { command: "table-range", id: "el-tbl" });
      const { messages: withRange, stop: stopWithRange } = collectMessages();
      pressEscape(win);
      await tick();
      stopWithRange();
      expect(withRange).toContainEqual({ source: "slidra-selection", event: "table-key", id: "el-tbl", key: "Escape", meta: false, ctrl: false, shift: false });
      expect(withRange.some((m: any) => m.event === "clear")).toBe(false);

      await sendHostCommand(win, { command: "table-range", id: null });
      const { messages: withoutRange, stop: stopWithoutRange } = collectMessages();
      pressEscape(win);
      await tick();
      stopWithoutRange();
      expect(withoutRange).toContainEqual({ source: "slidra-selection", event: "clear" });
      expect(withoutRange.some((m: any) => m.event === "table-key")).toBe(false);
    });

    it("Tab/Shift+Tab are only relayed as table-key while tableRangeId is active, and suppress the default behavior", async () => {
      const { win } = boot(TABLE);
      await sendHostCommand(win, { command: "table-range", id: "el-tbl" });
      const { messages, stop } = collectMessages();
      const tabEvent = new (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      win.dispatchEvent(tabEvent);
      pressKey(win, "Tab", { shift: true });
      await tick();
      stop();

      expect(tabEvent.defaultPrevented).toBe(true);
      expect(messages).toContainEqual({ source: "slidra-selection", event: "table-key", id: "el-tbl", key: "Tab", meta: false, ctrl: false, shift: false });
      expect(messages).toContainEqual({ source: "slidra-selection", event: "table-key", id: "el-tbl", key: "Tab", meta: false, ctrl: false, shift: true });
    });

    it("Cmd+B/Ctrl+B are only relayed as table-key while tableRangeId is active", async () => {
      const { win } = boot(TABLE);

      const { messages: beforeRange, stop: stopBefore } = collectMessages();
      pressKey(win, "b", { meta: true });
      await tick();
      stopBefore();
      expect(beforeRange.some((m: any) => m.event === "table-key")).toBe(false);

      await sendHostCommand(win, { command: "table-range", id: "el-tbl" });
      const { messages, stop } = collectMessages();
      pressKey(win, "b", { meta: true });
      await tick();
      stop();
      expect(messages).toContainEqual({ source: "slidra-selection", event: "table-key", id: "el-tbl", key: "b", meta: true, ctrl: false, shift: false });
    });

    it("a table-range command with an id that is neither a string nor null is ignored, tableRangeId unchanged", async () => {
      const { win } = boot(TABLE);
      await sendHostCommand(win, { command: "table-range", id: "el-tbl" });
      await sendHostCommand(win, { command: "table-range", id: 123 });

      const { messages, stop } = collectMessages();
      pressKey(win, "Delete");
      await tick();
      stop();

      expect(messages).toContainEqual({
        source: "slidra-selection",
        event: "table-key",
        id: "el-tbl",
        key: "Delete",
        meta: false,
        ctrl: false,
        shift: false,
      });
    });
  });
});

// A ⇧-held pointer-down that jitters past DRAG_THRESHOLD_PX on an element
// that is not yet selected must ADD it (the multi-selection the user was
// building survives), whereas the same drag without a modifier replaces the
// selection with just that element — found when a human's "⇧-click chart,
// then Group" kept ending up with only the chart selected.
describe("selection-runtime.js — a drag start with Shift held adds to the selection, without it replaces it", () => {
  async function dragOnto(shift: boolean): Promise<{ id?: string; additive?: boolean }[]> {
    const { win, doc } = boot(
      '<svg viewBox="0 0 1280 720"><rect id="el-a" width="100" height="100"/><rect id="el-b" x="300" width="100" height="100"/></svg>',
    );
    click(doc, doc.getElementById("el-a")!);
    await tick();
    const { messages, stop } = collectMessages();
    const PointerEventCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    doc.getElementById("el-b")!.dispatchEvent(
      new PointerEventCtor("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 350, clientY: 50, shiftKey: shift }),
    );
    win.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerId: 1, clientX: 360, clientY: 60, shiftKey: shift }));
    await tick();
    stop();
    return (messages as { event?: string; id?: string; additive?: boolean }[]).filter((m) => m.event === "select");
  }

  it("shift-dragging an unselected element: sends select with additive:true, the original selection is kept", async () => {
    const selects = await dragOnto(true);
    expect(selects).toEqual([expect.objectContaining({ id: "el-b", additive: true })]);
  });

  it("dragging an unselected element without a modifier: sends select with additive:false (unchanged behavior)", async () => {
    const selects = await dragOnto(false);
    expect(selects).toEqual([expect.objectContaining({ id: "el-b", additive: false })]);
  });
});

describe("selection-runtime.js — stage media layer", () => {
  function stubMediaPlayback(win: Window): void {
    const MediaProto = (win as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement
      .prototype;
    MediaProto.play = () => Promise.resolve();
    MediaProto.pause = () => {
      /* jsdom stub — see player-runtime.test.ts for the same pattern. */
    };
  }

  it("builds a <video>/<audio> overlay and control bar for each id in the media table, with the media itself pointer-events:none and the control bar pointer-events:auto", async () => {
    const { win, doc } = boot('<svg><rect id="el-video"/><circle id="el-audio"/></svg>', COLORS, {
      "el-video": { src: "../assets/clip.webm", kind: "video" },
      "el-audio": { src: "../assets/n.oga", kind: "audio" },
    });
    fireLoad(win);

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const video = host.shadowRoot!.querySelector("video") as HTMLVideoElement;
    const audio = host.shadowRoot!.querySelector("audio") as HTMLAudioElement;
    expect(video.src).toContain("clip.webm");
    expect(audio.src).toContain("n.oga");
    // Inline + !important, same convention as `host`'s own critical
    // properties — checked directly rather than via getComputedStyle,
    // which jsdom does not reliably resolve for shadow-root stylesheet
    // rules (see e2e/visual-qa for the real-browser rendering check).
    expect(video.style.getPropertyValue("pointer-events")).toBe("none");
    expect(video.style.getPropertyPriority("pointer-events")).toBe("important");
    const bars = host.shadowRoot!.querySelectorAll(".media-control-bar");
    expect(bars.length).toBe(2);
    const bar = bars[0] as HTMLElement;
    expect(bar.style.getPropertyValue("pointer-events")).toBe("auto");
  });

  it("the control bar carries data-slidra-media-control=\"play\"/\"seek\" attributes", async () => {
    const { win, doc } = boot('<svg><rect id="el-video"/></svg>', COLORS, {
      "el-video": { src: "../assets/clip.webm", kind: "video" },
    });
    fireLoad(win);

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    expect(host.shadowRoot!.querySelector('[data-slidra-media-control="play"]')).not.toBeNull();
    expect(host.shadowRoot!.querySelector('[data-slidra-media-control="seek"]')).not.toBeNull();
  });

  it("clicking the control bar does not change the selection: with an element already selected, clicking the play button leaves selectedIds unchanged and doesn't send an extra select/clear", async () => {
    const { win, doc } = boot('<svg><rect id="el-a"/><rect id="el-video"/></svg>', COLORS, {
      "el-video": { src: "../assets/clip.webm", kind: "video" },
    });
    stubMediaPlayback(win);
    fireLoad(win);
    click(doc, doc.getElementById("el-a")!);
    await tick();

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const box = host.shadowRoot!.querySelector(".sel") as HTMLElement;
    expect(box.style.display).toBe("block");

    const { messages, stop } = collectMessages();
    const playButton = host.shadowRoot!.querySelector('[data-slidra-media-control="play"]') as HTMLElement;
    click(doc, playButton);
    await tick();
    stop();

    expect(box.style.display).toBe("block"); // el-a's box is still selected, not cleared or swapped out
    expect((messages as { event?: string }[]).some((m) => m.event === "select" || m.event === "clear")).toBe(false);
  });

  it("pressing play calls el.play(); pressing it again (now playing) calls el.pause()", async () => {
    // jsdom does not implement real media playback — `.paused` never
    // toggles on its own the way a real browser's would, so this stubs it
    // as a settable property the play/pause spies themselves flip, the
    // same "fake just enough of the platform" posture
    // player-runtime.test.ts already uses for HTMLMediaElement.
    const { win, doc } = boot('<svg><rect id="el-video"/></svg>', COLORS, {
      "el-video": { src: "../assets/clip.webm", kind: "video" },
    });
    const MediaProto = (win as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement
      .prototype;
    let isPaused = true;
    Object.defineProperty(MediaProto, "paused", { configurable: true, get: () => isPaused });
    const playSpy = vi.fn(() => {
      isPaused = false;
      return Promise.resolve();
    });
    const pauseSpy = vi.fn(() => {
      isPaused = true;
    });
    MediaProto.play = playSpy;
    MediaProto.pause = pauseSpy;
    fireLoad(win);

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const playButton = host.shadowRoot!.querySelector('[data-slidra-media-control="play"]') as HTMLElement;

    click(doc, playButton);
    await tick();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).not.toHaveBeenCalled();

    click(doc, playButton);
    await tick();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("when the media table is an empty object, no <video>/<audio>/control bar is built in the shadow root (existing selection behavior is unaffected)", async () => {
    const { win, doc } = boot('<svg><rect id="el-a"/></svg>', COLORS, {});
    fireLoad(win);

    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    expect(host.shadowRoot!.querySelector("video")).toBeNull();
    expect(host.shadowRoot!.querySelector("audio")).toBeNull();
    expect(host.shadowRoot!.querySelector(".media-control-bar")).toBeNull();

    click(doc, doc.getElementById("el-a")!);
    const box = host.shadowRoot!.querySelector(".sel") as HTMLElement;
    expect(box.style.display).toBe("block");
  });
});
