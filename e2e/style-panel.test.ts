import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * The editable Style panel end to end, against a real Chromium — same
 * `startServerFor`/`openApp` shape as `e2e/object-animation.test.ts`. This
 * is the one e2e file for: A1-A10 (Style › Object), B1-B5 (Style › Page),
 * C (sub-tab state machine), D (Edit style entry point), G (skeleton
 * sections never fire a command).
 *
 * Every test opens its own server against a fresh copy of the fixture deck
 * (`style-panel-deck`) — no test depends on another's mutations. File
 * content is always read back with `registry.dispatch("cat", ...)` and
 * checked verbatim — never trusted from what the panel itself displays.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const deckDir = path.join(e2eDir, "fixtures/style-panel-deck");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

interface TestServer {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}

async function startServerFor(): Promise<TestServer> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-style-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-style-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg").first();
  await expect.poll(() => slideText.count().catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0);
  return page;
}

async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

async function readSlide(registry: CommandRegistry, presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
  return result.data!.content;
}

async function readProjectJson(registry: CommandRegistry, presentationId: string): Promise<{ canvas: { width: number; height: number } }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
  return JSON.parse(result.data!.content);
}

/** Selects `elementId` on the stage, then opens Style › Object via the ContextBar's `Edit style` entry (the one legal entry point). */
async function selectAndOpenStyleObject(page: Page, frame: Frame, elementId: string): Promise<void> {
  await frame.locator(`#${elementId}`).click();
  await hoverContextBar(page);
  await page.locator('button[title="Edit style"]').click();
  await expect.poll(() => page.locator('[role="tab"][data-tab="style"]').getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");
}

/** The context bar is ghost (`pointer-events: none`) until the pointer hovers it long enough to solidify — a click before this never reaches a button, it always resolves to the iframe underneath instead. */
async function hoverContextBar(page: Page): Promise<void> {
  const box = (await page.locator(".context-bar").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
}

/**
 * `canvasSize` (App.tsx's `presentationInfo`) loads over its own
 * `/api/presentation` fetch, separate from the iframe's slide render
 * `openApp` already waits on — until it resolves, Style › Page renders its
 * "no editable slide" empty state instead of real fields. Poll for the
 * Width field rather than a fixed sleep.
 */
async function openStylePage(page: Page): Promise<void> {
  await page.locator('[role="tab"][data-tab="style"]').click();
  await page.locator('[role="tab"][data-subtab="page"]').click();
  await expect.poll(() => page.locator('[data-attr="canvas-width"] input').count(), { timeout: 10_000 }).toBe(1);
}

async function fillField(page: Page, attr: string, value: string): Promise<void> {
  const input = page.locator(`[data-attr="${attr}"] input`);
  await input.fill(value);
  await input.blur();
}

async function selectField(page: Page, attr: string, value: string): Promise<void> {
  await page.locator(`[data-attr="${attr}"] select`).selectOption(value);
}

async function undo(registry: CommandRegistry, presentationId: string): Promise<void> {
  const result = await registry.dispatch("undo", { id: presentationId });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

// ── Style › Object ──────────────────────────────────────────────

it("A1 Text·Font: switching to Noto Sans TC keeps the file and the iframe in sync; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    await selectAndOpenStyleObject(page, frame, "el-text");

    await fillField(page, "font-family", "Noto Sans TC");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('font-family="Noto Sans TC"');
    await expect.poll(() => frame.locator("#el-text text").getAttribute("font-family")).toBe("Noto Sans TC");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).not.toContain("font-family=");
  } finally {
    await cleanup();
  }
});

