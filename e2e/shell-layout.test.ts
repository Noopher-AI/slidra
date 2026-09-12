import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/**
 * NOOP-60/#197 驗收條件第 2 條：「1280×720 與 2560×1440 下版面尺寸與原型
 * 一致」。原型與書面規格（01-DESIGN_TOKENS.md 的「間距與尺寸」、
 * 02-DESIGN_DOC.md §3）都沒有跑起來或量測，本檔直接核對 tokens.css 落地
 * 的字面數值——這些數值本身已由 apps/web/test/tokens.test.ts 機械核
 * 對回 01-DESIGN_TOKENS.md，這裡驗證的是「CSS 數值有沒有真的在瀏覽器裡
 * 生效成對應的版面尺寸」，兩者互補、不重複。
 *
 * 誤差容忍 ±1px（子像素捨入，boundingBox() 是浮點數）。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
];

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

async function boundingBoxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} 沒有量到 boundingBox（不存在或未渲染）`);
  return box;
}

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`;

  it(`${label}：外殼各區塊尺寸與 tokens.css 落地的設計包數值一致`, async () => {
    const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: `shell-layout-${label}` });
    try {
      const page = await openApp(browser, started.server, { viewport });
      openPages.push(page);

      const titlebar = await boundingBoxOf(page, ".titlebar");
      expect(titlebar.height).toBeCloseTo(48, 0);

      const rail = await boundingBoxOf(page, ".rail");
      expect(rail.width).toBeCloseTo(212, 0);

      const sidePanel = await boundingBoxOf(page, ".side-panel");
      expect(sidePanel.width).toBeCloseTo(340, 0);

      const notes = await boundingBoxOf(page, ".notes");
      expect(notes.height).toBeCloseTo(112, 0);

      const statusBar = await boundingBoxOf(page, ".status");
      expect(statusBar.height).toBeGreaterThanOrEqual(36 - 1);

      const dock = await boundingBoxOf(page, ".dock");
      expect(dock.height).toBeCloseTo(46, 0);

      // 舞台留白：直接讀 .canvas-area 的 computed padding（28px 上／36px
      // 左右／76px 底，Dock 保留區），不是從 .canvas-area 與 .stage 的
      // boundingBox 差值反推——.stage 用 aspect-ratio + max-width/height
      // 貼合可用空間，在非 16:9 的可用空間（本殼的 rail/side-panel/notes
      // 版位並不保證裁出剛好 16:9 的舞台區）下會在某一軸出現額外的
      // letterbox，那不是 padding 值本身、也不是這裡要驗的東西——舞台置中
      // 與該額外留白的行為已由 e2e/stage.test.ts 的 DOCK_RESERVATION 斷言
      // 覆蓋，此檔只驗 tokens.css 落地的 padding 字面值有沒有真的生效。
      const padding = await page.locator(".canvas-area").evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          top: parseFloat(cs.paddingTop),
          right: parseFloat(cs.paddingRight),
          bottom: parseFloat(cs.paddingBottom),
          left: parseFloat(cs.paddingLeft),
        };
      });
      expect(padding.top).toBeCloseTo(28, 0);
      expect(padding.right).toBeCloseTo(36, 0);
      expect(padding.left).toBeCloseTo(36, 0);
      expect(padding.bottom).toBeCloseTo(76, 0);
    } finally {
      await started.cleanup();
    }
  });
}
