import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { CommandRegistry } from "@co-motion/cli";
import { attributeValue, scanDocument } from "../packages/core/src/slide/scan.js";
import { readTableModel } from "../packages/core/src/table/model.js";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/**
 * [E2.T18] 剪貼簿：⌘C／⌘X／⌘V 對元素（含多選、群組）與儲存格範圍，跨頁貼上，
 * 右鍵選單... 見計畫 §5 的驗收標準 A0-A7. 唯一一個新開的 e2e 檔（計畫 §6.3：
 * `e2e/vitest.config.ts` 的 `fileParallelism: false` 讓每個 e2e 檔都是一次完整
 * build+Chromium+server 啟動的成本，六個測項共用一次瀏覽器啟動，each `it()`
 * still packs its own fresh copy of the fixture via `startServerFor`, so the
 * six tests never share mutated state).
 *
 * 不做截圖比對（計畫第 2 節邊界 10）：AGENTS.md 的視覺回歸把關分工只認 CI 上
 * 的逐像素比對，本檔完全不呼叫 `compareScreenshot`。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/clipboard-deck");
const cliBinPath = path.join(rootDir, "packages/cli/bin/co-motion.js");

let browser: Browser;
let openPages: Page[] = [];
let startedServers: StartedServer[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
  for (const started of startedServers) await started.cleanup();
  startedServers = [];
});

async function start(): Promise<StartedServer> {
  const started = await startServerFor({ deckDir, prefix: "clipboard" });
  startedServers.push(started);
  return started;
}

async function openWithClipboard(started: StartedServer): Promise<Page> {
  const page = await openApp(browser, started.server);
  openPages.push(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: started.server.url });
  return page;
}

async function readSlide(registry: CommandRegistry, presentationId: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

async function readSystemClipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * `navigator.clipboard` is a real OS-level resource, not sandboxed per
 * Playwright `BrowserContext` — a `Meta+c` keydown only *starts* the async
 * `navigator.clipboard.writeText()` (canvas.ts's controller never awaits
 * it, since nothing here can hold a synchronous ClipboardEvent open; see
 * A0's comment). Reading it back immediately can race ahead of that write
 * and observe whatever a PRIOR test in this same file left behind. Every
 * copy below waits for the clipboard to actually contain `expectMarker`
 * (something unique to what was just copied) before treating the copy as
 * done.
 */
async function copyAndWaitForClipboard(page: Page, expectMarker: string): Promise<string> {
  await page.keyboard.press("Meta+c");
  await expect.poll(() => readSystemClipboardText(page), { timeout: 10_000 }).toContain(expectMarker);
  return readSystemClipboardText(page);
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [cliBinPath, ...args],
      { env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? ((error as NodeJS.ErrnoException).code as unknown as number) : 0, stdout, stderr });
      },
    );
  });
}

/** The CLI's default renderer prints `message` then `JSON.stringify(data, null, 2)` on the next line(s) (bin.ts) — this pulls that JSON back out. */
function parseCliData<T>(stdout: string): T {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) throw new Error(`CLI 輸出沒有 JSON：${stdout}`);
  return JSON.parse(stdout.slice(jsonStart)) as T;
}

const slideFrame = (page: Page) => page.frameLocator("iframe.slide-frame");

it("A0：sandbox iframe 內的 ⌘C 能寫入系統剪貼簿，內容是合法的 co-motion 剪貼簿 SVG", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  await slideFrame(page).locator("#el-solo").click();
  const clipboardText = await copyAndWaitForClipboard(page, "el-solo");

  expect(clipboardText).toMatch(/^<svg/);
  expect(clipboardText).toContain('data-comot-clipboard="elements"');
  expect(clipboardText).toContain('id="el-solo"');
});

it("06-KEYBOARD ⌘X：元素離開投影片且進系統剪貼簿，一筆歷史，undo 還原", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  await slideFrame(page).locator("#el-solo").click();
  await page.keyboard.press("Meta+x");
  await expect.poll(() => readSystemClipboardText(page), { timeout: 10_000 }).toContain("el-solo");

  const clipboardText = await readSystemClipboardText(page);
  expect(clipboardText).toMatch(/^<svg/);
  expect(clipboardText).toContain('data-comot-clipboard="elements"');
  expect(clipboardText).toContain('id="el-solo"');

  const afterCut = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  expect(afterCut).not.toContain('id="el-solo"');
  expect(afterCut).not.toBe(before);

  await page.keyboard.press("Meta+z");
  await expect
    .poll(() => readSlide(started.registry, started.presentationId, "slides/001.svg"), { timeout: 10_000 })
    .toBe(before);
});

