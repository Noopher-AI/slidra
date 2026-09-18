// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { browserFetch } from "./helpers/browser-fetch.js";

/**
 * Page management: the New/Templates panel and drag-to-reorder scenarios,
 * plus a regression test against a real root cause — `slide notes set` used
 * to write an `<slidra:notes>` element without binding the `slidra:` prefix,
 * which broke play-mode parsing for that slide.
 *
 * Drag reordering does not synthesize native HTML5 drag-and-drop through
 * Playwright's mouse events — Chromium's native DnD depends on OS-level drag
 * coordination, which is unreliable to trigger via a mouse event sequence in
 * a headless environment. Instead, `page.evaluate` dispatches real `DragEvent`s
 * (`dragstart`/`dragover`/`drop`/`dragend`, with a real `DataTransfer`)
 * directly on the DOM nodes — this still exercises the same event listeners
 * `overview.ts` actually attaches in the browser, testing the same production
 * code, just skipping the OS layer that cannot be reliably reproduced in
 * headless CI.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/page-management-deck");
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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-pm-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-pm-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
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

  const server = await startServe({ policy: openPolicy, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
    },
  };
}

/**
 * The CLI-only half of the GUI/CLI equivalence test (C): no server, no
 * browser — a bare registry against its own copy of the fixture deck, the
 * same shape `notes-transition.test.ts` uses for its CLI-side assertions.
 */
async function startRegistryFor(): Promise<{
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-pm-cli-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-pm-cli-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  return {
    registry,
    presentationId,
    cleanup: async () => {
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
    },
  };
}

/**
 * Collapses every re-minted `el-*` id (`slide add --template`/`slide
 * duplicate` both call `mintElementIds`, which is `crypto.randomUUID`-backed
 * — never equal across two independent runs) to a stable, first-seen-order
 * placeholder, so a GUI run and a CLI run of the same operation can be
 * compared byte-for-byte on everything except the part that's random by
 * design. Consistent across the whole document, so an id used twice (an
 * attribute and a same-document reference) still normalizes to one value.
 */
function normalizeIds(svg: string): string {
  const seen = new Map<string, string>();
  let counter = 0;
  return svg.replace(/el-[A-Za-z0-9_-]+/g, (match) => {
    let placeholder = seen.get(match);
    if (placeholder === undefined) {
      placeholder = `el-NORMALIZED-${counter++}`;
      seen.set(match, placeholder);
    }
    return placeholder;
  });
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  // Thumbnails materialise lazily (IntersectionObserver) — wait for the
  // rail itself before any test touches `.overview-item`.
  await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);
  return page;
}

async function readProject(registry: CommandRegistry, id: string): Promise<{ slides: string[] }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.data!.content);
}

async function readSlide(registry: CommandRegistry, id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

/** Fires `dragstart` on `fromIndex`'s `<li>` then `dragover` on `toIndex`'s, at a Y offset near that item's top or bottom edge (the "cursor position decides insert-before/-after" rule as this shell implements it — no trailing placeholder card, see overview.ts's own comment). */
async function dragOver(page: Page, fromIndex: number, toIndex: number, edge: "top" | "bottom"): Promise<void> {
  await page.evaluate(
    ({ fromIndex, toIndex, edge }) => {
      const w = window as unknown as { __e2eDrag?: DataTransfer };
      const source = document.querySelector(`.overview-item[data-index="${fromIndex}"]`) as HTMLElement;
      const target = document.querySelector(`.overview-item[data-index="${toIndex}"]`) as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = edge === "top" ? rect.top + 2 : rect.bottom - 2;
      const dataTransfer = new DataTransfer();
      w.__e2eDrag = dataTransfer;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY: rect.top }),
      );
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
    },
    { fromIndex, toIndex, edge },
  );
}

async function drop(page: Page, toIndex: number, edge: "top" | "bottom"): Promise<void> {
  await page.evaluate(
    ({ toIndex, edge }) => {
      const w = window as unknown as { __e2eDrag?: DataTransfer };
      const target = document.querySelector(`.overview-item[data-index="${toIndex}"]`) as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = edge === "top" ? rect.top + 2 : rect.bottom - 2;
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: w.__e2eDrag, clientX, clientY }),
      );
    },
    { toIndex, edge },
  );
}

async function dragEnd(page: Page, fromIndex: number): Promise<void> {
  await page.evaluate((fromIndex) => {
    const w = window as unknown as { __e2eDrag?: DataTransfer };
    const source = document.querySelector(`.overview-item[data-index="${fromIndex}"]`) as HTMLElement;
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: w.__e2eDrag }));
  }, fromIndex);
}

