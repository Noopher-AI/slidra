// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { connectDeckServerRegistry, createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Element selection: clicking an element on the canvas in view mode
 * selects it, draws a four-corner box over it in a Shadow DOM, and shows
 * its display name (or id fallback) in the status bar. Modeled on
 * e2e/demo-deck.test.ts's startServerFor shape and e2e/player-hostile.test.ts's
 * hostile-fixture posture.
 *
 * Every click below uses a real Playwright locator click (dispatches a
 * trusted mouse event) or `page.mouse.click()` at a measured coordinate —
 * never `element.click()` inside page script — because wave 4's grid unit
 * found a real gap here: DOM `.click()` passes even when a missing
 * `pointer-events: none` would swallow a genuine mouse event.
 *
 * Scenario ↔ test cross-reference table (05-INTERACTIONS.feature):
 *
 * - Feature "Selection" › Scenario "Single select" (selection box appears /
 *   top-left name label / context bar directly below):
 *   - "clicking an element on the canvas selects it, showing a four-corner box (drawn in the Shadow DOM, not eight b/u handles)"
 *   - "the status bar shows the selected element's display name; an element with no display name shows its id instead"
 *   - "selecting a single element: a name label appears (above the selection box) along with the context bar (below the selection box)"
 *   - "baseline screenshot: standard view with selection box" / "clicking the background on demo slide 1 selects the background container..."
 *   - "hostile slide CSS cannot cover the Shadow DOM selection box..." / "a slide's own script intercepts the click first..."
 *   - "selection still works after leaving play mode: ..."
 *   - The context bar's "flips above when there's not enough room below" branch: not e2e'd in this file — see the explanatory block before the "the presentation file's bytes are completely unchanged after selection" test — it's covered precisely by packages/web/test/stage-overlays.test.ts (a pure-logic unit test).
 * - Feature "Selection" › Scenario "Multi-select" / "Select all / deselect": ⇧-click/box-select/⌘A are direct stage operations,
 *   tested in e2e/direct-manipulation.test.ts ("shift-clicking two elements then dragging them together",
 *   "dragging a box-select rectangle from empty space", "⌘A selects all top-level elements on the page..."); this file only tests
 *   "clicking empty space deselects, clearing the status bar's selection display" (the Esc/click-empty-space-to-clear half).
 * - Feature "Groups (including nested)" › Scenario "Select group":
 *   - "clicking a child inside a group selects the whole group, and the status bar shows the group's display name"
 *   - "selecting a group shows a dashed box"
 * - Feature "Groups (including nested)" › Scenario "Drill in" (label shows the path "Group 2 › Group 1"):
 *   - "drilling into nested groups one level at a time stacks dashed boxes: each level entered adds one box, and outer boxes stay put"
 *   - "exiting one level at a time with Esc: each press collapses only the innermost box, and outer boxes remain until they too are exited"
 *   - "the drag target matches the selection level: ..."
 *   - "baseline screenshot: dashed box while editing a group" / "baseline screenshot: label after drilling into a group (Group 2 › Group 1 path)"
 * - Feature "Groups (including nested)" › Scenario "Group" / "Nested" / "Ungroup" (the Dock's
 *   Group/Ungroup buttons; the disabled-state matrix itself is tested in
 *   packages/web/test/dock.test.ts — this file only tests that the button actually issues the command and the file actually changes):
 *   - "grouping: shift-selecting 2 elements and clicking Group removes the members' own animations and shows a toast"
 *     (includes the group-toast baseline screenshot)
 *   - "nesting: selecting one existing group plus one element and clicking Group wraps them in an outer layer, leaving the existing group untouched"
 *   - "ungrouping: selecting a whole group and clicking Ungroup dissolves only the current level — the inner group and its animation are preserved, only the outer level is removed"
 *
 * The remaining test cases (sandbox attributes, play-mode interactions) don't
 * map to the scenarios above; each one's own title is self-descriptive.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "docs/demo");
const hostileDeckDir = path.join(e2eDir, "fixtures/hostile-selection-deck");
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

async function startServerFor(
  deckDir: string,
): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-selection-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-selection-files-"));
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
      E2E_NEW_TITLE: "this test does not send a message",
    },
  };

  const server = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent });
  const live = await connectDeckServerRegistry(server.url);
  agent.env!.E2E_PRESENTATION_ID = live.presentationId;

  return {
    server,
    registry: live.registry,
    presentationId: live.presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
    },
  };
}

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

/**
 * The Playwright `Frame` object for the main canvas iframe, distinguished
 * from the overview thumbnail iframes (which also have `srcdoc` documents)
 * by its `class="slide-frame"` element — same disambiguation
 * e2e/player.test.ts already uses. Needed whenever a test has to run JS
 * *inside* the iframe's own document (its opaque origin makes normal
 * cross-document access from page script impossible; Playwright's CDP-based
 * `Frame.evaluate` is not subject to that restriction).
 */
async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("could not find the main canvas's iframe.slide-frame");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

it("view mode's main canvas iframe sandbox is allow-scripts and does not include allow-same-origin", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  } finally {
    await cleanup();
  }
});