it("A2 Text·Size: switching to 32 sets file font-size=32 and rewraps the line (tspan y changes); undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    const originalY = /<tspan x="[^"]*" y="([^"]+)"/.exec(before)![1];

    await selectAndOpenStyleObject(page, frame, "el-text");
    await fillField(page, "font-size", "32");

    const updated = await (async () => {
      let latest = before;
      await expect.poll(async () => {
        latest = await readSlide(registry, presentationId);
        return latest.includes('font-size="32"');
      }).toBe(true);
      return latest;
    })();
    const newY = /<tspan x="[^"]*" y="([^"]+)"/.exec(updated)![1];
    expect(newY).not.toBe(originalY);
    await expect.poll(() => frame.locator("#el-text text").getAttribute("font-size")).toBe("32");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A3 Text·Weight: switching to 700 sets file font-weight=700; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-text");

    await fillField(page, "font-weight", "700");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('font-weight="700"');
    await expect.poll(() => frame.locator("#el-text text").getAttribute("font-weight")).toBe("700");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A4 Text·Text color: switching to #ff0000 sets file fill=#ff0000; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-caption");

    await fillField(page, "fill", "#ff0000");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('fill="#ff0000"');
    await expect.poll(() => frame.locator("#el-caption-text").getAttribute("fill")).toBe("#ff0000");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A5 Text·Align (text box): switching to center sets file data-slidra-text-align=center and tspan x changes; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    const originalX = /<tspan x="([^"]*)"/.exec(before)![1];
    await selectAndOpenStyleObject(page, frame, "el-text");

    await selectField(page, "align", "center");
    const updated = await (async () => {
      let latest = before;
      await expect.poll(async () => {
        latest = await readSlide(registry, presentationId);
        return latest.includes('data-slidra-text-align="center"');
      }).toBe(true);
      return latest;
    })();
    const newX = /<tspan x="([^"]*)"/.exec(updated)![1];
    expect(newX).not.toBe(originalX);
    await expect.poll(() => frame.locator("#el-text").getAttribute("data-slidra-text-align")).toBe("center");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A6 Text·Align (plain <text>): switching to left sets file text-anchor=start; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    expect(before).toContain('text-anchor="middle"'); // el-caption's original value — starting alignment is Center
    await selectAndOpenStyleObject(page, frame, "el-caption");

    await selectField(page, "align", "left");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('text-anchor="start"');
    await expect.poll(() => frame.locator("#el-caption-text").getAttribute("text-anchor")).toBe("start");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A7 Shape·Fill color: switching to #123456 sets file fill=#123456; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-a");

    await fillField(page, "fill", "#123456");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('fill="#123456"');
    await expect.poll(() => frame.locator("#el-a rect").getAttribute("fill")).toBe("#123456");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A8 Shape·Stroke color: switching to #000000 sets file stroke=#000000; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-a");

    await fillField(page, "stroke", "#000000");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('stroke="#000000"');
    await expect.poll(() => frame.locator("#el-a rect").getAttribute("stroke")).toBe("#000000");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A9 Shape·Stroke width: switching to 4 sets file stroke-width=4; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-a");

    await fillField(page, "stroke-width", "4");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('stroke-width="4"');
    await expect.poll(() => frame.locator("#el-a rect").getAttribute("stroke-width")).toBe("4");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A10 Appearance·Opacity: switching to 0.5 sets file opacity=0.5; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await selectAndOpenStyleObject(page, frame, "el-a");

    await fillField(page, "opacity", "0.5");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('opacity="0.5"');
    await expect.poll(() => frame.locator("#el-a rect").getAttribute("opacity")).toBe("0.5");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

// ── Style › Page ─────────────────────────────────────────────────

it("B1 Background: switching to #202020 sets background-color in the root <svg>'s style; the iframe reflects it; undo reverts (recorded in history)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await openStylePage(page);

    await fillField(page, "background", "#202020");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain("background-color:#202020");
    await expect
      .poll(() => frame.locator("svg").evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(32, 32, 32)");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("B2 Accent: switching to #00ff00 sets --slidra-accent in the root <svg>'s style; the iframe reflects it; undo reverts", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);
    await openStylePage(page);

    await fillField(page, "accent", "#00ff00");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain("--slidra-accent:#00ff00");
    await expect
      .poll(() => frame.locator("svg").evaluate((el) => (el as unknown as SVGElement).style.getPropertyValue("--slidra-accent")))
      .toBe("#00ff00");

    await undo(registry, presentationId);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("B3 Slide size preset button (4:3): project.json/viewBox changes, element transforms are untouched, and .stage's ratio follows; undo only reverts the prior content edit, size stays at the new value", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    // Make a content edit that lands in history first, so undo has something to revert (unrelated to canvas set itself).
    await selectAndOpenStyleObject(page, frame, "el-b");
    await fillField(page, "opacity", "0.9");
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('opacity="0.9"');
    // This write echoes back over the live-reload SSE stream and drives
    // canvas.ts's reload(): it clears the selection, re-fetches the slide,
    // then re-applies the selection once the iframe's new document finishes
    // loading (`keepSelectionAcrossReload`/`selectOnceLoaded`). That clear-
    // then-reselect round trip flips `hasSelection` false→true, and App.tsx's
    // effect (`setSub(hasSelection ? "object" : "page")`) follows it — if
    // that flip back to "object" lands AFTER this test has already switched
    // to Style › Page, it unmounts the Page panel out from under the very
    // next click (`element was detached from the DOM`). Waiting for the
    // edited element's own attribute to show up in the reloaded iframe
    // means the frame has already loaded its new document, so
    // `selectOnceLoaded`'s reselect — hooked to that same `load` event — has
    // already run and the "object" flip is already behind us.
    await expect.poll(() => frame.locator("#el-b rect").getAttribute("opacity")).toBe("0.9");

    await openStylePage(page);
    await page.locator('button.style-page-preset:has-text("4:3")').click();

    await expect.poll(async () => (await readProjectJson(registry, presentationId)).canvas).toEqual({ width: 1024, height: 768 });
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('viewBox="0 0 1024 768"');
    const afterResize = await readSlide(registry, presentationId);
    expect(afterResize).toContain('transform="translate(80 80)"'); // el-a's transform is unchanged, byte for byte
    await expect
      .poll(() => page.locator(".stage").evaluate((el) => (el as HTMLElement).style.aspectRatio))
      .toBe("1024 / 768");

    await undo(registry, presentationId); // this reverts the opacity edit, not the size
    const afterUndo = await readSlide(registry, presentationId);
    expect(afterUndo).not.toContain('opacity="0.9"');
    expect((await readProjectJson(registry, presentationId)).canvas).toEqual({ width: 1024, height: 768 });
  } finally {
    await cleanup();
  }
});

