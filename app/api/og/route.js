import { coverImageForFile } from "../../../lib/og.js";
import { encodePath, scanDecks } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

/** GET /api/og?deck=/decks/<n>/<file>: the cover of a deck this server lists, as a link-preview PNG. */
export async function GET(request) {
  const deckUrl = new URL(request.url).searchParams.get("deck") ?? "";
  const { mounts } = await scanDecks();
  const file = mounts.get(deckUrl) ?? mounts.get(encodePath(deckUrl));
  if (!file) return new Response("No such deck\n", { status: 404 });
  try {
    const png = await coverImageForFile(file);
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" } });
  } catch {
    return new Response("This deck has no preview\n", { status: 422 });
  }
}