// ADR-0007: this loosening is cut in exactly one place, the main canvas —
// the overview rail's thumbnails must stay zero-token.
it("the overview thumbnails' iframe sandbox stays zero-token (this loosening applies only to the main canvas)", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await expect.poll(() => page.locator("iframe.overview-frame").count()).toBeGreaterThan(0);
    const thumbSandbox = await page.locator("iframe.overview-frame").first().getAttribute("sandbox");
    expect(thumbSandbox).toBe("");
  } finally {
    await cleanup();
  }
});

it("clicking an element on the canvas selects it, showing a four-corner box (drawn in the Shadow DOM, not eight b/u handles)", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const titleLocator = page.frameLocator("iframe.slide-frame").locator("#el-title");
    await titleLocator.click();

    const frame = await canvasFrame(page);
    const corners = await frame.evaluate(() => {
      // The shadow host carries a stable attribute (selection-runtime.js),
      // not a DOM-position assumption — the runtime is injected before
      // the fetched slide markup (#56 fix), so the host is not
      // document.body's last child.
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const root = host.shadowRoot;
      if (!root) return null;
      const sel = root.querySelector(".sel");
      const i = sel?.querySelector("i") ?? null;
      if (!sel || !i) return null;
      const contentOf = (el: Element, pseudo: string) => getComputedStyle(el, pseudo).content;
      return {
        display: getComputedStyle(sel).display,
        topLeft: contentOf(sel, "::before"),
        topRight: contentOf(sel, "::after"),
        bottomLeft: contentOf(i, "::before"),
        bottomRight: contentOf(i, "::after"),
        // exactly four corners, never eight handles — the
        // template's `b`/`u` elements must never be created.
        hasB: root.querySelector("b") !== null,
        hasU: root.querySelector("u") !== null,
      };
    });

    expect(corners).not.toBeNull();
    expect(corners!.display).toBe("block");
    expect(corners!.topLeft).not.toBe("none");
    expect(corners!.topRight).not.toBe("none");
    expect(corners!.bottomLeft).not.toBe("none");
    expect(corners!.bottomRight).not.toBe("none");
    expect(corners!.hasB).toBe(false);
    expect(corners!.hasU).toBe(false);
  } finally {
    await cleanup();
  }
});

it("the status bar shows the selected element's display name; an element with no display name shows its id instead", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Title");

    await slideFrame.locator("#el-plain").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: el-plain");
  } finally {
    await cleanup();
  }
});

/**
 * A deck built inside the test, so a test that needs a particular slide
 * shape does not have to bend `demo/` (or `e2e/fixtures/`, which other
 * tests own) into that shape. Written in the compliant container form
 * (ADR-0008).
 */
