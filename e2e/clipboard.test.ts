import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { JSDOM } from "jsdom";
import type { CommandRegistry } from "./helpers/cli.js";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/** Parses a slide's raw SVG text into a queryable DOM — this file's own minimal stand-in for the deleted TypeScript engine's `scanDocument`/`readTableModel` (this file's assertions only, not a new shared utility). */
function parseSlideSvg(svg: string): Document {
  return new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
}

/**
 * Clipboard: Cmd+C/Cmd+X/Cmd+V against elements (including multi-select and
 * groups) and cell ranges, cross-page pasting, and the context menu.
 * `e2e/vitest.config.ts`'s `fileParallelism: false` makes every e2e file pay
 * the full cost of a build+Chromium+server startup, so this file shares one
 * browser launch across its tests — each `it()` still packs its own fresh
 * copy of the fixture via `startServerFor`, so the tests never share
 * mutated state.
 *
 * No screenshot comparison here: per AGENTS.md's visual-regression
 * division of responsibility, only the pixel-by-pixel comparison on CI
 * counts, and this file never calls `compareScreenshot`.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/clipboard-deck");
const cliBinPath = path.join(rootDir, "target/release/slidra");

let browser: Browser;
let openPages: Page[] = [];
let startedServers: StartedServer[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
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
 * the Cmd+C test below). Reading it back immediately can race ahead of that write
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
      cliBinPath,
      args,
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
  if (jsonStart === -1) throw new Error(`CLI output has no JSON: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart)) as T;
}

const slideFrame = (page: Page) => page.frameLocator("iframe.slide-frame");

it("Cmd+C inside the sandboxed iframe writes to the system clipboard, and the content is a valid slidra clipboard SVG", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  await slideFrame(page).locator("#el-solo").click();
  const clipboardText = await copyAndWaitForClipboard(page, "el-solo");

  expect(clipboardText).toMatch(/^<svg/);
  expect(clipboardText).toContain('data-slidra-clipboard="elements"');
  expect(clipboardText).toContain('id="el-solo"');
});

it("06-KEYBOARD Cmd+X: the element leaves the slide and enters the system clipboard as one history entry, restorable with undo", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  const selChip = page.locator(".status-selection-chip");
  await slideFrame(page).locator("#el-solo").click();
  await expect.poll(() => selChip.textContent()).not.toBe("");
  await page.keyboard.press("Meta+x");
  await expect
    .poll(async () => (await readSlide(started.registry, started.presentationId, "slides/001.svg")).includes('id="el-solo"'), {
      timeout: 10_000,
    })
    .toBe(false);
  await expect.poll(() => readSystemClipboardText(page), { timeout: 10_000 }).toContain("el-solo");

  const clipboardText = await readSystemClipboardText(page);
  expect(clipboardText).toMatch(/^<svg/);
  expect(clipboardText).toContain('data-slidra-clipboard="elements"');
  expect(clipboardText).toContain('id="el-solo"');

  const afterCut = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  expect(afterCut).not.toContain('id="el-solo"');
  expect(afterCut).not.toBe(before);

  await page.keyboard.press("Meta+z");
  await expect
    .poll(() => readSlide(started.registry, started.presentationId, "slides/001.svg"), { timeout: 10_000 })
    .toBe(before);
});

it("pasting an element on the same page — a new <g>, a new id ≠ the original id, offset by exactly PASTE_OFFSET_STEP", async () => {
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
  const match = /<g id="(el-[^"]+)" data-slidra-name="Single Element" transform="translate\(120 120\)">/.exec(after);
  expect(match).not.toBeNull();
  expect(match![1]).not.toBe("el-solo");
});

it("pasting across pages — the target page gains the element and its effects (pointing at the new id), and the source page is byte-for-byte unchanged", async () => {
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
  expect(slide2).toContain(`<slidra:effect target="${newId}"`);
  expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before1);
});

it("pasting a group — both child containers get new ids, and the children's relative positions are unchanged", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  // Clicking a group's child selects the whole group (05-INTERACTIONS.feature's "selecting a group").
  await slideFrame(page).locator("#el-group-a rect").click();
  await copyAndWaitForClipboard(page, "el-group-a");
  await page.keyboard.press("Meta+v");

  await expect
    .poll(async () => {
      const svg = await readSlide(started.registry, started.presentationId, "slides/001.svg");
      return (svg.match(/data-slidra-name="Group"/g) ?? []).length;
    }, { timeout: 10_000 })
    .toBe(2);
  const after = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const doc = parseSlideSvg(after);
  const groups = [...doc.querySelectorAll('g[data-slidra-name="Group"]')];
  const pastedGroup = groups.find((el) => el.id !== "el-group");
  expect(pastedGroup).toBeDefined();
  const children = [...pastedGroup!.children].filter((el) => el.tagName === "g");
  expect(children).toHaveLength(2);
  const childIds = children.map((el) => el.id);
  expect(childIds).not.toContain("el-group-a");
  expect(childIds).not.toContain("el-group-b");
  // Original children sit at translate(0 0) and translate(80 0) — an 80px
  // horizontal gap. The pasted group's own two children must preserve it.
  const xOffsets = children.map((el) => Number(/translate\((-?[\d.]+) /.exec(el.getAttribute("transform") ?? "")?.[1] ?? "0"));
  expect(Math.abs(xOffsets[1] - xOffsets[0])).toBeCloseTo(80, 5);
});

it("copy-pasting a cell range (CLI) — a TSV round-trip, and the new text is visible in the browser after loading", async () => {
  const started = await start();
  const page = await openWithClipboard(started);

  const copyResult = await runCli([
    "table", "cell", "copy", started.presentationId, "slides/001.svg", "tbl-1", "--range", "0,0:0,2",
  ]);
  expect(copyResult.code).toBe(0);
  const { tsv } = parseCliData<{ tsv: string }>(copyResult.stdout);
  expect(tsv).toBe("A1\tB1\tC1");

  const tsvFile = path.join(await mkdtemp(path.join(tmpdir(), "slidra-e2e-clipboard-tsv-")), "cells.tsv");
  await writeFile(tsvFile, tsv, "utf-8");
  const pasteResult = await runCli([
    "table", "cell", "paste", started.presentationId, "slides/001.svg", "tbl-1", "--at", "2,0", "--tsv-file", tsvFile,
  ]);
  expect(pasteResult.code).toBe(0);
  expect(parseCliData<{ cells: number }>(pasteResult.stdout).cells).toBe(3);

  const after = await readSlide(started.registry, started.presentationId, "slides/001.svg");
  const doc = parseSlideSvg(after);
  const row2 = ["2,0", "2,1", "2,2"].map(
    (address) => doc.querySelector(`[data-slidra-cell="${address}"] text`)?.textContent ?? "",
  );
  expect(row2).toEqual(["A1", "B1", "C1"]);

  // ADR-0001: confirm the static render, not just the file bytes.
  await page.locator('.overview-item[data-index="0"] .overview-thumb').click();
  await page.reload();
  await expect.poll(() => slideFrame(page).locator('[data-slidra-cell="2,0"] text').textContent(), { timeout: 10_000 }).toBe("A1");
  expect(await slideFrame(page).locator('[data-slidra-cell="2,1"] text').textContent()).toBe("B1");
  expect(await slideFrame(page).locator('[data-slidra-cell="2,2"] text').textContent()).toBe("C1");
});

it("the file change from a paste is reproducible via CLI element paste (the GUI and the agent take the same path, differing only in the random id)", async () => {
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
  const guiNewId = /<g id="(el-[^"]+)" data-slidra-name="Single Element" transform="translate\(120 120\)">/.exec(guiResult)![1];

  await page.keyboard.press("Meta+z");
  await expect
    .poll(
      async () => (await readSlide(started.registry, started.presentationId, "slides/001.svg")).includes("translate(120 120)"),
      { timeout: 10_000 },
    )
    .toBe(false);

  const svgFile = path.join(await mkdtemp(path.join(tmpdir(), "slidra-e2e-clipboard-svg-")), "clip.svg");
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

it("untrusted content is rejected on paste — a forged clipboard SVG with onload leaves the file unchanged and shows an error", async () => {
  const started = await start();
  const page = await openWithClipboard(started);
  const before = await readSlide(started.registry, started.presentationId, "slides/001.svg");

  const hostileSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-slidra-clipboard="elements" data-slidra-source="slides/001.svg">' +
    '<g id="el-hostile" onload="fetch(\'https://evil.example\')"><rect width="10" height="10"/></g></svg>';
  await page.evaluate((svg) => navigator.clipboard.writeText(svg), hostileSvg);
  await page.keyboard.press("Meta+v");

  await expect.poll(() => page.locator(".canvas-error-banner").isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
  expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before);
});

/**
 * One representative payload per bypass angle: if any cell is wrongly let
 * through, `page.context().route` catches the request to evil.example and
 * `outbound` ends up non-empty.
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
    // The "//"-form payload was already caught by ABSOLUTE_URL before ever
    // reaching the local-name check this cell means to isolate; omitting "//" (still a real
    // outbound reference once the shape match applies) actually exercises that check alone.
    '<g id="el-hostile" xmlns:xl="http://www.w3.org/1999/xlink"><image xl:href="https:evil.example/x.png" width="10" height="10"/></g>',
  ],
  // Two bypasses that reached a real outbound request.
  ["R4 TAB href", '<g id="el-hostile"><image href="/\t/evil.example/x.png" width="10" height="10"/></g>'],
  ["R4 uppercase HREF", '<g id="el-hostile"><image HREF="https:evil.example/y.png" width="10" height="10"/></g>'],
  // A CSS-hex-escape row and three style-carrying rows are pruned here:
  // `style` was dropped from the allowlist entirely, so all four are
  // rejected at the same "style not in allowlist" line as "R2 url(...)
  // raw-string bypass" above (kept as the one representative — it carries
  // entity-encoding, `url()`, and a protocol-relative `//` in a single
  // payload, the most dimensions of any style-carrying cell). Each removed
  // row's payload survives verbatim in core's cheaper (0.4s, no browser)
  // `REJECT_MATRIX` — a browser launch adds no information a unit-layer
  // assertion doesn't already give:
  //   R5 CSS-escaped url()                 → core REJECT_MATRIX N11
  //   R6 style unclosed url()              → core REJECT_MATRIX R1
  //   R6 style cursor image-set()          → core REJECT_MATRIX R2
  //   R6 style background-image image-set() → core REJECT_MATRIX R3
  // The real-world entry point for the raw-form XML legality defect: a raw,
  // unescaped `<` in `href` used to pass through and write an unparsable
  // slide (`DOMParser` failure → that page's animations silently vanish).
  // Unlike the cells above, this one has no cheaper single-layer equivalent
  // worth keeping it off — it's the shape that actually surfaced the regression.
  ["R8 raw < in href", '<g id="el-hostile"><image href="a<b.png" width="10" height="10"/></g>'],
];

it.each(A8_BYPASS_MATRIX)(
  "%s's forged clipboard content is rejected on paste, and the browser makes no request at all to evil.example",
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
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-slidra-clipboard="elements" data-slidra-source="slides/001.svg">' +
      hostileFragment +
      "</svg>";
    await page.evaluate((svg) => navigator.clipboard.writeText(svg), hostileSvg);
    await page.keyboard.press("Meta+v");

    await expect.poll(() => page.locator(".canvas-error-banner").isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
    expect(await readSlide(started.registry, started.presentationId, "slides/001.svg")).toBe(before);
    expect(outbound).toEqual([]);
  },
);
