import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError } from "../errors.js";
import { createFontBook, type FontBook } from "./metrics.js";

/**
 * The Node side of the bundled fonts: getting hold of the font file, and
 * putting it inside a container. Everything that has to run in the browser
 * lives in metrics.ts, which imports no `node:` module at all.
 *
 * The master font file is deliberately NOT in version control (7 MB of
 * binary in every clone). It is fetched from Google Fonts on first use and
 * cached on disk; the licence text next to this file IS in version control,
 * because it is text and it has to travel with every copy.
 */

/** Where fonts live inside a container, relative to the container root. */
export const BUNDLED_FONT_DIR = "assets/fonts";

/** File name the font is cached and bundled under. */
export const BUNDLED_FONT_FILE = "NotoSansTC-Regular.ttf";

/** File name the licence text is bundled under. */
export const BUNDLED_LICENCE_FILE = "OFL.txt";

const GOOGLE_FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400&display=swap";

/**
 * The font cache is addressed by its own environment variable and NEVER
 * derived from `resolveCoMotionHome()`. Ten test files point
 * `CO_MOTION_HOME` at a fresh temp directory — some of them per test — so a
 * cache underneath it would re-download 7 MB on every one of them. The
 * cache is machine-scoped content, not per-presentation state.
 */
export function resolveFontCacheDir(): string {
  return (
    process.env.CO_MOTION_FONT_CACHE ?? path.join(homedir(), ".cache", "co-motion", "fonts")
  );
}

/**
 * Downloads the master font from Google Fonts. The CSS endpoint is asked
 * with a plain UA on purpose: a modern-browser UA is served woff2, and we
 * need the raw sfnt. Same approach as scripts/build-font-subset.mjs.
 */
async function downloadFont(): Promise<Uint8Array> {
  const cssResponse = await fetch(GOOGLE_FONTS_CSS, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!cssResponse.ok) {
    throw new CoMotionError(`無法取得 Noto Sans TC 的字型來源：HTTP ${cssResponse.status}`);
  }
  const css = await cssResponse.text();
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
  if (!match) {
    throw new CoMotionError("Google Fonts 的回應裡找不到 Noto Sans TC 的 .ttf 來源網址");
  }
  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) {
    throw new CoMotionError(`無法下載 Noto Sans TC：HTTP ${fontResponse.status}`);
  }
  return new Uint8Array(await fontResponse.arrayBuffer());
}

/**
 * Returns the master font's bytes, downloading and caching them on first
 * use. Offline with a cold cache is an explicit error telling the user what
 * to do — never a silent fall back to a system font, which is precisely the
 * failure #71 exists to remove.
 */
export async function readBundledFontBytes(): Promise<Uint8Array> {
  const cacheDir = resolveFontCacheDir();
  const cachedPath = path.join(cacheDir, BUNDLED_FONT_FILE);
  try {
    return new Uint8Array(await readFile(cachedPath));
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await downloadFont();
  } catch (error) {
    if (error instanceof CoMotionError) {
      throw error;
    }
    throw new CoMotionError(
      "取不到內建字型 Noto Sans TC，而且本機快取是空的。請在能連上網路時再執行一次" +
        "（會下載一次並快取起來），或用 CO_MOTION_FONT_CACHE 指向已經有 " +
        `${BUNDLED_FONT_FILE} 的目錄。`,
    );
  }

  // Written via a temp file and renamed: two commands running at once must
  // never be able to read a half-written font file out of the cache.
  await mkdir(cacheDir, { recursive: true });
  const tempPath = path.join(cacheDir, `.${BUNDLED_FONT_FILE}.${randomBytes(6).toString("hex")}`);
  await writeFile(tempPath, bytes);
  await rename(tempPath, cachedPath);
  return bytes;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** The SIL OFL text that travels with every container. Lives in version control. */
async function readBundledLicence(): Promise<string> {
  // src/font/bundle.ts and dist/font/bundle.js sit the same two levels below
  // the package root, so this one expression resolves to the same file
  // whether vitest is running the sources or the CLI is running the build.
  const packageRoot = new URL("../../", import.meta.url);
  return readFile(new URL(`src/font/${BUNDLED_LICENCE_FILE}`, packageRoot), "utf-8");
}

/**
 * Copies the bundled font and its licence into `<rootDir>/assets/fonts/`.
 * `rootDir` is a container root — a staging directory or a work directory.
 */
export async function stageBundledFonts(rootDir: string): Promise<void> {
  const fontDir = path.join(rootDir, BUNDLED_FONT_DIR);
  await mkdir(fontDir, { recursive: true });
  await writeFile(path.join(fontDir, BUNDLED_FONT_FILE), await readBundledFontBytes());
  await writeFile(path.join(fontDir, BUNDLED_LICENCE_FILE), await readBundledLicence(), "utf-8");
}

/**
 * Builds the font book for the container rooted at `workDir`. A container
 * with no font directory yields an empty book — every presentation created
 * before this feature is one, and opening those must keep working; the
 * error then surfaces at the first measurement instead. A font file that
 * fails to parse is an error, never a skipped face.
 */
export async function loadFontBook(workDir: string): Promise<FontBook> {
  const fontDir = path.join(workDir, BUNDLED_FONT_DIR);
  let entries: string[];
  try {
    entries = await readdir(fontDir);
  } catch (error) {
    if (isEnoent(error)) {
      return createFontBook([]);
    }
    throw error;
  }
  // A font file is one with a font extension. OFL.txt is not omitted, it
  // simply is not a font — that is a definition, not a skip.
  const fontFiles = entries.filter((entry) => /\.(ttf|otf)$/i.test(entry)).sort();
  const fonts = await Promise.all(
    fontFiles.map(async (entry) => new Uint8Array(await readFile(path.join(fontDir, entry)))),
  );
  return createFontBook(fonts);
}
