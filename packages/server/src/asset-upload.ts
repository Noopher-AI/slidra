import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJsonCommand } from "./slidra/command.js";

/**
 * `POST /api/asset` (T3/NOOP-142) — the front end's byte-upload path for
 * drag/drop and clipboard-paste asset import.
 *
 * `POST /api/command` cannot carry this: its `name` whitelist forwards to
 * a fixed set of commands, and `asset import`'s own input is a server-local
 * path or URL — a browser has neither, only `File`/`Blob` bytes — and its
 * 64 KiB body cap (`command-endpoint.ts`) would reject any real image
 * base64-encoded into JSON anyway. This route exists so the transport
 * matches what a browser actually has: raw bytes in the body, a filename
 * in a header. [E4.T9]/F7: the format decision itself now lives entirely
 * in the Rust `slidra asset import <staged-file> --json` command — this
 * module writes the uploaded bytes to a temp file and spawns it, then
 * cleans the temp file up; it owns no format logic of its own (ADR-0015:
 * one place decides, never a second copy).
 */

/** Same order of magnitude headroom over a real screenshot/photo as the CLI's own import allows; large enough for real media, small enough to bound memory while reading. */
export const MAX_ASSET_BODY_BYTES = 32 * 1024 * 1024;

const ASSET_NAME_HEADER = "x-slidra-asset-name";
/**
 * [E2.T17] plan §4.3/D5: the URL-import counterpart of `ASSET_NAME_HEADER`
 * — GUI panels send the source as a URL instead of raw bytes. Only
 * `http(s)` is ever accepted here: `asset import`'s CLI `source` also
 * accepts a local filesystem path, and blanket-forwarding that same
 * flexibility to an HTTP endpoint would widen ADR-0004's "no reading
 * outside the presentation" hole from "the CLI operator's own machine" to
 * "anything this server process can open a file descriptor on" — `file:`,
 * a relative path, and an absolute path are all rejected the same way.
 */
const ASSET_URL_HEADER = "x-slidra-asset-url";
const URL_SCHEME_PATTERN = /^https?:\/\//i;

interface AssetImportData {
  /** Virtual path of the imported file, e.g. "assets/photo-1.png". */
  path: string;
  mimeType: string;
  kind: string;
}

/** A user-facing asset-import failure, always safe to relay verbatim as a 400 (never carries a real filesystem path — see `runAssetImport`). */
class AssetImportFailedError extends Error {}

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
 * Writes `bytes` to a fresh temp file (named after `sourceBasename`'s own
 * basename — `asset import` derives the imported file's name from its
 * source's basename, so the staged file's name must match what the caller
 * asked to import) and runs `slidra asset import <staged-file> --json`
 * against it, cleaning the temp directory up either way.
 *
 * A missing/unreadable source file (`failureKind === "not-found"`) can only
 * ever mean OUR OWN staged temp file here — the caller never gets to name
 * a real filesystem path — so that message (which would otherwise quote
 * the real temp path, ADR-0004) is replaced with a fixed one (plan §4.5).
 * Every other failure (an unsupported media format, ...) only ever names
 * virtual paths and is relayed verbatim.
 */
