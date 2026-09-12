import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { requireBuilt } from "./helpers/launch.js";
import { loadPdf } from "./helpers/pdf.js";

/**
 * `slidra export`. Spawns the real compiled `slidra` binary — never
 * `runExportCli` called in-process, since that would skip the exact
 * bin-dispatch branch this needs to exercise; this is the strongest form of
 * that boundary — the Rust binary itself execs Node for `export`, closer to
 * a real invocation than an in-process Node shim would be — and reads the
 * produced PDF through `pdf.ts`'s `pdf.js`-backed helper, never asserting on
 * PDF bytes/internal structure directly.
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const slidraBinPath = path.join(rootDir, "target/release/slidra");
const exportDeckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const brokenEffectsDeckDir = path.join(rootDir, "e2e/fixtures/broken-effects-deck");
const backdropFilterDeckDir = path.join(rootDir, "e2e/fixtures/backdrop-filter-deck");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      slidraBinPath,
      args,
      { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(rootDir);
  await stat(path.join(rootDir, "apps/web/dist/export.html"));
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser.close();
});

let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-export-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-export-files-"));
  registry = createDefaultRegistry();
  // openFixture() below dispatches "open"/"new" through `registry`, which
  // shells out to the real compiled binary via
  // `packages/server/src/slidra/bin.ts`'s `resolveSlidraBin()` — it
  // reads `process.env` directly, not the `env()` object below (that one
  // only covers the separately-spawned `runCli` child), so both variables
  // must be set here too, or `registry.dispatch` fails before `runCli` is
  // ever reached.
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function env(): NodeJS.ProcessEnv {
  // `slidra export`'s `runExportCli` spawns the Rust binary itself
  // (`loadProject`) for CLI-driven exports — in production `SLIDRA_BIN` is
  // always set by the Rust launcher before it execs into the Node entry
  // point (`crates/slidra/src/node_entry.rs`); this test goes through that
  // exact launcher too (`runCli` spawns `slidraBinPath` directly), so
  // setting it here mirrors a real invocation rather than working around
  // one.
  return { ...process.env, SLIDRA_HOME: slidraHome, SLIDRA_BIN: slidraBinPath };
}

async function openFixture(deckDir: string): Promise<string> {
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  return opened.data!.id;
}

describe("argv validation — no browser needed, fails before ever touching Playwright", () => {
  it("missing presentation-id", async () => {
    const result = await runCli(["export", "--format", "pdf"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("Command export is missing an argument: presentation-id");
  });

  it("missing --format", async () => {
    const result = await runCli(["export", "some-id"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("Command export is missing an argument: --format");
  });

  it("--format is not one of pdf/pdf-frames (case-sensitive)", async () => {
    const result = await runCli(["export", "some-id", "--format", "PDF"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--format must be one of: pdf, pdf-frames");
  });

  it("--format pptx is also rejected (not a supported format)", async () => {
    const result = await runCli(["export", "some-id", "--format", "pptx"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--format must be one of: pdf, pdf-frames");
  });

  it("--out is missing a value", async () => {
    const result = await runCli(["export", "some-id", "--format", "pdf", "--out"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--out is missing a value");
  });

  it("id does not exist", async () => {
    const result = await runCli(["export", "no-such-id", "--format", "pdf"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no presentation found for id: no-such-id");
  });
});

describe("successful export", () => {
  it("--format pdf: one page per slide", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(slidraDir, "out.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Exported: ${outPath} (3 pages)`);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(3);
    } finally {
      await info.close();
    }
  }, 60_000);

  it("--format pdf-frames: page count = sum(steps+1)", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(slidraDir, "out-frames.pdf");
    const result = await runCli(["export", id, "--format", "pdf-frames", "--out", outPath], { env: env() });

    expect(result.code).toBe(0);
    // export-deck's step counts are [0, 2, 1] -> sum(steps+1) = 1 + 3 + 2 = 6.
    expect(result.stdout).toContain(`Exported: ${outPath} (6 pages)`);
    // Progress output: expect at least a start line and one progress line
    // (not every frame is required to print, see the polling comment in
    // export/render.ts).
    expect(result.stdout).toContain("Export started: pdf-frames, 6 frames total");
    expect(result.stdout).toMatch(/Progress: \d+\/6/);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(6);

      // Frame ordering: page 1 = slide 1 (0 steps, just 1 frame); pages 2-4
      // = slide 2's 3 frames (opening, step one, step one+two); pages 5-6 =
      // slide 3's 2 frames (opening, its only step). Page 2 (slide 2's
      // opening, neither enter element has appeared yet) must differ from
      // page 4 (slide 2's final state, both enter elements present) to
      // prove that frame-by-frame advancement actually applies startStep,
      // rather than rendering the same frame for every step.
      const openingRaster = await info.rasterizePage(1);
      const finalRaster = await info.rasterizePage(3);
      expect(openingRaster.equals(finalRaster)).toBe(false);
    } finally {
      await info.close();
    }
  }, 60_000);

  it("when --out is omitted, writes <name>.pdf to the current working directory", async () => {
    const id = await openFixture(exportDeckDir);
    // realpath: macOS's tmpdir is a symlink (/var → /private/var) and the
    // CLI prints the resolved path.
    const workDir = await realpath(await mkdtemp(path.join(tmpdir(), "slidra-export-cwd-")));
    try {
      const result = await runCli(["export", id, "--format", "pdf"], { env: env(), cwd: workDir });
      expect(result.code).toBe(0);
      const expectedPath = path.join(workDir, "Export test deck.pdf");
      expect(result.stdout).toContain(`Exported: ${expectedPath} (3 pages)`);
      const stats = await stat(expectedPath);
      expect(stats.isFile()).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("overwrites an existing output file of the same name", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(slidraDir, "overwrite.pdf");
    await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });
    const firstBytes = await readFile(outPath);
    expect(firstBytes.length).toBeGreaterThan(0);

    const second = await runCli(["export", id, "--format", "pdf-frames", "--out", outPath], { env: env() });
    expect(second.code).toBe(0);
    const secondBytes = await readFile(outPath);
    const info = await loadPdf(browser, secondBytes);
    try {
      expect(info.numPages).toBe(6); // pdf-frames's page count, proving it was really overwritten with the second run's content
    } finally {
      await info.close();
    }
  }, 60_000);
});

describe("no partial PDF is produced on failure", () => {
  it("presentation has no slides", async () => {
    const emptyDeckDir = await mkdtemp(path.join(tmpdir(), "slidra-export-empty-"));
    try {
      await mkdir(path.join(emptyDeckDir, "slides"), { recursive: true });
      await mkdir(path.join(emptyDeckDir, "assets"), { recursive: true });
      await writeFile(
        path.join(emptyDeckDir, "project.json"),
        JSON.stringify({ formatVersion: 1, name: "Blank deck", canvas: { width: 1280, height: 720 }, slides: [] }),
      );
      const id = await openFixture(emptyDeckDir);
      const outPath = path.join(slidraDir, "should-not-exist.pdf");
      const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe("Presentation has no slides");
      await expect(stat(outPath)).rejects.toThrow();
    } finally {
      await rm(emptyDeckDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("when a slide's effect list is broken: exit 1, the raw error message, no file produced", async () => {
    const id = await openFixture(brokenEffectsDeckDir);
    const outPath = path.join(slidraDir, "should-not-exist-either.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

    expect(result.code).toBe(1);
    // slides/001.svg's first (and only) breakage: a media effect missing
    // data-slidra-media (the raw text thrown by player-plan.ts's mediaCuesFor).
    expect(result.stderr).toContain("el-speaker");
    expect(result.stderr).toContain("data-slidra-media");
    await expect(stat(outPath)).rejects.toThrow();
  }, 60_000);
});

describe("known limitation: backdrop-filter does not appear in exported PDFs", () => {
  // This documents a known limitation, not correct behavior; if some future
  // Chromium version starts supporting it, this test will go red and the
  // assertion should be flipped (see the page.pdf() call in
  // export/render.ts).
  //
  // Approach: the two backdrop-filter-deck slides are identical except for
  // whether backdrop-filter is applied (see the fixture's two .svg files).
  // Export both to a one-page PDF, rasterize, and compare — if
  // backdrop-filter ever starts taking effect in the print path after some
  // Chromium update, the two pages will show a real pixel difference and
  // this test will catch it rather than silently passing.
  //
  // The comparison uses a pixelmatch tolerance rather than exact byte
  // equality: testing found that even when two pages are visually identical
  // (pixelmatch, default tolerance), the raw PNG bytes can still differ
  // (non-deterministic floating point/antialiasing in the canvas
  // rasterization path, unrelated to backdrop-filter itself) — the same
  // reasoning as the "render-sensitive comparison" handling elsewhere.
  it("two slides differing only in backdrop-filter render visually identical PDFs", async () => {
    const id = await openFixture(backdropFilterDeckDir);
    const outPath = path.join(slidraDir, "backdrop.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });
    expect(result.code).toBe(0);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(2);
      const withBackdropFilter = PNG.sync.read(await info.rasterizePage(0));
      const withoutBackdropFilter = PNG.sync.read(await info.rasterizePage(1));
      expect(withBackdropFilter.width).toBe(withoutBackdropFilter.width);
      expect(withBackdropFilter.height).toBe(withoutBackdropFilter.height);
      const diff = new PNG({ width: withBackdropFilter.width, height: withBackdropFilter.height });
      const diffPixels = pixelmatch(
        withBackdropFilter.data,
        withoutBackdropFilter.data,
        diff.data,
        withBackdropFilter.width,
        withBackdropFilter.height,
        { threshold: 0.1 },
      );
      expect(diffPixels).toBe(0);
    } finally {
      await info.close();
    }
  }, 60_000);
});
