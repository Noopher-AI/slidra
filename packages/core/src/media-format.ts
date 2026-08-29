/**
 * The single source of truth for which media formats co-motion recognises
 * (NOOP-90/T4, ADR-0015): one extension/MIME/kind entry per format, plus a
 * byte-signature detector that decides a file's real format from its
 * content — never from a caller-supplied extension. `packages/server/src/raw.ts`
 * derives its media Content-Type table from this list instead of keeping a
 * second copy (Dev-Leader ruling on NOOP-99: the player's own
 * `packages/web/src/player-plan.ts` extension lists are out of this
 * ticket's boundary and stay independent, guarded by the existing
 * cross-package test `packages/web/test/player-plan.test.ts`).
 *
 * No Node built-ins here, matching the rest of this module's siblings
 * (`element-text.ts`, `slide/`) — pure byte inspection only, safe to run in
 * a browser too.
 */

export type MediaKind = "image" | "video" | "audio";

export interface MediaFormatEntry {
  /** Canonical extension written for a newly imported asset of this format, including the leading dot. */
  readonly extension: string;
  readonly mimeType: string;
  readonly kind: MediaKind;
  /** Other extensions that must resolve to the same MIME type when serving a pre-existing file (e.g. ".jpeg" alongside ".jpg"). Never used when naming a freshly imported file. */
  readonly aliasExtensions: readonly string[];
}

function entry(
  extension: string,
  mimeType: string,
  kind: MediaKind,
  aliasExtensions: readonly string[] = [],
): MediaFormatEntry {
  return { extension, mimeType, kind, aliasExtensions };
}

const PNG = entry(".png", "image/png", "image");
const JPEG = entry(".jpg", "image/jpeg", "image", [".jpeg"]);
const GIF = entry(".gif", "image/gif", "image");
const WEBP = entry(".webp", "image/webp", "image");
const MP4 = entry(".mp4", "video/mp4", "video");
const WEBM = entry(".webm", "video/webm", "video");
// .m4v is essentially an MP4 container with an Apple-assigned extension;
// nginx's own mime.types maps m4v to video/mp4 alongside .mp4 itself.
const M4V = entry(".m4v", "video/mp4", "video");
const MOV = entry(".mov", "video/quicktime", "video");
const OGV = entry(".ogv", "video/ogg", "video");
const MP3 = entry(".mp3", "audio/mpeg", "audio");
const WAV = entry(".wav", "audio/wav", "audio");
const M4A = entry(".m4a", "audio/mp4", "audio");
// .opus and .oga are both Ogg-muxed audio; audio/ogg is the correct
// container type for both (see raw.ts's prior note on why "audio/opus",
// which names the raw codec/RTP payload rather than an Ogg file, is not
// used here).
const OPUS = entry(".opus", "audio/ogg", "audio");
const OGA = entry(".oga", "audio/ogg", "audio");
const AAC = entry(".aac", "audio/aac", "audio");

/** Every media format co-motion knows about. Order is not significant. */
export const MEDIA_FORMATS: readonly MediaFormatEntry[] = [
  PNG,
  JPEG,
  GIF,
  WEBP,
  MP4,
  WEBM,
  M4V,
  MOV,
  OGV,
  MP3,
  WAV,
  M4A,
  OPUS,
  OGA,
  AAC,
];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

/** Finds `needle` anywhere in the first `withinFirst` bytes. Used to locate an Ogg stream's codec identification header, which does not sit at a fixed offset. */
function containsWithin(bytes: Uint8Array, needle: readonly number[], withinFirst: number): boolean {
  const limit = Math.min(bytes.length - needle.length, withinFirst);
  for (let start = 0; start <= limit; start++) {
    let matched = true;
    for (let i = 0; i < needle.length; i++) {
      if (bytes[start + i] !== needle[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** ISO Base Media File Format container: MP4, M4V, MOV and M4A all share the same "ftyp" box; only the major brand at offset 8 tells them apart. */
function detectIsoBmff(bytes: Uint8Array): MediaFormatEntry {
  const brand = asciiAt(bytes, 8, 4);
  if (brand === "qt  ") return MOV;
  if (brand === "M4A ") return M4A;
  if (brand === "M4V " || brand === "M4VH" || brand === "M4VP") return M4V;
  // Every other ISO-BMFF major brand (isom, iso2, mp41, mp42, avc1, dash, ...)
  // is treated as a plain MP4 container — this project only needs to route
  // recognised media to the right extension/MIME type, not classify every
  // ISO-BMFF profile.
  return MP4;
}

const VORBIS_IDENTIFICATION_HEADER = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x01vorbis"
const OPUS_IDENTIFICATION_HEADER = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const THEORA_IDENTIFICATION_HEADER = [0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61]; // "\x80theora"
const OGG_CODEC_SCAN_WINDOW = 256;

/** Ogg is a generic container; the codec identification header inside its first logical page tells video (Theora) apart from the two audio codecs this project imports. An Ogg stream carrying an unrecognised codec is not a supported media format. */
function detectOggCodec(bytes: Uint8Array): MediaFormatEntry | null {
  if (containsWithin(bytes, THEORA_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW)) return OGV;
  if (containsWithin(bytes, OPUS_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW)) return OPUS;
  if (containsWithin(bytes, VORBIS_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW)) return OGA;
  return null;
}

/**
 * Detects a file's real media format from its opening bytes only — never
 * from a filename or a declared Content-Type (ADR-0015). Returns `null`
 * when the bytes match no known format, which callers must treat as a
 * rejection, not a fallback to any default.
 */
export function detectMediaFormat(bytes: Uint8Array): MediaFormatEntry | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return GIF; // "GIF8"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
    // RIFF container: WEBP and WAV share the same 4-byte magic; the format
    // tag sits at offset 8.
    if (asciiAt(bytes, 8, 4) === "WEBP") return WEBP;
    if (asciiAt(bytes, 8, 4) === "WAVE") return WAV;
    return null;
  }
  if (asciiAt(bytes, 4, 4) === "ftyp") return detectIsoBmff(bytes);
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return WEBM;
  if (asciiAt(bytes, 0, 4) === "OggS") return detectOggCodec(bytes);
  if (asciiAt(bytes, 0, 3) === "ID3") return MP3;
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync (11 bits of 1s spanning byte 0 and the top 3
    // bits of byte 1). The next 2 bits of byte 1 are the "layer" field:
    // binary 01 is Layer III (MP3); binary 00 is reserved in the real MPEG
    // audio spec and is exactly the value ADTS AAC repurposes for its own,
    // structurally different frame header — so a reserved layer field after
    // a valid sync is read as ADTS AAC, not as a corrupt MP3 frame.
    const layer = (bytes[1] >> 1) & 0x3;
    if (layer === 0b01) return MP3;
    if (layer === 0b00) return AAC;
  }
  return null;
}
