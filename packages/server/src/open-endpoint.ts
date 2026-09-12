import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SlidraError } from "./slidra/errors.js";
import { runJsonCommand } from "./slidra/command.js";
import {
  maxMtimeInDirectory,
  readProjectsRegistry,
  resolveSlidraHome,
  withProjectsRegistryLock,
  writeProjectsRegistry,
} from "./slidra/home.js";
import { readSaveState } from "./slidra/save-state.js";
import type { ChangeBroadcaster } from "./changes.js";
import { broadcastSaveState } from "./save-state.js";

/**
 * `POST /api/open` (NOOP-93, §4.1) — the GUI's Open action. A browser's
 * `<input type="file">` only ever hands over bytes, never a real filesystem
 * path (§2 point 6, §7 decision 6), so this is the same "raw body + a
 * filename header" shape `POST /api/asset` already established.
 *
 * The uploaded bytes are staged under `<SLIDRA_HOME>/opened/<opaque>/`
 * and become the presentation's new `sourcePath` — Save from here on
 * writes back to that staged copy, never to wherever the file actually
 * lives on the author's own machine, because this server was never told
 * that path (§7 decision 6's documented limitation).
 *
 * [E4.T9]/F7: there is no CLI command that swaps an existing id's content
 * while keeping the id itself (every route, the change broadcaster, and
 * the agent chat session are all bound to the id `serve` started on).
 * `slidra open <staged-file> --json` always mints a *new* id, so this
 * module implements "reopen in place" itself (plan §3.8): open into a
 * throwaway id, then move that id's on-disk content into the real id's
 * work directory, then discard the throwaway id and the old undo history.
 */

const FILE_NAME_HEADER = "x-slidra-file-name";
const DISCARD_UNSAVED_HEADER = "x-slidra-discard-unsaved";
const UNNAMED_FALLBACK = "未命名.slidra";
/** The deck `POST /api/new` creates: no slides, and a name the author is meant to replace. */
const NEW_DECK_NAME = "未命名";
const NEW_DECK_FILE_NAME = `${NEW_DECK_NAME}.slidra`;

/** Same order-of-magnitude headroom as asset-upload.ts's own limit, halved: a `.slidra` with no large embedded media is far smaller than this; a bigger one should go through the CLI instead (§4.1's table). */
export const MAX_OPEN_BODY_BYTES = 16 * 1024 * 1024;

const ILLEGAL_FILESYSTEM_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** Ported verbatim from `packages/core`'s `asset-import.ts` (§3.7) — this file's only private copy, used to turn the uploaded file's display name into a safe on-disk staging name. */
function sanitizeAssetBaseName(sourceName: string): string {
  const withoutExtension = sourceName.replace(/\.[^./]+$/, "");
  const sanitized = withoutExtension.replace(ILLEGAL_FILESYSTEM_CHARS, "_").trim();
  return sanitized.length > 0 ? sanitized : "asset";
}

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
 * Replaces presentation `id`'s work directory content in place with
 * `stagedPath`'s, without changing `id` itself — plan §3.8, ported from
 * `packages/core`'s `reopenPresentationInPlace`, with the actual unpack
 * moved into the Rust binary: `slidra open <stagedPath> --json` does the
 * zip decompression, `project.json` validation and formatVersion migration
 * (a fresh, throwaway id `id2`); this function only moves files around
 * afterwards.
 *
 * The real work directory (`workDirFor(id)`) is never deleted or recreated
 * — only its children are swapped — because `fs.watch(workDir, {recursive:
 * true})` (`watch.ts`) holds a handle on that exact inode; recreating the
 * directory would kill a live `serve` watcher out from under a running
 * server. `id`'s staging directory (`workDirFor(id2)`) and its `projects.json`
 * entry are removed once the swap is durable.
 */
