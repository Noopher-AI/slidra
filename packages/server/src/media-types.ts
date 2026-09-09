/**
 * `/api/raw/`'s extension → MIME type table (NOOP-90/T4, [E4.T9]/F7).
 *
 * `packages/server` no longer imports `packages/core`, so this is a
 * literal expansion of `packages/core/src/media-format.ts`'s
 * `MEDIA_FORMATS` table (the byte-signature *detector* itself stays in
 * Rust — `asset import` runs there now; this file only needs the
 * extension/MIME/alias mapping raw.ts already merges with its own
 * `.svg`/`.json`/`.ttf`/`.otf`/`.txt` entries). Must stay in lockstep with
 * that source list and with the player's own extension allow-list
 * (`packages/web/src/player-plan.ts`) — `packages/web/test/player-plan.test.ts`
 * asserts every entry in the player's allow-list resolves to a
 * non-octet-stream type here, specifically to keep the two lists from
 * drifting apart.
 */
export const MEDIA_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  // .m4v is essentially an MP4 container with an Apple-assigned extension;
  // nginx's own mime.types maps m4v to video/mp4 alongside .mp4 itself.
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  // .opus and .oga are both Ogg-muxed audio; audio/ogg is the correct
  // container type for both.
  ".opus": "audio/ogg",
  ".oga": "audio/ogg",
  ".aac": "audio/aac",
};
