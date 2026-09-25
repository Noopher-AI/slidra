#!/usr/bin/env node
// Slidra Viewer — a zero-dependency static server.
//
//   node server.js [decks-dir-or-file ...] [--port 8080] [--host 127.0.0.1]
//
// Serves the viewer at http://localhost:8080/ and lists every .slidra file
// in the given directories (default: ./decks and ./examples) at
// /api/decks. Decks are parsed and played entirely in the browser; the
// server only hands out bytes.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".slidra": "application/vnd.slidra",
};

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT) || 8080,
    host: process.env.HOST || "127.0.0.1",
    sources: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice(7));
    else if (arg === "--host") options.host = argv[++i];
    else if (arg.startsWith("--host=")) options.host = arg.slice(7);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node server.js [decks-dir-or-file ...] [--port 8080] [--host 127.0.0.1]");
      process.exit(0);
    } else options.sources.push(path.resolve(arg));
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    console.error(`invalid port: ${options.port}`);
    process.exit(2);
  }
  if (options.sources.length === 0) options.sources = [path.join(ROOT, "decks"), path.join(ROOT, "examples")];
  return options;
}

const options = parseArgs(process.argv.slice(2));

/**
 * Every served deck, keyed by its URL path. Each source is mounted at
 * /decks/<n>/…; a single-file source is mounted as itself. Rebuilt on each
 * /api/decks request so newly added files appear on reload.
 */
async function scanDecks() {
  const decks = [];
  const mounts = new Map();
  for (const [n, source] of options.sources.entries()) {
    let info;
    try {
      info = await stat(source);
    } catch {
      continue;
    }
    const mount = `/decks/${n}/`;
    if (info.isFile()) {
      if (!source.toLowerCase().endsWith(".slidra")) continue;
      const name = path.basename(source);
      const url = mount + encodeURIComponent(name);
      mounts.set(url, source);
      decks.push({ name, url, path: displayPath(source), size: info.size });
      continue;
    }
    for (const file of await walk(source, 3)) {
      const relative = path.relative(source, file).split(path.sep);
      const url = mount + relative.map(encodeURIComponent).join("/");
      const size = (await stat(file)).size;
      mounts.set(url, file);
      decks.push({ name: path.basename(file), url, path: displayPath(file), size });
    }
  }
  return { decks, mounts };
}

async function walk(dir, depth) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...(await walk(full, depth - 1)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".slidra")) found.push(full);
  }
  return found;
}

function displayPath(file) {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

/** Resolves a URL path under `base`, refusing anything that escapes it. */
function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = path.resolve(base, "." + path.posix.normalize("/" + decoded));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function sendFile(req, res, file, cache = "no-cache") {
  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, "Not found\n");
  }
  if (!info.isFile()) return send(res, 404, "Not found\n");
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag });
    return res.end();
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": cache,
    ETag: etag,
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed\n");
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api/decks") {
      const { decks } = await scanDecks();
      const directory = options.sources.map(displayPath).join(", ");
      return send(res, 200, JSON.stringify({ directory, decks }), "application/json; charset=utf-8");
    }
    if (pathname.startsWith("/decks/")) {
      const { mounts } = await scanDecks();
      const file = mounts.get(pathname) ?? mounts.get(encodePath(safeDecode(pathname)));
      return file ? sendFile(req, res, file) : send(res, 404, "No such deck\n");
    }
    if (pathname.startsWith("/spec/")) {
      const file = safeJoin(path.join(ROOT, "spec"), pathname.slice("/spec/".length));
      return file ? sendFile(req, res, file) : send(res, 404, "Not found\n");
    }
    const file = safeJoin(path.join(ROOT, "public"), pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file) return send(res, 400, "Bad path\n");
    return sendFile(req, res, file);
  } catch (error) {
    console.error(error);
    send(res, 500, "Internal error\n");
  }
});

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePath(value) {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${options.port} is already in use. Try --port <another>.`);
  else console.error(error.message);
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  const { port } = server.address();
  const host = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host === "127.0.0.1" ? "localhost" : options.host;
  console.log(`Slidra Viewer → http://${host}:${port}/`);
  for (const source of options.sources) console.log(`  serving decks from ${displayPath(source)}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