async function makeDeckDir(slideSvg: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-selection-deck-"));
  await mkdir(path.join(dir, "slides"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(
    path.join(dir, "project.json"),
    JSON.stringify(
      { formatVersion: 1, name: "Selection Test Deck", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(path.join(dir, "slides/001.svg"), slideSvg, "utf-8");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// This test used `demo/` until #72, and cannot any more — for a reason that
// is the ticket itself. Demo slide 1's background `<rect>` is now an
// element of its own inside a container with an id, so there is no longer
// any point on that page with nothing under it. Leaving the background out
// of conversion just to keep one test's assumption alive would be the wrong
// repair, so the test brings its own deck instead: one small square with
// generous empty space around it.
it("clicking empty space deselects, clearing the status bar's selection display", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-square" data-slidra-name="Square">\n' +
      '    <rect x="540" y="280" width="200" height="160" fill="#c66"/>\n' +
      "  </g>\n" +
      // openApp waits for the first painted <text>; a deck with none would
      // never finish loading as far as that helper is concerned.
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="500" text-anchor="middle" font-size="32" fill="#9aa7b4">Square</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-square").click();
    // The postMessage round trip from selection-runtime.js to React state
    // is asynchronous — poll rather than reading immediately after click.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).not.toBe("");

    // The slide's top-left corner: the square sits at x=540 y=280 on a
    // 1280×720 viewBox, so this point has no element under it at all.
    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("could not measure the svg's bounding box");
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("none");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// 05-INTERACTIONS.feature's "Selection › Single select" scenario has two
// "and" clauses — "a name label appears at top-left" and "the context bar
// appears directly below the selection box (flipping above when there's
// not enough room)" — that previously had no e2e coverage at all (the
// coordinate-conversion logic itself is unit-tested in
// packages/web/test/stage-overlays.test.ts; this verifies the final on-screen
// position in a real browser).
it("selecting a single element: a name label appears (above the selection box) along with the context bar (below the selection box)", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-square" data-slidra-name="Square">\n' +
      // Bottom edge at y=200, leaving 520 user units of slide below it —
      // comfortably more than the context bar's fixed 49 CSS px (GAP 13 +
      // BAR_HEIGHT 36) floor at any realistic render scale.
      '    <rect x="540" y="100" width="200" height="100" fill="#c66"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="500" text-anchor="middle" font-size="32" fill="#9aa7b4">Square</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-square").click();

    const label = page.locator(".selection-label");
    await expect.poll(() => label.textContent().catch(() => null)).toBe("Square");

    const selBox = await slideFrame.locator(".sel").boundingBox();
    const labelBox = await label.boundingBox();
    const barBox = await page.locator(".context-bar").boundingBox();
    expect(selBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(barBox).not.toBeNull();

    // Label sits above the selection box's own top edge (a small tolerance
    // for sub-pixel layout rounding, not for being wrong by a whole line).
    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(selBox!.y + 1);
    // Context bar sits below the selection box's own bottom edge.
    expect(barBox!.y).toBeGreaterThanOrEqual(selBox!.y + selBox!.height - 1);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// a bullet-list layout's second line used to sit
// right where the (always-opaque, always-`pointer-events:auto`) context bar
// renders after selecting the first line — the bar visually and hit-test
// blocked that line, so clicking it (or ⇧-clicking it to add to the
// selection) landed on the bar instead. Fixed by making the bar itself
// ghost (semi-transparent, `pointer-events:none`) until the pointer actually hovers it
// for `HOVER_SOLIDIFY_MS`, and reverting to ghost after it leaves for
// `HOVER_GHOST_MS` (`OverlayLayer`'s `createHoverSolidifier`,
// `packages/web/test/stage-overlays.test.ts` unit-tests the delay logic
// itself directly). This is the one e2e case that crosses the parent
// document/iframe boundary the unit tests cannot reach: a real click must
// pass through the bar's on-screen position into the iframe underneath it.
it("the context bar passes clicks through to blocked content underneath while unhovered; hovering long enough lets its own button receive clicks", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-title" data-slidra-name="Title">\n' +
      '    <rect x="100" y="60" width="1080" height="100" fill="#c66"/>\n' +
      // openApp() waits for the slide's first painted <text> before
      // returning — this fixture is otherwise all <rect>.
      '    <text x="120" y="120" font-size="20">Title</text>\n' +
      "  </g>\n" +
      // Starts right at the title's bottom edge and runs deep enough
      // (measured empirically: with this deck's viewBox/viewport pair the
      // context bar renders fully inside this rect's on-screen box) that
      // the bar's fixed CSS-px band below the title always lands on top of
      // it, reproducing the "context bar blocks the next line" layout.
      '  <g id="el-subtitle" data-slidra-name="Subtitle">\n' +
      '    <rect x="100" y="170" width="1080" height="400" fill="#6c9"/>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-title").click();
    await expect.poll(() => page.locator(".selection-label").textContent().catch(() => null)).toBe("Title");

    const barBox = await page.locator(".context-bar").boundingBox();
    expect(barBox).not.toBeNull();
    expect(await page.locator(".context-bar.is-solid").count()).toBe(0);
    const overBar = { x: barBox!.x + barBox!.width / 2, y: barBox!.y + barBox!.height / 2 };

    // Ghost state, no hover yet: a real mouse click at the bar's own
    // on-screen position must pass straight through to the subtitle rect
    // the bar happens to be sitting on top of.
    await page.mouse.click(overBar.x, overBar.y);
    await expect.poll(() => page.locator(".selection-label").textContent().catch(() => null)).toBe("Subtitle");

    // Hover the (subtitle's own, freshly repositioned) bar long enough to
    // solidify, then its Delete button must actually receive a click —
    // proof `.is-solid` really flips `pointer-events` back to `auto`, not
    // just a class name with no effect.
    const barBox2 = await page.locator(".context-bar").boundingBox();
    expect(barBox2).not.toBeNull();
    await page.mouse.move(barBox2!.x + barBox2!.width / 2, barBox2!.y + barBox2!.height / 2);
    await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
    await page.locator('.context-bar button[title="Delete"]').click();

    await expect.poll(() => slideFrame.locator("#el-subtitle").count()).toBe(0);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// The above-flip branch (`ContextBar`'s `fitsBelow === false`) is NOT
// e2e'd here — measured directly (see this PR's delivery notes): `.canvas-
// area`'s CSS reserves a FIXED `--space-gutter-bottom: 76px` below the
// rendered slide (packages/web/src/styles/tokens.css), and the flip
// threshold is GAP(8) + BAR_HEIGHT(40) = 48px < 76px. Any element placed
// anywhere within the slide's own bounds therefore always leaves at least
// 76px below it — `fitsBelow` is mathematically guaranteed true for every
// reachable-by-content-placement position, at every viewport size tried
// (probed at well heights from ~150px to ~700px). The flip branch is only
// reachable through zoom+pan pushing a selection's on-screen box past the
// visible well's edge, which this suite does not attempt to orchestrate
// precisely — `packages/web/test/stage-overlays.test.ts` unit-tests both
// branches of `ContextBar`'s `fitsBelow` decision directly against its own
// props instead, including the exact boundary case, which is the more
// precise place to pin this particular piece of logic down.

it("the presentation file's bytes are completely unchanged after selection", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor(demoDir);
  try {
    const before = sha256(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!
        .content,
    );

    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await page.frameLocator("iframe.slide-frame").locator("#el-subtitle").click();

    const after = sha256(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!
        .content,
    );
    expect(after).toBe(before);
  } finally {
    await cleanup();
  }
});

// ADR-0007's own reasoning: a slide's `*`/`::before` rule cannot cross a
// Shadow DOM boundary, which is what selection-runtime.js relies on to
// keep its box visible under hostile CSS. This test proves the boundary
// actually holds by building a second, deliberately naive light-DOM box
// with the same markup inside the same iframe and showing the fixture
// really does defeat it — a fixture that fails to defeat a naive
// implementation would prove nothing about the Shadow DOM.
it("hostile slide CSS cannot cover the Shadow DOM selection box, though the same CSS does cover a non-Shadow-DOM control", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const frame = await canvasFrame(page);
    const measurement = await frame.evaluate(() => {
      // The real box selection-runtime.js already drew, inside its shadow
      // root — protected by the host's own inline !important styles.
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const realBox = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      if (!realBox) return null;
      const realStyle = getComputedStyle(realBox);

      // The naive control: the *same* markup (`.sel` + `<i>`), but placed
      // directly in the light DOM with no shadow root and no inline
      // !important defence — exactly what selection-runtime.js would look
      // like without ADR-0007's Shadow DOM requirement.
      const control = document.createElement("div");
      control.className = "sel";
      control.appendChild(document.createElement("i"));
      document.body.appendChild(control);
      const controlStyle = getComputedStyle(control);

      return {
        realDisplay: realStyle.display,
        realVisibility: realStyle.visibility,
        realOpacity: realStyle.opacity,
        controlDisplay: controlStyle.display,
        controlVisibility: controlStyle.visibility,
        controlOpacity: controlStyle.opacity,
        // Corroborating, not conclusive, evidence for the covering vector
        // (the full-viewport high-z-index overlay): the CSS values the
        // browser's own paint-order algorithm uses. This does not
        // substitute for a pixel-level "is it actually painted on top"
        // measurement — see the unit's own report for why one was not
        // attempted (the box is deliberately `pointer-events: none`,
        // which excludes it from `elementFromPoint` hit-testing, the
        // usual non-pixel way to ask "what's on top here").
        hostZIndex: getComputedStyle(host).zIndex,
        hostPosition: getComputedStyle(host).position,
      };
    });

    expect(measurement).not.toBeNull();
    // The naive light-DOM control genuinely gets defeated by the hostile
    // `*` rule — proving this fixture is actually hostile, not a no-op.
    expect(measurement!.controlDisplay).toBe("none");
    expect(measurement!.controlVisibility).toBe("hidden");
    expect(measurement!.controlOpacity).toBe("0");
    // The real, shadow-DOM box survives the exact same stylesheet.
    expect(measurement!.realDisplay).toBe("block");
    expect(measurement!.realVisibility).toBe("visible");
    expect(measurement!.realOpacity).toBe("1");
    // The overlay's own z-index is 999999999; our host's inline
    // !important z-index (2147483647, the max signed 32-bit value) and
    // `position: fixed` outrank it in the values the cascade computes,
    // even though this test does not sample pixels to confirm paint order.
    expect(Number(measurement!.hostZIndex)).toBeGreaterThan(999999999);
    expect(measurement!.hostPosition).toBe("fixed");
  } finally {
    await cleanup();
  }
});

// the view-mode iframe has `allow-scripts` too
// (ADR-0007), so any slide script can forge a `slidra-player` message by
// hand — `event.source === frame.contentWindow` only proves which iframe
// sent it, never which script inside that iframe did. Before canvas.ts's
// mode gate, this forged message drove advancePastEnd() and replaced the
// view-mode srcdoc with the play document (containing
// `window.__SLIDRA_PLAN__`) while mode stayed "view" — reproduced directly
// against this branch's pre-fix canvas.ts. Slide 2 of hostile-selection-deck
// carries the forging script; slide 1's hostile CSS plays no part here.
// Slide 2 is deliberately not the deck's last slide (slide 3 is harmless
// filler after it): advancePastEnd() is a no-op on the last slide even
// with no gate at all, so landing on the true last slide would make this
// test pass whether or not the fix is in place.
it("in view mode, a slide forging a slidra-player message neither advances the slide nor swaps the iframe to the play document", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const pageIndicator = page.locator(".slide-nav-position");
    const slideFrame = page.locator("iframe.slide-frame");

    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 1 of 4");
    await page.locator('button[aria-label="Next slide"]').click();
    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 2 of 4");

    const sandbox = await slideFrame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");

    // Slide 2's script fires its forged message 300ms after load; give it
    // comfortably longer than that before asserting nothing moved.
    await page.waitForTimeout(600);

    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 2 of 4");
    const srcdoc = await slideFrame.getAttribute("srcdoc");
    expect(srcdoc).not.toBeNull();
    expect(srcdoc).not.toContain("__SLIDRA_PLAN__");
  } finally {
    await cleanup();
  }
});

// slide 4 of hostile-selection-deck installs a
// capturing `window` click listener that calls
// `event.stopImmediatePropagation()` the moment its inline script runs.
// Before the fix, this silently killed selection with no visible error:
// wrapSelectionDocument() put the runtime AFTER the slide markup, so the
// slide's script ran (and registered) first, and the runtime's own
// listener lived on `document`/bubbling, which capture never even
// reaches. The click below is a real mouse click (Playwright locator
// click), never `element.click()` in page script, per this file's own
// posture note above.
it("a slide's own script intercepting the click first (stopImmediatePropagation) still can't block selection: the status bar and selection box still update", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const pageIndicator = page.locator(".slide-nav-position");
    for (let i = 0; i < 3; i++) {
      await page.locator('button[aria-label="Next slide"]').click();
    }
    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 4 of 4");

    const selName = page.locator(".status-selection-chip");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Title");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("block");
  } finally {
    await cleanup();
  }
});

// exitPlay() destroys the play iframe and rebuilds it in view
// mode — that rebuild must re-inject selection-runtime.js, or selection
// silently stops working with no error and no failed assertion anywhere
// else. Both the status bar text and the Shadow DOM box are asserted: the
// status bar alone would not catch a rebuilt frame that lost its box.
it("selection still works after leaving play mode: the status bar shows the display name, and the selection box is still drawn in the Shadow DOM", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);

    await page.locator(".play-from-start-button").click();
    // Shell collapsing (titlebar unmounts) is direct evidence play mode
    // took effect — same signal e2e/shell.test.ts polls after this same
    // click, chosen over the sandbox attribute because both modes now
    // carry allow-scripts (ADR-0007).
    await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

    await page.locator('button:has-text("Exit Play")').click();
    // Symmetric wait for the round trip back to view mode: the titlebar
    // (and with it its own Play-from-start button) reappears.
    await expect.poll(() => page.locator(".titlebar").count()).toBe(1);

    const selName = page.locator(".status-selection-chip");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Title");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("block");
  } finally {
    await cleanup();
  }
});

