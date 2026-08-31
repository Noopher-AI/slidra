import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * T3/NOOP-142's 「插入」分頁 6 顆按鈕 + 人的資產匯入路徑 (拖曳/剪貼簿/檔案選
 * 擇), driven end-to-end through real Chromium — same startServerFor/openApp
 * shape as e2e/ribbon-home.test.ts, same fixture (more than one selectable
 * element, no `templates`). File-change assertions read the presentation
 * through the same in-process `registry` the server dispatches through
 * (`cat`), never the DOM.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");
const presentationFontDir = path.join(rootDir, "packages/core/src/assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

// A real, minimal (1x1) decodable PNG — not just the 8-byte magic prefix —
// so the fixture also stands in for "a real image a browser can hand back
// through a <input type=file>/DataTransfer/clipboard item" (§6 of the
// plan: "用最小的 1×1 PNG，不要塞大圖進 repo").
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let browser: Browser;
let openPages: Page[] = [];
let fixtureDir: string;
let realPngPath: string;
let fakePngPath: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  fixtureDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ribbon-insert-"));
  realPngPath = path.join(fixtureDir, "photo.png");
  fakePngPath = path.join(fixtureDir, "fake.png");
  await writeFile(realPngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
  // Disguised extension: real bytes are plain text, not an image — the
  // rejection has to come from the byte header, never the ".png" name.
  await writeFile(fakePngPath, "this is just a text file, not a real image", "utf-8");
});

afterAll(async () => {
  await browser?.close();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-insert-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-insert-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-insert-deck-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckStagingDir, comotPath);
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
      await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.locator('.tab:has-text("插入")').click();
  return page;
}

async function readSlide(registry: CommandRegistry, presentationId: string, slidePath = "slides/001.svg"): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

async function listAssets(registry: CommandRegistry, presentationId: string): Promise<string[]> {
  const result = await registry.dispatch<{ entries: string[] }>("ls", { id: presentationId, path: "assets" });
  return result.ok ? result.data!.entries : [];
}

/** Picks a file through the button's own trigger (`accept`-filtered `<input type=file>`, T3's real code path), not by bypassing it. */
async function pickFile(page: Page, buttonLabel: string, filePath: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(`.cmd:has-text("${buttonLabel}")`).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(filePath);
}

it("A1 維持綠：插入分頁 6 顆按鈕全部接線後，disabled 數量仍是 0", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await page.locator(".groups .cmd[disabled]").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("圖片：檔案選擇匯入 PNG 後，該頁多出一個 href 指向 ../assets/ 的 <image>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await pickFile(page, "圖片", realPngPath);

    await expect.poll(async () => listAssets(registry, presentationId)).toEqual(["photo.png"]);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('href="../assets/photo.png"');
  } finally {
    await cleanup();
  }
});

it("影片：檔案選擇匯入 webm 後，該頁多出一個帶 data-comot-media 的 <rect>（不是 <image>）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const clipPath = path.join(e2eDir, "fixtures/media-deck/assets/clip.webm");
    await pickFile(page, "影片", clipPath);

    await expect.poll(async () => listAssets(registry, presentationId)).toEqual(["clip.webm"]);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('data-comot-media="../assets/clip.webm"');
    expect(svg).not.toContain("<image");
  } finally {
    await cleanup();
  }
});

it("音訊：檔案選擇匯入 oga 後，該頁多出一個帶 data-comot-media 的 <rect>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const narrationPath = path.join(e2eDir, "fixtures/media-deck/assets/narration.oga");
    await pickFile(page, "音訊", narrationPath);

    await expect.poll(async () => listAssets(registry, presentationId)).toEqual(["narration.oga"]);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('data-comot-media="../assets/narration.oga"');
  } finally {
    await cleanup();
  }
});

it("圖案：選單出現，選「橢圓」後該頁多出一個含 <ellipse> 的 <g>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeCount = before.match(/<ellipse/g)?.length ?? 0;

    await page.locator('.groups .cmd:has-text("圖案")').click();
    const menuItems = page.locator('.ribbon-menu [role="menuitem"]');
    await expect.poll(() => menuItems.count()).toBe(3);
    await page.locator('.ribbon-menu [role="menuitem"]:has-text("橢圓")').click();

    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<ellipse/g)?.length ?? 0).toBe(
      beforeCount + 1,
    );
    // NOOP-224: a shape with no `fill` renders SVG-default black, invisible
    // against the `demo/` deck's near-black background.
    const after = await readSlide(registry, presentationId);
    expect(/<ellipse[^>]*\sfill="[^"]+"/.test(after)).toBe(true);
  } finally {
    await cleanup();
  }
});

