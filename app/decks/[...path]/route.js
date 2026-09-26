import { readFile } from "node:fs/promises";
import { encodePath, scanDecks } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { pathname } = new URL(request.url);
  const { mounts } = await scanDecks();
  const file = mounts.get(pathname) ?? mounts.get(encodePath(safeDecode(pathname)));
  if (!file) return new Response("No such deck\n", { status: 404 });
  const bytes = await readFile(file);
  return new Response(bytes, {
    headers: { "Content-Type": "application/vnd.slidra", "Cache-Control": "no-cache" },
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
