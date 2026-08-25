import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  createNewPresentation,
  listPresentationEntries,
  openPresentation,
  packPresentation,
  readPresentationFontBook,
} from "../src/workspace.js";
import { createFontBook, MEASURED_TEXT_CSS } from "../src/font/metrics.js";
import {
  BUNDLED_FONT_DIR,
  ensureBundledFonts,
  loadFontBook,
  readBundledFontBytes,
  resolveFontCacheDir,
  stageBundledFonts,
} from "../src/font/bundle.js";

const ENV = process.env;

/** Runs `body` with the font cache pointed at `dir`. */
async function withFontCache(dir: string, body: () => Promise<void>): Promise<void> {
  const previous = ENV.CO_MOTION_FONT_CACHE;
  ENV.CO_MOTION_FONT_CACHE = dir;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete ENV.CO_MOTION_FONT_CACHE;
    } else {
      ENV.CO_MOTION_FONT_CACHE = previous;
    }
  }
}

/** Runs `body` with every outgoing fetch failing, the way being offline does. */
async function withoutNetwork(body: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// The real bundled font, from the on-disk cache (downloaded once on first
// use). Every expectation below is about this specific font file.
const notoSansTC = readBundledFontBytes;

describe("createFontBook reads a face's metadata straight out of the sfnt tables", () => {
  it("reports the family name from the name table", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.faces.map((face) => face.family)).toEqual(["Noto Sans TC"]);
  });

  // Noto Sans TC Regular's published design values: 1000 units per em,
  // usWeightClass 400. hhea ascender/descender/lineGap are the vertical
  // metrics the same file declares.
  it("reports units per em, weight and the vertical metrics", async () => {
    const [face] = createFontBook([await notoSansTC()]).faces;
    expect(face.unitsPerEm).toBe(1000);
    expect(face.weight).toBe(400);
    expect(face.ascender).toBeGreaterThan(0);
    expect(face.descender).toBeLessThan(0);
  });
});

const NOTO = { fontFamily: "Noto Sans TC", fontSize: 100 } as const;

describe("measureText sums the glyph advances out of hmtx", () => {
  it("gives a full-width CJK run exactly one em per character", async () => {
    // Noto Sans TC is a CJK font: its ideographs are designed on the em
    // square, so five of them at 100px is exactly 500px by construction.
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("驗收用簡報", NOTO)).toBe(500);
  });

  it("gives an empty string zero width", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("", NOTO)).toBe(0);
  });

  it("scales linearly with the font size", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("驗收用簡報", { ...NOTO, fontSize: 41.5 })).toBeCloseTo(207.5, 10);
  });
});

describe("the style has to name exactly one bundled face", () => {
  it("rejects a CSS font-family list rather than falling back down it", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText("x", { ...NOTO, fontFamily: '"Noto Sans TC", sans-serif' })).toThrow(
      /字型名稱不可以是清單/,
    );
  });

  it("matches the family name case-insensitively and ignores surrounding space", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("驗收用簡報", { ...NOTO, fontFamily: "  noto sans tc " })).toBe(500);
  });

  it("names the bundled families when the requested one is not among them", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText("x", { ...NOTO, fontFamily: "Helvetica" })).toThrow(
      "這份簡報沒有打包字型「Helvetica」；已打包：Noto Sans TC",
    );
  });

  it("names the available weights when the requested weight is not bundled", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText("x", { ...NOTO, fontWeight: 700 })).toThrow(
      "這份簡報沒有打包字重 700 的「Noto Sans TC」；可用字重：400",
    );
  });

  it("says so plainly when the presentation bundles no font at all", () => {
    const book = createFontBook([]);
    expect(() => book.measureText("x", NOTO)).toThrow("這份簡報沒有打包字型");
  });

  it("refuses two bundled files claiming the same family and weight", async () => {
    const ttf = await notoSansTC();
    expect(() => createFontBook([ttf, ttf])).toThrow(/無法決定用哪一份/);
  });
});

describe("font size", () => {
  it("accepts a fractional size", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("驗", { ...NOTO, fontSize: 41.5 })).toBeCloseTo(41.5, 10);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", async (fontSize) => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText("驗", { ...NOTO, fontSize })).toThrow(
      "字級必須是大於 0 的數字",
    );
  });
});

