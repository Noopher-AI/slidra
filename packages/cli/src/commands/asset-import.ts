import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CoMotionError,
  createPresentationFile,
  listPresentationEntries,
  resolveAssetImport,
  resolveDataAssetImport,
  type MediaKind,
} from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

/**
 * `co-motion asset import` — copies or downloads a media asset into the
 * presentation's `assets/` directory (NOOP-90/T4, ADR-0015). Byte-header
 * validation and filename-conflict resolution are `@co-motion/core`'s
 * `resolveAssetImport`; this command only does the I/O: read the source
 * (local path or URL), then write through `createPresentationFile` so the
 * import gets undo for free (deleting the file undoes it).
 */

export interface AssetImportInput {
  id: string;
  /** An absolute local filesystem path, or an http(s) URL. */
  source: string;
  /** `"csv"` opts into the ADR-0015 data-asset hole (E2.T14, plan §0(c)); omitted, behaviour is byte-for-byte the pre-existing media-only path. */
  as?: string;
}

export interface AssetImportData {
  /** Virtual path of the imported file, e.g. "assets/photo-1.png" or "assets/data/sales.csv". */
  path: string;
  mimeType: string;
  /** `"data"` only for a `--as csv` import (E2.T14) — never a `MediaKind`, so the JSON output never claims a CSV is an image/video/audio. */
  kind: MediaKind | "data";
}

const URL_PATTERN = /^https?:\/\//i;

export const assetImportCommand: CommandHandler<AssetImportInput, AssetImportData> = async (input) => {
  const bytes = URL_PATTERN.test(input.source)
    ? await downloadSource(input.source)
    : await readLocalSource(input.source);

  if (input.as !== undefined) {
    if (input.as !== "csv") {
      throw new CoMotionError(`不支援的資料格式：${input.as}`);
    }
    const data = await importDataAssetBytes(input.id, sourceNameOf(input.source), bytes);
    return { ok: true, data, message: `已匯入資料：${data.path}` };
  }

  const data = await importAssetBytes(input.id, sourceNameOf(input.source), bytes);
  return { ok: true, data, message: `已匯入媒體：${data.path}` };
};

export function register(registry: CommandRegistry): void {
  registry.register("asset import", { handler: assetImportCommand, render: null });
}

/**
 * The format-decision + write half of asset import, with the source I/O
 * already done by the caller (NOOP-90/T4's CLI command reads a local path
 * or URL above; NOOP-142/T3's `POST /api/asset` hands in bytes it read off
 * the wire). This is the one place `resolveAssetImport` + `createPresentationFile`
 * are wired together — both callers share it so there is never a second
 * copy of the format-detection-then-write sequence.
 */
export async function importAssetBytes(id: string, sourceName: string, bytes: Uint8Array): Promise<AssetImportData> {
  const existingAssetNames = await listPresentationEntries(id, "assets");
  const { format, fileName } = resolveAssetImport({
    sourceName,
    bytes,
    existingAssetNames,
  });

  const virtualPath = `assets/${fileName}`;
  await createPresentationFile(id, virtualPath, Buffer.from(bytes));

  return { path: virtualPath, mimeType: format.mimeType, kind: format.kind };
}

/**
 * The `--as csv` counterpart of `importAssetBytes`: destination is fixed to
 * `assets/data/` (plan §4.3), never `assets/`, so a data asset and a media
 * asset can never collide on the same conflict-free-filename sequence.
 */
export async function importDataAssetBytes(id: string, sourceName: string, bytes: Uint8Array): Promise<AssetImportData> {
  const existingAssetNames = await listPresentationEntries(id, "assets/data");
  const { fileName } = resolveDataAssetImport({ sourceName, bytes, existingAssetNames });

  const virtualPath = `assets/data/${fileName}`;
  await createPresentationFile(id, virtualPath, Buffer.from(bytes));

  return { path: virtualPath, mimeType: "text/csv", kind: "data" };
}

function sourceNameOf(source: string): string {
  if (URL_PATTERN.test(source)) {
    return decodeURIComponent(path.posix.basename(new URL(source).pathname));
  }
  return path.basename(source);
}

async function readLocalSource(sourcePath: string): Promise<Uint8Array> {
  try {
    return await readFile(sourcePath);
  } catch {
    // sourcePath is input the caller supplied directly (not the hidden work
    // directory ADR-0004 forbids naming), so echoing it back is fine.
    throw new CoMotionError(`找不到來源檔案：${sourcePath}`);
  }
}

async function downloadSource(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new CoMotionError(`無法下載來源：${url}`);
  }
  if (!response.ok) {
    throw new CoMotionError(`無法下載來源，伺服器回應 ${response.status}：${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
