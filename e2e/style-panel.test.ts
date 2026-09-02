import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * 樣式面板 (NOOP-143). Real Chromium + real server + real file writes,
 * modeled on e2e/selection.test.ts and e2e/direct-manipulation.test.ts's
 * startServerFor/openApp shape. Uses its own checked-in fixture
 * (e2e/fixtures/style-panel-deck) rather than `demo/` — the plan's own
 * assumption note: demo/ is a shared baseline other e2e suites own, and a
 * deck built for this ticket's specific needs (two elements sharing one
 * fill, one with a different fill, one group, one text box) does not
 * belong bent into it.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/style-panel-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-style-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-style-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
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

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

/** NOOP-271/#154: 樣式面板現在是側邊分頁的一個 tab，預設停在對話，這裡先切過去。 */
async function openStyleTab(page: Page): Promise<void> {
  await page.locator('.side-panel-tab[data-tab="style"]').click();
}

async function readSlide(registry: CommandRegistry, presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

/** `fill="..."` on a specific element's own `<rect>`, read straight from the file — never from what the panel claims. */
function readFillAttr(svg: string, elementId: string): string | null {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*>[\\s\\S]*?<rect[^>]*fill="([^"]*)"`).exec(svg);
  return elementMatch ? elementMatch[1] : null;
}

it("A：選取元素時，fill 格顯示的值與 SVG 檔裡的原文字串一致", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    const fillInput = page.locator('input[data-attr="fill"]');
    await expect.poll(() => fillInput.inputValue()).toBe("#c43e1c");
    expect(await fillInput.getAttribute("data-state")).toBe("value");

    const svg = await readSlide(registry, presentationId);
    expect(readFillAttr(svg, "el-a")).toBe("#c43e1c");
  } finally {
    await cleanup();
  }
});

it("B：沒有 stroke 屬性的元素，stroke 格是空字串、data-state=unset，不捏 SVG 預設值", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    const strokeInput = page.locator('input[data-attr="stroke"]');
    await expect.poll(() => strokeInput.getAttribute("data-state")).toBe("unset");
    expect(await strokeInput.inputValue()).toBe("");
    expect(await strokeInput.getAttribute("placeholder")).toBe("未設定");
  } finally {
    await cleanup();
  }
});

it("C：把 fill 改成新值並失焦後，slide 檔裡該元素的 fill 真的變成新值", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    const fillInput = page.locator('input[data-attr="fill"]');
    await expect.poll(() => fillInput.inputValue()).toBe("#c43e1c");
    await fillInput.fill("#123456");
    await fillInput.blur();

    await expect
      .poll(async () => readFillAttr(await readSlide(registry, presentationId), "el-a"), { timeout: 10_000 })
      .toBe("#123456");
  } finally {
    await cleanup();
  }
});

it("D：多選改一個屬性只佔一格復原：一次 undo 兩個元素同時回到原值", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });

    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：2 個元素");

    const fillInput = page.locator('input[data-attr="fill"]');
    await expect.poll(() => fillInput.inputValue()).toBe("#c43e1c");
    await fillInput.fill("#000000");
    await fillInput.blur();

    await expect
      .poll(async () => readFillAttr(await readSlide(registry, presentationId), "el-a"), { timeout: 10_000 })
      .toBe("#000000");
    expect(readFillAttr(await readSlide(registry, presentationId), "el-b")).toBe("#000000");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    const afterUndo = await readSlide(registry, presentationId);
    expect(readFillAttr(afterUndo, "el-a")).toBe("#c43e1c");
    expect(readFillAttr(afterUndo, "el-b")).toBe("#c43e1c");
  } finally {
    await cleanup();
  }
});

it("E：兩個 fill 相同的元素同時選取，面板顯示該共同值", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });

    const fillInput = page.locator('input[data-attr="fill"]');
    await expect.poll(() => fillInput.getAttribute("data-state")).toBe("value");
    expect(await fillInput.inputValue()).toBe("#c43e1c");
  } finally {
    await cleanup();
  }
});

it("F：兩個 fill 不同的元素同時選取，面板顯示不一致（空字串＋placeholder）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-c").click({ modifiers: ["Shift"] });

    const fillInput = page.locator('input[data-attr="fill"]');
    await expect.poll(() => fillInput.getAttribute("data-state")).toBe("mixed");
    expect(await fillInput.inputValue()).toBe("");
    expect(await fillInput.getAttribute("placeholder")).toBe("不一致");
  } finally {
    await cleanup();
  }
});

it("G：直接 POST 白名單外的屬性（transform）被命令層拒絕，HTTP 500", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    const before = await readSlide(registry, presentationId);

    const response = await page.request.post(`${server.url}/api/command`, {
      data: {
        name: "element style set",
        input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "transform", value: "translate(1,1)" },
      },
    });

    expect(response.status()).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("不在樣式白名單內");
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("H：面板提供的 data-attr 集合恰好是八個白名單屬性，不含任何幾何或 data-comot- 屬性", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    const controls = page.locator(".style-panel :is(input,select)[data-attr]");
    await expect.poll(() => controls.count()).toBe(8);
    const attrs = await controls.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-attr")));
    expect(new Set(attrs)).toEqual(
      new Set(["fill", "stroke", "stroke-width", "font-family", "font-size", "font-weight", "text-anchor", "opacity"]),
    );
    for (const forbidden of ["transform", "x", "y", "width", "height"]) {
      expect(attrs).not.toContain(forbidden);
    }
    expect(attrs.some((attr) => attr?.startsWith("data-comot-"))).toBe(false);
  } finally {
    await cleanup();
  }
});

it("I：選取群組時，八格全部 disabled，並顯示群組沒有可套用樣式的提示", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-group").click();

    const controls = page.locator(".style-panel :is(input,select)[data-attr]");
    await expect.poll(() => controls.count()).toBe(8);
    const disabledFlags = await controls.evaluateAll((elements) =>
      elements.map((el) => (el as HTMLInputElement | HTMLSelectElement).disabled),
    );
    expect(disabledFlags.every(Boolean)).toBe(true);
    await expect.poll(() => page.locator(".style-panel-note").isVisible()).toBe(true);
  } finally {
    await cleanup();
  }
});

it("J：選取文字框時，只有 text-anchor 被 disabled，font-size 仍可編輯", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-text").click();

    const anchorSelect = page.locator('select[data-attr="text-anchor"]');
    const fontSizeInput = page.locator('input[data-attr="font-size"]');
    await expect.poll(() => anchorSelect.isDisabled()).toBe(true);
    expect(await fontSizeInput.isDisabled()).toBe(false);
  } finally {
    await cleanup();
  }
});

it("K：選取 0 個元素時，面板顯示空狀態提示，八格都不渲染", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openStyleTab(page);
    await expect.poll(() => page.locator(".style-panel-empty").isVisible()).toBe(true);
    expect(await page.locator(".style-panel :is(input,select)[data-attr]").count()).toBe(0);
  } finally {
    await cleanup();
  }
});