describe("characters the browser lays out differently are rejected, never guessed", () => {
  // Each entry was measured against Chromium: core and browser disagree, so
  // measuring these would return a silently wrong number.
  it.each([
    ["U+0009 TAB", "a\u0009b", "文字不可包含控制字元"],
    ["U+200D ZERO WIDTH JOINER", "a\u200Db", "文字不可包含零寬或格式字元"],
    ["U+00AD SOFT HYPHEN", "x\u00ADy", "文字不可包含零寬或格式字元"],
    ["U+FE00 VARIATION SELECTOR-1", "\u4E00\uFE00", "不支援變體選擇符"],
    ["U+0301/U+0302 COMBINING ACCENTS", "a\u0301\u0302b", "不支援組合字元，請改用預組合字元"],
  ])("rejects %s", async (_name, text, message) => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText(text, NOTO)).toThrow(message);
  });

  it("accepts the precomposed form of the same accented letter", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.measureText("\u00E9", NOTO)).toBeGreaterThan(0);
  });
});

describe("a character the font does not have is an error naming it", () => {
  it("names every missing code point once, with its font", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(() => book.measureText("\u{1F642}a\u{1F642}", NOTO)).toThrow(
      "字型「Noto Sans TC」不支援下列字元：\u{1F642} (U+1F642)",
    );
  });
});

describe("advanceOf", () => {
  it("agrees with measureText on a single character", async () => {
    const book = createFontBook([await notoSansTC()]);
    expect(book.advanceOf(0x9a57, NOTO)).toBe(book.measureText("\u9A57", NOTO));
  });
});

describe("MEASURED_TEXT_CSS", () => {
  it("switches off exactly the three behaviours core does not model", () => {
    expect(MEASURED_TEXT_CSS).toBe(
      "font-kerning:none;font-variant-ligatures:none;text-spacing-trim:space-all",
    );
  });
});

describe("a corrupt font file is an error, never a skipped face", () => {
  it("rejects bytes that are not an sfnt", () => {
    expect(() => createFontBook([new Uint8Array(64)])).toThrow(CoMotionError);
  });
});

describe("the master font is cached on disk, not kept in version control", () => {
  it("takes its cache directory from CO_MOTION_FONT_CACHE, never from CO_MOTION_HOME", () => {
    // Ten test files point CO_MOTION_HOME at a fresh temp directory; a cache
    // underneath it would re-download 7 MB for each of them.
    const cacheDir = resolveFontCacheDir();
    ENV.CO_MOTION_HOME = "/tmp/some-other-home";
    try {
      expect(resolveFontCacheDir()).toBe(cacheDir);
    } finally {
      delete ENV.CO_MOTION_HOME;
    }
  });

  it("reads the cached file without going to the network", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "co-motion-font-cache-"));
    await writeFile(path.join(cacheDir, "NotoSansTC-Regular.ttf"), await readBundledFontBytes());
    await withFontCache(cacheDir, async () => {
      await withoutNetwork(async () => {
        expect((await readBundledFontBytes()).byteLength).toBe(7_090_820);
      });
    });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("says what to do when the cache is cold and the network is unreachable", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "co-motion-font-cache-"));
    await withFontCache(cacheDir, async () => {
      await withoutNetwork(async () => {
        await expect(readBundledFontBytes()).rejects.toThrow(
          /取不到內建字型 Noto Sans TC，而且本機快取是空的/,
        );
      });
    });
    await rm(cacheDir, { recursive: true, force: true });
  });
});

describe("a container carries the font and its licence", () => {
  it("stages both files under assets/fonts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-container-"));
    await stageBundledFonts(root);
    expect((await readdir(path.join(root, BUNDLED_FONT_DIR))).sort()).toEqual([
      "NotoSansTC-Regular.ttf",
      "OFL.txt",
    ]);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the licence text intact, so it travels with every copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-container-"));
    await stageBundledFonts(root);
    const licence = await readFile(path.join(root, BUNDLED_FONT_DIR, "OFL.txt"), "utf-8");
    expect(licence).toContain("SIL Open Font License");
    await rm(root, { recursive: true, force: true });
  });

  it("measures text from the container's own font, not the OS's", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-container-"));
    await stageBundledFonts(root);
    const book = await loadFontBook(root);
    expect(book.faces.map((face) => face.family)).toEqual(["Noto Sans TC"]);
    expect(book.measureText("驗收用簡報", NOTO)).toBe(500);
    await rm(root, { recursive: true, force: true });
  });

  it("gives a presentation with no bundled font an empty book that fails loudly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-container-"));
    const book = await loadFontBook(root);
    expect(book.faces).toEqual([]);
    expect(() => book.measureText("x", NOTO)).toThrow("這份簡報沒有打包字型");
    await rm(root, { recursive: true, force: true });
  });
});

