import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommandRegistry } from "@co-motion/cli";

/**
 * `POST /api/command` (NOOP-91 §4.9) — the front end's only write path.
 *
 * Direct manipulation on the canvas (drag, handles, snapping) has to end in
 * a real command, and before this ticket the server had no route that could
 * run one: `POST` was 405 for everything except `/api/chat`. This module is
 * that route, and it is deliberately the narrowest thing that can work.
 *
 * Two properties carry the whole security posture, and both are structural
 * rather than remembered:
 *
 *  1. A NAME WHITELIST, checked BEFORE `registry.dispatch` is reached at
 *     all. Every registered command is reachable through the registry —
 *     `open`, `pack`, `new`, `convert` included — so an endpoint that
 *     forwarded an arbitrary `name` would hand any script that can reach
 *     this origin the entire CLI. The check is not a filter over the
 *     registry's contents; it is a fixed list this module owns.
 *
 *  2. THE PRESENTATION ID IS THE SERVER'S. Whatever `id` the client put in
 *     `input` is discarded and overwritten with the id this server was
 *     started on. A `serve` process is bound to exactly one presentation,
 *     so a request that could name another one would let a page reach
 *     outside the deck it is displaying.
 *
 * Freeze/lock gates are explicitly NOT here (cross-ticket arbitration):
 * another ticket layers those on top of this route.
 */

/**
 * The only commands this endpoint will run. Each entry is a decision for
 * whichever ticket needed it, not a convenience — the Ribbon's "常用" tab
 * (NOOP-141) is what added `slide add` / `element copy` / `element cut` /
 * `element paste` / `element insert` / `textbox add` / `element align` /
 * `element distribute` / `element order` to the original four, in-place text
 * editing (NOOP-144) added `text set`, and the style panel (NOOP-143) added
 * `element style set` — the command layer's own
 * `STYLE_ATTRIBUTE_WHITELIST`/`validateStyleAttribute`
 * (`packages/core/src/element-edit.ts`) still does the real gatekeeping on
 * which attributes are settable.
 */
export const COMMAND_WHITELIST: readonly string[] = [
  "element move",
  "element scale",
  "element rotate",
  "textbox width",
  "text set",
  "slide add",
  // [E2.T3] 的頁面管理與備忘稿加入這四條。
  "slide delete",
  "slide duplicate",
  "slide move",
  "slide notes set",
  "element copy",
  "element cut",
  "element paste",
  "element insert",
  "textbox add",
  "element align",
  "element distribute",
  "element order",
  "element style set",
  // [E2.T11] replaces the presentation-wide `presentation transition set`
  // with the per-slide `slide transition set`.
  "slide transition set",
  // [E4.T7] 的範本管理對話框加入這四條。
  "template add",
  "template list",
  "template rename",
  "template delete",
  // NOOP-90/T2 的舞台選取與直接操作加入這三條：四角把手送
  // `element resize`（新命令）；Delete/Backspace 與元素右鍵選單的 Delete
  // 送 `element delete`；⌘D 與右鍵選單的 Duplicate 送 `element
  // duplicate` —— 這兩條命令本來就存在於 registry，只是從未被這個端點
  // 放行過，沒有這三條會被這個白名單本身 403 掉。
  "element resize",
  "element delete",
  "element duplicate",
  // [E2.T7] 的 Animate 面板／時間軸／情境列 Edit animation 加入這四條；
  // `effect list` 不在其中——GUI 的清單狀態走一般的檔案讀取路徑
  // （`GET /api/files/`），不需要透過命令端點。
  "effect add",
  "effect remove",
  "effect move",
  "effect set",
  // [E2.T8] 的留言框／Pinned context 加入這三條——建立、修改、刪除留言都是
  // GUI 的寫入路徑；`comment list` 不必加，前端讀留言走 `/api/raw/`，不經
  // 這個端點（見計畫 §4.3）。
  "comment add",
  "comment edit",
  "comment delete",
];

/**
 * Hard cap on the request body. A drag's command input is a few hundred
 * bytes; 64 KiB is orders of magnitude of headroom and still small enough
 * that a stream of oversized bodies cannot grow this process's memory. The
 * limit is enforced WHILE reading (the socket is destroyed the moment it is
 * exceeded), not after buffering the whole thing, which would defeat the
 * point of having a limit.
 */
export const MAX_COMMAND_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

function readLimitedBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return; // Drain the rest without buffering any of it.
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        // Stop ACCUMULATING immediately — but do not destroy the socket
        // here. Destroying it mid-request races the 400 this rejection is
        // about to produce, and the client sees an ECONNRESET instead of
        // the explicit refusal (measured, not assumed). The remaining
        // bytes are read and thrown away, so memory stays bounded by
        // `limit` plus one chunk either way.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Runs one whitelisted command against this server's own presentation.
 *
 * Check order matters and is asserted by the tests: body size, then JSON
 * syntax, then `name`'s type, then the whitelist, then `input`'s shape.
 * The whitelist sits ahead of input validation so a non-whitelisted name is
 * always answered 403 — never 400 — regardless of what the body carried
 * alongside it, which keeps "was this command refused?" a question with one
 * answer.
 *
 * Failure mapping follows `/api/files/`'s existing narrow rule (ticket
 * #14): only a `failureKind` that positively proves absence is a 404.
 * A missing kind is "not proven absent", i.e. 500.
 */
export async function handleCommandPost(
  registry: CommandRegistry,
  presentationId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: string;
  try {
    raw = await readLimitedBody(req, MAX_COMMAND_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 400, { error: `請求內容過大（上限 ${MAX_COMMAND_BODY_BYTES} 位元組）` });
      return;
    }
    sendJson(res, 400, { error: "請求內容讀取失敗" });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "請求內容不是有效的 JSON" });
    return;
  }
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "請求內容必須是物件" });
    return;
  }

  const { name, input } = body as { name?: unknown; input?: unknown };
  if (typeof name !== "string") {
    sendJson(res, 400, { error: "name 必須是字串" });
    return;
  }
  if (!COMMAND_WHITELIST.includes(name)) {
    sendJson(res, 403, { error: `這個端點不接受命令：${name}` });
    return;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    sendJson(res, 400, { error: "input 必須是物件" });
    return;
  }

  // The client's own `id`, if it sent one, is overwritten here — never
  // merged, never trusted. This spread order is the enforcement.
  const resolvedInput = { ...(input as Record<string, unknown>), id: presentationId };

  let result: Awaited<ReturnType<CommandRegistry["dispatch"]>>;
  try {
    result = await registry.dispatch(name, resolvedInput);
  } catch (error) {
    // A thrown error out of dispatch is a bug or an unclassified failure,
    // never a user-facing "not found".
    sendJson(res, 500, { error: error instanceof Error ? error.message : "命令執行失敗" });
    return;
  }

  if (!result.ok) {
    const status = result.failureKind === "not-found" ? 404 : 500;
    sendJson(res, status, { error: result.message, failureKind: result.failureKind ?? null });
    return;
  }

  sendJson(res, 200, { ok: true, data: result.data ?? {}, message: result.message });
}
