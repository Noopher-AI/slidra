import { deckSources, displayPath, scanDecks } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const { decks } = await scanDecks();
  const directory = deckSources().map(displayPath).join(", ");
  return Response.json({ directory, decks }, { headers: { "Cache-Control": "no-store" } });
}
