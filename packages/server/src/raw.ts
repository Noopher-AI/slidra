import type { ServerResponse } from "node:http";
import { CoMotionError, readPresentationFileBytes } from "@co-motion/core";

/**
 * Byte-preserving read for `assets/` content (images, video, audio) that
 * the browser needs as its original bytes, not the decoded text `cat`
 * returns (ticket #11). Kept as its own module, separate from serve.ts's
 * command-dispatch flow, because this read deliberately does not go
 * through `registry.dispatch` — see the comment at its one call site in
 * serve.ts for why.
 */

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
};

/**
 * Derives a Content-Type from the virtual path's extension only — no
 * content sniffing, no MIME library. An unrecognised extension is served
 * as `application/octet-stream`, never guessed.
 */
export function rawContentTypeFor(virtualPath: string): string {
  const dot = virtualPath.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  const extension = virtualPath.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Handles one `/api/raw/<virtual path>` request: looks the path up through
 * the same virtual tree every other read uses, and writes back the file's
 * exact bytes with a derived Content-Type and Content-Length. Any
 * `CoMotionError` (not found, resolves to a directory) becomes a 404 with
 * an explicit Traditional Chinese body — this route makes no distinction
 * between "missing" and "not a file", the same way `/api/files/` doesn't.
 */
export async function handleRawRequest(
  presentationId: string,
  virtualPath: string,
  res: ServerResponse,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readPresentationFileBytes(presentationId, virtualPath);
  } catch (error) {
    if (error instanceof CoMotionError) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": rawContentTypeFor(virtualPath),
    "Content-Length": bytes.length,
  });
  res.end(bytes);
}
