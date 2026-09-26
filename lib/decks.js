// Server-side deck library: finds the .slidra files the viewer lists at
// /api/decks and hands out their bytes at /decks/<n>/….
//
// Sources come from SLIDRA_DECKS (a path-delimited list of directories or
// .slidra files); the default is ./decks and ./examples. Each source is
// mounted at /decks/<n>/; a single-file source is mounted as itself.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export function deckSources() {
  const configured = (process.env.SLIDRA_DECKS ?? "").split(path.delimiter).filter(Boolean);
  const sources = configured.length > 0 ? configured : ["decks", "examples"];
  return sources.map((source) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), source));
}

/** Every served deck, plus a map from its URL path to its file. Rescanned per request so new files appear on reload. */
export async function scanDecks() {
  const decks = [];
  const mounts = new Map();
  for (const [n, source] of deckSources().entries()) {
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

export function displayPath(file) {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

/** Resolves a URL path under `base`, refusing anything that escapes it. */
export function safeJoin(base, urlPath) {
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

export function encodePath(value) {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