// ADR-0008: a group is a container of containers, so clicking a child
// inside a group selects the whole group — PowerPoint's semantics. This is
// what switching selection to recognize containers actually buys, and it
// is invisible on `demo/` (which has no groups), so the test brings its
// own deck.
it("clicking a child inside a group selects the whole group, and the status bar shows the group's display name", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-group" data-slidra-name="Group">\n' +
      '    <g id="el-child-left" data-slidra-name="Left">\n' +
      '      <rect x="200" y="260" width="200" height="200" fill="#c66"/>\n' +
      "    </g>\n" +
      '    <g id="el-child-right" data-slidra-name="Right">\n' +
      '      <rect x="880" y="260" width="200" height="200" fill="#69c"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      // openApp waits for the first painted <text>; see makeDeckDir's other
      // caller. This one sits well outside the group.
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">Group test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const selName = page.locator(".status-selection-chip");

    // Click the child's own `<rect>`. The nearest id-carrying ancestor is
    // el-child-left; the outermost is el-group, and el-group is the answer.
    await page.frameLocator("iframe.slide-frame").locator("#el-child-left rect").click();

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Group");
    // Feature "Groups (including nested)" › Scenario "Select group": the label
    // shows the group's display name (selection stays at the top level here,
    // so groupPath is [] and the label has no "A › B" path prefix — just the name itself).
    await expect.poll(() => page.locator(".selection-label").textContent()).toBe("Group");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// --- The dashed-box visual aid for group editing -----------------------------

/**
 * The `.group-frame` overlay's box pool: one dashed box per
 * level of `groupPath` currently in scope, outermost first. Only the
 * currently-visible (`display:block`) boxes are returned — a collapsed
 * inner level leaves its pooled element behind with `display:none`, which
 * would otherwise show up as a spurious zero-rect entry.
 */
async function groupFrameBoxes(
  page: Page,
): Promise<Array<{ display: string; left: number; top: number; width: number; height: number }>> {
  const frame = await canvasFrame(page);
  return frame.evaluate(() => {
    const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const els = [...host.shadowRoot!.querySelectorAll(".group-frame")] as HTMLElement[];
    return els
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          display: getComputedStyle(el).display,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
  });
}

/**
 * Three-level nested deck for the group-frame tests: a decorative untagged
 * `<rect>` gives `el-outer` a bounding box strictly larger than (and
 * offset from) `el-inner`'s own, so "the frame moved to the inner group"
 * is a real geometry assertion rather than two rects that happen to
 * coincide because the outer group has no content of its own.
 */
async function makeNestedGroupDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-slidra-name="Outer Group">\n' +
      '    <rect x="450" y="200" width="380" height="320" fill="none" stroke="#ccc"/>\n' +
      '    <g id="el-inner" data-slidra-name="Inner Group" transform="translate(500 260)">\n' +
      '      <rect id="el-leaf" data-slidra-name="Leaf Node" width="200" height="200" fill="#c66"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      // openApp waits for the first painted <text>; see makeDeckDir's other callers.
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">Group dashed-box test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("selecting a group shows a dashed box", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);

    // Clicking the leaf resolves to the outermost id'd ancestor, el-outer
    // (the container rule already covered above) — selecting a group.
    await page.frameLocator("iframe.slide-frame").locator("#el-leaf").click();

    const boxes = await groupFrameBoxes(page);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].display).toBe("block");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("drilling into nested groups one level at a time stacks dashed boxes: each level entered adds one box, and outer boxes stay put", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    // First dblclick enters el-outer (the outermost group at top level).
    // The newly-entered scope's own selection is resolved by
    // the same outermost-within-scope rule a click/drag would use
    // (resolveClickTarget), so it lands on el-inner — the outermost
    // id-carrying element strictly inside el-outer — not directly on the
    // leaf under the pointer. This is what makes the highlighted selection
    // box match what a drag started right after this dblclick would
    // actually move (see the "the drag target matches the selection level" test below).
    // el-inner being selected-but-not-yet-entered gets the same one-frame
    // preview a plain click on any group gets ("selecting a group shows a
    // dashed box" above), on top of el-outer's own entered-scope frame —
    // 2 frames already, not 1.
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Inner Group");
    // The click/dblclick sequence's own select messages each round-trip
    // through the host (which echoes group scope + handle flags back down
    // — see canvas.ts's pushSelectionToRuntime); give the last echo time to
    // land before reading geometry, so a still-in-flight echo cannot land
    // after a later assertion/action and silently revert local state.
    await page.waitForTimeout(50);
    const afterOuter = await groupFrameBoxes(page);
    expect(afterOuter).toHaveLength(2);
    const [outerFrame, innerPreviewFrame] = afterOuter;

    // Second dblclick, now scoped inside el-outer, formally enters el-inner
    // too (it is itself a group container, wrapping el-leaf) and resolves
    // the leaf as el-inner's own outermost-within-scope descendant. Both
    // frames were already showing (as el-outer's entered-scope frame and
    // el-inner's selected-but-not-entered preview) — entering el-inner for
    // real must not move or drop either one (a single-element frame that
    // moved to the innermost level would make the outer group vanish).
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Leaf Node");
    await page.waitForTimeout(50);
    const afterInner = await groupFrameBoxes(page);
    expect(afterInner).toHaveLength(2);
    const [outerAfterInner, innerFrame] = afterInner;

    // Both frames' rects are unchanged by entering the inner level.
    expect(outerAfterInner.left).toBeCloseTo(outerFrame.left, 0);
    expect(outerAfterInner.width).toBeCloseTo(outerFrame.width, 0);
    expect(innerFrame.left).toBeCloseTo(innerPreviewFrame.left, 0);
    expect(innerFrame.width).toBeCloseTo(innerPreviewFrame.width, 0);

    // The inner group's rect is strictly contained within the outer's, per
    // the deck's own construction (el-outer's decorative rect makes it larger).
    expect(innerFrame.left).not.toBe(outerFrame.left);
    expect(innerFrame.width).toBeLessThan(outerFrame.width);
    expect(innerFrame.height).toBeLessThan(outerFrame.height);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("exiting one level at a time with Esc: each press collapses only the innermost box, and outer boxes remain until they too are exited", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Inner Group");
    await page.waitForTimeout(50);
    const [outerFrame] = await groupFrameBoxes(page);

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Leaf Node");
    // See the previous test's comment: wait for the dblclick's own select
    // message to round-trip back through the host before pressing Escape,
    // so a late-arriving echo cannot re-apply the just-entered scope on
    // top of Escape's own (synchronous, local) pop.
    await page.waitForTimeout(50);
    expect(await groupFrameBoxes(page)).toHaveLength(2);

    // First Esc: back out of el-inner, into el-outer — the innermost frame
    // is removed and the outer frame's own rect is left untouched.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    const afterFirstEsc = await groupFrameBoxes(page);
    expect(afterFirstEsc).toHaveLength(1);
    expect(afterFirstEsc[0].left).toBeCloseTo(outerFrame.left, 0);
    expect(afterFirstEsc[0].width).toBeCloseTo(outerFrame.width, 0);

    // Second Esc: back to the top level. The still-selected leaf is not a
    // group container, so every frame is gone.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    expect(await groupFrameBoxes(page)).toHaveLength(0);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

/**
 * Two-child inner group for the drag/selection-consistency test below —
 * mirrors a three-level-nested deck ⊃ inner group ⊃ blue square/pink
 * square repro. `makeNestedGroupDeck`'s inner group wraps a single leaf, so
 * its own bounding box happens to coincide with that leaf's — useless for
 * telling "the solid box wraps the leaf" apart from "the solid box wraps
 * the whole group" geometrically. Two side-by-side children make the two
 * boxes visibly different sizes.
 */
// ADR-0008's normal form requires every group's children to themselves be
// `<g>` containers ("a group is a container of containers") and forbids an
// id/data-slidra-name on a bare primitive — core's parseSlide (packages/core
// src/slide/format.ts's toElement) only recurses into a `<g>`'s children as
// real, independently addressable SlideElements when EVERY child is itself
// a `<g>`; otherwise the whole thing collapses into one opaque "compound"
// element and anything nested inside becomes unreachable by id for a
// server-side command (found the hard way: an earlier, non-compliant draft
// of this deck put id/name straight on the `<rect>`s and a stray
// id-less decorative `<rect>` next to el-inner, which silently made
// el-inner unindexable — the drag below produced zero commands and zero
// errors). el-blue/el-pink therefore get their own wrapping `<g>` each.
async function makeDragConsistencyDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-slidra-name="Outer Group">\n' +
      '    <g id="el-inner" data-slidra-name="Inner Group" transform="translate(460 220)">\n' +
      '      <g id="el-blue" data-slidra-name="Blue Square">\n' +
      '        <rect width="150" height="150" fill="#69c"/>\n' +
      "      </g>\n" +
      '      <g id="el-pink" data-slidra-name="Pink Square" transform="translate(190 0)">\n' +
      '        <rect width="150" height="150" fill="#c9a"/>\n' +
      "      </g>\n" +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">Drag consistency test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

/** `translate(x y)` on `elementId`'s own `<g>` — mirrors e2e/direct-manipulation.test.ts's own `readTranslate`. */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) throw new Error(`could not find ${elementId}'s transform`);
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) throw new Error(`${elementId}'s transform has no translate: ${elementMatch[1]}`);
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