it("New panel: Blank and the template list are both usable, applying either inserts a new slide", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readProject(registry, presentationId);
    expect(before.slides).toEqual(["slides/001.svg", "slides/002.svg", "slides/003.svg", "slides/004.svg"]);

    await page.locator(".rail-actions").getByRole("button", { name: "New" }).click();
    const menu = page.locator('[role="menu"][data-menu="new"]');
    await expect.poll(() => menu.getByRole("menuitem", { name: "From outline…" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Blank" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Title" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Section" }).isVisible()).toBe(true);

    await menu.getByRole("menuitem", { name: "Blank" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const afterBlank = await readProject(registry, presentationId);
    // Current page was slides/001.svg (index 0) on load, so Blank inserts at index 1.
    const blankSlidePath = afterBlank.slides[1];
    expect(before.slides).not.toContain(blankSlidePath);

    // Applying a template: same insertion semantics, content copied byte-for-byte except ids.
    await page.locator(".rail-actions").getByRole("button", { name: "New" }).click();
    await menu.getByRole("menuitem", { name: "Title" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      6,
    );
    const afterTemplate = await readProject(registry, presentationId);
    // Blank's own insert already moved currentIndex to 1 (runPageCommand's
    // showSlide(at)), so this second insert lands right after IT, at index 2.
    const templateSlidePath = afterTemplate.slides[2];
    const templateContent = await readSlide(registry, presentationId, templateSlidePath);
    expect(templateContent).toContain("Title Template");
    expect(templateContent).not.toContain('id="el-template-title"'); // re-minted, not copied verbatim
    expect(templateContent).toMatch(/id="el-[^"]+"/);
  } finally {
    await cleanup();
  }
});

it("Templates button: lists only templates (no Blank/From outline…), applying goes through the same function as the New panel", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.getByRole("button", { name: "Templates" }).click();
    const menu = page.locator('[role="menu"][data-menu="templates"]');
    await expect.poll(() => menu.getByRole("menuitem", { name: "Title" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Section" }).isVisible()).toBe(true);
    expect(await menu.getByRole("menuitem", { name: "Blank" }).count()).toBe(0);
    expect(await menu.getByRole("menuitem", { name: "From outline…" }).count()).toBe(0);

    await menu.getByRole("menuitem", { name: "Section" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const project = await readProject(registry, presentationId);
    const newContent = await readSlide(registry, presentationId, project.slides[1]);
    expect(newContent).toContain("Section Template");
  } finally {
    await cleanup();
  }
});

it("master mode: entering shows the deck's templates on the rail and stage, its label avoids sync language, and leaving restores the previous slide (AC1/AC5)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    // Starts on slides/001.svg (index 0) — the slide master mode must
    // restore on exit.
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("0");

    await page.getByRole("button", { name: "Edit template" }).click();

    // The rail now lists the deck's two templates, not its four slides.
    await expect.poll(() => page.locator(".overview-item").count()).toBe(2);
    await expect.poll(() => page.locator(".rail-slides-label").textContent()).toContain("Templates");
    const stageText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => stageText.textContent()).toBe("Title Template");

    // AC5: the mode's own explanation never implies automatic sync, and
    // says outright that existing slides don't change on their own.
    const barText = (await page.locator(".master-mode-bar").textContent()) ?? "";
    expect(barText.toLowerCase()).not.toMatch(/sync|automatic/);
    expect(barText).toContain("don't change");
    await expect.poll(() => page.getByRole("button", { name: "Let the agent update the slides" }).isVisible()).toBe(true);

    // AC1: selecting a different template puts it on stage, same as a slide.
    await page.locator('.overview-item[data-index="1"] button.overview-thumb').click();
    await expect.poll(() => stageText.textContent()).toBe("Section Template");

    await page.getByRole("button", { name: "Back to slides" }).click();

    // Back to the deck's four slides, on the same slide the author left.
    await expect.poll(() => page.locator(".overview-item").count()).toBe(4);
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("0");
    await expect.poll(() => stageText.textContent()).not.toBe("Section Template");
  } finally {
    await cleanup();
  }
});

it("master mode: leaving restores the slide the author was actually on, not one clamped to the template count (AC1)", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    // This deck has four slides and two templates. Entering master mode
    // from a slide index the template list cannot hold (3 > 2 - 1) is the
    // case the AC1 test above cannot see: it enters from index 0, where a
    // clamp against the wrong list is indistinguishable from a correct
    // restore.
    await page.locator('.overview-item[data-index="3"] button.overview-thumb').click();
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("3");

    await page.getByRole("button", { name: "Edit template" }).click();
    await expect.poll(() => page.locator(".overview-item").count()).toBe(2);

    await page.getByRole("button", { name: "Back to slides" }).click();
    await expect.poll(() => page.locator(".overview-item").count()).toBe(4);
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("3");
  } finally {
    await cleanup();
  }
});

it("master mode: editing a template with an ordinary command changes only the template, no slide (AC2)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slidesBefore = (await readProject(registry, presentationId)).slides;
    const slideBytesBefore = await Promise.all(slidesBefore.map((p) => readSlide(registry, presentationId, p)));

    await page.getByRole("button", { name: "Edit template" }).click();
    await expect.poll(() => page.locator(".overview-item").count()).toBe(2);

    // Same command endpoint any ordinary tool (Style panel, in-place text
    // edit) already issues — see file-roundtrip.test.ts/
    // direct-manipulation.test.ts for the same direct-POST shape.
    const response = await browserFetch(server.url, "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "templates/001.svg", elementId: "el-template-title", newText: "Edited Template" },
      }),
    });
    expect(response.status).toBe(200);

    const templateAfter = await readSlide(registry, presentationId, "templates/001.svg");
    expect(templateAfter).toContain("Edited Template");

    const slidesAfter = (await readProject(registry, presentationId)).slides;
    expect(slidesAfter).toEqual(slidesBefore);
    const slideBytesAfter = await Promise.all(slidesAfter.map((p) => readSlide(registry, presentationId, p)));
    expect(slideBytesAfter).toEqual(slideBytesBefore);
  } finally {
    await cleanup();
  }
});

