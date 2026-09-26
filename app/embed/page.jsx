import EmbedShell from "./embed-shell.jsx";
import { encodePath, scanDecks } from "../../lib/decks.js";
import { deckSummaryForFile } from "../../lib/og.js";

export async function generateMetadata({ searchParams }) {
  const deckUrl = (await searchParams).deck;
  if (typeof deckUrl !== "string") return { title: "Slidra" };
  const { mounts } = await scanDecks();
  const file = mounts.get(deckUrl) ?? mounts.get(encodePath(deckUrl));
  const summary = file ? await deckSummaryForFile(file) : null;
  return { title: summary ? `${summary.name || "Untitled deck"} — Slidra` : "Slidra" };
}

export default function Embed() {
  return <EmbedShell />;
}
