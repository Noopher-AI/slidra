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
 * One resolved byte range, or an explicit verdict about why no single
 * range could be produced.
 *
 * `ignore` is RFC 9110's "a recipient that does not understand the Range
 * header field, or the range unit, MUST ignore it and serve the whole
 * representation" — a syntactically broken header is not an error, it is a
 * plain 200. `unsatisfiable` is the opposite: the client asked in a form we
 * understand, and the answer is genuinely "no such bytes", which owes a 416
 * rather than a silent full body.
 */
type RangeResolution =
  | { kind: "ignore" }
  | { kind: "satisfiable"; start: number; end: number }
  | { kind: "unsatisfiable"; reason: string };

/**
 * Resolves a `Range` header against a known total size. Only single `bytes=`
 * ranges are supported: multi-range would require a multipart/byteranges
 * body, and answering it with just the first part would silently hand the
 * client different bytes than it asked for, so it is refused outright.
 */
export function resolveByteRange(rangeHeader: string | undefined, totalSize: number): RangeResolution {
  if (rangeHeader === undefined) {
    return { kind: "ignore" };
  }
  const match = /^bytes=(.*)$/.exec(rangeHeader.trim());
  if (match === null) {
    // Some other range unit, or not a range at all: not understood, so ignored.
    return { kind: "ignore" };
  }
  const spec = match[1].trim();
  if (spec.includes(",")) {
    return { kind: "unsatisfiable", reason: "不支援多重區間（multi-range）請求，一次只能請求一個位元組區間" };
  }
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (parts === null || (parts[1] === "" && parts[2] === "")) {
    return { kind: "ignore" };
  }
  const [, rawStart, rawEnd] = parts;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0 || totalSize === 0) {
      return { kind: "unsatisfiable", reason: "請求的位元組區間超出檔案範圍" };
    }
    const start = Math.max(0, totalSize - suffixLength);
    return { kind: "satisfiable", start, end: totalSize - 1 };
  }

  const start = Number(rawStart);
  if (start >= totalSize) {
    return { kind: "unsatisfiable", reason: "請求的位元組區間超出檔案範圍" };
  }
  // An absent or over-long end is clamped to the last byte.
  const end = rawEnd === "" ? totalSize - 1 : Math.min(Number(rawEnd), totalSize - 1);
  if (end < start) {
    return { kind: "unsatisfiable", reason: "請求的位元組區間無效" };
  }
  return { kind: "satisfiable", start, end };
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
 *
 * `Range` handling (ticket #13) deliberately happens *after* the bytes have
 * been read successfully, so it cannot disturb that classification: a range
 * request against a missing asset is still a 404, not a 416. The whole file
 * is read into memory either way — `readPresentationFileBytes` returns a
 * Buffer and the range is a slice of it. That is enough for what the browser
 * needs from a range request (an exact 206 window, which is what Safari and
 * seeking depend on); streaming the file off disk is a separate concern.
 */
export async function handleRawRequest(
  presentationId: string,
  virtualPath: string,
  res: ServerResponse,
  rangeHeader: string | undefined,
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

  const contentType = rawContentTypeFor(virtualPath);
  const range = resolveByteRange(rangeHeader, bytes.length);
  if (range.kind === "unsatisfiable") {
    res.writeHead(416, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Range": `bytes */${bytes.length}`,
      "Accept-Ranges": "bytes",
    });
    res.end(JSON.stringify({ error: range.reason }));
    return;
  }
  if (range.kind === "satisfiable") {
    const slice = bytes.subarray(range.start, range.end + 1);
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": slice.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    res.end(slice);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": bytes.length,
    // The virtual path is not a content-addressed URL: the same
    // `/api/raw/<path>` can legitimately serve different bytes over time,
    // since the file on disk — not the URL — is the source of truth
    // (live reload exists precisely because the file can change under the
    // browser's feet). No response carries an ETag or Last-Modified for the
    // browser to revalidate against, so caching is not merely stale-prone
    // here, it is unconditionally wrong: treat every response as one-shot.
    "Cache-Control": "no-store",
    // Without this the browser has no reason to believe a Range request
    // would be honoured, and downloads large video in full before playing.
    "Accept-Ranges": "bytes",
  });
  res.end(bytes);
}
