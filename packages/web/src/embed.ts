// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * Third-party video embeds (YouTube) — the web's own copy of
 * core's `embed.ts` URL recognition helpers (F8, NOOP-289). Pure
 * URL parsing, no engine/rendering logic, so it ports unchanged.
 */

/** The one embed provider this project supports. A string union rather than a bare `"youtube"` so adding Vimeo later is a value, not a shape change. */
export type EmbedProvider = "youtube";

export const EMBED_PROVIDERS: readonly EmbedProvider[] = ["youtube"];

/**
 * A YouTube video id is exactly 11 characters from the URL-safe base64
 * alphabet. Matching that shape (rather than "whatever came after the
 * slash") is what keeps a path segment like `results` or `playlist` from
 * being mistaken for a video.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"];
const SHORT_HOST = "youtu.be";

function idOrNull(candidate: string): string | null {
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The video id in a YouTube link, or `null` for anything that is not one.
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

/**
 * The URL the shell's embed overlay loads. `youtube-nocookie.com` rather
 * than `youtube.com`: it is the same player without the tracking cookies.
 */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * `source` -> the embed URL to store on the element, or `null` when the
 * source is not a recognised embed link (the caller then treats it as an
 * ordinary asset URL).
 */
export function embedUrlFor(source: string): { provider: EmbedProvider; url: string } | null {
  const videoId = youtubeVideoId(source);
  if (videoId === null) return null;
  return { provider: "youtube", url: youtubeEmbedUrl(videoId) };
}

/**
 * The `src` the overlay actually loads, given the URL stored on the
 * element — adds whatever the provider needs to accept remote-control
 * commands. `enablejsapi=1` is what makes the YouTube player listen for the
 * `postMessage` commands `embedCommandMessage` produces.
 */
export function embedPlayerSrc(provider: EmbedProvider, url: string): string {
  if (provider !== "youtube") return url;
  return url + (url.includes("?") ? "&" : "?") + "enablejsapi=1";
}
