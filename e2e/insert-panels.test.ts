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

  it("Video 面板貼 YouTube 網址 → 不下載任何資產，改成 data-comot-embed，且父文件疊出 <iframe> 播放器", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-video-youtube" });
    try {
      const page = await openPage(started.server);
      const beforeAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });

      await page.getByRole("button", { name: "Video" }).click();
      const panel = page.locator('.media-panel[aria-label="Video"]');
      await panel.locator(".media-panel-url").fill("https://www.youtube.com/watch?v=MtKyexX-GQc");
      await panel.locator(".media-panel-insert").click();
      await expect.poll(() => panel.count()).toBe(0);

      const after = await readSlide(started);
      // 網頁連結沒有位元組可下載：這條路徑必須完全繞過資產匯入。
      expect(after).toContain('data-comot-embed="youtube"');
      expect(after).toContain('data-comot-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc"');
      const afterAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });
      expect(afterAssets.data!.entries).toEqual(beforeAssets.data!.entries);

      // 播放器活在父文件（ADR-0011：投影片的 srcdoc iframe 永遠不給
      // allow-same-origin，YouTube 播放器在那裡根本載不起來）。
      const embed = page.locator(".embed-frame");
      await expect.poll(() => embed.count()).toBe(1);
      // `enablejsapi=1` 是載入用的，不寫進投影片檔案——上面斷言過檔案裡
      // 存的是乾淨的網址。有它，media 效果才驅動得動這個播放器。
      expect(await embed.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/MtKyexX-GQc?enablejsapi=1");
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

describe("停用態（05-INTERACTIONS.feature「停用態」，e2e 補齊 packages/web/test/dock.test.ts 沒有涵蓋的可從 UI 到達的三種狀態）", () => {
  it("無選取時 Animate/Arrange/Group 停用，選 2 個元素後 Group 變成可按（Insert 群組不受影響）", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-disabled-state" });
    try {
      const page = await openPage(started.server);
      const animateButton = page.locator('.dock-command[aria-label="Animate"]');
      const arrangeButton = page.locator('.dock-command[aria-label="Arrange"]');
      const groupButton = page.locator('.dock-command[aria-label="Group"]');
      const textButton = page.getByRole("button", { name: "Text" });

      // 無選取：Animate／Arrange／Group 三顆都停用；Insert 群組（Text 為代表）不受影響。
      expect(await animateButton.isDisabled()).toBe(true);
      expect(await arrangeButton.isDisabled()).toBe(true);
      expect(await groupButton.isDisabled()).toBe(true);
      expect(await textButton.isDisabled()).toBe(false);

      // 選 2 個元素：Group 變成可按。先選副標、再 Shift 加選標題（不是反過來
      // ——標題選取後的情境列＝正下方，會落在副標的點擊區域上方，先選標題
      // 會讓第二次點擊打中情境列而不是副標本身，選取不會變成 2 個元素）。
      const slideFrame = page.frameLocator("iframe.slide-frame");
      const selName = page.locator(".status-selection-chip");
      await slideFrame.locator("#el-subtitle").click();
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 副標");
      await slideFrame.locator("#el-title").click({ modifiers: ["Shift"] });
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
      expect(await groupButton.isDisabled()).toBe(false);
      expect(await animateButton.isDisabled()).toBe(false);
      expect(await arrangeButton.isDisabled()).toBe(false);
    } finally {
      await started.cleanup();
    }
  });
});

describe("Text 插入面板（05-INTERACTIONS.feature「插入」Text：輸入 + 樣式預設 + 對齊，Enter 直接插入）", () => {
  it("打字後按 Enter：直接插入文字框，元素被選取、面板關閉", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-text-enter" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);
      await panel.locator(".text-panel-input").fill("Enter 直接插入");
      await panel.locator(".text-panel-input").press("Enter");

      await expect.poll(() => panel.count()).toBe(0); // 面板關閉

      const after = await readSlide(started);
      expect(after).not.toBe(before);
      expect(after).toContain("Enter 直接插入");

      const sel = page.frameLocator("iframe.slide-frame").locator(".sel");
      await expect.poll(() => sel.boundingBox()).not.toBeNull();
    } finally {
      await started.cleanup();
    }
  });

  it("打字後按 Shift+Enter：換行，不插入、面板不關", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-text-shift-enter" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);
      const textarea = panel.locator(".text-panel-input");
      await textarea.fill("第一行");
      await textarea.press("Shift+Enter");
      await textarea.type("第二行");

      expect(await panel.count()).toBe(1); // 面板還開著
      expect(await textarea.inputValue()).toBe("第一行\n第二行");
      expect(await readSlide(started)).toBe(before); // 沒有插入任何東西
    } finally {
      await started.cleanup();
    }
  });
});

describe("拖放檔案到插入面板（06-KEYBOARD_AND_GESTURES.md「拖放檔案到插入面板」）", () => {
  it("對 Image 面板的 dropzone 派送帶檔案的 drop 事件：檔名出現在面板上，此時還沒有插入任何元素", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-drag-drop" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Image" }).click();
      const panel = page.locator('.media-panel[aria-label="Image"]');
      await expect.poll(() => panel.count()).toBe(1);

      await page.evaluate(
        ({ base64, name, mime }) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const file = new File([bytes], name, { type: mime });
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          const dropzone = document.querySelector(".media-panel-dropzone");
          if (!dropzone) throw new Error("找不到 .media-panel-dropzone");
          dropzone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
        },
        { base64: GIF_BYTES.toString("base64"), name: "dropped.gif", mime: "image/gif" },
      );

      await expect.poll(() => panel.locator(".media-panel-dropzone").textContent()).toBe("dropped.gif");
      expect(await panel.count()).toBe(1); // 面板還開著，還沒插入
      expect(await readSlide(started)).toBe(before);
    } finally {
      await started.cleanup();
    }
  });
});

describe("Esc 優先序（06-KEYBOARD_AND_GESTURES.md：面板開著且有選取時，一次 Esc 只關面板、選取還在）", () => {
  it("插入面板開著＋有選取：第一次 Esc 只關面板，選取不變；再對舞台按一次 Esc 才清選取", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-esc-priority" });
    try {
      const page = await openPage(started.server);
      const slideFrame = page.frameLocator("iframe.slide-frame");
      const selName = page.locator(".status-selection-chip");

      await slideFrame.locator("#el-title").click();
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 標題");

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);

      await page.keyboard.press("Escape");
      await expect.poll(() => panel.count()).toBe(0); // 面板關閉
      expect(await selName.textContent().then((t) => t?.trim())).toBe("Selected: 標題"); // 選取還在

      // 面板關閉後焦點還停在剛才點開它的 Dock 按鈕（父文件），不在 iframe
      // 裡——selection-runtime.js 的 Escape 監聽只在 iframe 本身有焦點時收
      // 得到。點一下已選取的元素（不改變選取本身：同一個元素、非疊加）把
      // 焦點帶回 iframe，再按 Esc 才輪到清除選取。
      await slideFrame.locator("#el-title").click();
      await page.keyboard.press("Escape");
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");
    } finally {
      await started.cleanup();
    }
  });
});
