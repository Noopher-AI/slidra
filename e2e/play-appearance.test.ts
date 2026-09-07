import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * 播放模式外觀 (issue #54): pure black full-bleed stage, the floating
 * control bar (上一步/下一步/頁碼/全螢幕/離開播放), the idle-hide of both
 * cursor and control bar together, and the survival of the three floating
 * notices through that idle-hide. `demo/` is used for the control-bar/
 * idle/screenshot tests (no effect list to fight the paging assertions);
 * `fixtures/broken-effects-deck/` is reused from
 * e2e/player-effect-error.test.ts for the one test that needs a real
 * `.player-error-notice` on screen.
 *
 * Viewport fixed at 1440×900, same as e2e/appearance.test.ts and
 * docs/design/base-shell.html's own static frame ("樣板永遠以 1440×900 的
 * 視窗呈現").
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const playDeckDir = path.join(e2eDir, "fixtures/play-deck");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/play");

const VIEWPORT = { width: 1440, height: 900 };

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

async function startServerFor(
  deckDir: string,
  prefix: string,
): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-home-`));
  const comotDir = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-files-`));
  process.env["CO_MOTION_HOME"] = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, `${prefix}.comot`);
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
    cleanup: async () => {
      await server.close();
      delete process.env["CO_MOTION_HOME"];
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(deckDir: string, prefix: string): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const { server, cleanup } = await startServerFor(deckDir, prefix);
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => document.fonts.ready);

  return { page, cleanup };
}

/**
 * Same wait as e2e/player-media.test.ts's own waitForPlayerFocus: the
 * play iframe is torn down and rebuilt with `allow-scripts` on entering
 * play, and a click/keypress fired before the fresh runtime posts "ready"
 * has no listener to reach.
 */
async function enterPlay(page: Page): Promise<void> {
  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
}