// A regression repro — after entering a group,
// the solid selection box was drawn on a leaf while a drag actually moved
// its enclosing (un-entered) inner group. The two assertions below cover
// both halves of that mismatch directly, rather than trusting that
// "displayed" and "dragged" agree: first, that the box shown right after
// entering the group already spans the whole group (not just the child
// under the pointer); second, that dragging from that same point really
// does move the group as a rigid whole (both children shift, and neither
// child gained a transform of its own).
it("the drag target matches the selection level: the node marked by the solid box is the same node actually being dragged", async () => {
  const deck = await makeDragConsistencyDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const selName = page.locator(".status-selection-chip");
    const pink = page.frameLocator("iframe.slide-frame").locator("#el-pink");

    // One dblclick enters el-outer; el-pink's outermost-within-scope
    // ancestor is el-inner (a group wrapping both el-blue and el-pink), so
    // the solid selection box must land on the whole group, not on
    // el-pink alone.
    await pink.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Inner Group");
    await page.waitForTimeout(50);

    // The iframe is sandboxed without allow-same-origin (see the sandbox
    // test above), so its contentDocument is unreachable from page-level
    // script — canvasFrame's CDP-based Frame.evaluate is the only way in,
    // same as groupFrameBoxes above.
    const frame = await canvasFrame(page);
    const selBox = await frame.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const rect = host.shadowRoot!.querySelector(".sel")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const pinkBox = await pink.boundingBox();
    if (!pinkBox) throw new Error("could not measure el-pink's bounding box");
    // el-inner's own box (blue + pink side by side) is roughly twice as
    // wide as el-pink alone — a box that had wrongly wrapped just the leaf
    // would be close to pinkBox.width, not ~2x it.
    expect(selBox.width).toBeGreaterThan(pinkBox.width * 1.5);

    const before = (
      await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })
    ).data!.content;
    const innerBefore = readTranslate(before, "el-inner");
    const pinkLocalBefore = readTranslate(before, "el-pink");

    // Alt disables snap-to-guide (direct-manipulation.test.ts's own
    // convention) — without it this drag's endpoint can land within
    // snapping distance of a guide and get pulled back to (effectively)
    // its start position, which is not what this test means to prove.
    const from = { x: pinkBox.x + pinkBox.width / 2, y: pinkBox.y + pinkBox.height / 2 };
    await page.keyboard.down("Alt");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 90, { steps: 5 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(150);

    const after = (
      await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })
    ).data!.content;
    // el-blue never had a transform of its own and still doesn't; el-pink
    // keeps exactly its original local offset — neither child moved
    // independently, only el-inner did, as one rigid unit.
    expect(/<g id="el-blue"[^>]*transform=/.test(after)).toBe(false);
    expect(readTranslate(after, "el-pink")).toEqual(pinkLocalBefore);
    const innerAfter = readTranslate(after, "el-inner");
    expect(innerAfter.x).not.toBe(innerBefore.x);
    expect(innerAfter.y).not.toBe(innerBefore.y);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("the label after drilling into a group (Group 2 › Group 1 path)", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    // Two dblclicks drills all the way to the leaf, same sequence as
    // "drilling into nested groups one level at a time" above — label
    // ends up "outer group › inner group › leaf node".
    await slideLeaf.dblclick();
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Leaf Node");
    await expect.poll(() => page.locator(".selection-label").textContent()).toBe("Outer Group › Inner Group › Leaf Node");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// --- Grouping/ungrouping (the Dock's Group/Ungroup buttons) ----------------

/** How many effect items the slide currently has, straight off the server (independent of what the GUI has rendered). */
async function effectCount(registry: CommandRegistry, presentationId: string): Promise<number> {
  const result = await registry.dispatch<{ effects: unknown[] }>("effect list", { id: presentationId, slidePath: "slides/001.svg" });
  return result.ok ? result.data!.effects.length : -1;
}

// Two same-layer elements, both above the vertical midline — the "group-
// toast" screenshot below clips to the dock ∪ toast union, and needs
// whatever sits *behind* that strip (through the glass blur) to be the same
// blank space before and after the reload `element group` triggers (see
// that test's own comment for why).
async function makeGroupCommandDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-a" data-slidra-name="Rectangle A">\n' +
      '    <rect x="200" y="80" width="160" height="120" fill="#c66"/>\n' +
      "  </g>\n" +
      '  <g id="el-b" data-slidra-name="Rectangle B">\n' +
      '    <rect x="500" y="80" width="160" height="120" fill="#69c"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="260" text-anchor="middle" font-size="32" fill="#9aa7b4">Grouping test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("grouping: shift-selecting 2 elements and clicking Group removes the members' own animations and shows a toast", async () => {
  const deck = await makeGroupCommandDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    // el-a carries an animation of its own before grouping — a
    // member's individual animation does not carry over into the new group.
    const added = await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"],
      family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0,
    });
    expect(added.ok).toBe(true);
    expect(await effectCount(registry, presentationId)).toBe(1);

    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Group"]');

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();

    const toast = page.locator(".dock-toast");
    await expect.poll(() => toast.textContent()).toBe("Grouped 2 elements · their animations were removed");

    // After grouping, selection becomes the new group itself; the new group
    // is auto-named Group 1.
    // Moved ahead of the screenshot: the dock button's enabled/disabled
    // state tracks whether selection has been restored, not whether the
    // toast has merely appeared — it is not decoupled from reload progress.
    // What we wait for here is that same reload, just switched from
    // "ignore it" to "wait for it to land", so the screenshot below is
    // pinned to the state after reload instead of racing it (the original
    // "don't wait for reload to finish" assumption doesn't hold for this
    // member, and got amplified into occasional flakiness by a faster reload).
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Group 1");
    expect(await effectCount(registry, presentationId)).toBe(0);

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    const groupMatch = /<g id="(el-[^"]+)" data-slidra-name="Group 1">/.exec(svg);
    if (!groupMatch) throw new Error("could not find the new group's <g data-slidra-name=\"Group 1\">");
    expect(svg.indexOf('id="el-a"')).toBeGreaterThan(groupMatch.index);
    expect(svg.indexOf('id="el-b"')).toBeGreaterThan(groupMatch.index);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// A pre-existing group (el-group ⊃ el-child) sitting next to a lone element
