import { deckSources, displayPath, scanDecks } from "../../../lib/decks.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const { decks } = await scanDecks();
  const directory = deckSources().map(displayPath).join(", ");
  // SLIDRA_ALLOW_REMOTE=1 trusts the served decks to load network resources without asking (format §13).
  const allowRemote = process.env.SLIDRA_ALLOW_REMOTE === "1";
  return Response.json({ directory, decks, allowRemote }, { headers: { "Cache-Control": "no-store" } });
}