it("drag reordering: a red insertion line appears at the drop target's edge, releasing changes project.json's order", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    let commandCalls = 0;
    await page.route("**/call", (route) => {
      commandCalls++;
      void route.continue();
    });

    // Drop item 0 (slides/001.svg) onto the BOTTOM half of item 2
    // (slides/003.svg): to=3, newIndex=2 → final order [002,003,001,004]
    // ("[2,3,1,4]" by original numbering).
    await dragOver(page, 0, 2, "bottom");
    await expect.poll(() => page.locator(".overview-drop-line").count(), { timeout: 5_000 }).toBe(1);
    const dropLineColor = await page
      .locator(".overview-drop-line")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const brandRed = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--brand-red"));
    const brandRedResolved = await page.evaluate((v) => {
      const probe = document.createElement("div");
      probe.style.color = v;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, brandRed.trim());
    expect(dropLineColor).toBe(brandRedResolved);

    await drop(page, 2, "bottom");
    await dragEnd(page, 0);

    await expect.poll(async () => (await readProject(registry, presentationId)).slides, { timeout: 10_000 }).toEqual([
      "slides/002.svg",
      "slides/003.svg",
      "slides/001.svg",
      "slides/004.svg",
    ]);
    await expect.poll(() => page.locator(".overview-drop-line").count()).toBe(0);
    expect(commandCalls).toBe(1);

    // no-op: dropping item 0 onto itself (top half) must not draw a line or send a command.
    await dragOver(page, 0, 0, "top");
    expect(await page.locator(".overview-drop-line").count()).toBe(0);
    await drop(page, 0, "top");
    await dragEnd(page, 0);
    expect(commandCalls).toBe(1);

    // no-op: dropping item 0 onto its own immediate next slot (index 1's top half, i.e. to=1=from+1).
    await dragOver(page, 0, 1, "top");
    expect(await page.locator(".overview-drop-line").count()).toBe(0);
    await drop(page, 1, "top");
    await dragEnd(page, 0);
    expect(commandCalls).toBe(1);
    await expect.poll(async () => (await readProject(registry, presentationId)).slides).toEqual([
      "slides/002.svg",
      "slides/003.svg",
      "slides/001.svg",
      "slides/004.svg",
    ]);
  } finally {
    await cleanup();
  }
});

