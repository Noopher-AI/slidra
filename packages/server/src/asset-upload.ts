import type { IncomingMessage, ServerResponse } from "node:http";
import { importAssetBytes, type AssetImportData } from "@co-motion/cli";
import { CoMotionError } from "@co-motion/core";

/**
 * `POST /api/asset` (T3/NOOP-142) — the front end's byte-upload path for
 * drag/drop and clipboard-paste asset import.
 *
 * `POST /api/command` cannot carry this: its `name` whitelist forwards to
 * `registry.dispatch`, and `asset import`'s own input is a server-local
 * path or URL — a browser has neither, only `File`/`Blob` bytes — and its
 * 64 KiB body cap (`command-endpoint.ts`) would reject any real image
 * base64-encoded into JSON anyway. This route exists so the transport
 * matches what a browser actually has: raw bytes in the body, a filename
 * in a header. The format decision itself still goes through
 * `resolveAssetImport` via the CLI's shared `importAssetBytes` — this
 * module owns no format logic of its own (ADR-0015: one place decides,
 * never a second copy).
 */

/** Same order of magnitude headroom over a real screenshot/photo as the CLI's own import allows; large enough for real media, small enough to bound memory while reading. */
export const MAX_ASSET_BODY_BYTES = 32 * 1024 * 1024;

const ASSET_NAME_HEADER = "x-co-motion-asset-name";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

/** Same shape as `command-endpoint.ts`'s `readLimitedBody`, but binary: chunks are kept as `Buffer`s, never decoded through a text encoding along the way. */
function readLimitedBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        // Same reasoning as command-endpoint.ts: stop accumulating, but do
        // not destroy the socket, so the 400 below can still reach the
        // client instead of racing an ECONNRESET.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Runs one asset upload against this server's own presentation. The
 * presentation id is never read from the request — same rule as
 * `handleCommandPost` — this server was started on exactly one id and that
 * is the only one any route ever writes into.
 */
export async function handleAssetPost(
  presentationId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sourceNameHeader = req.headers[ASSET_NAME_HEADER];
  const sourceName = typeof sourceNameHeader === "string" ? sourceNameHeader : "";
  if (sourceName.trim() === "") {
    sendJson(res, 400, { error: `缺少標頭：${ASSET_NAME_HEADER}` });
    return;
  }
  let decodedSourceName: string;
  try {
    decodedSourceName = decodeURIComponent(sourceName);
  } catch {
    sendJson(res, 400, { error: `標頭編碼無效：${ASSET_NAME_HEADER}` });
    return;
  }

  let body: Buffer;
  try {
    body = await readLimitedBinaryBody(req, MAX_ASSET_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 400, { error: `請求內容過大（上限 ${MAX_ASSET_BODY_BYTES} 位元組）` });
      return;
    }
    sendJson(res, 400, { error: "請求內容讀取失敗" });
    return;
  }

  let data: AssetImportData;
  try {
    data = await importAssetBytes(presentationId, decodedSourceName, new Uint8Array(body));
  } catch (error) {
    sendJson(res, 400, { error: error instanceof CoMotionError ? error.message : "匯入失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, data, message: `已匯入媒體：${data.path}` });
}
