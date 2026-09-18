// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

export interface EditorServiceOptions {
  port: number;
  staticDir: string;
  /** Final page bytes. Bootstrap injection belongs to the launcher, not this service. */
  indexHtml: Uint8Array;
  host?: string;
}

export interface EditorService {
  url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function send(res: ServerResponse, status: number, contentType: string, body: Uint8Array): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
    "Cache-Control": status === 200 ? "no-store" : "no-cache",
  });
  res.end(body);
}

export async function startEditorService(options: EditorServiceOptions): Promise<EditorService> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`).pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 404, "text/plain; charset=utf-8", new TextEncoder().encode("not found"));
        return;
      }
      if (pathname === "/") {
        send(res, 200, "text/html; charset=utf-8", options.indexHtml);
        return;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        send(res, 404, "text/plain; charset=utf-8", new TextEncoder().encode("not found"));
        return;
      }

      const relative = path.posix.normalize(pathname).replace(/^\/+/, "");
      if (relative.startsWith("..")) {
        send(res, 404, "text/plain; charset=utf-8", new TextEncoder().encode("not found"));
        return;
      }
      try {
        const bytes = await readFile(path.join(options.staticDir, relative));
        send(res, 200, CONTENT_TYPES[path.extname(relative)] ?? "application/octet-stream", bytes);
      } catch {
        send(res, 404, "text/plain; charset=utf-8", new TextEncoder().encode("not found"));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("editor service did not bind a TCP port");

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
