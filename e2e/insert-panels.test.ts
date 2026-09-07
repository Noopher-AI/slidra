import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, requireBuilt, startServerFor, type StartedServer } from "./helpers/launch.js";

/**
 * [E2.T17] plan §5 A1/A2/A8 — the one new e2e file this ticket adds (plan
 * §6.3): 05-INTERACTIONS.feature「底部玻璃工具列」的插入場景（`87-99` 行）
 * and the Shape menu scenario, driven through a real Chromium against a
 * real server (existing `table.test.ts`/`chart.test.ts` pattern). Appearance
 * (panel/menu centred over the dock) is covered by shell-visual.test.ts's
 * screenshot baselines, not asserted here — this file is behaviour only.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const SLIDE_PATH = "slides/001.svg";

// 1×1 GIF — real decodable bytes, smaller than the PNG signature other
// asset-import tests use, matching this file's only need: something
// `resolveAssetImport` classifies as `kind: "image"`.
const GIF_BYTES = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function openPage(server: StartedServer["server"]): Promise<Page> {
  const page = await openApp(browser, server);
  openPages.push(page);
  return page;
}

async function readSlide(started: StartedServer): Promise<string> {
  const result = await started.registry.dispatch<{ content: string }>("cat", { id: started.presentationId, path: SLIDE_PATH });
  return result.data!.content;
}

describe("底部玻璃工具列 — 插入面板（05-INTERACTIONS.feature「插入（所有類型先詢問）」）", () => {
  it("按 Image/Video/Audio/Shape 各自從 dock 正上方中央長出對應浮層", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-open" });
    try {
      const page = await openPage(started.server);

      for (const label of ["Image", "Video", "Audio"] as const) {
        await page.getByRole("button", { name: label }).click();
        const panel = page.locator(`.media-panel[aria-label="${label}"]`);
        await expect.poll(() => panel.count()).toBe(1);
        const dockBox = (await page.locator(".dock").boundingBox())!;
        const panelBox = (await panel.boundingBox())!;
        // "正上方中央" (02-DESIGN_DOC.md §2.3): horizontally centred over
        // the whole dock, sitting above it — exact centring, ±2px for
        // sub-pixel rounding.
        expect(Math.abs(panelBox.x + panelBox.width / 2 - (dockBox.x + dockBox.width / 2))).toBeLessThan(2);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(dockBox.y + 1);
        // 關掉，換下一個
        await page.keyboard.press("Escape");
        await expect.poll(() => panel.count()).toBe(0);
      }

      await page.getByRole("button", { name: "Shape" }).click();
      const shapeMenu = page.locator(".shape-menu");
      await expect.poll(() => shapeMenu.count()).toBe(1);
      const dockBox = (await page.locator(".dock").boundingBox())!;
      const menuBox = (await shapeMenu.boundingBox())!;
      expect(Math.abs(menuBox.x + menuBox.width / 2 - (dockBox.x + dockBox.width / 2))).toBeLessThan(2);
    } finally {
      await started.cleanup();
    }
  });

  it("Image/Video/Audio 面板各自有檔案選擇、URL 文字框、caption 文字框三個欄位", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-fields" });
    try {
      const page = await openPage(started.server);

      for (const label of ["Image", "Video", "Audio"] as const) {
        await page.getByRole("button", { name: label }).click();
        const panel = page.locator(`.media-panel[aria-label="${label}"]`);
        await expect.poll(() => panel.count()).toBe(1);
        expect(await panel.locator('input[type="file"]').count()).toBe(1);
        expect(await panel.locator(".media-panel-url").count()).toBe(1);
        expect(await panel.locator(".media-panel-caption").count()).toBe(1);
        await page.keyboard.press("Escape");
      }
    } finally {
      await started.cleanup();
    }
  });

  it("Image 面板：從 URL 匯入 + caption，按 Insert → 元素加到目前頁、被選取、面板關閉", async () => {
    const sourceServer = http.createServer((req, res) => {
      if (req.url === "/photo.gif") {
        res.writeHead(200, { "Content-Type": "image/gif" });
        res.end(GIF_BYTES);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
    const { port } = sourceServer.address() as AddressInfo;
    const sourceUrl = `http://127.0.0.1:${port}/photo.gif`;

    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-url-import" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Image" }).click();
      const panel = page.locator('.media-panel[aria-label="Image"]');
      await panel.locator(".media-panel-url").fill(sourceUrl);
      await panel.locator(".media-panel-caption").fill("我的圖片");
      await panel.locator(".media-panel-insert").click();

      await expect.poll(() => panel.count()).toBe(0); // 面板關閉

      const after = await readSlide(started);
      expect(after).not.toBe(before);
      expect(after).toContain('data-comot-name="我的圖片"');
      expect(after).toMatch(/<image[^>]*href="\.\.\/assets\/photo(-1)?\.gif"/);

      // 新元素被選取
      const sel = page.frameLocator("iframe.slide-frame").locator(".sel");
      await expect.poll(() => sel.boundingBox()).not.toBeNull();
    } finally {
      await started.cleanup();
      await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    }
  });

  it("Image 面板：選擇本機檔案，按 Insert → 走 controller.importAsset(file)，元素加到目前頁、面板關閉", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-file-import" });
    try {
      const page = await openPage(started.server);
      const before = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });

      await page.getByRole("button", { name: "Image" }).click();
      const panel = page.locator('.media-panel[aria-label="Image"]');
      await panel.locator('input[type="file"]').setInputFiles({ name: "photo.gif", mimeType: "image/gif", buffer: GIF_BYTES });
      await panel.locator(".media-panel-insert").click();
      await expect.poll(() => panel.count()).toBe(0);

      const after = await readSlide(started);
      expect(after).toMatch(/<image[^>]*href="\.\.\/assets\/photo\.gif"/);
      const listed = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });
      // demo/ 這份 fixture 本身已有 assets/（004.svg 用到的 intro.webm 等）
      // ——只斷言這次匯入「多出來」的那一個，不假設目錄一開始是空的。
      expect(listed.data!.entries).toEqual([...before.data!.entries, "photo.gif"].sort());
    } finally {
      await started.cleanup();
    }
  });

  it("Video 面板：三個欄位留空按 Insert → 插入 kind=video 的占位元素，不做任何匯入", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-video-placeholder" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);
      const beforeAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });

      await page.getByRole("button", { name: "Video" }).click();
      const panel = page.locator('.media-panel[aria-label="Video"]');
      await panel.locator(".media-panel-insert").click();
      await expect.poll(() => panel.count()).toBe(0);

      const after = await readSlide(started);
      expect(after).toContain('data-comot-type="video"');
      expect(after).not.toContain("data-comot-media=");

      const afterAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });
      expect(afterAssets.data!.entries).toEqual(beforeAssets.data!.entries); // 沒有任何匯入發生
      expect(after).not.toBe(before);
    } finally {
      await started.cleanup();
    }
  });

  it("Audio 面板：三個欄位留空按 Insert → 插入 kind=audio 的占位元素", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-audio-placeholder" });
    try {
      const page = await openPage(started.server);

      await page.getByRole("button", { name: "Audio" }).click();
      const panel = page.locator('.media-panel[aria-label="Audio"]');
      await panel.locator(".media-panel-insert").click();
      await expect.poll(() => panel.count()).toBe(0);

      const after = await readSlide(started);
      expect(after).toContain('data-comot-type="audio"');
    } finally {
      await started.cleanup();
    }
  });
});

describe("Shape 選單（05-INTERACTIONS.feature「Shape / Arrange 選單」）", () => {
  it("長出 Rectangle/Ellipse/Line；點 Rectangle 插入矩形，被選取，選單關閉", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-shape-rect" });
    try {
      const page = await openPage(started.server);

      await page.getByRole("button", { name: "Shape" }).click();
      const menu = page.locator(".shape-menu");
      await expect.poll(() => menu.count()).toBe(1);
      expect(await menu.getByText("Rectangle").count()).toBe(1);
      expect(await menu.getByText("Ellipse").count()).toBe(1);
      expect(await menu.getByText("Line").count()).toBe(1);

      const before = await readSlide(started);
      await menu.getByText("Rectangle").click();
      await expect.poll(() => menu.count()).toBe(0);

      const after = await readSlide(started);
      expect(after).not.toBe(before);
      expect(after).toMatch(/<rect x="0" y="0" width="[\d.]+" height="[\d.]+"/);

      const sel = page.frameLocator("iframe.slide-frame").locator(".sel");
      await expect.poll(() => sel.boundingBox()).not.toBeNull();
    } finally {
      await started.cleanup();
    }
  });

  it("點 Line 插入線元素，且帶有非空 stroke（沒有 pageStyle.accent 時的後備色，不是看不見的洞）", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-shape-line" });
    try {
      const page = await openPage(started.server);

      await page.getByRole("button", { name: "Shape" }).click();
      const menu = page.locator(".shape-menu");
      await expect.poll(() => menu.count()).toBe(1);
      await menu.getByText("Line").click();
      await expect.poll(() => menu.count()).toBe(0);

      const after = await readSlide(started);
      const match = /<line[^>]*stroke="([^"]*)"/.exec(after);
      expect(match).not.toBeNull();
      expect(match![1].length).toBeGreaterThan(0);
    } finally {
      await started.cleanup();
    }
  });
});
