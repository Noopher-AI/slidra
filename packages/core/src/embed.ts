import { CoMotionError } from "./errors.js";

/**
 * [E2.T17] Third-party video embeds (YouTube).
 *
 * A YouTube link is not an asset: there are no bytes to download and no
 * file header to detect, so it cannot go through `resolveAssetImport`'s
 * path at all. It is a reference to a player hosted somewhere else, and
 * the slide stores exactly that reference — the canonical `nocookie`
 * embed URL — under `data-comot-media`, with `data-comot-embed="youtube"`
 * marking it as "this is a foreign player, not a media file".
 *
 * Why the shell renders it in the PARENT document rather than inside the
 * slide iframe: that iframe is a `srcdoc` document, so granting it
 * `allow-same-origin` (which the YouTube player requires — measured: with
 * `allow-scripts` alone the player refuses to load with
 * `embedder.identity.missing.referrer`) would make it same-origin with the
 * app itself, letting untrusted slide content script its way out of the
 * sandbox. ADR-0011 forbids exactly that, and a nested iframe's sandbox
 * flags are the INTERSECTION with its parent's, so the permission cannot be
 * handed to just the embed from inside. The parent-document overlay is what
 * keeps the sandbox token untouched.
 */

/** The one embed provider this project supports. A string union rather than a bare `"youtube"` so adding Vimeo later is a value, not a shape change. */
export type EmbedProvider = "youtube";

export const EMBED_PROVIDERS: readonly EmbedProvider[] = ["youtube"];

/** Narrows an arbitrary string to an `EmbedProvider`, throwing the project's standard error otherwise. */
export function requireEmbedProvider(value: string): EmbedProvider {
  if (!EMBED_PROVIDERS.includes(value as EmbedProvider)) {
    throw new CoMotionError(`不支援的嵌入來源：${value}（支援的來源：${EMBED_PROVIDERS.join("、")}）`);
  }
  return value as EmbedProvider;
}

/**
 * A YouTube video id is exactly 11 characters from the URL-safe base64
 * alphabet. Matching that shape (rather than "whatever came after the
 * slash") is what keeps a path segment like `results` or `playlist` from
 * being mistaken for a video.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"];
const SHORT_HOST = "youtu.be";

/**
 * The video id in a YouTube link, or `null` for anything that is not one.
 * Returning `null` rather than throwing is deliberate: the caller's next
 * question is "is this a YouTube link at all?", and a link to an ordinary
 * `.mp4` must fall through to the asset-download path, not blow up.
 *
 * Recognised shapes: `watch?v=<id>`, `youtu.be/<id>`, `/embed/<id>`,
 * `/shorts/<id>`, `/live/<id>` — on either the normal or the `nocookie`
 * host, with or without `www.`/`m.`.
 */
export function youtubeVideoId(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (host === SHORT_HOST) {
    return idOrNull(url.pathname.split("/")[1]);
  }
  if (!YOUTUBE_HOSTS.includes(host)) return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return null;
  if (segments[0] === "watch") {
    return idOrNull(url.searchParams.get("v") ?? "");
  }
  if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live") {
    return idOrNull(segments[1] ?? "");
  }
  return null;
}

function idOrNull(candidate: string): string | null {
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The URL the shell's embed overlay loads. `youtube-nocookie.com` rather
 * than `youtube.com`: it is the same player without the tracking cookies,
 * which is the right default for a document the author will hand to an
 * audience.
 */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * `source` -> the embed URL to store on the element, or `null` when the
 * source is not a recognised embed link (the caller then treats it as an
 * ordinary asset URL). One function so no caller re-implements the
 * "recognise, then canonicalise" pair.
 */
export function embedUrlFor(source: string): { provider: EmbedProvider; url: string } | null {
  const videoId = youtubeVideoId(source);
  if (videoId === null) return null;
  return { provider: "youtube", url: youtubeEmbedUrl(videoId) };
}

/**
 * The `src` the overlay actually loads, given the URL stored on the
 * element. Kept apart from `youtubeEmbedUrl` deliberately: the stored URL
 * is the canonical, human-meaningful one that lives in the slide file,
 * while this adds whatever the provider needs to accept remote-control
 * commands — a rendering detail that has no business being written into
 * the document.
 *
 * `enablejsapi=1` is what makes the YouTube player listen for the
 * `postMessage` commands `embedCommandMessage` produces; without it the
 * player ignores them silently.
 */
export function embedPlayerSrc(provider: EmbedProvider, url: string): string {
  if (provider !== "youtube") return url;
  return url + (url.includes("?") ? "&" : "?") + "enablejsapi=1";
}
