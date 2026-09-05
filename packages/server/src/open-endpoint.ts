import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, readSaveState, reopenPresentationInPlace, resolveCoMotionHome, sanitizeAssetBaseName } from "@co-motion/core";
import type { ChangeBroadcaster } from "./changes.js";
import { broadcastSaveState } from "./save-state.js";

/**
 * `POST /api/open` (NOOP-93, §4.1) — the GUI's Open action. A browser's
 * `<input type="file">` only ever hands over bytes, never a real filesystem
 * path (§2 point 6, §7 decision 6), so this is the same "raw body + a
 * filename header" shape `POST /api/asset` already established
 * (`asset-upload.ts`'s `readLimitedBinaryBody`, copied here rather than
 * shared — the two bodies mean different things and there is no third
 * caller yet to justify factoring them together).
 *
 * The uploaded bytes are staged under `<CO_MOTION_HOME>/opened/<opaque>/`
 * and become the presentation's new `sourcePath` — Save from here on
 * writes back to that staged copy, never to wherever the file actually
 * lives on the author's own machine, because this server was never told
 * that path (§7 decision 6's documented limitation).
 */

const FILE_NAME_HEADER = "x-co-motion-file-name";
const DISCARD_UNSAVED_HEADER = "x-co-motion-discard-unsaved";
const UNNAMED_FALLBACK = "未命名.comot";

/** Same order-of-magnitude headroom as asset-upload.ts's own limit, halved: a `.comot` with no large embedded media is far smaller than this; a bigger one should go through the CLI instead (§4.1's table). */
export const MAX_OPEN_BODY_BYTES = 16 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

/** Same shape as asset-upload.ts's own `readLimitedBinaryBody` — binary, size-capped, never destroys the socket on overflow so a 400 can still reach the client. */
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
 * Runs one `POST /api/open` against this server's own presentation id — the
 * presentation id is never read from the request, same rule every other
 * route in this file family follows (`handleAssetPost`, `handleCommandPost`).
 */
export async function handleOpenPost(
  presentationId: string,
  changeBroadcaster: ChangeBroadcaster,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const fileNameHeader = req.headers[FILE_NAME_HEADER];
  let displayName = UNNAMED_FALLBACK;
  if (typeof fileNameHeader === "string" && fileNameHeader.trim() !== "") {
    try {
      displayName = decodeURIComponent(fileNameHeader);
    } catch {
      sendJson(res, 400, { error: `標頭編碼無效：${FILE_NAME_HEADER}` });
      return;
    }
  }

  let body: Buffer;
  try {
    body = await readLimitedBinaryBody(req, MAX_OPEN_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 400, { error: "簡報檔案過大" });
      return;
    }
    sendJson(res, 400, { error: "請求內容讀取失敗" });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: "沒有收到檔案內容" });
    return;
  }

  if (req.headers[DISCARD_UNSAVED_HEADER] !== "1") {
    const saveState = await readSaveState(presentationId);
    if (saveState.known && saveState.dirty) {
      sendJson(res, 409, { error: "目前的簡報有未儲存的變更" });
      return;
    }
  }

  const home = resolveCoMotionHome();
  const opaqueId = randomBytes(9).toString("hex");
  const safeName = `${sanitizeAssetBaseName(displayName)}.comot`;
  const stagedDir = path.join(home, "opened", opaqueId);
  const stagedPath = path.join(stagedDir, safeName);
  await mkdir(stagedDir, { recursive: true });
  await writeFile(stagedPath, body);

  try {
    // Validates the uploaded bytes (a real zip, a valid project.json, a
    // supported formatVersion) before touching the live work directory —
    // see reopenPresentationInPlace's own comment. Its CoMotionError
    // messages (from unpackContainer / assertSupportedFormatVersion) are
    // relayed verbatim, matching §4.1's table.
    await reopenPresentationInPlace(presentationId, stagedPath);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof CoMotionError ? error.message : "開啟失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, fileName: safeName });
  // §4.1: "同一輪內廣播 presentation-changed 與 save-state（dirty:false）" —
  // called directly here rather than left to changes.ts's own debounced
  // fs.watch pickup, which would (a) only fire once some browser tab has
  // opened /api/events at all (ensureWatcher() starts lazily) and (b) lag
  // by its 100ms debounce. Both events share the one existing broadcaster.
  changeBroadcaster.broadcast("presentation-changed", {});
  await broadcastSaveState(changeBroadcaster, presentationId);
}