it("A1：元素同頁貼上 — 新 <g>，新 id ≠ 原 id，位移恰為 PASTE_OFFSET_STEP", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  await slideFrame(page).locator("#el-solo").click();
  await copyAndWaitForClipboard(page, "el-solo");
  await page.keyboard.press("Meta+v");

  await expect
    .poll(async () => (await readSlide(started.registry, started.presentationId, "slides/001.svg")) !== before, {
      timeout: 10_000,
    })
    .toBe(true);
  const after = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  // el-solo's own translate is (100 100); the paste's first landing on its
  // own source slide gets one PASTE_OFFSET_STEP (20), per paste-offset.ts.
  const match = /<g id="(el-[^"]+)" data-comot-name="單一元素" transform="translate\(120 120\)">/.exec(after);
  expect(match).not.toBeNull();
  expect(match![1]).not.toBe("el-solo");
});

it("A2：跨頁貼上 — 目標頁多出元素與其效果（指向新 id），來源頁逐位元組不變", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before1 = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  await slideFrame(page).locator("#el-solo").click();
  await copyAndWaitForClipboard(page, "el-solo");
  await page.locator('.overview-item[data-index="1"] .overview-thumb').click();
  await expect.poll(() => slideFrame(page).locator("#el-solo").count(), { timeout: 10_000 }).toBe(0);
  await page.keyboard.press("Meta+v");

  await expect
    .poll(async () => (await readSlide(started.registry, started.presentationId, "slides/002.svg")).includes('<g id="el-'), {
      timeout: 10_000,
    })
    .toBe(true);
  const slide2 = await readSlide(started.registry, started.presentationId, "slides/002.svg");
  const idMatch = /<g id="(el-[^"]+)"/.exec(slide2);
  expect(idMatch).not.toBeNull();
  const newId = idMatch![1];
  expect(newId).not.toBe("el-solo");
  expect(slide2).toContain(`<comot:effect target="${newId}"`);
  expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before1);
});

it("A3：群組貼上 — 兩個子容器 id 都是新的，且子元素相對位置不變", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  // Clicking a group's child selects the whole group (05-INTERACTIONS.feature「選取群組」).
  await slideFrame(page).locator("#el-group-a rect").click();
  await copyAndWaitForClipboard(page, "el-group-a");
  await page.keyboard.press("Meta+v");

  await expect
    .poll(async () => {
      const svg = await readSlide(started.registry, started.presentationId, "slides/001.svg");
      return (svg.match(/data-comot-name="群組"/g) ?? []).length;
    }, { timeout: 10_000 })
    .toBe(2);
  const after = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const svgRoot = scanDocument(after).find((node) => node.tag === "svg")!;
  const groups = svgRoot.children.filter(
    (node) => node.tag === "g" && attributeValue(node, "data-comot-name") === "群組",
  );
  const pastedGroup = groups.find((node) => attributeValue(node, "id") !== "el-group")!;
  expect(pastedGroup).toBeDefined();
  expect(attributeValue(pastedGroup, "id")).not.toBe("el-group");
  const children = pastedGroup.children.filter((node) => node.tag === "g");
  expect(children).toHaveLength(2);
  const childIds = children.map((child) => attributeValue(child, "id"));
  expect(childIds).not.toContain("el-group-a");
  expect(childIds).not.toContain("el-group-b");
  // Original children sit at translate(0 0) and translate(80 0) — an 80px
  // horizontal gap. The pasted group's own two children must preserve it.
  const xOffsets = children.map((child) => Number(/translate\((-?[\d.]+) /.exec(attributeValue(child, "transform") ?? "")?.[1] ?? "0"));
  expect(Math.abs(xOffsets[1] - xOffsets[0])).toBeCloseTo(80, 5);
});