it("root-cause regression guard: entering play mode after slide notes set shows no [role=alert] and the slide renders normally", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const result = await registry.dispatch("slide notes set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      text: "Speaker notes: this text must not appear in the thumbnail or the play view",
    });
    expect(result.ok).toBe(true);
    const content = await readSlide(registry, presentationId, "slides/001.svg");
    expect(content).toContain('<slidra:notes xmlns:slidra="https://slidra.app/ns/2026">');

    const page = await openApp(server);

    // The thumbnail must not render <metadata> content (notes text must not
    // leak into the rail) — `<metadata>` is legitimately present in the
    // markup (wrapSlideDocument stuffs the whole slide markup into the
    // iframe's body), so what's asserted here is "invisible" (the SVG UA
    // stylesheet sets `display:none` on `<metadata>`), not "the text is
    // absent from the HTML".
    const thumbFrame = page.frameLocator(".overview-item[data-index=\"0\"] iframe.overview-frame");
    await expect.poll(() => thumbFrame.locator("metadata").count().catch(() => 0), { timeout: 15_000 }).toBeGreaterThan(0);
    const metadataVisible = await thumbFrame.locator("metadata").first().isVisible();
    expect(metadataVisible).toBe(false);

    await page.locator(".play-button").click();
    await page.waitForTimeout(500);

    // Next.js keeps its own always-present, empty route announcer at
    // `#__next-route-announcer__` with `role="alert"` — it is a live region,
    // never an error. What this guard is about is the app's own alerts.
    expect(await page.locator('[role="alert"]:not(#__next-route-announcer__)').count()).toBe(0);
    expect(await page.content()).not.toContain("Failed to load effect list");

    const playFrame = page.frameLocator("iframe.slide-frame");
    await expect.poll(() => playFrame.locator("#el-page-1").textContent().catch(() => null), { timeout: 15_000 }).toBe(
      "Page One",
    );
  } finally {
    await cleanup();
  }
});

it("speaker notes: type -> blur -> file content; survives switching pages back and forth; escaped characters round-trip", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const notes = page.getByRole("textbox", { name: "Speaker notes" });

    await notes.click();
    await notes.fill("Page One notes");
    await page.locator(".rail-slides-label").click(); // blur the textarea
    await expect
      .poll(async () => readSlide(registry, presentationId, "slides/001.svg"), { timeout: 10_000 })
      .toEqual(expect.stringContaining('<slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Page One notes</slidra:notes>'));

    // Switching pages and back: switch to slide 2 (no notes, shows the
    // placeholder), then switch back to slide 1 — the field must show what
    // was just saved, not empty and not slide 2's draft.
    await page.locator('.overview-item[data-index="1"] .overview-thumb').click();
    await expect.poll(() => notes.inputValue()).toBe("");
    await page.locator('.overview-item[data-index="0"] .overview-thumb').click();
    await expect.poll(() => notes.inputValue()).toBe("Page One notes");

    // Escaped characters round-trip: the file must escape them, and the UI
    // must decode them back on read.
    await notes.click();
    await notes.fill("1 < 2 && true");
    await page.locator(".rail-slides-label").click();
    await expect
      .poll(async () => readSlide(registry, presentationId, "slides/001.svg"), { timeout: 10_000 })
      .toEqual(expect.stringContaining("1 &lt; 2 &amp;&amp; true"));
    await page.reload();
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.getByRole("textbox", { name: "Speaker notes" }).inputValue(), { timeout: 10_000 }).toBe(
      "1 < 2 && true",
    );
  } finally {
    await cleanup();
  }
});

it("keyboard shortcuts: Cmd+D duplicates the current slide, Delete removes it (both only with no selection), PageUp/PageDown change pages", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // Click a safe element first that doesn't send focus into the slide
    // iframe, so page.keyboard.press reaches the document-level keydown
    // effect rather than the player runtime.
    await page.locator(".rail-slides-label").click();

    await page.keyboard.press("PageDown");
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("1");
    await page.keyboard.press("PageUp");
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("0");

    await page.keyboard.press("ControlOrMeta+d");
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const afterDuplicate = await readProject(registry, presentationId);
    expect(afterDuplicate.slides[1]).not.toBe("slides/002.svg"); // inserted right after the source, not appended
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("1");

    await page.locator(".rail-slides-label").click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      4,
    );
    const afterDelete = await readProject(registry, presentationId);
    expect(afterDelete.slides).toEqual(afterDuplicate.slides.filter((_, i) => i !== 1));
  } finally {
    await cleanup();
  }
});