it("B4 manual Width/Height input: project.json/viewBox change to the entered values", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStylePage(page);

    await fillField(page, "canvas-width", "1600");
    await expect.poll(async () => (await readProjectJson(registry, presentationId)).canvas.width).toBe(1600);
    // decision: no optimistic preview — the Height field's commit reads the CURRENT
    // `canvasSize` prop for the width half of the pair — that prop only
    // catches up once the browser's own presentation-changed → reload
    // round trip lands. Editing Height before that round trip completes
    // would resubmit the OLD width (a real, documented limitation — see
    // the delivery notes). `data-canvas-width` mirrors the live prop
    // (never the field's own draft, which already reads "1600" the
    // instant it is typed) — waiting on it is the real readiness signal.
    await expect.poll(() => page.locator(".style-page-panel").getAttribute("data-canvas-width")).toBe("1600");
    await fillField(page, "canvas-height", "900");
    await expect.poll(async () => (await readProjectJson(registry, presentationId)).canvas).toEqual({ width: 1600, height: 900 });
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('viewBox="0 0 1600 900"');
  } finally {
    await cleanup();
  }
});

it("B5 Swap orientation: width and height swap", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStylePage(page);

    await page.locator("button.style-page-swap").click();
    await expect.poll(async () => (await readProjectJson(registry, presentationId)).canvas).toEqual({ width: 720, height: 1280 });
    await expect.poll(async () => readSlide(registry, presentationId)).toContain('viewBox="0 0 720 1280"');
  } finally {
    await cleanup();
  }
});

// ── Sub-tab state machine ───────────────────────────────────────────────

it("C: with no selection, the Object button is disabled and stays on Page; selecting auto-switches to Object; deselecting auto-returns to Page", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    await page.locator('[role="tab"][data-tab="style"]').click();

    expect(await page.locator('[role="tab"][data-subtab="object"]').isDisabled()).toBe(true);
    expect(await page.locator('[role="tab"][data-subtab="page"]').getAttribute("aria-selected")).toBe("true");

    await frame.locator("#el-a").click();
    await expect.poll(() => page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");

    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator('[role="tab"][data-subtab="page"]').getAttribute("aria-selected")).toBe("true");
  } finally {
    await cleanup();
  }
});

// ── Edit style entry point ────────────────────────────────────────────────

it("D: the context bar has exactly one Edit style button; clicking it only switches the right panel, issuing no command (file bytes unchanged)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);

    await frame.locator("#el-a").click();
    await expect.poll(() => page.locator('button[title="Edit style"]').count()).toBe(1);

    await hoverContextBar(page);
    await page.locator('button[title="Edit style"]').click();
    await expect.poll(() => page.locator('[role="tab"][data-tab="style"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

// ── Skeleton sections never fire a stray command ─────────────────────────────────────────────

it("G: every control in the Table/Chart/Image caption sections is disabled, and the slide's bytes are unchanged", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = await canvasFrame(page);
    const before = await readSlide(registry, presentationId);

    await selectAndOpenStyleObject(page, frame, "el-image");
    await expect.poll(() => page.locator('[data-section="image"]').count()).toBe(1);

    for (const section of ["table", "chart", "image"]) {
      const controls = page.locator(`[data-section="${section}"] :is(input,select)`);
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);
      const disabledFlags = await controls.evaluateAll((elements) =>
        elements.map((el) => (el as HTMLInputElement | HTMLSelectElement).disabled),
      );
      expect(disabledFlags.every(Boolean)).toBe(true);
    }

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});
