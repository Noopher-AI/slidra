import type { ServerResponse } from "node:http";
import { CoMotionError, CoMotionNotFoundError, readPresentationFileBytes } from "@co-motion/core";

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
 * `readPresentationFileBytes` can fail for reasons that must not be
 * collapsed into the same response, so the classification here is
 * deliberately the narrow way round: only `CoMotionNotFoundError` (a
 * `CoMotionError` subtype that positively means "the virtual path does
 * not resolve to a file — not found, or resolves to a directory, or the
 * presentation id itself is unknown") is a 404. Every other
 * `CoMotionError` — an I/O failure reading the file or an earlier
 * directory, a corrupt registry, or any subtype added later that nobody
 * has taught this function about yet — is a 500, because "not an
 * instance of CoMotionNotFoundError" is not evidence that the asset is
 * missing. This is the inverse of an earlier version that treated
 * "not an I/O error" as proof of absence, which silently 404'd every new
 * error kind until someone noticed (ticket #11, fourth fix round). Either
 * way the response body is `error.message`, which — like every
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
    if (error instanceof CoMotionNotFoundError) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    if (error instanceof CoMotionError) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": rawContentTypeFor(virtualPath),
    "Content-Length": bytes.length,
    // The virtual path is not a content-addressed URL: the same
    // `/api/raw/<path>` can legitimately serve different bytes over time,
    // since the file on disk — not the URL — is the source of truth
    // (live reload exists precisely because the file can change under the
    // browser's feet). No response carries an ETag or Last-Modified for the
    // browser to revalidate against, so caching is not merely stale-prone
    // here, it is unconditionally wrong: treat every response as one-shot.
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}