it("A4：儲存格範圍複製貼上（CLI，[E2.T14] 軟依賴）— TSV 往返，瀏覽器載入後畫面看得到新文字", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  const copyResult = await runCli([
    "table", "cell", "copy", started.presentationId, "slides/001.svg", "tbl-1", "--range", "0,0:0,2",
  ]);
  expect(copyResult.code).toBe(0);
  const { tsv } = parseCliData<{ tsv: string }>(copyResult.stdout);
  expect(tsv).toBe("A1\tB1\tC1");

  const tsvFile = path.join(await mkdtemp(path.join(tmpdir(), "co-motion-e2e-clipboard-tsv-")), "cells.tsv");
  await writeFile(tsvFile, tsv, "utf-8");
  const pasteResult = await runCli([
    "table", "cell", "paste", started.presentationId, "slides/001.svg", "tbl-1", "--at", "2,0", "--tsv-file", tsvFile,
  ]);
  expect(pasteResult.code).toBe(0);
  expect(parseCliData<{ cells: number }>(pasteResult.stdout).cells).toBe(3);

  const after = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const row2 = readTableModel(after, "tbl-1").cells.filter((cell) => cell.row === 2).map((cell) => cell.text);
  expect(row2).toEqual(["A1", "B1", "C1"]);

  // ADR-0001: confirm the static render, not just the file bytes.
  await page.locator('.overview-item[data-index="0"] .overview-thumb').click();
  await page.reload();
  await expect.poll(() => slideFrame(page).locator('[data-comot-cell="2,0"] text').textContent(), { timeout: 10_000 }).toBe("A1");
  expect(await slideFrame(page).locator('[data-comot-cell="2,1"] text').textContent()).toBe("B1");
  expect(await slideFrame(page).locator('[data-comot-cell="2,2"] text').textContent()).toBe("C1");
});

it("A5：貼上後的檔案變更由 CLI element paste 可重現（GUI 與 agent 走同一條路，僅隨機 id 不同）", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  await slideFrame(page).locator("#el-solo").click();
  const clipboardSvg = await copyAndWaitForClipboard(page, "el-solo");
  await page.keyboard.press("Meta+v");

  await expect
    .poll(async () => (await readSlide(started.registry, started.presentationId, "slides/001.svg")).includes("translate(120 120)"), {
      timeout: 10_000,
    })
    .toBe(true);
  const guiResult = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const guiNewId = /<g id="(el-[^"]+)" data-comot-name="單一元素" transform="translate\(120 120\)">/.exec(guiResult)![1];

  await page.keyboard.press("Meta+z");
  await expect
    .poll(
      async () => (await readSlide(started.registry, started.presentationId, "slides/001.svg")).includes("translate(120 120)"),
      { timeout: 10_000 },
    )
    .toBe(false);

  const svgFile = path.join(await mkdtemp(path.join(tmpdir(), "co-motion-e2e-clipboard-svg-")), "clip.svg");
  await writeFile(svgFile, clipboardSvg, "utf-8");
  const cliPaste = await runCli([
    "element", "paste", started.presentationId, "slides/001.svg", "--dx", "20", "--dy", "20", "--svg-file", svgFile,
  ]);
  expect(cliPaste.code).toBe(0);
  const cliResult = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const cliNewId = parseCliData<{ elementIds: string[] }>(cliPaste.stdout).elementIds[0];

  // Same path, different only in the one thing that is *supposed* to differ
  // between two independent pastes: the cryptographically random new id
  // (`generateElementId`) — never reproducible byte-for-byte across two
  // separate invocations, so the comparison normalises exactly that one
  // substring away on both sides before asserting full equality.
  const normalize = (svg: string, id: string) => svg.split(id).join("NEW_ID");
  expect(normalize(guiResult, guiNewId)).toBe(normalize(cliResult, cliNewId));
});

it("A7：不可信內容貼不進去 — 含 onload 的偽造剪貼簿 SVG 貼上後檔案不變，畫面顯示錯誤", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  const hostileSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-comot-clipboard="elements" data-comot-source="slides/001.svg">' +
    '<g id="el-hostile" onload="fetch(\'https://evil.example\')"><rect width="10" height="10"/></g></svg>';
  await page.evaluate((svg) => navigator.clipboard.writeText(svg), hostileSvg);
  await page.keyboard.press("Meta+v");

  await expect.poll(() => page.locator(".canvas-error-banner").isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
  expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before);
});

