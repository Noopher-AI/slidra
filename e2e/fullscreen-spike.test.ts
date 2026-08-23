import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

/**
 * 全螢幕可行性實測 (issue #24). A spike, not a product feature: nothing here
 * is imported by anything, and no production code was added for it. What it
 * leaves behind is evidence for one question that ADR 0010 explicitly
 * deferred to measurement:
 *
 *   "全螢幕由父文件對 iframe 元素本身呼叫 requestFullscreen()，不授予 sandbox
 *    任何全螢幕權限。此路徑在 opaque origin 下的行為應以實測確認。"
 *
 * The slide runs in an iframe with `allow-scripts` and deliberately WITHOUT
 * `allow-same-origin`, so it sits in an opaque origin. The spec says the
 * parent may still fullscreen the iframe element, because the parent owns
 * the element — the sandbox governs what the *content* may do, not what the
 * embedder may do to the box. This test checks that claim on three engines.
 *
 * Two things this test refuses to do:
 *
 *   - It never treats "the Promise resolved" as proof. A resolved promise
 *     with no visual change would be exactly the failure mode worth
 *     catching, so every case also asserts `fullscreenElement` identity and
 *     a real size change up to screen dimensions.
 *   - It never skips an engine and never swallows a rejection. If an engine
 *     failed, the assertion would report it as a failure of that engine,
 *     named in the test title.
 *
 * The alternative shape #29 would have to fall back to — fullscreening the
 * container div instead of the iframe — is measured with the same strength,
 * so that decision does not rest on another untested assumption.
 */

// The sandbox posture from ADR 0010, asserted rather than commented.
const SANDBOX_ATTRIBUTE = "allow-scripts";

// Proof that `allow-scripts` really took effect: script inside an opaque
// origin can reach its parent only through postMessage, so a message
// arriving is a script having run somewhere no same-origin access exists.
const RUNTIME_HELLO = "runtime-在-opaque-origin-裡活著";

// Small on purpose: the pre-fullscreen size must be nowhere near the screen
// size, or "the size changed" would prove nothing.
const BOX_WIDTH = 320;
const BOX_HEIGHT = 180;

const VIEWPORT = { width: 800, height: 600 };

// `document.exitFullscreen` and the `webkitRequestFullscreen` prefix: WebKit
// still ships the prefixed spelling, so the page picks whichever exists
// rather than assuming the unprefixed name.
const SPIKE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>全螢幕可行性實測</title>
<script>
  // Registered before the iframe is parsed, so the runtime's greeting
  // cannot arrive before anyone is listening.
  window.__messages = [];
  addEventListener("message", (event) => { window.__messages.push(event.data); });
  window.__fullscreenOutcome = null;
  function requestFullscreenOn(target) {
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    window.__fullscreenOutcome = "pending";
    Promise.resolve(request.call(target)).then(
      () => { window.__fullscreenOutcome = "resolved"; },
      (error) => { window.__fullscreenOutcome = "rejected: " + error; },
    );
  }
<\/script>
<style>
  html, body { margin: 0; }
  #shell { width: ${BOX_WIDTH}px; height: ${BOX_HEIGHT}px; }
  #slide { display: block; width: 100%; height: 100%; border: 0; }
  #controls { position: relative; z-index: 1; }
</style>
<div id="shell">
  <iframe id="slide" sandbox="${SANDBOX_ATTRIBUTE}" srcdoc='&lt;script&gt;parent.postMessage("${RUNTIME_HELLO}", "*");&lt;/script&gt;&lt;body style="background:#123"&gt;&lt;/body&gt;'></iframe>
</div>
<div id="controls">
  <button id="fullscreen-iframe">對 iframe 進入全螢幕</button>
  <button id="fullscreen-shell">對容器 div 進入全螢幕</button>
</div>
<script>
  document.getElementById("fullscreen-iframe").onclick = () => {
    requestFullscreenOn(document.getElementById("slide"));
  };
  document.getElementById("fullscreen-shell").onclick = () => {
    requestFullscreenOn(document.getElementById("shell"));
  };
