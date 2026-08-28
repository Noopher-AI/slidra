import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * 總覽 (issue #27) end to end. Modeled on e2e/player.test.ts's beforeAll:
 * everything real — a `.comot` packed from a hand-written fixture deck, the
 * real `open` command, a real server, the real built bundle, real
 * Chromium. The agent is the same fake ACP subprocess the smoke/player
 * tests use; nothing here sends it a message.
 *
 * Two decks are used, on purpose:
 *  - `fixtures/player-deck/` (owned by issue #28's unit, read-only here):
 *    three slides, one of which references a real PNG through a relative
 *    path — exactly what "縮圖裡看得到那張圖" needs, and reusing it avoids
 *    duplicating that asset.
 *  - `fixtures/overview-deck/` (this ticket's own fixture): two dozen
 *    hand-written slides, for the "幾十頁也捲得動" and lazy-loading
 *    criteria, which need more slides than player-deck has.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const playerDeckDir = path.join(e2eDir, "fixtures/player-deck");
const overviewDeckDir = path.join(e2eDir, "fixtures/overview-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Packs `deckDir` into a fresh `.comot`, opens it, and starts a real server
 * for it. Returns the server plus a cleanup function — each `it()` below
 * gets its own isolated CO_MOTION_HOME and presentation, the same isolation
 * player.test.ts's single shared deck gets from running as the only test.
 */
async function startServerFor(
  deckDir: string,
): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-overview-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-overview-files-"));
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

it("總覽依 slides 順序列出縮圖，點縮圖跳頁且主畫面同步，目前頁明確可辨", async () => {
  const { server, cleanup } = await startServerFor(playerDeckDir);
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const items = page.locator("li.overview-item");
    await expect.poll(() => items.count(), { timeout: 30_000 }).toBe(3);

    const thumbAttr = (index: number, attr: string) =>
      items.nth(index).locator("button.overview-thumb").getAttribute(attr);
    const isCurrent = (index: number) =>
      items
        .nth(index)
        .getAttribute("class")
        .then((value) => (value ?? "").includes("overview-item-current"));

    // Order matches project.json's slides order (001, 002, 003): the first
    // item's aria-label is "第 1 頁", not derived from any other ordering.
    expect(await thumbAttr(0, "aria-label")).toBe("第 1 頁");
    expect(await thumbAttr(1, "aria-label")).toBe("第 2 頁");
    expect(await thumbAttr(2, "aria-label")).toBe("第 3 頁");

    // The current slide (index 0 on load) is marked.
    expect(await isCurrent(0)).toBe(true);
    expect(await thumbAttr(0, "aria-current")).toBe("page");
    expect(await isCurrent(1)).toBe(false);

    // Clicking the third thumbnail jumps the main canvas to slide 3, and
    // the mark moves with it.
    await items.nth(2).locator("button.overview-thumb").click();

    const mainSlideText = page.frameLocator("iframe.slide-frame").locator("svg text");
    await expect.poll(() => mainSlideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("第三頁");
    await expect.poll(() => isCurrent(2), { timeout: 30_000 }).toBe(true);
    expect(await isCurrent(0)).toBe(false);

    await page.close();
  } finally {
    await cleanup();
  }
});

it("引用圖片資產的投影片，總覽縮圖裡真的畫出那張圖", async () => {
  const { server, cleanup } = await startServerFor(playerDeckDir);
  try {
    const page = await browser.newPage();
    const rawResponses: { url: string; status: number; contentType: string | undefined }[] = [];
    page.on("response", (response) => {
      if (!response.url().includes("/api/raw/")) return;
      rawResponses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"],
      });
    });

    await page.goto(server.url);

    // Slide 2 (index 1) is the one with the photo. Force it to intersect by
    // scrolling its thumbnail into view — the sidebar is tall enough for
    // three items to already be in view on a normal viewport, but this
    // makes the test independent of viewport size.
    const secondThumb = page.locator('li.overview-item[data-index="1"] iframe.overview-frame');
    await secondThumb.scrollIntoViewIfNeeded();

    // As with the main-canvas equivalent (e2e/player.test.ts): an <image>
    // element in the DOM proves nothing about whether it actually loaded, so
    // this checks both that the bytes came back as a real PNG and that the
    // browser painted it with a non-zero box.
    await expect
      .poll(() => rawResponses.filter((r) => r.url.endsWith("/assets/photo.png")), { timeout: 30_000 })
      .toHaveLength(1);
    const photoResponse = rawResponses.find((r) => r.url.endsWith("/assets/photo.png"))!;
    expect(photoResponse.status).toBe(200);
    expect(photoResponse.contentType).toContain("image/png");

    const thumbImage = page
      .frameLocator('li.overview-item[data-index="1"] iframe.overview-frame')
      .locator("svg image");
    const box = await thumbImage.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    await page.close();
  } finally {
    await cleanup();
  }
});

it("外部編輯改了某頁的文字（slides 順序不變），總覽的縮圖也跟著換新", async () => {
  // P1 fix (review gate round 1): canvas.subscribe() cannot tell "the
  // slides list moved" apart from "an external edit changed a slide's
  // markup but project.json's slides order stayed the same" — the ordinary
  // shape of a live-reload edit. This proves the whole real path: a real
  // `text set` write to the packed-and-opened work directory (the same one
  // `watchPresentation` in packages/core/src/watch.ts is watching) →
  // fs.watch → the server's SSE broadcast → the browser's live-reload
  // handler → overviewControllerRef.refresh() → the already-materialised
  // thumbnail's iframe getting a new srcdoc. No mocks anywhere in this
  // chain.
  const { server, registry, presentationId, cleanup } = await startServerFor(playerDeckDir);
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    // Slide 1 (index 0) is on screen from the start, so its thumbnail is
    // already materialised — the same state the P1 report described.
    const firstThumbText = page
      .frameLocator('li.overview-item[data-index="0"] iframe.overview-frame')
      .locator("svg text");
    await expect.poll(() => firstThumbText.textContent().catch(() => null), { timeout: 30_000 }).toBe("第一頁");

    // A real write through the CLI's text-mutation primitive, into the
    // exact work directory `open` extracted the .comot into — the same one
    // the server's watcher is watching. slides/001.svg's element carries
    // id="el-first-title" (see e2e/fixtures/player-deck/slides/001.svg).
    const result = await registry.dispatch("text set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementId: "el-first-title",
      newText: "外部編輯過的標題",
    });
    expect(result.ok).toBe(true);

    // The main canvas is showing slide 1 too, so this also proves reload()
    // still fires — but the point of this test is the thumbnail catching up.
    await expect.poll(() => firstThumbText.textContent().catch(() => null), { timeout: 30_000 }).toBe(
      "外部編輯過的標題",
    );

    await page.close();
  } finally {
    await cleanup();
  }
});