it("文字方塊：該頁多出一個含 <text> 的 <g>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeCount = before.match(/<g /g)?.length ?? 0;
    // Fixture already has both a filled and a fill-less `<text>` (NOOP-224:
    // counting must isolate the newly inserted one, not just "some text has
    // fill", which would already be true before the fix).
    const beforeFilledTextCount = before.match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0;

    await page.locator('.groups .cmd:has-text("文字方塊")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      beforeCount + 1,
    );
    const after = await readSlide(registry, presentationId);
    expect(after).toContain("<text");
    expect(after.match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0).toBe(beforeFilledTextCount + 1);
  } finally {
    await cleanup();
  }
});

it("頁碼：插入字面 {{ slide_number }}，渲染路徑（供播放模式用）顯示正確頁碼，搬到第 1 頁後跟著更新", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    // Second slide so there is a real "move" to prove the number updates.
    const added = await registry.dispatch<{ path: string }>("slide add", { id: presentationId });
    const secondSlidePath = added.data!.path;
    // Fixture already has both a filled and a fill-less `<text>` (NOOP-224:
    // counting must isolate the newly inserted one, not just "some text has
    // fill", which would already be true before the fix).
    const beforeFilledTextCount =
      (await readSlide(registry, presentationId)).match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0;

    const page = await openApp(server);
    await page.locator('.cmd:has-text("頁碼")').click();

    await expect.poll(async () => (await readSlide(registry, presentationId)).includes("{{ slide_number }}")).toBe(
      true,
    );
    const rawSvg = await readSlide(registry, presentationId);
    expect(rawSvg).toContain("{{ slide_number }}");
    expect(rawSvg.match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0).toBe(beforeFilledTextCount + 1);

    // Rendered path (what /api/files/ hands the play-mode iframe) shows "1"
    // — the slide the button was clicked on is the first slide.
    const renderedBefore = await (await fetch(`${server.url}/api/files/slides/001.svg`)).text();
    expect(renderedBefore).toContain(">1<");

    // Move it to the second position; the raw bytes carrying the literal
    // variable must not have changed — only the rendered substitution does.
    await registry.dispatch("slide move", { id: presentationId, slidePath: "slides/001.svg", newIndex: 1 });
    expect(await readSlide(registry, presentationId)).toBe(rawSvg);
    const renderedAfter = await (await fetch(`${server.url}/api/files/slides/001.svg`)).text();
    expect(renderedAfter).toContain(">2<");
    void secondSlidePath;
  } finally {
    await cleanup();
  }
});

it("拖曳一張真 PNG 進舞台：檔案進 assets/，投影片出現對應 <image>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const overlay = page.locator(".drop-overlay");

    // §0.2's trap, guarded directly: the iframe's own dragenter must reach
    // the overlay through canvas.ts's forwarded "drag-enter" message — a
    // dragenter dispatched straight on the parent document's stage well is
    // not the same code path and would pass even if that relay were dead.
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("body").dispatchEvent("dragenter");
    await expect.poll(() => overlay.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");

    const bytes = await readFileBase64(realPngPath);
    await overlay.evaluate(
      (el, base64) => {
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        const file = new File([arr], "dropped.png", { type: "image/png" });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      },
      bytes,
    );

    await expect.poll(async () => listAssets(registry, presentationId)).toEqual(["dropped.png"]);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('href="../assets/dropped.png"');
    expect(await page.locator(".canvas-error-banner[role='alert']").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("拖入偽裝成 .png 的文字檔：被拒絕，訊息說明格式不符，assets/ 與投影片位元組不變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const overlay = page.locator(".drop-overlay");
    const before = await readSlide(registry, presentationId);

    const bytes = await readFileBase64(fakePngPath);
    await overlay.evaluate(
      (el, base64) => {
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        const file = new File([arr], "fake.png", { type: "image/png" });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      },
      bytes,
    );

    const alert = page.locator(".canvas-error-banner[role='alert']");
    await expect.poll(() => alert.textContent()).toContain("不支援的媒體格式");
    expect(await listAssets(registry, presentationId)).toEqual([]);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("剪貼簿貼上一張 PNG：檔案進 assets/，投影片出現對應 <image>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const bytes = await readFileBase64(realPngPath);

    // Real OS clipboard access is flaky under headless CI, so this
    // synthesizes the `paste` ClipboardEvent App.tsx's window listener
    // reacts to — the same posture the plan calls for when real clipboard
    // permissions are unavailable (§6).
    await page.evaluate((base64) => {
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      const file = new File([arr], "clipboard.png", { type: "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer });
      window.dispatchEvent(event);
    }, bytes);

    await expect.poll(async () => listAssets(registry, presentationId)).toEqual(["clipboard.png"]);
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('href="../assets/clipboard.png"')).toBe(
      true,
    );
  } finally {
    await cleanup();
  }
});

async function readFileBase64(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(filePath)).toString("base64");
}