<\/script>`;

type Snapshot = {
  outcome: string | null;
  messages: unknown[];
  sandbox: string | null;
  fullscreenElementId: string | null;
  iframeSize: [number, number];
  shellSize: [number, number];
  screenSize: [number, number];
};

function readSnapshot(): Snapshot {
  const iframe = document.getElementById("slide") as HTMLIFrameElement;
  const shell = document.getElementById("shell") as HTMLElement;
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const win = window as unknown as { __fullscreenOutcome: string | null; __messages: unknown[] };
  return {
    outcome: win.__fullscreenOutcome,
    messages: win.__messages,
    sandbox: iframe.getAttribute("sandbox"),
    fullscreenElementId: fullscreenElement ? fullscreenElement.id : null,
    iframeSize: [iframe.clientWidth, iframe.clientHeight],
    shellSize: [shell.clientWidth, shell.clientHeight],
    screenSize: [screen.width, screen.height],
  };
}

function exitFullscreen(): void {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  const win = window as unknown as { __fullscreenOutcome: string | null };
  win.__fullscreenOutcome = "pending";
  Promise.resolve(exit.call(doc)).then(
    () => { win.__fullscreenOutcome = "resolved"; },
    (error) => { win.__fullscreenOutcome = "rejected: " + error; },
  );
}

/**
 * Fullscreen transitions are driven by the window manager, not by the
 * renderer, so there is no event that Playwright can await on the Node side.
 * Polling for the expected `fullscreenElement` is the honest wait: it fails
 * loudly on timeout rather than passing on a lucky sleep.
 */
async function waitForFullscreenElement(page: Page, expectedId: string | null): Promise<Snapshot> {
  const deadline = Date.now() + 15_000;
  let snapshot = await page.evaluate(readSnapshot);
  while (snapshot.fullscreenElementId !== expectedId && Date.now() < deadline) {
    await page.waitForTimeout(100);
    snapshot = await page.evaluate(readSnapshot);
  }
  // Give the layout one more beat after the transition so clientWidth has
  // settled on the post-transition size rather than a mid-animation one.
  await page.waitForTimeout(300);
  return page.evaluate(readSnapshot);
}

type Engine = {
  name: string;
  type: BrowserType;
  /**
   * Headless fullscreen is not trustworthy by default — an engine that
   * silently no-ops would look like "not supported". All three were checked
   * headed as well as headless while writing this spike and behaved
   * identically, including the real size change, so headless is used here
   * for a runnable test. Anything that starts failing headless must be
   * re-checked headed before being written down as an engine limitation.
   */
  headless: boolean;
};

const ENGINES: Engine[] = [
  { name: "Chromium", type: chromium, headless: true },
  { name: "Firefox", type: firefox, headless: true },
  { name: "WebKit", type: webkit, headless: true },
];

describe.each(ENGINES)("$name：opaque origin 的 sandbox iframe 全螢幕", (engine) => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await engine.type.launch({ headless: engine.headless });
    // Printed so a passing run says out loud which real engine, which
    // version and which display mode produced the evidence.
    console.log(
      `${engine.name} ${browser.version()}（${engine.headless ? "headless" : "headed"}）`,
    );
    page = await browser.newPage({ viewport: VIEWPORT });
    await page.setContent(SPIKE_PAGE);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("sandbox 只有 allow-scripts，而 iframe 裡的 script 確實跑起來了", async () => {
    await page.waitForFunction(() => {
      return (window as unknown as { __messages: unknown[] }).__messages.length > 0;
    });
    const snapshot = await page.evaluate(readSnapshot);

    expect(snapshot.sandbox).toBe(SANDBOX_ATTRIBUTE);
    expect(snapshot.sandbox).not.toContain("allow-same-origin");
    expect(snapshot.messages).toContain(RUNTIME_HELLO);
  });

  it("父文件對 iframe 呼叫 requestFullscreen()：iframe 真的變成全螢幕元素且撐滿螢幕", async () => {
    const before = await page.evaluate(readSnapshot);
    expect(before.fullscreenElementId).toBeNull();
    expect(before.iframeSize).toEqual([BOX_WIDTH, BOX_HEIGHT]);

    // A real user gesture. Calling requestFullscreen() from page.evaluate()
    // would have no transient activation, and any failure there would be an
    // artefact of the harness rather than a fact about the engine.
    await page.click("#fullscreen-iframe");
    const after = await waitForFullscreenElement(page, "slide");

    expect(after.outcome).toBe("resolved");
    expect(after.fullscreenElementId).toBe("slide");
    expect(after.iframeSize).toEqual(after.screenSize);
    expect(after.iframeSize).not.toEqual(before.iframeSize);
  });

  it("document.exitFullscreen() 之後 fullscreenElement 為 null，尺寸回到原本大小", async () => {
    await page.evaluate(exitFullscreen);
    const after = await waitForFullscreenElement(page, null);

    expect(after.outcome).toBe("resolved");
    expect(after.fullscreenElementId).toBeNull();
    expect(after.iframeSize).toEqual([BOX_WIDTH, BOX_HEIGHT]);
  });

  it("替代路徑：對包住 iframe 的容器 div 全螢幕，iframe 也一起撐滿（#29 的後備形狀）", async () => {
    const before = await page.evaluate(readSnapshot);
    expect(before.fullscreenElementId).toBeNull();

    await page.click("#fullscreen-shell");
    const after = await waitForFullscreenElement(page, "shell");

    expect(after.outcome).toBe("resolved");
    expect(after.fullscreenElementId).toBe("shell");
    expect(after.shellSize).toEqual(after.screenSize);
    // The iframe is sized by CSS off the container, so it follows along.
    expect(after.iframeSize).toEqual(after.screenSize);

    await page.evaluate(exitFullscreen);
    const restored = await waitForFullscreenElement(page, null);
    expect(restored.fullscreenElementId).toBeNull();
    expect(restored.shellSize).toEqual([BOX_WIDTH, BOX_HEIGHT]);
  });
});
