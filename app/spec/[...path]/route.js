import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { path: segments } = await params;
  const file = safeJoin(path.join(/*turbopackIgnore: true*/ process.cwd(), "spec"), segments.join("/"));
  if (!file || !file.endsWith(".md")) return new Response("Not found\n", { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    });
  } catch {
    return new Response("Not found\n", { status: 404 });
  }
}
