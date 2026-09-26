import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { path: segments } = await params;
  const file = safeJoin(path.join(/*turbopackIgnore: true*/ process.cwd(), "spec"), segments.join("/"));
  const type = file && (file.endsWith(".md") ? "text/plain; charset=utf-8" : file.endsWith(".json") ? "application/json; charset=utf-8" : null);
  if (!type) return new Response("Not found\n", { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": type, "Cache-Control": "no-cache" },
    });
  } catch {
    return new Response("Not found\n", { status: 404 });
  }
}