it("縮圖 iframe 維持零 token sandbox", async () => {
  const { server, cleanup } = await startServerFor(playerDeckDir);
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    await expect.poll(() => page.locator("li.overview-item").count(), { timeout: 30_000 }).toBe(3);

    // Materialisation is lazy (an iframe only exists once its <li> has
    // intersected), so wait for all three near-viewport thumbnails' iframes
    // to exist before reading their sandbox attribute.
    await expect.poll(() => page.locator("iframe.overview-frame").count(), { timeout: 30_000 }).toBe(3);
    const sandboxValues = await page.locator("iframe.overview-frame").evaluateAll((frames) =>
      frames.map((frame) => frame.getAttribute("sandbox")),
    );
    expect(sandboxValues).toHaveLength(3);
    for (const value of sandboxValues) {
      expect(value).toBe("");
    }

    await page.close();
  } finally {
    await cleanup();
  }
});

it("縮圖 iframe 實際載入容器內嵌的字型，不是降級成系統字型（ADR-0016 / #71 第 2 輪）", async () => {
  // Unlike the other tests in this file (which reuse hand-written fixture
  // decks that predate #71 and carry no `fonts/`), this one needs a deck
  // that actually embeds a font — `new` via the CLI is what
  // buildMinimalPresentation (packages/core/src/presentation.ts) backs, and
  // it always embeds NotoSansTC-Presentation.ttf under `fonts/`.
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-overview-font-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-overview-font-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  try {
    const registry: CommandRegistry = createDefaultRegistry();
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath, name: "縮圖字型測試" });
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
    try {
      const page = await browser.newPage();
      await page.goto(server.url);

      const firstThumbFrame = page.locator('li.overview-item[data-index="0"] iframe.overview-frame');
      await expect.poll(() => firstThumbFrame.count(), { timeout: 30_000 }).toBe(1);

      // The main canvas (canvas.ts's own wrapper) is the known-good control:
      // its @font-face + font load must succeed the same way, or this test
      // would be comparing the thumbnail against a broken baseline.
      const mainFrame = page.frameLocator("iframe.slide-frame").locator("body");
      const mainFontStatus = await mainFrame.evaluate(async (el) => {
        const doc = el.ownerDocument;
        await doc.fonts.ready;
        const face = Array.from(doc.fonts).find((f) => f.family.replace(/"/g, "") === "Noto Sans TC");
        return face?.status ?? "missing";
      });
      expect(mainFontStatus).toBe("loaded");

      const thumbFrame = page.frameLocator('li.overview-item[data-index="0"] iframe.overview-frame').locator("body");
      const thumbFontStatus = await thumbFrame.evaluate(async (el) => {
        const doc = el.ownerDocument;
        await doc.fonts.ready;
        const face = Array.from(doc.fonts).find((f) => f.family.replace(/"/g, "") === "Noto Sans TC");
        return face?.status ?? "missing";
      });
      expect(thumbFontStatus).toBe("loaded");

      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    delete process.env.CO_MOTION_HOME;
    await rm(coMotionHome, { recursive: true, force: true });
    await rm(comotDir, { recursive: true, force: true });
  }
});

it("幾十頁的簡報：只有視窗附近的縮圖被實體化，捲動後才補上遠處的", async () => {
  const { server, cleanup } = await startServerFor(overviewDeckDir);
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const items = page.locator("li.overview-item");
    await expect.poll(() => items.count(), { timeout: 30_000 }).toBe(24);

    // All 24 <li> exist immediately (the scrollbar must be honest), but
    // only the ones near the top of the viewport are materialised at
    // first. "Materialised" means the iframe ELEMENT exists at all — an
    // eagerly-created iframe with an empty srcdoc would still cost a
    // browsing context per slide, which is the very thing #27's lazy
    // loading criterion forbids (P1, review gate round 3).
    const frameCountOf = (index: number) =>
      page.locator(`li.overview-item[data-index="${index}"] iframe.overview-frame`).count();
    const srcdocOf = (index: number) =>
      page.locator(`li.overview-item[data-index="${index}"] iframe.overview-frame`).evaluate(
        (frame) => (frame as HTMLIFrameElement).srcdoc,
      );

    await expect.poll(() => frameCountOf(0), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => srcdocOf(0), { timeout: 30_000 }).not.toBe("");
    // The very last slide is far below the fold on first load: not only no
    // srcdoc — no iframe element at all.
    expect(await frameCountOf(23)).toBe(0);

    await items.nth(23).scrollIntoViewIfNeeded();
    await expect.poll(() => frameCountOf(23), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => srcdocOf(23), { timeout: 30_000 }).not.toBe("");

    // Clicking the now-visible last thumbnail still jumps the main canvas.
    await items.nth(23).locator("button.overview-thumb").click();
    const mainSlideText = page.frameLocator("iframe.slide-frame").locator("svg text");
    await expect.poll(() => mainSlideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("後記");

    await page.close();
  } finally {
    await cleanup();
  }
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
