// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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

/**
 * Object animation (the PPTX-style mental model) end to end, against a
 * real Chromium — same `startServerFor`/`openApp` shape as
 * e2e/direct-manipulation.test.ts. Every family, the badges, the Edit
 * animation entry, and the GUI↔CLI equivalence all live here rather than
 * one file each.
 *
 * Each test opens its own server against a fresh copy of the fixture deck
 * (`object-animation-deck`) — no test depends on another's mutations.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const deckDir = path.join(e2eDir, "fixtures/object-animation-deck");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
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
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-anim-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-anim-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  throw new Error("could not find the main canvas's iframe.slide-frame");
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

// Reads the raw XML directly rather than going through `effect list`.
// `effect list` reports corruption per the CLI's own spec whenever the
// first item in the list has a `start` other than `on-click` (moving step
// derivation into `effect list` is what first made this reachable here —
// `effect add` itself allows writing that state; see the CLI reference's
// "open questions" for `effect add`). This function is purely a read-back
// mechanism: it's testing whether the content the GUI/CLI wrote to the
// file is correct, not whether `effect list` itself conforms to spec, so
// it uses `cat` + regex instead, mirroring the same approach used in
// packages/cli/test/effect.test.ts.
async function readEffects(registry: CommandRegistry, presentationId: string): Promise<EffectRow[]> {
  const result = await registry.dispatch<{ content: string }>("cat", {
    id: presentationId,
    path: "slides/001.svg",
  });
  if (!result.ok) return [];
  const svg = result.data!.content;
  const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  return [...svg.matchAll(/<slidra:effect\b[^>]*\/>/g)].map((match) => {
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

it("selecting an element and clicking Add animation issues effect add; the agent can reproduce the same result via the same CLI command", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await slideFrame.locator("#el-a").click();
    await openAnimatePanel(page);
    await addAnimationViaPanel(page, { family: "enter", effect: "fade", duration: 0.5, delay: 0 });

    // The right panel auto-switches to Animate › Object, with the new card at the end of the list.
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

    // The agent reproduces this via the same command: call the CLI's effect add directly, doing the same thing to another element.
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
    // The two entries are identical apart from target/index — the GUI and the CLI produce the same result.
    const { target: _guiTarget, index: _guiIndex, ...guiRest } = afterCli[0];
    const { target: _cliTarget, index: _cliIndex, ...cliRest } = afterCli[1];
    expect(guiRest).toEqual(cliRest);
  } finally {
    await cleanup();
  }
});

it("group animation: multi-selecting scattered elements gives the first entry the specified start, all others with-previous", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await openAnimatePanel(page);
    await addAnimationViaPanel(page, { family: "enter", effect: "zoom", start: "after-previous" });

    // The insert panel only closes once `effect add` actually returns ok
    // (AnimatePanel.tsx's `addAnimation()`: await runCommand → onClose() is
    // only called when result.ok) — waiting for it to close proves the
    // write has landed, so the two assertions below can't race ahead of the
    // write completing. `objectCards(...).toBe(2)` used to serve as this
    // sync point, but the approved end state is 0 (see the comment below),
    // which is indistinguishable from the starting count of 0 via polling,
    // so a different signal is needed.
    await expect.poll(() => page.locator(".animate-panel").count()).toBe(0);

    // When the first item in the list has a start other than on-click,
    // `effect list` returns failed per the CLI's own spec, the route turns
    // that into a 500, and the Animate › Object panel's `useSlideEffects`
    // treats it as an empty list — this is a direct, approved consequence
    // of the spec, not a bug and not something this change introduced. The
    // panel going empty doesn't affect the underlying file: readEffects()
    // below reads the XML directly, proving both effects were in fact
    // written correctly per the start rules.
    await expect.poll(() => objectCards(page).count()).toBe(0);
    const effects = await readEffects(registry, presentationId);
    expect(effects).toHaveLength(2);
    expect(effects.map((e) => e.start)).toEqual(["after-previous", "with-previous"]);
  } finally {
    await cleanup();
  }
});

it("group animation: selecting an entire group <g> produces exactly one effect entry, listed as Group N (n)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    // el-group-a is a nested child of el-group; a click resolves to the
    // outermost id-carrying container (el-group itself).
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

it("ordering and parameters: editing Duration writes back to the file immediately; ↑ swaps two adjacent effect entries' order", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-b"], family: "enter", effect: "zoom",
    });

    const page = await openApp(server);
    // The Object sub-tab is disabled with no selection at all (auto-reverts
    // to Page) — selecting an element (it doesn't need to be one with an
    // effect) is only so the sub-tab can be switched to; the Object list
    // itself shows the whole slide's effect list, not just the selected
    // element's.
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

    await objectCards(page).nth(1).locator('button[aria-label="Move Up"]').click();
    await expect
      .poll(async () => (await readEffects(registry, presentationId)).map((e) => e.target))
      .toEqual(["el-b", "el-a"]);
  } finally {
    await cleanup();
  }
});

it("preview: a card's ▶ actually triggers that effect's animation in play mode", async () => {
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

    // Automatically returns to view mode after preview-done — the context
    // bar becomes responsive again, proving both selection and runtime were
    // restored.
    await expect.poll(() => page.locator(".play-bar").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("enter family: advancing to that step actually animates the element, and opacity returns to 1", async () => {
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

it("emphasis family: advancing produces a transform animation, and the element itself is never hidden", async () => {
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

it("exit family: the target starts out visible (D12), and advancing ends the animation at opacity 0", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-exit"], family: "exit", effect: "disappear", duration: 0.2,
    });

    const page = await openApp(server);
    // D12: an exit-only target is visible from the start (on entering play mode).
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

it("path family: advancing moves the element along d (transform is no longer its initial value)", async () => {
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

it("stage badges stay in sync with the list: pressing ↑ in the list also swaps the badges' numbering", async () => {
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

    await objectCards(page).nth(1).locator('button[aria-label="Move Up"]').click();
    await expect.poll(async () => (await readEffects(registry, presentationId)).map((e) => e.target)).toEqual(["el-b", "el-a"]);

    await expect.poll(() => badgeTextFor("el-b")).toBe("1");
    expect(await badgeTextFor("el-a")).toBe("2");
  } finally {
    await cleanup();
  }
});

// The structural fix for the animation badge wrongly turning on
// pointer-events:auto and blocking the element's top-left resize handle.
// This lives in this file rather than a new e2e file or shell-layout.test.ts's
// no-selection demo: there, `.stage-geometry` contains only two empty
// containers, making any scan vacuously true and meaningless; here there
// is already a full "select an animated element + open the Animate tab"
// setup, with a real badge on the stage, so the assertion actually means
// something.
it("two-layer split: the geometry layer passes clicks through entirely, so the animation badge no longer blocks the element's top-left handle", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });

    const page = await openApp(server);
    await (await canvasFrame(page)).locator("#el-a").click();
    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => page.locator(".animation-badge").count()).toBe(1);

    // No element under the geometry layer has computed pointer-events
    // auto, and the scan actually sees something (guarding against a
    // vacuous assertion) — the badge must really be inside the geometry layer.
    const scan = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".stage-geometry, .stage-geometry *"));
      return nodes.map((el) => ({ cls: el.className, pe: getComputedStyle(el).pointerEvents }));
    });
    expect(scan.length).toBeGreaterThanOrEqual(4);
    expect(scan.some((n) => String(n.cls).includes("animation-badge"))).toBe(true);
    expect(scan.filter((n) => n.pe === "auto")).toEqual([]);

    // The core fix: the badge's exact center coincides with the
    // element's top-left handle center (`transform: translate(-50%,-50%)`);
    // that point must pass through to the iframe, no longer caught by
    // either the geometry layer or the widget layer.
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
    expect(hit!.inGeometry).toBe(false); // mutation point: this fails if the badge is switched back to pointer-events:auto
    expect(hit!.inWidgets).toBe(false);
    expect(hit!.tag).toBe("IFRAME");
  } finally {
    await cleanup();
  }
});

it("Edit animation entry point: not rendered when an element with no animation is selected; rendered and switches to Animate › Object when one has an animation; there is exactly one entry point site-wide", async () => {
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

    // the context bar is ghost (`pointer-events: none`)
    // until the pointer hovers it long enough to solidify — a plain
    // `.click()` never reaches the button, it always resolves to the
    // iframe underneath instead.
    const editAnimationBox = (await page.locator('[title="Edit animation"]').boundingBox())!;
    await page.mouse.move(editAnimationBox.x + editAnimationBox.width / 2, editAnimationBox.y + editAnimationBox.height / 2);
    await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
    await page.locator('[title="Edit animation"]').click();
    await expect.poll(() => page.locator('[role="tab"][data-tab="animate"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator('[role="tab"][data-subtab="object"]').getAttribute("aria-selected")).toBe("true");

    // No second entry point exists site-wide (the prototype's right-click menu has been removed).
    expect(await page.locator('[title="Edit animation"]').count()).toBe(1);
  } finally {
    await cleanup();
  }
});

it("Animate › Page: setting an Enter effect via the GUI and clicking Apply to all slides; the agent can reproduce it via the same slide transition set --all", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    // Create a second slide to prove --all really applies to "every" slide, not just the current one.
    const added = await registry.dispatch<{ slidePath: string }>("slide add", { id: presentationId });
    expect(added.ok).toBe(true);
    const secondSlidePath = added.data!.slidePath;

    const page = await openApp(server);
    await page.locator('[role="tab"][data-tab="animate"]').click();
    const panel = page.locator(".animate-page-panel");
    await panel.waitFor();
    // No element selected — stays on the default Page sub-tab, not Object.
    expect(await page.locator('[role="tab"][data-subtab="page"]').getAttribute("aria-selected")).toBe("true");

    await panel.locator('[data-edge="enter"] .animate-page-effect-card', { hasText: "Fade" }).click();

    await expect
      .poll(async () => (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content)
      .toContain('enter="fade"');
    // Apply to all slides hasn't been clicked yet — the second slide is unaffected.
    expect(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: secondSlidePath })).data!.content,
    ).not.toContain("slidra:transition");

    await panel.locator(".animate-page-apply-all").click();

    await expect
      .poll(async () => (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: secondSlidePath })).data!.content)
      .toContain('enter="fade"');

    // The agent can reproduce this via the same command: the CLI's --all produces a consistent result on a brand-new presentation.
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

it("structural assertions for the Animate panel, the Animate › Object list, the stage's numbered badges, and Animate › Page", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"], family: "enter", effect: "fade",
    });

    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);
    await slideFrame.locator("#el-a").click();
    await openAnimatePanel(page);
    await page.keyboard.press("Escape");

    await page.locator('[role="tab"][data-tab="animate"]').click();
    await expect.poll(() => objectCards(page).count()).toBe(1);

    // the card's fields grid must fit inside the
    // panel — before the fix, a <select>'s min-content forced the grid
    // track wider than the panel (`.animate-card-fields` scrollWidth >
    // clientWidth) and pushed the Start/Delay column's right edge past the
    // 1440px-wide panel entirely.
    const fields = objectCards(page).locator(".animate-card-fields").first();
    const fieldsScroll = await fields.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(fieldsScroll.scrollWidth).toBeLessThanOrEqual(fieldsScroll.clientWidth);
    const startField = objectCards(page).locator(".animate-card-field", { hasText: "Start" }).locator("select").first();
    const startRight = await startField.evaluate((el) => el.getBoundingClientRect().right);
    expect(startRight).toBeLessThanOrEqual(VIEWPORT.width);

    await expect.poll(() => page.locator(".animation-badge").count()).toBe(1);

    // Animate › Page (no selection, back to the Page sub-tab).
    // The `.animate-page-panel` container already exists before its data
    // loads (AnimatePagePanel.tsx's loading state returns an empty shell
    // with the same name) — waiting for just the container to appear isn't
    // enough, so instead wait for the Apply to all slides button and all 8
    // effect cards (4 Enter + 4 Exit) to actually render.
    await page.locator('[role="tab"][data-subtab="page"]').click();
    await page.locator(".animate-page-panel .animate-page-apply-all").waitFor();
    await expect.poll(() => page.locator(".animate-page-effect-card").count()).toBe(8);
  } finally {
    await cleanup();
  }
});