it("thumbnail context menu: opens, Comment to agent is disabled, Duplicate/Move/Delete each dispatch their own command", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
    const menu = page.locator('[data-testid="thumb-context-menu"]');
    await expect.poll(() => menu.isVisible()).toBe(true);
    const commentItem = menu.getByRole("menuitem", { name: "Comment to agent" });
    expect(await commentItem.getAttribute("aria-disabled")).toBe("true");
    expect(await commentItem.isDisabled()).toBe(true);
    // Move up is disabled on the first slide.
    expect(await menu.getByRole("menuitem", { name: "Move up" }).isDisabled()).toBe(true);

    await menu.getByRole("menuitem", { name: /^Duplicate slide/ }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    await expect.poll(() => menu.isVisible()).toBe(false); // menu closes after an action

    await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Move down" }).click();
    await expect
      .poll(async () => (await readProject(registry, presentationId)).slides[1], { timeout: 10_000 })
      .toBe("slides/001.svg");

    await page.locator('.overview-item[data-index="1"]').click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Delete slide" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      4,
    );
    expect((await readProject(registry, presentationId)).slides).not.toContain("slides/001.svg");
  } finally {
    await cleanup();
  }
});

it("thumbnail context menu \"Save as template\": saving makes the template appear immediately under Templates/New › Layouts, and applying it reproduces the source slide's content", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const beforeSlides = (await readProject(registry, presentationId)).slides;
    const sourceContent = await readSlide(registry, presentationId, beforeSlides[1]);

    await page.locator('.overview-item[data-index="1"]').click({ button: "right" });
    const contextMenu = page.locator('[data-testid="thumb-context-menu"]');
    await expect.poll(() => contextMenu.isVisible()).toBe(true);
    await contextMenu.getByRole("menuitem", { name: "Save as template" }).click();

    const modal = page.locator('[role="dialog"][aria-label="Save as template"]');
    await expect.poll(() => modal.isVisible()).toBe(true);
    await modal.getByLabel("Template name").fill("My Template");
    await modal.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => modal.isVisible()).toBe(false);

    await page.getByRole("button", { name: "Templates" }).click();
    const templatesMenu = page.locator('[role="menu"][data-menu="templates"]');
    await expect.poll(() => templatesMenu.getByRole("menuitem", { name: "My Template" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");

    await page.locator(".rail-actions").getByRole("button", { name: "New" }).click();
    const newMenu = page.locator('[role="menu"][data-menu="new"]');
    await expect.poll(() => newMenu.getByRole("menuitem", { name: "My Template" }).isVisible()).toBe(true);
    await newMenu.getByRole("menuitem", { name: "My Template" }).click();

    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const afterSlides = (await readProject(registry, presentationId)).slides;
    const newSlidePath = afterSlides.find((slidePath) => !beforeSlides.includes(slidePath));
    if (!newSlidePath) throw new Error("could not find the newly inserted slide");
    const newContent = await readSlide(registry, presentationId, newSlidePath);
    expect(normalizeIds(newContent)).toBe(normalizeIds(sourceContent));
  } finally {
    await cleanup();
  }
});

it("the thumbnail comment button is hidden at rest and only appears on hover", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const pin = page.locator('.overview-item[data-index="0"] .overview-comment-button');

    // The "only visible on hover" rule only holds for a thumbnail with no
    // page-level comments — when it has one, `.has-comments` keeps it always
    // lit (rail.css), which is what makes the rest-state assertion below
    // meaningful. This fixture deck currently has no comments; if it ever
    // grows one, this will fail with a readable message instead of the
    // opacity assertion mysteriously not being 0.
    await expect.poll(() => pin.evaluate((el) => el.classList.contains("has-comments"))).toBe(false);

    await page.mouse.move(0, 0);
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

    await page.locator('.overview-item[data-index="0"]').hover();
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    // Hovering a different thumbnail: only the hovered one shows, others stay at 0.
    await page.locator('.overview-item[data-index="1"]').hover();
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  } finally {
    await cleanup();
  }
});

