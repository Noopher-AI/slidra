import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CoMotionError,
  createPresentationFile,
  listPresentationEntries,
  resolveAssetImport,
  type MediaKind,
} from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

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
}

export interface AssetImportData {
  /** Virtual path of the imported file, e.g. "assets/photo-1.png". */
  path: string;
  mimeType: string;
  kind: MediaKind;
}

const URL_PATTERN = /^https?:\/\//i;

export const assetImportCommand: CommandHandler<AssetImportInput, AssetImportData> = async (input) => {
  const bytes = URL_PATTERN.test(input.source)
    ? await downloadSource(input.source)
    : await readLocalSource(input.source);

  const existingAssetNames = await listPresentationEntries(input.id, "assets");
  const { format, fileName } = resolveAssetImport({
    sourceName: sourceNameOf(input.source),
    bytes,
    existingAssetNames,
  });

  const virtualPath = `assets/${fileName}`;
  await createPresentationFile(input.id, virtualPath, Buffer.from(bytes));

  return {
    ok: true,
    data: { path: virtualPath, mimeType: format.mimeType, kind: format.kind },
    message: `已匯入媒體：${virtualPath}`,
  };
};

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