/**
 * 三輪繞過樣本各取一個代表性 payload（[E2.T18r2]／[E2.T18r3]／[E2.T18r4] 三輪
 * Review 累積發現的角度）：任何一格若被漏放行，`page.context().route` 都會
 * 攔到對 evil.example 的請求並讓 `outbound` 非空。
 */
const A8_BYPASS_MATRIX: ReadonlyArray<[cell: string, hostileFragment: string]> = [
  ["R1 entity-encoded href", '<g id="el-hostile"><image href="&#104;ttps://evil.example/x.png" width="10" height="10"/></g>'],
  [
    "R2 url(...) raw-string bypass",
    '<g id="el-hostile"><rect width="200" height="200" style="fill:&#x75;rl(&#x2f;&#x2f;evil.example/x.svg#g)"/></g>',
  ],
  ["R3 backslash href", '<g id="el-hostile"><image href="\\\\evil.example\\x.png" width="10" height="10"/></g>'],
  [
    "R3 xl:href namespace alias",
    // r5 (NOOP-201 §6.2): the "//"-form payload was already caught by ABSOLUTE_URL before ever
    // reaching the local-name check this cell means to isolate; omitting "//" (still a real
    // outbound reference once I2's shape match applies) actually exercises that check alone.
    '<g id="el-hostile" xmlns:xl="http://www.w3.org/1999/xlink"><image xl:href="https:evil.example/x.png" width="10" height="10"/></g>',
  ],
  // r5 (NOOP-201 §6.2): round-4's two bypasses that reached a real outbound request.
  ["R4 TAB href", '<g id="el-hostile"><image href="/\t/evil.example/x.png" width="10" height="10"/></g>'],
  ["R4 uppercase HREF", '<g id="el-hostile"><image HREF="https:evil.example/y.png" width="10" height="10"/></g>'],
  // [E2.T18r8 §6.3, test budget] r5's CSS-hex-escape row and r6's three
  // style-carrying rows are pruned here: `style` dropped from the allowlist
  // entirely in r6, so all four are rejected at the same "style not in
  // allowlist" line as "R2 url(...) raw-string bypass" above (kept as the
  // one representative — it carries entity-encoding, `url()`, and a
  // protocol-relative `//` in a single payload, the most dimensions of any
  // style-carrying cell). Each removed row's payload survives verbatim in
  // core's cheaper (0.4s, no browser) `REJECT_MATRIX` — a browser launch adds
  // no information a unit-layer assertion doesn't already give:
  //   R5 CSS-escaped url()                 → core REJECT_MATRIX N11
  //   R6 style unclosed url()              → core REJECT_MATRIX R1
  //   R6 style cursor image-set()          → core REJECT_MATRIX R2
  //   R6 style background-image image-set() → core REJECT_MATRIX R3
  // [E2.T18r8 F1] the real-world entry point for the raw-form XML legality
  // defect: a raw, unescaped `<` in `href` used to pass through and write an
  // unparsable slide (`DOMParser` failure → that page's animations silently
  // vanish). Unlike the cells above, this one has no cheaper single-layer
  // equivalent worth keeping it off — it's the shape Reviewer actually found
  // the regression through.
  ["R8 raw < in href", '<g id="el-hostile"><image href="a<b.png" width="10" height="10"/></g>'],
];

it.each(A8_BYPASS_MATRIX)(
  "A8：%s 的偽造剪貼簿內容貼不進去，且瀏覽器不對 evil.example 發出任何請求",
  async (_cell, hostileFragment) => {
    const started = await start();
    const page = await openWithClipboard(started);
    const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

    const outbound: string[] = [];
    await page.context().route(/evil\.example/, (route) => {
      outbound.push(route.request().url());
      return route.abort();
    });

    const hostileSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-comot-clipboard="elements" data-comot-source="slides/001.svg">' +
      hostileFragment +
      "</svg>";
    await page.evaluate((svg) => navigator.clipboard.writeText(svg), hostileSvg);
    await page.keyboard.press("Meta+v");

    await expect.poll(() => page.locator(".canvas-error-banner").isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
    expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before);
    expect(outbound).toEqual([]);
  },
);