async function runAssetImport(presentationId: string, sourceBasename: string, bytes: Uint8Array): Promise<AssetImportData> {
  const dir = await mkdtemp(path.join(tmpdir(), "slidra-asset-"));
  const safeName = path.basename(sourceBasename) || "asset";
  const filePath = path.join(dir, safeName);
  try {
    await writeFile(filePath, bytes);
    const result = await runJsonCommand<AssetImportData>(["asset", "import", presentationId, filePath]);
    if (!result.ok) {
      throw new AssetImportFailedError(result.failureKind === "not-found" ? "匯入失敗" : result.message);
    }
    const data = result.data;
    if (typeof data !== "object" || data === null || typeof (data as AssetImportData).path !== "string") {
      throw new AssetImportFailedError("匯入失敗");
    }
    return data as AssetImportData;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs one asset upload against this server's own presentation. The
 * presentation id is never read from the request — same rule as
 * `handleCommandPost` — this server was started on exactly one id and that
 * is the only one any route ever writes into.
 */
export async function handleAssetPost(presentationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sourceNameHeader = req.headers[ASSET_NAME_HEADER];
  const sourceUrlHeader = req.headers[ASSET_URL_HEADER];
  const hasName = typeof sourceNameHeader === "string" && sourceNameHeader.trim() !== "";
  const hasUrl = typeof sourceUrlHeader === "string" && sourceUrlHeader.trim() !== "";

  if (hasName && hasUrl) {
    sendJson(res, 400, { error: `不可同時提供 ${ASSET_NAME_HEADER} 與 ${ASSET_URL_HEADER}` });
    return;
  }

  if (hasUrl) {
    await handleUrlAsset(presentationId, sourceUrlHeader as string, res);
    return;
  }

  const sourceName = typeof sourceNameHeader === "string" ? sourceNameHeader : "";
  if (sourceName.trim() === "") {
    sendJson(res, 400, { error: `缺少標頭：${ASSET_NAME_HEADER} 或 ${ASSET_URL_HEADER}` });
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
    data = await runAssetImport(presentationId, decodedSourceName, new Uint8Array(body));
  } catch (error) {
    sendJson(res, 400, { error: error instanceof AssetImportFailedError ? error.message : "匯入失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, data, message: `已匯入媒體：${data.path}` });
}

/** `sourceNameOf` for a URL (mirrors the old `packages/cli` asset-import command's own helper): the URL path's basename, percent-decoded. */
function sourceBasenameOfUrl(url: string): string {
  return decodeURIComponent(path.posix.basename(new URL(url).pathname));
}

/**
 * Downloads `url`'s bytes, bounded by `maxBytes` — checked against
 * `Content-Length` first (fails fast without buffering when the server is
 * honest about size), then again after buffering (a missing or lying
 * header does not get a pass). `crates/slidra/src/http.rs`'s own module
 * comment documents that the Rust binary's `asset import <url>` takes NO
 * size limit at all, so the URL must never be handed to it directly (plan
 * §4.5, decision #8) — this Node-side download is what keeps
 * `MAX_ASSET_BODY_BYTES` enforced for a browser-triggered import.
 */
async function downloadAssetSource(url: string, maxBytes: number): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new AssetImportFailedError(`無法下載來源：${url}`);
  }
  if (!response.ok) {
    throw new AssetImportFailedError(`無法下載來源，伺服器回應 ${response.status}：${url}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new AssetImportFailedError(`下載內容過大（上限 ${maxBytes} 位元組）：${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new AssetImportFailedError(`下載內容過大（上限 ${maxBytes} 位元組）：${url}`);
  }
  return bytes;
}

/**
 * [E2.T17] plan §4.3/D5: `POST /api/asset`'s URL mode — `X-Slidra-Asset-Url`
 * (URL-encoded) instead of a raw-bytes body. Downloads server-side (bounded
 * by `MAX_ASSET_BODY_BYTES`) and stages the result the same way the
 * raw-bytes path does, then runs the same `asset import` spawn.
 */
async function handleUrlAsset(presentationId: string, urlHeader: string, res: ServerResponse): Promise<void> {
  let url: string;
  try {
    url = decodeURIComponent(urlHeader);
  } catch {
    sendJson(res, 400, { error: `標頭編碼無效：${ASSET_URL_HEADER}` });
    return;
  }

  if (!URL_SCHEME_PATTERN.test(url)) {
    sendJson(res, 400, { error: `${ASSET_URL_HEADER} 必須是 http(s) 網址` });
    return;
  }

  let data: AssetImportData;
  try {
    const bytes = await downloadAssetSource(url, MAX_ASSET_BODY_BYTES);
    data = await runAssetImport(presentationId, sourceBasenameOfUrl(url), bytes);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof AssetImportFailedError ? error.message : "匯入失敗" });
    return;
  }

  sendJson(res, 200, { ok: true, data, message: `已匯入媒體：${data.path}` });
}
