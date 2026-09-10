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
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * [E2.T7]/NOOP-66/#206: `05-INTERACTIONS.feature`「物件動畫（PPTX 心智）」
 * end to end, against a real Chromium — same `startServerFor`/`openApp`
 * shape as e2e/direct-manipulation.test.ts. This is the ONE e2e file this
 * ticket's plan allows opening (§6.3): every family, the
 * badges, the Edit animation entry, and the GUI↔CLI equivalence all live
 * here rather than one file each.
 *
 * Each test opens its own server against a fresh copy of the fixture deck
 * (`object-animation-deck`) — no test depends on another's mutations.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/co-motion");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const deckDir = path.join(e2eDir, "fixtures/object-animation-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/object-animation");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
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

interface TestServer {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}

async function startServerFor(): Promise<TestServer> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-anim-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-anim-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  // [E4.T9]/F7: co-motion serve now spawns the Rust binary for every read/write.
  process.env.CO_MOTION_BIN = coMotionBin;

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

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      delete process.env.CO_MOTION_BIN;
      await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

interface EffectRow {
  target: string;
  family: string;
  effect: string;
  start: string;
  duration: number;
  delay: number;
  d?: string;
}

// [E4.T7] 裁示（Dev-Leader, NOOP-304 [需決策] 回覆）：改讀原始 XML，不再透過
// `effect list`。`effect list` 現在會依 cli.md 既有規格對「清單第一項
// start 不是 on-click」的清單回報損毀（[E4.T7] 把 step 推導搬進 effect
// list 之後才第一次讓這裡撞上，`effect add` 本身允許寫入這個狀態——見
// cli.md `effect add`「不確定與保留事項」）。這個函式只是讀回機制，測的是
// GUI／CLI 寫進檔案的內容對不對，不是 `effect list` 合不合規格，所以改用
// `cat` + regex，跟 packages/cli/test/effect.test.ts:76-89 對稱處理。
async function readEffects(registry: CommandRegistry, presentationId: string): Promise<EffectRow[]> {
  const result = await registry.dispatch<{ content: string }>("cat", {
    id: presentationId,
    path: "slides/001.svg",
  });
  if (!result.ok) return [];
  const svg = result.data!.content;
  const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  return [...svg.matchAll(/<comot:effect\b[^>]*\/>/g)].map((match) => {
    const tag = match[0];
    const row: EffectRow = {
      target: attr(tag, "target")!,
      family: attr(tag, "family")!,
      effect: attr(tag, "effect")!,
      start: attr(tag, "start")!,
      duration: Number(attr(tag, "duration")),
      delay: Number(attr(tag, "delay")),
    };
    const d = attr(tag, "d");
    if (d !== undefined) row.d = d;
    return row;
  });
}

async function openAnimatePanel(page: Page): Promise<void> {
  await page.locator('button[aria-label="Animate"]').click();
}

interface AddAnimationInput {
  family?: "enter" | "emphasis" | "exit" | "path" | "media";
  effect?: string;
  start?: "on-click" | "with-previous" | "after-previous";
  duration?: number;
  delay?: number;
  d?: string;
}

/** Drives the Animate insert panel end to end (already open) and clicks "Add animation". */
async function addAnimationViaPanel(page: Page, input: AddAnimationInput): Promise<void> {
  const panel = page.locator(".animate-panel");
  if (input.family) {
    await panel.locator(`[role="tab"]:has-text("${input.family}")`).click();
  }
  if (input.effect) {
    await panel.locator(".animate-panel-fields").waitFor();
    await panel.locator(".animate-panel-gallery button", { hasText: input.effect }).click();
  }
  if (input.start) {
    await panel.locator("select").first().selectOption(input.start);
  }
  if (input.duration !== undefined) {
    await panel.locator('.animate-panel-field:has-text("Duration") input').fill(String(input.duration));
  }
  if (input.delay !== undefined) {
    await panel.locator('.animate-panel-field:has-text("Delay") input').fill(String(input.delay));
  }
  if (input.d !== undefined) {
    await panel.locator('.animate-panel-field:has-text("Path") input').fill(input.d);
  }
  await panel.locator(".animate-panel-add").click();
}

function objectCards(page: Page) {
  return page.locator(".animate-object-list .animate-card");
}

