import type { ServerResponse } from "node:http";
import { CoMotionError, CoMotionIOError, readPresentationFileBytes } from "@co-motion/core";

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
 * exact bytes with a derived Content-Type and Content-Length.
 *
 * `readPresentationFileBytes` can fail two genuinely different ways, and
 * they must not be collapsed into the same response: the virtual path may
 * simply not resolve to a file (not found, or resolves to a directory) —
 * a real 404 — or it may resolve to a file that was actually discovered on
 * disk, with the underlying read itself then failing (permissions, a
 * failing disk, any other I/O error) — which is this server's problem, not
 * a missing asset, and must not be reported as one. `CoMotionIOError` (a
 * `CoMotionError` subtype, so it is checked first) marks that second case;
 * every other `CoMotionError` keeps meaning "the asset is not there".
 * Either way the response body is `error.message`, which — like every
 * `CoMotionError` message — never contains the real filesystem path
 * (ADR-0004); only the caller-supplied virtual path may appear in it.
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
    if (error instanceof CoMotionIOError) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
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
