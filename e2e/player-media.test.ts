import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Response as PWResponse } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * 媒體播放效果 end to end (issue #30): advancing to a video step starts the
 * video, advancing to an audio step starts the audio, both align to their
 * SVG placeholder, both are served with real HTTP Range support, and both
 * stop when the author leaves the slide. Real binaries throughout — no
 * mocks (design doc's Testing Decisions) — `fixtures/media-deck/assets/`
 * holds a tiny hand-produced WebM (VP8/Opus) clip and a tiny Ogg/Vorbis
 * clip, made with ffmpeg. WebM/Ogg, not MP4/AAC, because Playwright's
 * bundled Chromium is an open-source build that may lack H.264/AAC (design
 * doc's "codec trap").
 *
 * Never launches Chromium with an autoplay-policy override — the real
 * keyboard press below is the real user gesture play() relies on, and that
 * is the entire point of the "播放帶聲音成功，不被自動播放政策擋下"
 * acceptance criterion.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/media-deck");
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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-media-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-media-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "media-deck.comot");
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

/**
 * Same disambiguation `e2e/selection.test.ts`'s own `canvasFrame` uses: the
 * main slide iframe is told apart from the overview thumbnails (also
 * `srcdoc` documents) by its `class="slide-frame"` element.
 */
async function canvasFrame(page: import("playwright").Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

/**
 * Clicking 播放 rebuilds the iframe with `allow-scripts` immediately, but so
 * does view mode (ADR-0011) — the sandbox attribute can no longer tell "play
 * mode has started" from "still viewing". Wait for .titlebar (view mode's
 * shell chrome) to unmount instead, which is the signal that actually flips
 * only on entering play — the point at which canvas.ts hands focus to the
 * player (see canvas.ts's `onWindowMessage` "ready" branch). Only after that
 * does waiting on the play bar's own `data-player-focus` mean anything.
 * That attribute replaced the focus notice this helper used to wait on
 * (#68 removed the notice); it reports the same `playerHasFocus` state,
 * just without putting it in the author's face.
 */
async function waitForPlayerFocus(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect.poll(() => page.locator('.play-bar[data-player-focus="true"]').count(), { timeout: 10_000 }).toBe(1);
}

it("story 20：靜態檢視就看得到影片與音訊佔位元素，未播放時該位置不是一個洞", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/api/raw/slides/001.svg`);

    const opacityOf = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel) as SVGElement | null;
        if (!el) return null;
        return getComputedStyle(el).opacity;
      }, selector);

    await expect.poll(() => opacityOf("#el-video-placeholder")).toBe("1");
    await expect.poll(() => opacityOf("#el-audio-icon")).toBe("1");
  } finally {
    await cleanup();
  }
});

// [E2.T17] plan §4.4/A3-A4: the STAGE (view mode) media layer — distinct
// from every play-mode test below, which enters play via `.play-button`
// first. These two open the app in its default view mode and interact
// with `data-comot-media-control` directly inside the view iframe.
it("[E2.T17] 舞台（view 模式）下影片可播放、暫停、拖曳進度", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const viewFrame = () => page.frameLocator("iframe.slide-frame");
    await expect
      .poll(() => viewFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");

    const video = viewFrame().locator("video");
    await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(1);
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);

    const playButton = viewFrame().locator('[data-comot-media-control="play"]').first();
    await playButton.click();
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
      .toBe(false);
    const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(t0);

    await playButton.click();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 }).toBe(true);

    // 拖曳進度：真實拖曳一個看不見厚度的 range 很不可靠，直接把值設到目標並
    // 送出瀏覽器拖曳時本來就會送的同一個 "input" 事件——production 的
    // `seek.addEventListener("input", ...)` 分不出這跟真的滑鼠拖曳有什麼不同。
    const seek = viewFrame().locator('[data-comot-media-control="seek"]').first();
    const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
    const target = duration / 2;
    await seek.evaluate((el: HTMLInputElement, value: number) => {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, target);
    const seeked = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    expect(seeked).toBeGreaterThan(target - 0.2);
    expect(seeked).toBeLessThan(target + 0.2);
  } finally {
    await cleanup();
  }
});

it("[E2.T17] 舞台（view 模式）下音訊可播放、暫停、拖曳進度", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const viewFrame = () => page.frameLocator("iframe.slide-frame");
    await expect
      .poll(() => viewFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");

    const audio = viewFrame().locator("audio");
    await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(1);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

    const playButton = viewFrame().locator('[data-comot-media-control="play"]').nth(1);
    await playButton.click();
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 10_000 })
      .toBe(false);
    const t0 = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(t0);

    await playButton.click();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 10_000 }).toBe(true);

    const seek = viewFrame().locator('[data-comot-media-control="seek"]').nth(1);
    const duration = await audio.evaluate((el: HTMLAudioElement) => el.duration);
    const target = duration / 2;
    await seek.evaluate((el: HTMLInputElement, value: number) => {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, target);
    const seeked = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    expect(seeked).toBeGreaterThan(target - 0.2);
    expect(seeked).toBeLessThan(target + 0.2);
  } finally {
    await cleanup();
  }
});

// selection-runtime.js's `findMediaControlTarget` guard (checked first in
// both the "click" and "pointerdown" window listeners) has zero coverage
// otherwise — a mutation test removing both call sites left the full unit
// (2041/2041) and e2e (358 綠) suites green (NOOP-225 review round 1). These
// two are the regression it was missing: without the guard, a click/drag
// that lands on the control bar is indistinguishable from one that lands on
// empty stage, and falls through to the plain "clicked outside, clear
// selection" / "no element hit, start a marquee" paths below it.
it("元素被選取時點 .media-play：選取狀態不受影響（[E2.T17] 舞台媒體控制守衛）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const selectionChip = page.locator(".status-selection-chip");

    await expect
      .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");
    const frame = await canvasFrame(page);
    await frame.locator("#el-video-placeholder").click();
    await expect.poll(() => selectionChip.textContent()).toBe("Selected: el-video-placeholder");

    const video = frame.locator("video");
    await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(1);
    const playButton = frame.locator('[data-comot-media-control="play"]').first();
    await playButton.click();

    // 播放鍵本身仍要正常運作——守衛不能把整顆按鈕擋死，只能擋掉「點擊落在
    // 控制列上」被誤判為「點在空白處」而觸發的清除選取。
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 }).toBe(false);
    expect(await selectionChip.textContent()).toBe("Selected: el-video-placeholder");
  } finally {
    await cleanup();
  }
});

it("在 .media-seek 上按住拖曳：不產生 marquee、不改變選取（[E2.T17] 舞台媒體控制守衛）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const selectionChip = page.locator(".status-selection-chip");

    await expect
      .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");
    const frame = await canvasFrame(page);
    await expect.poll(() => frame.locator('[data-comot-media-control="seek"]').count()).toBeGreaterThan(0);
    await expect.poll(() => selectionChip.textContent()).toBe("");

    const marqueeDisplay = () =>
      frame.evaluate(() => {
        const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
        const marquee = host?.shadowRoot?.querySelector(".marquee") as HTMLElement | null;
        return marquee?.style.display ?? null;
      });

    const seek = frame.locator('[data-comot-media-control="seek"]').first();
    await seek.hover();
    await page.mouse.down();
    await page.mouse.move(200, 200, { steps: 5 }); // 遠超 DRAG_THRESHOLD_PX，若守衛失效會被判成 marquee 手勢
    expect(await marqueeDisplay()).not.toBe("block");
    await page.mouse.up();

    expect(await marqueeDisplay()).not.toBe("block");
    expect(await selectionChip.textContent()).toBe("");
  } finally {
    await cleanup();
  }
});

it("推進到影片的步驟時播放，對齊佔位元素位置與大小，且伺服器以 206 Partial Content 回應", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const videoResponses: PWResponse[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/raw/") && response.url().endsWith("clip.webm")) {
        videoResponses.push(response);
      }
    });

    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");

    await page.locator('.play-button').click();
    await waitForPlayerFocus(page);

    // Alignment expectation comes from the placeholder's own on-screen box
    // in the play iframe, measured before the video is created — not
    // recomputed the way the runtime computes it. Measured here, after
    // entering play mode, so it shares the same layout state as videoRect
    // below (entering play mode itself resizes the stage).
    const placeholderRect = await playFrame()
      .locator("#el-video-placeholder")
      .evaluate((el) => el.getBoundingClientRect().toJSON());

    await page.keyboard.press("ArrowRight");

    const video = playFrame().locator("video");
    await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(1);

    // Real decode proof, not just "play() resolved": readyState indicates
    // actual media data, and currentTime must genuinely advance over time.
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
    const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(t0);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

    const videoRect = await video.evaluate((el) => el.getBoundingClientRect().toJSON());
    expect(videoRect.left).toBeCloseTo(placeholderRect.left, 0);
    expect(videoRect.top).toBeCloseTo(placeholderRect.top, 0);
    expect(videoRect.width).toBeCloseTo(placeholderRect.width, 0);
    expect(videoRect.height).toBeCloseTo(placeholderRect.height, 0);

    // "大型影片不必整份下載即可開始播放" — observed from the browser's own
    // network events, not a fetch this test writes itself.
    await expect.poll(() => videoResponses.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const videoResponse = videoResponses[0];
    expect(videoResponse.status()).toBe(206);
    expect(await videoResponse.headerValue("accept-ranges")).toBe("bytes");
    // Ticket #30, review round 2: a real Content-Type, not
    // application/octet-stream — the e2e test was passing before this fix
    // only because Chromium sniffs bytes when the header is generic, which
    // masked the server-side MIME table gap. Asserting it here keeps that
    // gap from silently coming back.
    expect(await videoResponse.headerValue("content-type")).toBe("video/webm");

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("推進到音訊的步驟時播放，且伺服器以 206 Partial Content 回應", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    const audioResponses: PWResponse[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/raw/") && response.url().endsWith("narration.oga")) {
        audioResponses.push(response);
      }
    });

    await page.goto(server.url);
    const playFrame = () => page.frameLocator("iframe.slide-frame");
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");

    await page.locator('.play-button').click();
    await waitForPlayerFocus(page);

    await page.keyboard.press("ArrowRight"); // video step
    await expect.poll(() => playFrame().locator("video").count(), { timeout: 10_000 }).toBe(1);
    await page.keyboard.press("ArrowRight"); // audio step

    const audio = playFrame().locator("audio");
    await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(1);

    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
    const t0 = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(t0);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);

    await expect.poll(() => audioResponses.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(audioResponses[0].status()).toBe(206);
    expect(await audioResponses[0].headerValue("accept-ranges")).toBe("bytes");
    expect(await audioResponses[0].headerValue("content-type")).toBe("audio/ogg");
  } finally {
    await cleanup();
  }
});

it("離開投影片時，正在播放的影片與音訊全部停止；回到投影片時不出現兩份媒體同時播放", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");

    await page.locator('.play-button').click();
    await waitForPlayerFocus(page);

    await page.keyboard.press("ArrowRight"); // video step
    await expect.poll(() => playFrame().locator("video").count(), { timeout: 10_000 }).toBe(1);
    await page.keyboard.press("ArrowRight"); // audio step
    await expect.poll(() => playFrame().locator("audio").count(), { timeout: 10_000 }).toBe(1);

    const audioHandle = await playFrame().locator("audio").elementHandle();
    if (!audioHandle) throw new Error("找不到音訊元素");
    await expect
      .poll(() => audioHandle.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 10_000 })
      .toBe(false);

    // Advance past slide 1's last step: the runtime sends advance-past-end,
    // canvas.ts reassigns the iframe's srcdoc, which — per ADR-0010 — is a
    // full navigation of the play document, not an in-place DOM update.
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => playFrame().locator("#el-title2").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第二頁：離開第一頁後，媒體應已停止");

    // The old document's own execution context is gone along with it — a
    // handle from before the navigation can no longer be evaluated. That is
    // the measurement that decides assumption 11 (see the report): the
    // navigation itself tore the whole previous document down, audio
    // included, rather than leaving it detached-but-still-playing.
    await expect(audioHandle.evaluate((el: HTMLAudioElement) => el.paused)).rejects.toThrow();

    // The fresh slide-2 document never had any media in the first place.
    expect(await playFrame().locator("video").count()).toBe(0);
    expect(await playFrame().locator("audio").count()).toBe(0);

    // Idempotence across a genuine "leave and come back": go back to slide
    // 1 via #54's play-bar 上一步 button (controller.previous(), i.e.
    // showSlide(currentIndex - 1) — currently on slide 2 (index 1), so
    // this is a byte-for-byte equivalent call to the overview thumbnail
    // click this line used to make, per the wave brief's 裁決 1), replay
    // both steps, and confirm exactly one of each media element exists —
    // never two stacked from an old and a new document.
    await page.locator('.play-bar button[aria-label="上一步"]').click();
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("媒體播放測試");
    // showSlide() while still in play mode reassigns srcdoc just like
    // entering play the first time did, so the fresh runtime's own "ready"
    // message re-triggers canvas.ts's focusPlayer() automatically — no
    // manual click needed here, only the same wait for it to land.
    await waitForPlayerFocus(page);

    await page.keyboard.press("ArrowRight"); // video step
    await expect.poll(() => playFrame().locator("video").count(), { timeout: 10_000 }).toBe(1);
    await page.keyboard.press("ArrowRight"); // audio step
    await expect.poll(() => playFrame().locator("audio").count(), { timeout: 10_000 }).toBe(1);
  } finally {
    await cleanup();
  }
});