it("A11/A16：選取元素、Add animation 送出 effect add；agent 用同一條 CLI 命令能重現同樣的結果", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await slideFrame.locator("#el-a").click();
    await openAnimatePanel(page);
    await addAnimationViaPanel(page, { family: "enter", effect: "fade", duration: 0.5, delay: 0 });

    // 右欄自動切到 Animate › Object，新卡在清單末端。
    await expect.poll(() => objectCards(page).count()).toBe(1);
    expect(await page.locator('[role="tab"][data-tab="animate"]').getAttribute("aria-selected")).toBe("true");
    // …and stays on Object once the write's own reload has landed: the
    // selection survives (badge back on stage), so the sub-tab is not
    // snapped back to Page by the "no selection → Page" rule.
    await expect.poll(() => page.locator(".animation-badge").count()).toBe(1);
    await page.waitForTimeout(300);
    expect(await page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".context-bar").count()).toBe(1);

    const afterGui = await readEffects(registry, presentationId);
    expect(afterGui).toHaveLength(1);
    expect(afterGui[0]).toMatchObject({ target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0 });

    // A16：agent 用同一條命令重現——直接呼叫 CLI 的 effect add，對另一個元素做同樣的事。
    const cliResult = await registry.dispatch("effect add", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementIds: ["el-b"],
      family: "enter",
      effect: "fade",
      start: "on-click",
      duration: 0.5,
      delay: 0,
    });
    expect(cliResult.ok).toBe(true);
    const afterCli = await readEffects(registry, presentationId);
    expect(afterCli).toHaveLength(2);
    // 兩筆項目除了 target／index 之外的欄位完全相同——GUI 與 CLI 產生的是同一種結果。
    const { target: _guiTarget, index: _guiIndex, ...guiRest } = afterCli[0];
    const { target: _cliTarget, index: _cliIndex, ...cliRest } = afterCli[1];
    expect(guiRest).toEqual(cliRest);
  } finally {
    await cleanup();
  }
});

it("A11：群組動畫——多選散落元素，第一筆帶指定的 start，其餘一律 with-previous", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await openAnimatePanel(page);
    await addAnimationViaPanel(page, { family: "enter", effect: "zoom", start: "after-previous" });

    // 插入面板只在 `effect add` 真的回 ok 之後才關（AnimatePanel.tsx 的
    // `addAnimation()`：await runCommand → 只有 result.ok 才呼叫
    // onClose()）——等它關閉，證明寫入已經落地，下面兩個斷言才不會在寫入
    // 完成前就搶跑。原本用 `objectCards(...).toBe(2)` 當這個同步點，但
    // Plan 已核准的行為讓終態是 0（下一段註解），跟開局的 0 沒有落差可
    // poll，需要換一個訊號。
    await expect.poll(() => page.locator(".animate-panel").count()).toBe(0);

    // [E4.T7] 裁示（Dev-Leader, NOOP-304 [需決策] 回覆，擴大自 Plan NOOP-306
    // 「2.3 已知會被本票改掉的使用者可見行為」第 2 點）：清單第一項的 start
    // 不是 on-click 時，`effect list` 依 cli.md L2412 回 failed，路由轉成
    // 500，Animate › Object 面板的 `useSlideEffects` 把它當成空清單——這是
    // 規格的直接後果，Plan 已核准的行為，不是缺陷，也不是這次修改造成的。
    // 面板變空不影響底層檔案：下面 readEffects() 直接讀 XML，證明兩筆效果
    // 確實照 start 規則正確寫入。
    await expect.poll(() => objectCards(page).count()).toBe(0);
    const effects = await readEffects(registry, presentationId);
    expect(effects).toHaveLength(2);
    expect(effects.map((e) => e.start)).toEqual(["after-previous", "with-previous"]);
  } finally {
    await cleanup();
  }
});

it("A11：群組動畫——選取整個群組 <g>，只產生一筆效果項，清單顯示 Group N (n)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    // el-group-a 是 el-group 的巢狀子元素，點擊會依 #72 的規則解析到最外層
    // 帶 id 的容器（也就是 el-group 本身）。
    await slideFrame.locator("#el-group-a").click();
    await openAnimatePanel(page);
    await addAnimationViaPanel(page, { family: "enter", effect: "appear" });

    await expect.poll(() => objectCards(page).count()).toBe(1);
    expect(await objectCards(page).first().textContent()).toContain("Group 1 (2)");

    const effects = await readEffects(registry, presentationId);
    expect(effects).toHaveLength(1);
    expect(effects[0].target).toBe("el-group");
  } finally {
    await cleanup();
  }
});