it("控制列的上一步／下一步換的是投影片本身，不是效果清單的步驟（裁決 3）", async () => {
  // 對照表發現（gate round 1 追加要求）：demo/ 的四頁都沒有效果清單，
  // 「下一步換的是投影片、不是效果步驟」這句名字，用一個沒有任何效果
  // 步驟可以推進的 deck 是測不出來的——就算控制列誤接成逐步推進
  // player-runtime 的效果步驟，demo/ 上量出來的行為也會跟接
  // controller.next() 一模一樣，測試會在錯的實作下照樣綠燈。改用
  // fixtures/play-deck/（player-mode.test.ts 已驗證過的 fixture）：
  // 第 1 頁有兩個 enter 效果步驟（fadeText/appearText）要按兩次方向鍵
  // 才會套用完、第三次才換頁；控制列的「下一步」只按一次就要直接跳到
  // 第 2 頁，兩個效果步驟完全沒被套用——這才是「換頁不換效果步驟」
  // 這句話量得出來的形狀。
  const { page, cleanup } = await openApp(playDeckDir, "play-appearance-nav");
  try {
    await enterPlay(page);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeOpacity = () =>
      playFrame().locator("#el-fade-in").evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
    const titleText = () => playFrame().locator("#el-title").textContent().catch(() => null);
    const title2Text = () => playFrame().locator("#el-title2").textContent().catch(() => null);

    await expect.poll(titleText, { timeout: 30_000 }).toBe("播放第一頁");
    // 進場時兩個 enter 元素都還沒套用（同 player-mode.test.ts 的既有驗證）。
    await expect.poll(fadeOpacity).toBe("0");

    // 按一次「下一步」：若真的是 controller.next()（showSlide(+1)），
    // 會直接跳到第 2 頁，完全跳過第 1 頁剩下的兩個效果步驟。
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect.poll(title2Text, { timeout: 30_000 }).toBe("播放第二頁");
    // 沒有按過方向鍵、也沒有經過任何「套用中」的中間態——第 1 頁的
    // fade-in 元素本來就已經跟著整份文件一起被換掉了（play iframe 換頁
    // 是整份 srcdoc 重新指派，不是同文件內局部更新，見 canvas.ts）。

    // 按一次「上一步」：換回第 1 頁，頁碼與 disabled 同步（樣板的
    // `N / M` 形式；play-deck 只有 2 頁）。
    await page.locator('.play-bar button[aria-label="上一步"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).toBe("播放第一頁");
    expect(await page.locator(".play-bar-position").textContent()).toBe("1 / 2");
    expect(await page.locator('.play-bar button[aria-label="上一步"]').isDisabled()).toBe(true);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("[A15] 控制列子節點順序與樣板一致（上一步／頁碼／下一步／分隔線／全螢幕／離開播放），且底部置中", async () => {
  // gate round 2 (2026-08-25), medium finding：全螢幕/離開播放這兩顆一度
  // 順序反了（樣板是「全螢幕、離開播放」），而現有 e2e 對 `.play-bar` 的
  // 每一個選擇器都是 aria-label 或 class（見這個檔案與
  // player-effect-error.test.ts/player-media.test.ts 裡所有
  // `.play-bar ...` 用法），沒有任何一條在守子節點的實際順序——這正是
  // 這個偏差能一路走到 round 2 才被抓到的原因。這裡直接讀
  // `.play-bar` 的 DOM children、依序轉成可辨識的名字，跟樣板
  // （base-shell.html:419-426，波指揮官在 1440×900 用 Playwright 量過的
  // 順序）逐一比對，把順序變成一個真的被斷言守住的契約，而不是只靠人眼
  // 讀 JSX。[E2.T11] §4.8 把 pos 從「上/下之後」移到「上一步與下一步之間」
  // （原型的實際順序），並把控制列從左下移到底部置中——一併補上水平置中的
  // 幾何斷言，這兩者都是本票才第一次被守住的契約。
  const { page, cleanup } = await openApp(demoDir, "play-appearance-order");
  try {
    await enterPlay(page);

    const order = await page.locator(".play-bar").evaluate((el) =>
      Array.from(el.children).map((child) => {
        if (child.classList.contains("play-bar-position")) return "pos";
        if (child.classList.contains("play-bar-divider")) return "divider";
        const ariaLabel = child.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
        return child.textContent?.trim() ?? child.tagName;
      }),
    );
    expect(order).toEqual(["上一步", "pos", "下一步", "divider", "全螢幕", "離開播放"]);

    const barBox = await page.locator(".play-bar").boundingBox();
    const canvasAreaBox = await page.locator(".canvas-area").boundingBox();
    expect(barBox).not.toBeNull();
    expect(canvasAreaBox).not.toBeNull();
    const barCenterX = barBox!.x + barBox!.width / 2;
    const canvasCenterX = canvasAreaBox!.x + canvasAreaBox!.width / 2;
    expect(Math.abs(barCenterX - canvasCenterX)).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("閒置 2.5 秒後游標與控制列一起隱去，在投影片區域內移動滑鼠也能同時再現", async () => {
  // gate round 1 (2026-08-25), high finding：投影片 iframe 佔了播放畫面
  // 絕大部分面積，是作者最自然會把滑鼠移過去的地方。這裡原本的版本繞去
  // 控制列旁邊的窄邊（`page.mouse.move(60, 850)`），繞開了「跨 frame 邊界
  // 的 mousemove 不會冒泡到上層文件」這個限制，而不是回報它——測項名字
  // 說「滑鼠一動」，斷言卻只驗過一小塊安全地帶。這一版把「投影片區域內」
  // 設為主要路徑，原本的「投影片外」保留在最後當對照組。
  const { page, cleanup } = await openApp(demoDir, "play-appearance-idle");
  try {
    await enterPlay(page);

    const app = page.locator(".app");
    const bar = page.locator(".play-bar");
    const opacityOf = (locator: typeof bar) => locator.evaluate((el) => getComputedStyle(el).opacity);
    const cursorOf = () => app.evaluate((el) => getComputedStyle(el).cursor);

    const iframeBox = await page.locator("iframe.slide-frame").boundingBox();
    if (!iframeBox) throw new Error("找不到播放 iframe 的 bounding box");
    // 量測寫進報告：1440×900 視窗下量到的 iframe 尺寸（gate 指揮官的量測
    // 是 1415.11×795.98，這裡各次執行會有次像素差異，數量級一致即可）。
    console.log(`iframe box: ${JSON.stringify(iframeBox)}`);
    const iframeCenter = { x: iframeBox.x + iframeBox.width / 2, y: iframeBox.y + iframeBox.height / 2 };

    // 剛進入播放：控制列可見，游標正常。
    await expect.poll(() => opacityOf(bar)).toBe("1");
    expect(await cursorOf()).toBe("default");

    // 閒置超過 2.5 秒：兩者一起隱去。
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("0");
    expect(await cursorOf()).toBe("none");

    // 主要路徑：在投影片區域「內」移動滑鼠。`.play-mousemove-catcher`
    // （PlayChrome/play.css）鋪在 iframe 之上、接住這次 mousemove，讓它
    // 冒泡到上層文件，而不是被瀏覽器直接派送進 iframe 自己的文件裡。
    await page.mouse.move(iframeCenter.x, iframeCenter.y);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("1");
    expect(await cursorOf()).toBe("default");

    // 量測委任的取捨：停留在投影片區域內持續移動（不是移出去一次就不再
    // 動），確認閒置計時器真的每次都被重置、控制列不會在還沒滿 2.5 秒時
    // 自己先閃一次熄滅——這是覆蓋層是否把「每一次」mousemove 都冒泡出去
    // 的直接證據，不是只驗第一次。三次、每次間隔 1.2 秒（< 2.5 秒的閒置
    // 門檻），全部應維持 opacity "1"，不曾中途變回 "0"。
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1200);
      await page.mouse.move(iframeCenter.x + i + 1, iframeCenter.y);
      expect(await opacityOf(bar)).toBe("1");
    }

    // 對照組：移到控制列附近、明確在投影片 iframe 之外——上層文件本身的
    // mousemove 本來就會冒泡到 document，這條路徑從一開始就成立，保留
    // 下來證明覆蓋層沒有意外擋掉這條原本就通的路。
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("0");
    await page.mouse.move(60, 850);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("1");
    expect(await cursorOf()).toBe("default");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("投影片區域的點擊仍會把焦點交回播放器（覆蓋層攔截 click 後的補償）", async () => {
  // gate round 1 的量測沒有明講、但改動本身引出的問題：覆蓋層
  // pointer-events:auto 會攔下投影片區域的 click，原生的「點 iframe 給它
  // 瀏覽器焦點」因此不再發生。PlayChrome 用 controller.focusPlayer()
  // 補回——這裡驗證補償真的成立，不只是讀程式碼相信它成立。
  // [E2.T11] §4.8：這個覆蓋層的 onClick 現在「多做一件事」——除了
  // focusPlayer() 之外還會 stepPlayer("advance")（原型的「點畫面前進」）。
  // 不影響這條測項本身在驗的焦點回收，下一個人如果看到這裡的簡報也跟著
  // 前進了一步，那是新行為，不是回歸。
  const { page, cleanup } = await openApp(demoDir, "play-appearance-focus-click");
  try {
    await enterPlay(page);

    // 偷走焦點（沿用 e2e/player-fullscreen.test.ts 已驗證過的做法）。
    const playBar = page.locator(".play-bar");
    await page.locator('button:has-text("離開播放")').focus();
    await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("false");

    // 在投影片區域中央點一下——這個座標落在 .play-mousemove-catcher 上，
    // 不是原生落進 iframe 的點擊。
    const box = await page.locator(".canvas-area").boundingBox();
    if (!box) throw new Error("找不到 .canvas-area 的 bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("兩種浮動通知（播放錯誤／全螢幕錯誤）並列可見、不互相覆蓋，且在控制列隱去後依然顯示", async () => {
  const { page, cleanup } = await openApp(brokenEffectsDeckDir, "play-appearance-notices");
  try {
    await page.locator('.play-button').click();

    // 播放錯誤：這份 deck 第 1 頁的效果清單解析必定失敗（見
    // e2e/player-effect-error.test.ts）。canvas.ts 的解析失敗路徑（見
    // renderPlay 的 catch 分支）把 srcdoc 換成沒有 player-runtime 的靜態
    // 版本，所以這一頁永遠不會送出 "ready"。
    //
    // #68 撤掉焦點提示之後，這裡只剩兩種通知。焦點提示原本會跟著這次失敗
    // 一起成立（playerHasFocus 停在 false），但它從來不是這個測項要證明的
    // 事——要證明的是「通知不隨控制列一起隱去」，兩種通知同樣證得。
    const errorNotice = page.locator(".player-error-notice", { hasText: "效果清單" });
    await expect.poll(() => errorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await page.locator(".player-focus-notice").count()).toBe(0);

    // 全螢幕錯誤：沿用 e2e/player-fullscreen.test.ts 已驗證過的做法——用
    // 一個一定會拒絕的 requestFullscreen 替身製造真實的錯誤（不是假造
    // 成功又謊報失敗），再按下全螢幕鈕。
    await page.evaluate(() => {
      const container = document.querySelector(".canvas-area") as HTMLElement;
      container.requestFullscreen = () => Promise.reject(new Error("模擬測試：全螢幕請求被拒絕"));
    });
    await page.locator(".play-bar .fullscreen-toggle-button").click();
    const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
    await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // 兩則通知不互相覆蓋（review gate round 1, P2 的反面證據）：先前兩者
    // 用同一組 position:absolute 疊在同一個位置，後渲染的會蓋住先渲染的，
    // 而 isVisible() 仍會回報 true（Playwright 的可見性判斷不看 z-order），
    // 所以要量真實座標矩形是否相交。
    //
    // 這條量測原本在 e2e/player-fullscreen.test.ts，用「焦點提示 ＋ 全螢幕
    // 錯誤」這一組，因為那裡的 fixture 造不出播放錯誤。那一組只共存約 100
    // 毫秒（焦點一交回去提示就卸載），得靠頁面內逐幀取樣才量得準（issue
    // #43）。#68 撤掉焦點提示後，量測搬到這裡——這份 broken deck 讓兩則
    // 通知穩定共存，不再有會關上的窗口，兩次 boundingBox() 讀取之間沒有
    // 任何東西會卸載，所以逐幀取樣連同它防的那個 race 一起不需要了。
    const errorBox = await errorNotice.first().boundingBox();
    const fullscreenBox = await fullscreenErrorNotice.first().boundingBox();
    if (!errorBox || !fullscreenBox) throw new Error("兩則通知都要有實際大小才量得到重疊");
    const overlaps =
      errorBox.x < fullscreenBox.x + fullscreenBox.width &&
      errorBox.x + errorBox.width > fullscreenBox.x &&
      errorBox.y < fullscreenBox.y + fullscreenBox.height &&
      errorBox.y + errorBox.height > fullscreenBox.y;
    expect(overlaps).toBe(false);

    const opacityOf = (locator: ReturnType<Page["locator"]>) =>
      locator.first().evaluate((el) => getComputedStyle(el).opacity);

    // 通知本身不在 .play-bar 裡，閒置隱藏規則只作用在 .play-bar，所以兩
    // 種通知在控制列隱去後仍應可見——它們是錯誤，不是 chrome。這裡不再動
    // 滑鼠（上面的 evaluate()/click() 已經是最後的互動），單純等待閒置。
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(page.locator(".play-bar")), { timeout: 5_000 }).toBe("0");
    expect(await opacityOf(errorNotice)).toBe("1");
    expect(await opacityOf(fullscreenErrorNotice)).toBe("1");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("播放模式下，功能區、縮圖軌、對話、備忘稿、狀態列都不在 DOM 裡", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-dom");
  try {
    // 進入播放前：這些元素都在（標準檢視的既有外殼）。DOM count，不是
    // 可見性——#54 明文要求「不在 DOM 裡」，`display:none`／`opacity:0`
    // 都不算數，只有 querySelector/count 為 0 才算數。
    expect(await page.locator(".titlebar").count()).toBe(1);
    expect(await page.locator(".dock").count()).toBe(1);
    expect(await page.locator(".overview").count()).toBe(1);
    expect(await page.locator(".overview-list").count()).toBe(1);
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
    expect(await page.locator(".notes").count()).toBe(1);
    expect(await page.locator(".status-bar").count()).toBe(1);

    await enterPlay(page);

    expect(await page.locator(".titlebar").count()).toBe(0);
    expect(await page.locator(".dock").count()).toBe(0);
    expect(await page.locator(".overview").count()).toBe(0);
    expect(await page.locator(".overview-list").count()).toBe(0);
    expect(await page.locator(".chat-sidebar").count()).toBe(0);
    expect(await page.locator(".notes").count()).toBe(0);
    expect(await page.locator(".status-bar").count()).toBe(0);

    // 背景純黑，投影片置中且完整可見 (AC1/AC2)：舞台底本身即 #000
    // （styles/play.css 既有的 `.canvas` 規則），這裡量測整個播放黑幕
    // 容器 `.canvas-area` 的背景色，確認不是殘留的舞台底表面色。
    const bg = await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(0, 0, 0)");

    // gate round 1 (2026-08-25), medium finding：`.notes` 已離開 DOM
    // （上面已驗），但 `.main` 的第二條軌道（shell.css 的
    // `grid-template-rows: 1fr var(--h-notes)`）原本就算沒有 `<Notes>`
    // 也仍然佔位，留下一條透明、透出 `.app` 背景色（`--s-well`，不是黑）
    // 的窄條。量測方式沿用指揮官自己的做法：`.canvas-area` 高度應等於
    // `.body` 高度（收合成功就不會再矮一截），且視窗底部中央那一點的
    // 實際繪製顏色應該是黑色——不是只信 `.canvas-area` 自己的
    // background，因為那條規則填不到被 `.main` 軌道多留出來的空間。
    const bodyHeight = await page.locator(".body").evaluate((el) => el.getBoundingClientRect().height);
    const canvasAreaHeight = await page.locator(".canvas-area").evaluate((el) => el.getBoundingClientRect().height);
    expect(canvasAreaHeight).toBe(bodyHeight);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("找不到 viewport 尺寸");
    // 用 elementsFromPoint（複數版）取整疊、由上而下找第一個非透明背景：
    // 這個點最上層是 .play-mousemove-catcher（gate round 1 高風險項的
    // 修復，本身透明、沒有自己的背景色），單看 elementFromPoint 抓到的
    // 那一個元素會誤判成「透明」，量不出玻璃底下真正的顏色。人眼在這個
    // 點看到的其實是透明覆蓋層底下、真正不透明的那一層——這裡照著相同
    // 邏輯往下找。
    const bottomCenterColor = await page.evaluate(
      ([x, y]) => {
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        }
        return null;
      },
      [viewport.width / 2, viewport.height - 1] as const,
    );
    expect(bottomCenterColor).toBe("rgb(0, 0, 0)");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("離開播放模式後，總覽縮圖軌重新掛載且可點擊換頁（overview 模組存活證明）", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-overview-survival");
  try {
    // 進入播放，再離開——`<Rail>` 卸載又重掛載一次。
    await enterPlay(page);
    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".play-button").count(), { timeout: 10_000 }).toBe(1);

    // 只數元素不足以證明模組還活著（見波簡報的「陷阱」一節）：必須點
    // 一下縮圖，實際觀察投影片真的換了。
    const thumbnails = page.locator(".overview-thumb");
    await expect.poll(() => thumbnails.count(), { timeout: 10_000 }).toBe(4);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const titleText = () => playFrame().locator("svg text").first().textContent().catch(() => null);
    const firstSlideText = await titleText();

    await page.locator('button[aria-label="Slide 2"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).not.toBe(firstSlideText);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("基準截圖：控制列浮現態", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-shot-awake");
  try {
    await enterPlay(page);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "play-awake", baselineDir });
  } finally {
    await page.close();
    await cleanup();
  }
});

it("基準截圖：控制列隱藏態", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-shot-asleep");
  try {
    await enterPlay(page);
    await page.waitForTimeout(2800);
    await expect
      .poll(() => page.locator(".play-bar").evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 })
      .toBe("0");
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "play-asleep", baselineDir });
  } finally {
    await page.close();
    await cleanup();
  }
});

it("沒有背景矩形的投影片（`new` 產生的空白頁），播放模式仍畫出不透明白底而非一片黑（#120）", async () => {
  // `.canvas`（play.css，data-mode="play"）的 #000 黑幕是進場前/載入前的
  // 佔位色，本該被投影片文件蓋掉。但 `co-motion new` 的空白頁沒有背景矩形
  // （packages/core/src/presentation.ts's buildMinimalPresentation），播放
  // 模式走的是 renderPlay() 的正常路徑（canvas.ts's wrapPlayDocument），不
  // 是票面文字點名的 wrapSlideDocument——這裡直接量播放中 iframe 自己的
  // html/body 背景，量的是實際播放路徑用到的那個 wrap 函式，不是名字對得
  // 上但實際沒被這條路徑呼叫到的那個。
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-play-nobg-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-play-nobg-files-"));
  process.env["CO_MOTION_HOME"] = coMotionHome;
  try {
    const registry: CommandRegistry = createDefaultRegistry();
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath, name: "無背景播放測試" });
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
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(server.url);

      const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
      await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

      await enterPlay(page);

      const playBody = page.frameLocator("iframe.slide-frame").locator("body");
      const bodyBackground = await playBody.evaluate((el) => getComputedStyle(el).backgroundColor);
      // 規格拍板的字面值（票內「不透明白底」）：不是從實作反推的快照。只量
      // body——wrapPlayDocument()（canvas.ts）刻意只在 body 上蓋白底，沒有
      // 額外對 html 設定；body 沒填滿的部分本來就會由瀏覽器的 canvas
      // background propagation 規則沿用 body 的顏色，html 自己維持初始的
      // 透明值是正常、預期的行為，不是缺陷。
      expect(bodyBackground).toBe("rgb(255, 255, 255)");

      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    delete process.env["CO_MOTION_HOME"];
    await rm(coMotionHome, { recursive: true, force: true });
    await rm(comotDir, { recursive: true, force: true });
  }
});
