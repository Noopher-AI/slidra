import { headers } from "next/headers";
import ViewerShell from "./viewer-shell.jsx";
import { encodePath, scanDecks } from "../lib/decks.js";
import { OG_HEIGHT, OG_WIDTH, deckSummaryForFile } from "../lib/og.js";

/**
 * A link to one of this server's decks (`/?deck=/decks/<n>/<file>`) previews
 * as that deck: its name, description and cover slide.
 */
export async function generateMetadata({ searchParams }) {
  const deckUrl = (await searchParams).deck;
  if (typeof deckUrl !== "string") return {};
  const { mounts } = await scanDecks();
  const file = mounts.get(deckUrl) ?? mounts.get(encodePath(deckUrl));
  const summary = file ? await deckSummaryForFile(file) : null;
  if (!summary) return {};
  const host = (await headers()).get("host");
  const origin = host ? `${process.env.NODE_ENV === "production" ? "https" : "http"}://${host}` : undefined;
  const title = `${summary.name || "Untitled deck"} — Slidra`;
  const description = summary.description ?? `A ${summary.slides}-slide presentation in the open .slidra format.`;
  const image = { url: `/api/og?deck=${encodeURIComponent(deckUrl)}`, width: OG_WIDTH, height: OG_HEIGHT, alt: summary.name };
  return {
    metadataBase: origin ? new URL(origin) : undefined,
    title,
    description,
    openGraph: { title, description, type: "website", images: [image] },
    alternates: { types: { "application/json+oembed": `/api/oembed?url=${encodeURIComponent(`${origin ?? ""}/?deck=${encodeURIComponent(deckUrl)}`)}` } },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default function Home() {
  return <ViewerShell />;
}