it("GUI and CLI are byte-for-byte equivalent (every operation has a matching CLI command; an agent can reproduce it with the same command)", async () => {
  // Each operation runs once as a GUI action against a fresh copy of the
  // fixture, and once as an equivalent registry.dispatch against another
  // fresh copy, then the two results are compared — rather than chaining
  // all five operations on one deck: chaining would force the CLI side to
  // either re-read the intermediate state the GUI side wrote (which asserts
  // "CLI can read the GUI's output", not "the two paths are equivalent"), or
  // hand-compute five steps of intermediate indices — something slide-ops.ts's
  // index semantics already cover in its unit tests, so repeating it here adds
  // no verification value. "Run each once" is taken literally: one operation,
  // two paths, the same starting bytes.
  //
  // The GUI and CLI sides must never be open at the same time: `SLIDRA_HOME`
  // is a process-level env var (`workspace.ts` re-reads it on every call, see
  // its own comment), and both `startServerFor` and `startRegistryFor`
  // overwrite it. The GUI side must finish and `cleanup()` before the CLI
  // side starts, or both sides' file operations would hit the same temp
  // directory.

  // 1) slide add (Blank): GUI goes through New > Blank, the equivalent CLI is
  //    `slide add --at 1` (insertAt = hasSlides ? currentIndex+1 : 0, currentIndex is 0 right after load).
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      await page.locator(".rail-actions").getByRole("button", { name: "New" }).click();
      const menu = page.locator('[role="menu"][data-menu="new"]');
      await expect.poll(() => menu.getByRole("menuitem", { name: "Blank" }).isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: "Blank" }).click();
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(5);
      guiProject = await readProject(gui.registry, gui.presentationId);
      guiContent = await readSlide(gui.registry, gui.presentationId, guiProject.slides[1]);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch<{ slidePath: string }>("slide add", {
        id: cli.presentationId,
        at: 1,
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);
      const cliContent = await readSlide(cli.registry, cli.presentationId, cliResult.data!.slidePath);

      expect(cliProject).toEqual(guiProject);
      expect(cliContent).toBe(guiContent); // blank slides carry no ids — no normalization needed
    } finally {
      await cli.cleanup();
    }
  }

  // 2) slide duplicate: GUI goes through the thumbnail context menu, the
  //    equivalent CLI is `slide duplicate slides/001.svg`. Duplicating re-mints
  //    element ids, so normalize before comparing.
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
      const menu = page.locator('[data-testid="thumb-context-menu"]');
      await expect.poll(() => menu.isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: /^Duplicate slide/ }).click();
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(5);
      guiProject = await readProject(gui.registry, gui.presentationId);
      guiContent = normalizeIds(await readSlide(gui.registry, gui.presentationId, guiProject.slides[1]));
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch<{ slidePath: string }>("slide duplicate", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);
      const cliContent = normalizeIds(await readSlide(cli.registry, cli.presentationId, cliResult.data!.slidePath));

      expect(cliProject).toEqual(guiProject);
      expect(cliContent).toBe(guiContent);
    } finally {
      await cli.cleanup();
    }
  }

  // 3) slide delete: GUI presses the Delete key (no selection), the equivalent CLI is `slide delete slides/001.svg`.
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    try {
      const page = await openApp(gui.server);
      await page.locator(".rail-slides-label").click();
      await page.keyboard.press("Delete");
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(3);
      guiProject = await readProject(gui.registry, gui.presentationId);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide delete", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);

      expect(cliProject).toEqual(guiProject);
    } finally {
      await cli.cleanup();
    }
  }

  // 4) slide move: GUI drags (same drag as test B: 0 dragged to slide 2's
  //    bottom edge -> newIndex=2), the equivalent CLI is `slide move
  //    slides/001.svg 2`. Only touches project.json, doesn't open any SVG.
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    try {
      const page = await openApp(gui.server);
      await dragOver(page, 0, 2, "bottom");
      await drop(page, 2, "bottom");
      await dragEnd(page, 0);
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides, { timeout: 10_000 })
        .toEqual(["slides/002.svg", "slides/003.svg", "slides/001.svg", "slides/004.svg"]);
      guiProject = await readProject(gui.registry, gui.presentationId);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide move", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
        newIndex: 2,
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);

      expect(cliProject).toEqual(guiProject);
    } finally {
      await cli.cleanup();
    }
  }

  // 5) slide notes set: GUI types + blur, the equivalent CLI is `slide notes set slides/001.svg "…"`.
  {
    const text = "GUI/CLI equivalence test notes";
    const gui = await startServerFor();
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      const notes = page.getByRole("textbox", { name: "Speaker notes" });
      await notes.click();
      await notes.fill(text);
      await page.locator(".rail-slides-label").click();
      await expect
        .poll(async () => readSlide(gui.registry, gui.presentationId, "slides/001.svg"), { timeout: 10_000 })
        .toEqual(expect.stringContaining(text));
      guiContent = await readSlide(gui.registry, gui.presentationId, "slides/001.svg");
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide notes set", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
        text,
      });
      expect(cliResult.ok).toBe(true);
      const cliContent = await readSlide(cli.registry, cli.presentationId, "slides/001.svg");

      expect(cliContent).toBe(guiContent);
    } finally {
      await cli.cleanup();
    }
  }
});