// (el-extra), both direct children of <svg> — selecting "one existing group
// + one element" and grouping them is the "nested" scenario (05-INTERACTIONS
// .feature's "Groups (including nested)").
async function makeNestingCommandDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-group" data-slidra-name="Subgroup">\n' +
      '    <g id="el-child" data-slidra-name="Child">\n' +
      '      <rect x="150" y="80" width="120" height="100" fill="#c66"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-extra" data-slidra-name="Extra Element">\n' +
      '    <rect x="450" y="80" width="120" height="100" fill="#69c"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="300" text-anchor="middle" font-size="32" fill="#9aa7b4">Nested grouping test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("nesting: selecting one existing group plus one element and clicking Group wraps them in an outer layer, leaving the existing group untouched", async () => {
  const deck = await makeNestingCommandDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Group"]');

    // Clicking el-child resolves to its outermost id-carrying ancestor,
    // el-group — selecting the whole pre-existing group.
    await slideFrame.locator("#el-child").click();
    await slideFrame.locator("#el-extra").click({ modifiers: ["Shift"] });
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
    expect(await groupButton.getAttribute("aria-label")).toBe("Group");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();
    await expect.poll(() => page.locator(".dock-toast").textContent()).toBe("Grouped 2 elements");

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    // The pre-existing group and its own child are untouched; a new outer
    // group wraps el-group (as a whole) and el-extra.
    expect(svg).toContain('id="el-group"');
    expect(svg).toContain('id="el-child"');
    const outerMatch = /<g id="(el-[^"]+)" data-slidra-name="Group 1">/.exec(svg);
    if (!outerMatch) throw new Error("could not find the new outer group");
    expect(svg.indexOf('id="el-group"')).toBeGreaterThan(outerMatch.index);
    expect(svg.indexOf('id="el-extra"')).toBeGreaterThan(outerMatch.index);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// `makeNestedGroupDeck` (used by the group-frame test series) deliberately
