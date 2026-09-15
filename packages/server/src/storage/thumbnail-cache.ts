// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveSlidraHome } from "../slidra/home.js";
import { loadProject, readPresentationBytes, renderSlide } from "../slidra/reads.js";
import { MEDIA_MIME_TYPES } from "../media-types.js";
import { deckFileMtime, ensureDeckFolder } from "./deck-folder.js";
import type { DeckStore } from "./deck-store.js";

/**
 * `GET /api/decks/thumbnail`'s implementation ([E6.T4] plan §4/§7 decision
 * 5/6) — cache-first, keyed on the deck file's own mtime, so a 50-deck
 * folder is never re-rendered on every visit (AC6). Every render is a
 * first-slide SVG (decision 5: SVG, not a PNG/iframe — `<img loading="lazy">`
 * never executes script or fetches cross-origin) with its `../assets/*`
 * references inlined as data URIs so the cache file is self-contained
 * (decision 6).
 */

const MAX_INLINE_ASSET_BYTES = 2 * 1024 * 1024;

/** Thrown when `fileName` does not name a file in the deck folder — the route's own 404. */
export class ThumbnailNotFoundError extends Error {}

/** Thrown when the deck has no slides to render a thumbnail from — the route's own 204. */
export class ThumbnailNoSlidesError extends Error {}

export interface ThumbnailResult {
  bytes: Buffer;
  /** Already quoted, ready to write straight into an `ETag` header. */
  etag: string;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function thumbnailsDir(home: string): string {
  return path.join(home, "thumbnails");
}

/** `<sha256(deckPath) first 32 hex chars>-<mtimeMs>.svg` (plan §5's exact naming) — the hash has no `-` of its own, so splitting the file name on the first `-` always recovers it. */
function cacheFileName(deckPath: string, mtimeMs: number): string {
  const hash = createHash("sha256").update(deckPath).digest("hex").slice(0, 32);
  return `${hash}-${mtimeMs}.svg`;
}

function hashPrefixOf(cacheName: string): string {
  return cacheName.slice(0, cacheName.indexOf("-"));
}

/** Resolves a slide SVG's `../assets/<name>` href to its `cat`-virtual path — the only relative shape a slide ever uses (assets live one directory up from `slides/`). */
function assetVirtualPath(href: string): string | null {
  return href.startsWith("../assets/") ? href.slice("../".length) : null;
}

/**
 * Inlines every `../assets/*` href/xlink:href in `svg` as a data URI so the
 * cache file is self-contained. Best-effort per plan §7 decision 6: an
 * asset over 2 MiB or that fails to read is skipped, never inlined and
 * never failing the whole thumbnail — the cached SVG just renders with that
 * one image missing.
 */
async function inlineAssets(id: string, svg: string): Promise<string> {
  const hrefPattern = /(?:xlink:)?href="([^"]*)"/g;
  const replacements: Array<{ search: string; replace: string }> = [];
  for (const match of svg.matchAll(hrefPattern)) {
    const [full, href] = match;
    const virtualPath = assetVirtualPath(href!);
    if (virtualPath === null) continue;
    try {
      const bytes = await readPresentationBytes(id, virtualPath);
      if (bytes.byteLength > MAX_INLINE_ASSET_BYTES) continue;
      const mime = MEDIA_MIME_TYPES[path.extname(virtualPath).toLowerCase()];
      if (!mime) continue;
      const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
      replacements.push({ search: full!, replace: full!.replace(href!, dataUri) });
    } catch {
      // Unreadable asset — leave the original relative href in place.
    }
  }
  let result = svg;
  for (const { search, replace } of replacements) {
    result = result.replace(search, replace);
  }
  return result;
}

/** Deletes every cached thumbnail sharing `hashPrefix` except `keep` — the previous mtime's now-stale file (plan §4: "已變＝重生一次並刪掉同 hash 的舊 .svg"). */
async function pruneStaleCacheFiles(dir: string, hashPrefix: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((name) => name !== keep && name.startsWith(`${hashPrefix}-`))
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})),
  );
}

export async function getOrCreateThumbnail(store: DeckStore, fileName: string): Promise<ThumbnailResult> {
  const folder = await ensureDeckFolder();
  const deckPath = path.join(folder, fileName);
  if (!(await pathExists(deckPath))) {
    throw new ThumbnailNotFoundError(`no deck file found: ${fileName}`);
  }

  const mtimeMs = await deckFileMtime(deckPath);
  const dir = thumbnailsDir(resolveSlidraHome());
  const cacheName = cacheFileName(deckPath, mtimeMs);
  const cachePath = path.join(dir, cacheName);
  const etag = `"${cacheName.slice(0, -".svg".length)}"`;

  if (await pathExists(cachePath)) {
    return { bytes: await readFile(cachePath), etag };
  }

  const { id } = await store.resolveId(fileName);
  const project = await loadProject(id);
  const firstSlide = project.slides[0];
  if (firstSlide === undefined) {
    throw new ThumbnailNoSlidesError(`deck has no slides: ${fileName}`);
  }
  const rendered = await renderSlide(id, firstSlide);
  const bytes = Buffer.from(await inlineAssets(id, rendered), "utf-8");

  await mkdir(dir, { recursive: true });
  await writeFile(cachePath, bytes);
  await pruneStaleCacheFiles(dir, hashPrefixOf(cacheName), cacheName);

  return { bytes, etag };
}