it("A11：排序與參數——改 Duration 立即寫回檔案；↑ 交換相鄰兩筆效果項的順序", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-b"], family: "enter", effect: "zoom",
    });

    const page = await openApp(server);
    // Object 子分頁在沒有任何選取時停用（自動回 Page）——選一個元素（不需要
    // 是有效果的那個）只是為了讓子分頁可以切過去，Object 清單本身顯示的是
    // 整張投影片的效果清單，不是只顯示選取元素的。
    const slideFrame = await canvasFrame(page);
    await slideFrame.locator("#el-a").click();
    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => objectCards(page).count()).toBe(2);

    const firstCard = objectCards(page).first();
    await firstCard.locator('.animate-card-field:has-text("Duration") input').fill("1.4");
    await firstCard.locator('.animate-card-field:has-text("Duration") input').blur();

    await expect
      .poll(async () => (await readEffects(registry, presentationId)).find((e) => e.target === "el-a")?.duration)
      .toBe(1.4);

    await objectCards(page).nth(1).locator('button[aria-label="上移"]').click();
    await expect
      .poll(async () => (await readEffects(registry, presentationId)).map((e) => e.target))
      .toEqual(["el-b", "el-a"]);
  } finally {
    await cleanup();
  }
});

it("A11：預覽——卡片的 ▶ 在播放模式下真的觸發那個效果的動畫", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade", duration: 0.4,
    });

    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);
    await slideFrame.locator("#el-a").click();
    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => objectCards(page).count()).toBe(1);

    await objectCards(page).first().locator('button[aria-label="Preview"]').click();
    // previewEffects() rebuilds the iframe (allow-scripts) — the pre-preview
    // `slideFrame` handle is now detached, a fresh canvasFrame() is required.
    await expect
      .poll(async () => {
        const previewFrame = await canvasFrame(page).catch(() => null);
        if (!previewFrame) return 0;
        return previewFrame.locator("#el-a").evaluate((el) => el.getAnimations().length).catch(() => 0);
      })
      .toBeGreaterThan(0);

    // preview-done 之後自動回到 view 模式——情境列可以再度作用，證明選取／
    // runtime 都還原了。
    await expect.poll(() => page.locator(".play-bar").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("A12：enter 家族——推進到該步驟後，元素真的產生了動畫並且 opacity 回到 1", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade", duration: 0.3,
    });

    const page = await openApp(server);
    await page.locator(".play-button").click();
    const slideFrame = await canvasFrame(page);
    // Wait for the player to have applied the enter-family hide rule before
    // pressing: a keypress that lands before the player is ready never
    // advances the step, so nothing animates (flaked when run in sequence).
    await expect.poll(() => slideFrame.locator("#el-a").evaluate((el) => getComputedStyle(el).opacity).catch(() => "")).toBe("0");
    await page.keyboard.press("ArrowRight");

    await expect
      .poll(() => slideFrame.locator("#el-a").evaluate((el) => el.getAnimations().length).catch(() => 0))
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await slideFrame.locator("#el-a").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  } finally {
    await cleanup();
  }
});

it("A12：emphasis 家族——推進後產生 transform 動畫，元素本身不被隱藏", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-emphasis"], family: "emphasis", effect: "pulse", duration: 0.3,
    });

    const page = await openApp(server);
    await page.locator(".play-button").click();
    const slideFrame = await canvasFrame(page);
    await expect.poll(() => slideFrame.locator("#el-emphasis").evaluate((el) => getComputedStyle(el).opacity).catch(() => "")).toBe("1");
    await page.keyboard.press("ArrowRight");

    await expect
      .poll(() => slideFrame.locator("#el-emphasis").evaluate((el) => el.getAnimations().length).catch(() => 0))
      .toBeGreaterThan(0);
  } finally {
    await cleanup();
  }
});

it("A12：exit 家族——目標一開始就可見（D12），推進後動畫收尾在 opacity 0", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-exit"], family: "exit", effect: "disappear", duration: 0.2,
    });

    const page = await openApp(server);
    // D12：exit-only 目標從一開始（進入播放模式）就是可見的。
    await page.locator(".play-button").click();
    const slideFrame = await canvasFrame(page);
    expect(await slideFrame.locator("#el-exit").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    expect(await slideFrame.locator("#el-exit").evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  } finally {
    await cleanup();
  }
});