// mixes in an id-less decorative <rect> under el-outer — ADR-0008's
// compliance rule requires a container's children to be "all <g>, or all
// primitives", so this fixture is only legal at selection-runtime's
// rendering layer. Sending it into `element group/ungroup` (which goes
// through assertSlideCompliant) fails outright with a 403: "container has
// both primitives and child containers". So this builds a separate,
// fully-compliant three-level nested deck.
async function makeCompliantNestedDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-slidra-name="Outer Group">\n' +
      '    <g id="el-inner" data-slidra-name="Inner Group" transform="translate(500 60)">\n' +
      '      <g id="el-leaf" data-slidra-name="Leaf Node">\n' +
      '        <rect width="200" height="200" fill="#c66"/>\n' +
      "      </g>\n" +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-caption" data-slidra-name="Caption">\n' +
      '    <text x="640" y="600" text-anchor="middle" font-size="32" fill="#9aa7b4">Ungroup test</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("ungrouping: selecting a whole group and clicking Ungroup dissolves only the current level — the inner group and its animation are preserved, only the outer level is removed", async () => {
  const deck = await makeCompliantNestedDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    // el-outer (the level about to be dissolved) carries its own animation.
    const added = await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-outer"],
      family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0,
    });
    expect(added.ok).toBe(true);

    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Ungroup"]');

    // Not yet drilled into anything: clicking the leaf resolves to the
    // outermost group at top scope, el-outer.
    await slideLeaf.click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Outer Group");
    expect(await groupButton.getAttribute("aria-label")).toBe("Ungroup");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();
    await expect.poll(() => page.locator(".dock-toast").textContent()).toBe("Ungrouped · the group animation was removed");

    // After ungrouping, selection becomes the dissolved group's direct
    // child — el-outer's only direct child is el-inner.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Inner Group");
    expect(await effectCount(registry, presentationId)).toBe(0);

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    expect(svg).not.toContain('id="el-outer"');
    // Only the current level is dissolved: the inner group (and its leaf node) is preserved untouched.
    expect(svg).toContain('id="el-inner"');
    expect(svg).toContain('id="el-leaf"');
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});
