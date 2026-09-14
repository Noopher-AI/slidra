// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, requireBuilt, startServerFor, type StartedServer } from "./helpers/launch.js";

/**
 * The bottom glass toolbar's insert scenarios (image/video/audio/shape) and
 * the Shape menu scenario, driven through a real Chromium against a real
 * server (existing `table.test.ts`/`chart.test.ts` pattern). Appearance
 * (panel/menu centred over the dock) is not asserted here — this file is
 * behaviour only.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "docs/demo");
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

describe("bottom glass toolbar — insert panels (insert always asks for type first)", () => {
  it("clicking Image/Video/Audio/Shape each opens its floating panel centered directly above the dock", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-open" });
    try {
      const page = await openPage(started.server);

      for (const label of ["Image", "Video", "Audio"] as const) {
        await page.getByRole("button", { name: label }).click();
        const panel = page.locator(`.media-panel[aria-label="${label}"]`);
        await expect.poll(() => panel.count()).toBe(1);
        const dockBox = (await page.locator(".dock").boundingBox())!;
        const panelBox = (await panel.boundingBox())!;
        // "Centered directly above": horizontally centred over
        // the whole dock, sitting above it — exact centring, ±2px for
        // sub-pixel rounding.
        expect(Math.abs(panelBox.x + panelBox.width / 2 - (dockBox.x + dockBox.width / 2))).toBeLessThan(2);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(dockBox.y + 1);
        // Close it, move to the next one
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

  it("Image/Video/Audio panels each have a file picker, a URL field, and a caption field", async () => {
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

  it("Image panel: import from URL + caption, clicking Insert adds the element to the current page, selects it, and closes the panel", async () => {
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
      await panel.locator(".media-panel-caption").fill("my picture");
      await panel.locator(".media-panel-insert").click();

      await expect.poll(() => panel.count()).toBe(0); // panel closed

      const after = await readSlide(started);
      expect(after).not.toBe(before);
      expect(after).toContain('data-slidra-name="my picture"');
      expect(after).toMatch(/<image[^>]*href="\.\.\/assets\/photo(-1)?\.gif"/);

      // the new element is selected
      const sel = page.frameLocator("iframe.slide-frame").locator(".sel");
      await expect.poll(() => sel.boundingBox()).not.toBeNull();
    } finally {
      await started.cleanup();
      await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    }
  });

  it("Image panel: picking a local file and clicking Insert goes through controller.importAsset(file), adding the element to the current page and closing the panel", async () => {
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
      // The demo/ fixture already has its own assets/ (e.g. intro.webm used
      // by 004.svg) — only assert the one entry this import adds, don't
      // assume the directory started out empty.
      expect(listed.data!.entries).toEqual([...before.data!.entries, "photo.gif"].sort());
    } finally {
      await started.cleanup();
    }
  });

  it("Video panel: clicking Insert with all fields empty inserts a kind=video placeholder element, without importing anything", async () => {
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
      expect(after).toContain('data-slidra-type="video"');
      expect(after).not.toContain("data-slidra-media=");

      const afterAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });
      expect(afterAssets.data!.entries).toEqual(beforeAssets.data!.entries); // no import happened
      expect(after).not.toBe(before);
    } finally {
      await started.cleanup();
    }
  });

  it("pasting a YouTube URL into the Video panel doesn't download any asset — it becomes a data-slidra-embed, and the parent document overlays an <iframe> player", async () => {
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
      // There are no bytes to download for a web link: this path must
      // bypass asset import entirely.
      expect(after).toContain('data-slidra-embed="youtube"');
      expect(after).toContain('data-slidra-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc"');
      const afterAssets = await started.registry.dispatch<{ entries: string[] }>("ls", { id: started.presentationId, path: "assets" });
      expect(afterAssets.data!.entries).toEqual(beforeAssets.data!.entries);

      // The player lives in the parent document (per ADR-0011: the slide's
      // srcdoc iframe never gets allow-same-origin, so the YouTube player
      // could never load there).
      const embed = page.locator(".embed-frame");
      await expect.poll(() => embed.count()).toBe(1);
      // `enablejsapi=1` is only for loading and is never written into the
      // slide file — asserted above that the stored URL is clean. Having it
      // is what lets the media effect drive this player.
      expect(await embed.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/MtKyexX-GQc?enablejsapi=1");
    } finally {
      await started.cleanup();
    }
  });

  it("Audio panel: clicking Insert with all fields empty inserts a kind=audio placeholder element", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-audio-placeholder" });
    try {
      const page = await openPage(started.server);

      await page.getByRole("button", { name: "Audio" }).click();
      const panel = page.locator('.media-panel[aria-label="Audio"]');
      await panel.locator(".media-panel-insert").click();
      await expect.poll(() => panel.count()).toBe(0);

      const after = await readSlide(started);
      expect(after).toContain('data-slidra-type="audio"');
    } finally {
      await started.cleanup();
    }
  });
});

describe("Shape menu", () => {
  it("shows Rectangle/Ellipse/Line; clicking Rectangle inserts a rectangle, selects it, and closes the menu", async () => {
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

  it("clicking Line inserts a line element with a non-empty stroke (the fallback color when there's no pageStyle.accent, not an invisible gap)", async () => {
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

describe("disabled state (e2e covering three UI-reachable states packages/web/test/dock.test.ts doesn't reach)", () => {
  it("Animate/Arrange/Group are disabled with no selection, and Group becomes clickable once 2 elements are selected (the Insert group is unaffected)", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-disabled-state" });
    try {
      const page = await openPage(started.server);
      const animateButton = page.locator('.dock-command[aria-label="Animate"]');
      const arrangeButton = page.locator('.dock-command[aria-label="Arrange"]');
      const groupButton = page.locator('.dock-command[aria-label="Group"]');
      const textButton = page.getByRole("button", { name: "Text" });

      // With no selection: Animate/Arrange/Group are all disabled; the Insert
      // group (Text as a representative) is unaffected.
      expect(await animateButton.isDisabled()).toBe(true);
      expect(await arrangeButton.isDisabled()).toBe(true);
      expect(await groupButton.isDisabled()).toBe(true);
      expect(await textButton.isDisabled()).toBe(false);

      // Selecting 2 elements: Group becomes clickable. Select the subtitle
      // first, then Shift-add the title (not the reverse order — the
      // context bar that appears right below the title after selecting it
      // sits above the subtitle's click area, so selecting the title first
      // would make the second click hit the context bar instead of the
      // subtitle itself, and the selection would never reach 2 elements).
      const slideFrame = page.frameLocator("iframe.slide-frame");
      const selName = page.locator(".status-selection-chip");
      await slideFrame.locator("#el-subtitle").click();
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Subtitle");
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

describe("Text insert panel (typing + style presets + alignment; Enter inserts directly)", () => {
  it("typing then pressing Enter inserts the text box directly, selecting the element and closing the panel", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-text-enter" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);
      await panel.locator(".text-panel-input").fill("Enter inserts directly");
      await panel.locator(".text-panel-input").press("Enter");

      await expect.poll(() => panel.count()).toBe(0); // panel closed

      const after = await readSlide(started);
      expect(after).not.toBe(before);
      expect(after).toContain("Enter inserts directly");

      const sel = page.frameLocator("iframe.slide-frame").locator(".sel");
      await expect.poll(() => sel.boundingBox()).not.toBeNull();
    } finally {
      await started.cleanup();
    }
  });

  it("typing then pressing Shift+Enter inserts a newline without submitting, and the panel stays open", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-text-shift-enter" });
    try {
      const page = await openPage(started.server);
      const before = await readSlide(started);

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);
      const textarea = panel.locator(".text-panel-input");
      await textarea.fill("first line");
      await textarea.press("Shift+Enter");
      await textarea.type("second line");

      expect(await panel.count()).toBe(1); // panel still open
      expect(await textarea.inputValue()).toBe("first line\nsecond line");
      expect(await readSlide(started)).toBe(before); // nothing was inserted
    } finally {
      await started.cleanup();
    }
  });
});

describe("dragging a file onto an insert panel", () => {
  it("dispatching a drop event carrying a file onto the Image panel's dropzone shows the filename on the panel, without inserting anything yet", async () => {
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
          if (!dropzone) throw new Error("dropzone not found: .media-panel-dropzone");
          dropzone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
        },
        { base64: GIF_BYTES.toString("base64"), name: "dropped.gif", mime: "image/gif" },
      );

      await expect.poll(() => panel.locator(".media-panel-dropzone").textContent()).toBe("dropped.gif");
      expect(await panel.count()).toBe(1); // panel still open, nothing inserted yet
      expect(await readSlide(started)).toBe(before);
    } finally {
      await started.cleanup();
    }
  });
});

describe("Escape key priority (with a panel open and a selection active, one Escape only closes the panel and keeps the selection)", () => {
  it("with an insert panel open and a selection active: the first Escape only closes the panel and keeps the selection; a second Escape on the stage then clears the selection", async () => {
    const started = await startServerFor({ deckDir: demoDir, prefix: "insert-panels-esc-priority" });
    try {
      const page = await openPage(started.server);
      const slideFrame = page.frameLocator("iframe.slide-frame");
      const selName = page.locator(".status-selection-chip");

      await slideFrame.locator("#el-title").click();
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Title");

      await page.getByRole("button", { name: "Text" }).click();
      const panel = page.locator('.floating-layer.text-panel[aria-label="Text"]');
      await expect.poll(() => panel.count()).toBe(1);

      await page.keyboard.press("Escape");
      await expect.poll(() => panel.count()).toBe(0); // panel closed
      expect(await selName.textContent().then((t) => t?.trim())).toBe("Selected: Title"); // selection still there

      // After the panel closes, focus is still on the Dock button that
      // opened it (the parent document), not inside the iframe —
      // selection-runtime.js's Escape listener only picks up the keypress
      // when the iframe itself has focus. Clicking the already-selected
      // element (without changing the selection: same element, no
      // stacking) brings focus back into the iframe, so that the next
      // Escape is the one that clears the selection.
      await slideFrame.locator("#el-title").click();
      await page.keyboard.press("Escape");
      await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");
    } finally {
      await started.cleanup();
    }
  });
});