async function reopenPresentationInPlace(id: string, stagedPath: string): Promise<void> {
  const home = resolveSlidraHome();
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) {
    throw new SlidraError(`no presentation found for id: ${id}`);
  }

  const opened = await runJsonCommand<{ id: string }>(["open", stagedPath]);
  if (!opened.ok) {
    throw new SlidraError(opened.message);
  }
  const id2 = opened.data?.id;
  if (typeof id2 !== "string") {
    throw new SlidraError("open 回傳的資料格式錯誤");
  }

  const registryAfterOpen = await readProjectsRegistry();
  const stagedEntry = registryAfterOpen.get(id2);
  if (!stagedEntry) {
    throw new SlidraError(`no presentation found for id: ${id2}`);
  }

  const existingChildren = await readdir(entry.workDir);
  await Promise.all(existingChildren.map((name) => rm(path.join(entry.workDir, name), { recursive: true, force: true })));
  const stagedChildren = await readdir(stagedEntry.workDir);
  await Promise.all(
    stagedChildren.map((name) => rename(path.join(stagedEntry.workDir, name), path.join(entry.workDir, name))),
  );

  // Read-modify-write under the lock, so a `slidra` process registering
  // its own presentation at the same moment does not lose its entry to this
  // write (or vice versa). Deliberately narrower than this whole function:
  // the `open` above shells out to the CLI, which takes this same lock.
  const savedAt = await maxMtimeInDirectory(entry.workDir);
  await withProjectsRegistryLock(async () => {
    const finalRegistry = await readProjectsRegistry();
    finalRegistry.set(id, { ...entry, sourcePath: stagedPath, savedAt });
    finalRegistry.delete(id2);
    await writeProjectsRegistry(finalRegistry);
  });

  await rm(stagedEntry.workDir, { recursive: true, force: true }).catch(() => {});
  await rm(path.join(home, "history", id), { recursive: true, force: true }).catch(() => {});
}

/**
 * `POST /api/new` — the GUI's New action, the sibling of Open. Makes a
 * brand-new presentation with no slides at all (`slidra new` writes
 * `"slides": []`) and swaps it into this server's own id through the very
 * same `reopenPresentationInPlace` Open uses: `serve` is bound to one id
 * for its whole lifetime (routes, change broadcaster, agent session), so
 * "new" can only ever mean "this id, emptied", never a second id.
 *
 * Takes no request body. The unsaved-changes gate is Open's, verbatim —
 * discarding the author's work is exactly as destructive here.
 */
export async function handleNewPost(
  presentationId: string,
  changeBroadcaster: ChangeBroadcaster,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers[DISCARD_UNSAVED_HEADER] !== "1") {
    const saveState = await readSaveState(presentationId);
    if (saveState.known && saveState.dirty) {
      sendJson(res, 409, { error: "目前的簡報有未儲存的變更" });
      return;
    }
  }

  const home = resolveSlidraHome();
  const opaqueId = randomBytes(9).toString("hex");
  const stagedDir = path.join(home, "opened", opaqueId);
  const stagedPath = path.join(stagedDir, NEW_DECK_FILE_NAME);
  await mkdir(stagedDir, { recursive: true });

  const created = await runJsonCommand<unknown>(["new", stagedPath, "--name", NEW_DECK_NAME]);
  if (!created.ok) {
    await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, 400, { error: created.message });
    return;
  }

  try {
    await reopenPresentationInPlace(presentationId, stagedPath);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof SlidraError ? error.message : "建立失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, fileName: NEW_DECK_FILE_NAME });
  // Same pair of broadcasts, for the same reason, as handleOpenPost's.
  changeBroadcaster.broadcast("presentation-changed", {});
  await broadcastSaveState(changeBroadcaster, presentationId);
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

  const home = resolveSlidraHome();
  const opaqueId = randomBytes(9).toString("hex");
  const safeName = `${sanitizeAssetBaseName(displayName)}.slidra`;
  const stagedDir = path.join(home, "opened", opaqueId);
  const stagedPath = path.join(stagedDir, safeName);
  await mkdir(stagedDir, { recursive: true });
  await writeFile(stagedPath, body);

  try {
    // Validates the uploaded bytes (a real zip, a valid project.json, a
    // supported formatVersion) before touching the live work directory —
    // see reopenPresentationInPlace's own comment. Its SlidraError
    // messages (relayed from `slidra open`'s own JSON message) are
    // relayed verbatim, matching §4.1's table.
    await reopenPresentationInPlace(presentationId, stagedPath);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof SlidraError ? error.message : "開啟失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, fileName: safeName });
  // "presentation-changed and save-state (dirty:false) are broadcast in the
  // same turn" — called directly here rather than left to changes.ts's own debounced
  // fs.watch pickup, which would (a) only fire once some browser tab has
  // opened /api/events at all (ensureWatcher() starts lazily) and (b) lag
  // by its 100ms debounce. Both events share the one existing broadcaster.
  changeBroadcaster.broadcast("presentation-changed", {});
  await broadcastSaveState(changeBroadcaster, presentationId);
}