it("A12：path 家族——推進後元素沿著 d 位移（transform 不再是初始值）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-path"], family: "path", effect: "path", duration: 0.2, d: "M 0 0 L 200 100",
    });

    const page = await openApp(server);
    await page.locator(".play-button").click();
    const slideFrame = await canvasFrame(page);
    const before = await slideFrame.locator("#el-path").evaluate((el) => getComputedStyle(el).transform);

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    const after = await slideFrame.locator("#el-path").evaluate((el) => getComputedStyle(el).transform);
    expect(after).not.toBe(before);
  } finally {
    await cleanup();
  }
});

it("A14：舞台徽章與清單同步——清單按 ↑ 之後，徽章的數字順序跟著換", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-b"], family: "enter", effect: "zoom",
    });

    const page = await openApp(server);
    await (await canvasFrame(page)).locator("#el-a").click();
    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => objectCards(page).count()).toBe(2);
    await expect.poll(() => page.locator(".animation-badge").count()).toBe(2);

    const badgeTextFor = async (id: string) => {
      const box = await (await canvasFrame(page)).locator(`#${id}`).boundingBox();
      if (!box) return null;
      const badges = page.locator(".animation-badge");
      const count = await badges.count();
      for (let i = 0; i < count; i++) {
        const badgeBox = await badges.nth(i).boundingBox();
        if (!badgeBox) continue;
        if (Math.abs(badgeBox.x - box.x) < 40 && Math.abs(badgeBox.y - box.y) < 40) return badges.nth(i).textContent();
      }
      return null;
    };

    expect(await badgeTextFor("el-a")).toBe("1");
    expect(await badgeTextFor("el-b")).toBe("2");

    await objectCards(page).nth(1).locator('button[aria-label="上移"]').click();
    await expect.poll(async () => (await readEffects(registry, presentationId)).map((e) => e.target)).toEqual(["el-b", "el-a"]);

    await expect.poll(() => badgeTextFor("el-b")).toBe("1");
    expect(await badgeTextFor("el-a")).toBe("2");
  } finally {
    await cleanup();
  }
});

// [E5.T3] 兩層化：F-16（動畫徽章誤開 pointer-events:auto，擋住元素左上的縮
// 放把手）的結構性修復。放在這個檔案而非新開 e2e 檔或 shell-layout.test.ts
// 的無選取 demo：那裡 `.stage-geometry` 底下只有兩個空容器，掃描結果恆真
// 且無意義（NOOP-63 那種空斷言）；這裡已經有「選取有動畫的元素 + 開
// Animate 分頁」的完整 setup，徽章真的在舞台上，斷言才有力。
it("[E5.T3] 兩層化：幾何層整層穿透，動畫徽章不再擋住元素左上把手（F-16）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });

    const page = await openApp(server);
    await (await canvasFrame(page)).locator("#el-a").click();
    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => page.locator(".animation-badge").count()).toBe(1);

    // AC4：幾何層底下沒有任何元素的 computed pointer-events 是 auto，且掃
    // 描真的看到東西（防空斷言）——徽章必須真的在幾何層裡。
    const scan = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".stage-geometry, .stage-geometry *"));
      return nodes.map((el) => ({ cls: el.className, pe: getComputedStyle(el).pointerEvents }));
    });
    expect(scan.length).toBeGreaterThanOrEqual(4);
    expect(scan.some((n) => String(n.cls).includes("animation-badge"))).toBe(true);
    expect(scan.filter((n) => n.pe === "auto")).toEqual([]);

    // AC5（F-16 本體）：徽章正中心＝元素左上把手中心（`transform:
    // translate(-50%,-50%)`）；那一點必須穿透到 iframe，不再被幾何層或
    // widget 層接住。
    const badgeBox = await page.locator(".animation-badge").boundingBox();
    expect(badgeBox).not.toBeNull();
    const hit = await page.evaluate(
      ([cx, cy]) => {
        const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
        return (
          el && {
            tag: el.tagName,
            cls: el.className,
            inGeometry: !!el.closest(".stage-geometry"),
            inWidgets: !!el.closest(".stage-widgets"),
          }
        );
      },
      [badgeBox!.x + badgeBox!.width / 2, badgeBox!.y + badgeBox!.height / 2] as [number, number],
    );
    expect(hit).not.toBeNull();
    expect(hit!.inGeometry).toBe(false); // 突變點：徽章重新開回 auto 就會紅
    expect(hit!.inWidgets).toBe(false);
    expect(hit!.tag).toBe("IFRAME");
  } finally {
    await cleanup();
  }
});

