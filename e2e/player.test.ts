// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Multi-slide paging end to end. The deck under test is the
 * hand-written fixture in `fixtures/player-deck/`: three visibly different
 * slides, one of which references an asset by relative path. Everything is
 * real — a real `.slidra` packed from that directory, the real `open`
 * command, a real server, the real built bundle, a real Chromium. The
 * agent is the same fake ACP subprocess the smoke test uses; nothing here
 * talks to it.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/player-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-player-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-player-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  registry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "player-deck.slidra");
  await packDirectory(deckFixtureDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test does not send a message",
    },
  };

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  // Browser first, then server. An open page holds a live `/api/events`
  // SSE connection, and `server.close()` waits for in-flight requests to
  // finish — with a page still attached that wait never ends.
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
});

it("author can page forward and backward in the browser, and stops at both ends", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  const currentSlideText = async (): Promise<string | null> => {
    if (pageErrors.length > 0) return `Page errors: ${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };
  const nextButton = page.locator('.slide-nav-button[aria-label="Next slide"]');
  const previousButton = page.locator('.slide-nav-button[aria-label="Previous slide"]');
  const position = page.locator(".slide-nav-position");

  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("First Slide");
  await expect.poll(() => position.textContent(), { timeout: 30_000 }).toBe("Slide 1 of 3");
  // On the first slide, going back further does nothing: the control is there, and it refuses.
  await expect.poll(() => previousButton.isDisabled()).toBe(true);

  await nextButton.click();
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("Second Slide");
  await expect.poll(() => position.textContent()).toBe("Slide 2 of 3");

  await nextButton.click();
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("Third Slide");
  await expect.poll(() => position.textContent()).toBe("Slide 3 of 3");

  // On the last slide, going forward further does nothing, and it doesn't crash.
  await expect.poll(() => nextButton.isDisabled()).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("Third Slide");

  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("Second Slide");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("First Slide");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("First Slide");

  expect(pageErrors).toEqual([]);
});

it("the second slide's relative-path image actually loads", async () => {
  const page = await browser.newPage();
  // Each response is recorded with the frame that issued it: since the
  // overview panel renders real thumbnails, the same photo is legitimately
  // fetched by a thumbnail iframe too, and only frame attribution can keep
  // this test proving what it was written to prove — that the MAIN
  // canvas's slide loaded the image, not merely that somebody did.
  const rawResponses: { url: string; status: number; contentType: string | undefined; frame: unknown }[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/raw/")) return;
    rawResponses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"],
      frame: response.frame(),
    });
  });

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("First Slide");

  await page.locator('.slide-nav-button[aria-label="Next slide"]').click();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("Second Slide");

  // The frame the main canvas renders into. Its identity is stable across
  // srcdoc navigations (only play mode rebuilds the element, and this test
  // never enters play mode), so responses recorded earlier compare equal.
  const slideFrames = [];
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") slideFrames.push(frame);
  }
  expect(slideFrames).toHaveLength(1);
  const slideFrame = slideFrames[0];

  // A missing image leaves the <image> element in the DOM exactly as a
  // loaded one does, so the element's presence proves nothing. Two
  // independent checks that it really arrived: the bytes came back 200 as
  // a PNG, and the browser painted it with a non-zero box. The filter is
  // pinned to the main canvas's own frame — a thumbnail's load of the same
  // asset (legitimate since the overview panel exists) must neither satisfy
  // nor break this assertion.
  const photoFromCanvas = () =>
    rawResponses.filter((r) => r.url.endsWith("/assets/photo.png") && r.frame === slideFrame);
  await expect.poll(photoFromCanvas, { timeout: 30_000 }).toHaveLength(1);
  const photoResponse = photoFromCanvas()[0];
  expect(photoResponse.status).toBe(200);
  expect(photoResponse.contentType).toContain("image/png");

  const image = page.frameLocator("iframe.slide-frame").locator("svg image");
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