describe("a presentation picks up its font the first time it really needs one", () => {
  // Each test gets its own CO_MOTION_HOME so nothing touches the real
  // ~/.comotion (ADR-0004, ticket #9 testing convention).
  async function newDeck(): Promise<{ id: string; comotDir: string }> {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    ENV.CO_MOTION_HOME = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
    const comotPath = path.join(comotDir, "deck.comot");
    await createNewPresentation(comotPath, "字型驗收");
    const { id } = await openPresentation(comotPath);
    return { id, comotDir };
  }

  it("a brand-new deck carries no font at all", async () => {
    const { id } = await newDeck();
    expect(await listPresentationEntries(id)).toEqual(["assets", "project.json", "slides"]);
    expect(await listPresentationEntries(id, "assets")).toEqual([]);
    delete ENV.CO_MOTION_HOME;
  });

  it("the first measurement puts the font and its licence into the deck", async () => {
    const { id } = await newDeck();
    const book = await readPresentationFontBook(id);
    expect(book.measureText("驗收用簡報", NOTO)).toBe(500);
    expect(await listPresentationEntries(id, "assets/fonts")).toEqual([
      "NotoSansTC-Regular.ttf",
      "OFL.txt",
    ]);
    delete ENV.CO_MOTION_HOME;
  });

  it("a second measurement needs no network — the deck already has the font", async () => {
    const { id } = await newDeck();
    await readPresentationFontBook(id);
    await withoutNetwork(async () => {
      const emptyCache = await mkdtemp(path.join(tmpdir(), "co-motion-font-cache-"));
      await withFontCache(emptyCache, async () => {
        const book = await readPresentationFontBook(id);
        expect(book.measureText("驗收用簡報", NOTO)).toBe(500);
      });
      await rm(emptyCache, { recursive: true, force: true });
    });
    delete ENV.CO_MOTION_HOME;
  });

  it("packing puts the font into the .comot, so it opens without an installed font", async () => {
    const { id, comotDir } = await newDeck();
    const packedPath = path.join(comotDir, "packed.comot");
    await packPresentation(id, packedPath);
    const reopened = await openPresentation(packedPath);
    expect(await listPresentationEntries(reopened.id, "assets/fonts")).toEqual([
      "NotoSansTC-Regular.ttf",
      "OFL.txt",
    ]);
    delete ENV.CO_MOTION_HOME;
  });
});

describe("an interrupted staging must never masquerade as a finished bundle", () => {
  const FONT = "NotoSansTC-Regular.ttf";
  const LICENCE = "OFL.txt";

  async function fontDirOf(root: string): Promise<string> {
    const dir = path.join(root, BUNDLED_FONT_DIR);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("real failure injection: the font write fails, and the retry completes the bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    const dir = await fontDirOf(root);
    // A directory sitting where the font file goes makes the rename fail
    // with real I/O — no stubbing — after the licence has been written.
    await mkdir(path.join(dir, FONT));
    await expect(stageBundledFonts(root)).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual([FONT, LICENCE]);

    await rm(path.join(dir, FONT), { recursive: true });
    expect(await ensureBundledFonts(root)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([FONT, LICENCE]);
    expect((await loadFontBook(root)).measureText("驗收用簡報", NOTO)).toBe(500);
    await rm(root, { recursive: true, force: true });
  });

  it("a leftover font with no licence is completed, not skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    const dir = await fontDirOf(root);
    await writeFile(path.join(dir, FONT), await readBundledFontBytes());
    expect(await ensureBundledFonts(root)).toBe(true);
    expect(await readdir(dir)).toContain(LICENCE);
    await rm(root, { recursive: true, force: true });
  });

  it("a leftover licence with no font is completed, not skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    const dir = await fontDirOf(root);
    await writeFile(path.join(dir, LICENCE), "leftover");
    expect(await ensureBundledFonts(root)).toBe(true);
    expect(await readdir(dir)).toContain(FONT);
    await rm(root, { recursive: true, force: true });
  });

  it("a file that is not really a font is replaced, never packed as one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    const dir = await fontDirOf(root);
    await writeFile(path.join(dir, FONT), "NOT A REAL FONT");
    await writeFile(path.join(dir, LICENCE), "leftover");
    expect(await ensureBundledFonts(root)).toBe(true);
    expect((await loadFontBook(root)).faces.map((face) => face.family)).toEqual(["Noto Sans TC"]);
    await rm(root, { recursive: true, force: true });
  });

  it("a complete bundle is left exactly as it is", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    await stageBundledFonts(root);
    expect(await ensureBundledFonts(root)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("leaves no temp files behind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "co-motion-partial-"));
    await stageBundledFonts(root);
    expect((await readdir(path.join(root, BUNDLED_FONT_DIR))).sort()).toEqual([FONT, LICENCE]);
    await rm(root, { recursive: true, force: true });
  });
});
