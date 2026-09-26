import { encodePath, scanDecks } from "../../../lib/decks.js";
import { deckSummaryForFile } from "../../../lib/og.js";

export const dynamic = "force-dynamic";

/**
 * oEmbed (https://oembed.com) for this server's decks: given a viewer link
 * (`…/?deck=/decks/<n>/<file>`) or an embed link, answers with an <iframe>
 * of /embed that other sites paste or unfurl.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  if ((params.get("format") ?? "json") !== "json") return new Response("Only JSON is supported\n", { status: 501 });
  let target;
  try {
    target = new URL(params.get("url") ?? "");
  } catch {
    return new Response("url must be a link to a deck on this server\n", { status: 404 });
  }
  const origin = new URL(request.url).origin;
  const deckUrl = target.searchParams.get("deck") ?? "";
  const { mounts } = await scanDecks();
  const file = target.origin === origin ? (mounts.get(deckUrl) ?? mounts.get(encodePath(deckUrl))) : null;
  const summary = file ? await deckSummaryForFile(file) : null;
  if (!summary) return new Response("No such deck on this server\n", { status: 404 });

  const maxWidth = Number(params.get("maxwidth")) || Infinity;
  const maxHeight = Number(params.get("maxheight")) || Infinity;
  // 16:9 plus the 44 px control bar, within the consumer's bounds.
  let width = Math.min(960, maxWidth);
  let height = Math.round((width * 9) / 16) + 44;
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(((height - 44) * 16) / 9);
  }
  const embed = `${origin}/embed?deck=${encodeURIComponent(deckUrl)}`;
  const title = summary.name || "Untitled deck";
  const escape = (text) => text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  return Response.json({
    version: "1.0",
    type: "rich",
    provider_name: "Slidra",
    provider_url: origin,
    title,
    width,
    height,
    html: `<iframe src="${escape(embed)}" width="${width}" height="${height}" title="${escape(title)}" style="border:0" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>`,
    thumbnail_url: `${origin}/api/og?deck=${encodeURIComponent(deckUrl)}`,
    thumbnail_width: 1200,
    thumbnail_height: 630,
  });
}