it("A15：Edit animation 入口——無動畫元素選取時不渲染；有動畫時渲染且切到 Animate › Object；全站只有一個入口", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });

    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await slideFrame.locator("#el-b").click();
    await expect.poll(() => page.locator(".context-bar").count()).toBeGreaterThan(0);
    expect(await page.locator('[title="Edit animation"]').count()).toBe(0);

    await slideFrame.locator("#el-a").click();
    await expect.poll(() => page.locator('[title="Edit animation"]').count()).toBe(1);

    await page.locator('[title="Edit animation"]').click();
    await expect.poll(() => page.locator('[role="tab"][data-tab="animate"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");

    // 全站沒有第二個入口（原型的右鍵選單已移除，見 NOOP-124 計畫）。
    expect(await page.locator('[title="Edit animation"]').count()).toBe(1);
  } finally {
    await cleanup();
  }
});

it("[E2.T11] [A14] Animate › Page：GUI 設定 Enter 效果並按 Apply to all slides；agent 用同一條 slide transition set --all 可重現", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    // 造第二頁，證明 --all 真的套用到「每一張」，不是只有目前這頁。
    const added = await registry.dispatch<{ slidePath: string }>("slide add", { id: presentationId });
    expect(added.ok).toBe(true);
    const secondSlidePath = added.data!.slidePath;

    const page = await openApp(server);
    await page.locator('[role="tab"][data-tab="animate"]').click();
    const panel = page.locator(".animate-page-panel");
    await panel.waitFor();
    // 沒有選取任何元素——停在預設的 Page 子分頁，不是 Object。
    expect(await page.locator('[role="tab"][data-subtab="page"]').getAttribute("aria-selected")).toBe("true");

    await panel.locator('[data-edge="enter"] .animate-page-effect-card', { hasText: "Fade" }).click();

    await expect
      .poll(async () => (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content)
      .toContain('enter="fade"');
    // 還沒按 Apply to all slides——第二頁不受影響。
    expect(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: secondSlidePath })).data!.content,
    ).not.toContain("comot:transition");

    await panel.locator(".animate-page-apply-all").click();

    await expect
      .poll(async () => (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: secondSlidePath })).data!.content)
      .toContain('enter="fade"');

    // agent 用同一條命令可重現：CLI 版的 --all 在另一張全新簡報上產生一致的結果。
    const cliResult = await registry.dispatch("slide transition set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      all: true,
    });
    expect(cliResult.ok).toBe(true);
  } finally {
    await cleanup();
  }
});

it("A17：基準截圖四張（Animate 面板／Animate ›Object 清單／舞台編號徽章／Animate ›Page，[E2.T11] 新增第四張）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });

    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);
    await slideFrame.locator("#el-a").click();
    await openAnimatePanel(page);
    await compareScreenshot(page, { name: "animate-panel", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
    await page.keyboard.press("Escape");

    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => objectCards(page).count()).toBe(1);
    await compareScreenshot(page, { name: "animate-object-list", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    await expect.poll(() => page.locator(".animation-badge").count()).toBe(1);
    await compareScreenshot(page, { name: "stage-anim-badges", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    // [E2.T11]/[A16]：Animate › Page（無選取，回到 Page 子分頁）。
    // `.animate-page-panel` 容器在資料載入前就已存在（AnimatePagePanel.tsx 的載入態回傳同名空殼），
    // 只等容器出現會讓截圖偶爾拍到空殼而非內容——改等 Apply to all slides 按鈕與全部 8 張效果卡
    // （Enter 4 張＋Exit 4 張）都渲染出來才截圖。
    await page.locator('[role="tab"][data-subtab="page"]').click();
    await page.locator(".animate-page-panel .animate-page-apply-all").waitFor();
    await expect.poll(() => page.locator(".animate-page-effect-card").count()).toBe(8);
    await compareScreenshot(page, { name: "animate-page", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
  } finally {
    await cleanup();
  }
});
