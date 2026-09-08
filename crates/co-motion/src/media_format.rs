//! Media format byte-header detection — ported from
//! `packages/core/src/media-format.ts` (NOOP-90/T4, ADR-0015): one
//! extension/MIME/kind entry per format, plus a byte-signature detector
//! that decides a file's real format from its content — never from a
//! caller-supplied extension.
//!
//! Public API:
//! - `MediaKind` — `Image` | `Video` | `Audio` (mirrors TS's `MediaKind`
//!   string union; `as_str()` gives the lowercase JSON value).
//! - `MediaFormatEntry` — one row of the format table.
//! - `MEDIA_FORMATS` — every format this crate recognises, in table order
//!   (order is not significant, matching the TS original's own note).
//! - `detect_media_format(bytes) -> Option<MediaFormatEntry>` — `None` when
//!   the bytes match no known format; callers must treat that as a
//!   rejection, never a fallback to any default.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
        }
    }
}

/// One row of the media-format table — mirrors TS's `MediaFormatEntry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaFormatEntry {
    /// Canonical extension written for a newly imported asset of this
    /// format, including the leading dot.
    pub extension: &'static str,
    pub mime_type: &'static str,
    pub kind: MediaKind,
    /// Other extensions that must resolve to the same MIME type when
    /// serving a pre-existing file (e.g. ".jpeg" alongside ".jpg"). Never
    /// used when naming a freshly imported file — kept here only so this
    /// table stays a faithful, complete port of the TS original; no call
    /// site in this crate reads it yet (the server-side MIME lookup that
    /// consumes it in TS is out of this ticket's scope).
    pub alias_extensions: &'static [&'static str],
}

const fn entry(
    extension: &'static str,
    mime_type: &'static str,
    kind: MediaKind,
    alias_extensions: &'static [&'static str],
) -> MediaFormatEntry {
    MediaFormatEntry {
        extension,
        mime_type,
        kind,
        alias_extensions,
    }
}

const PNG: MediaFormatEntry = entry(".png", "image/png", MediaKind::Image, &[]);
const JPEG: MediaFormatEntry = entry(".jpg", "image/jpeg", MediaKind::Image, &[".jpeg"]);
const GIF: MediaFormatEntry = entry(".gif", "image/gif", MediaKind::Image, &[]);
const WEBP: MediaFormatEntry = entry(".webp", "image/webp", MediaKind::Image, &[]);
const MP4: MediaFormatEntry = entry(".mp4", "video/mp4", MediaKind::Video, &[]);
const WEBM: MediaFormatEntry = entry(".webm", "video/webm", MediaKind::Video, &[]);
// .m4v is essentially an MP4 container with an Apple-assigned extension;
// nginx's own mime.types maps m4v to video/mp4 alongside .mp4 itself.
const M4V: MediaFormatEntry = entry(".m4v", "video/mp4", MediaKind::Video, &[]);
const MOV: MediaFormatEntry = entry(".mov", "video/quicktime", MediaKind::Video, &[]);
const OGV: MediaFormatEntry = entry(".ogv", "video/ogg", MediaKind::Video, &[]);
const MP3: MediaFormatEntry = entry(".mp3", "audio/mpeg", MediaKind::Audio, &[]);
const WAV: MediaFormatEntry = entry(".wav", "audio/wav", MediaKind::Audio, &[]);
const M4A: MediaFormatEntry = entry(".m4a", "audio/mp4", MediaKind::Audio, &[]);
// .opus and .oga are both Ogg-muxed audio; audio/ogg is the correct
// container type for both ("audio/opus" names the raw codec/RTP payload
// rather than an Ogg file, so it is not used here).
const OPUS: MediaFormatEntry = entry(".opus", "audio/ogg", MediaKind::Audio, &[]);
const OGA: MediaFormatEntry = entry(".oga", "audio/ogg", MediaKind::Audio, &[]);
const AAC: MediaFormatEntry = entry(".aac", "audio/aac", MediaKind::Audio, &[]);

/// Every media format co-motion knows about. Order is not significant.
pub const MEDIA_FORMATS: &[MediaFormatEntry] = &[
    PNG, JPEG, GIF, WEBP, MP4, WEBM, M4V, MOV, OGV, MP3, WAV, M4A, OPUS, OGA, AAC,
];

fn starts_with(bytes: &[u8], prefix: &[u8], offset: usize) -> bool {
    if bytes.len() < offset + prefix.len() {
        return false;
    }
    &bytes[offset..offset + prefix.len()] == prefix
}

/// Reads `length` bytes at `offset` as ASCII (one byte -> one char, no
/// encoding validation — the TS original does the equivalent
/// `String.fromCharCode` per byte). Returns `""` if the bytes aren't
/// available, matching `asciiAt`'s TS behavior of never throwing on a
/// short buffer.
fn ascii_at(bytes: &[u8], offset: usize, length: usize) -> String {
    if bytes.len() < offset + length {
        return String::new();
    }
    bytes[offset..offset + length]
        .iter()
        .map(|&b| b as char)
        .collect()
}

/// Finds `needle` anywhere in the first `within_first` bytes. Used to
/// locate an Ogg stream's codec identification header, which does not sit
/// at a fixed offset.
fn contains_within(bytes: &[u8], needle: &[u8], within_first: usize) -> bool {
    if bytes.len() < needle.len() {
        return false;
    }
    let limit = std::cmp::min(bytes.len() - needle.len(), within_first);
    for start in 0..=limit {
        if &bytes[start..start + needle.len()] == needle {
            return true;
        }
    }
    false
}

/// ISO Base Media File Format container: MP4, M4V, MOV and M4A all share
/// the same "ftyp" box; only the major brand at offset 8 tells them apart.
fn detect_iso_bmff(bytes: &[u8]) -> MediaFormatEntry {
    let brand = ascii_at(bytes, 8, 4);
    if brand == "qt  " {
        return MOV;
    }
    if brand == "M4A " {
        return M4A;
    }
    if brand == "M4V " || brand == "M4VH" || brand == "M4VP" {
        return M4V;
    }
    // Every other ISO-BMFF major brand (isom, iso2, mp41, mp42, avc1,
    // dash, ...) is treated as a plain MP4 container — this project only
    // needs to route recognised media to the right extension/MIME type,
    // not classify every ISO-BMFF profile.
    MP4
}

const VORBIS_IDENTIFICATION_HEADER: &[u8] = b"\x01vorbis";
const OPUS_IDENTIFICATION_HEADER: &[u8] = b"OpusHead";
const THEORA_IDENTIFICATION_HEADER: &[u8] = b"\x80theora";
const OGG_CODEC_SCAN_WINDOW: usize = 256;

/// Ogg is a generic container; the codec identification header inside its
/// first logical page tells video (Theora) apart from the two audio
/// codecs this project imports. An Ogg stream carrying an unrecognised
/// codec is not a supported media format.
fn detect_ogg_codec(bytes: &[u8]) -> Option<MediaFormatEntry> {
    if contains_within(bytes, THEORA_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW) {
        return Some(OGV);
    }
    if contains_within(bytes, OPUS_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW) {
        return Some(OPUS);
    }
    if contains_within(bytes, VORBIS_IDENTIFICATION_HEADER, OGG_CODEC_SCAN_WINDOW) {
        return Some(OGA);
    }
    None
}

/// Detects a file's real media format from its opening bytes only — never
/// from a filename or a declared Content-Type (ADR-0015). Returns `None`
/// when the bytes match no known format, which callers must treat as a
/// rejection, not a fallback to any default.
pub fn detect_media_format(bytes: &[u8]) -> Option<MediaFormatEntry> {
    if starts_with(bytes, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) {
        return Some(PNG);
    }
    if starts_with(bytes, &[0xff, 0xd8, 0xff], 0) {
        return Some(JPEG);
    }
    if starts_with(bytes, &[0x47, 0x49, 0x46, 0x38], 0) {
        // "GIF8"
        return Some(GIF);
    }
    if starts_with(bytes, &[0x52, 0x49, 0x46, 0x46], 0) {
        // RIFF container: WEBP and WAV share the same 4-byte magic; the
        // format tag sits at offset 8.
        if ascii_at(bytes, 8, 4) == "WEBP" {
            return Some(WEBP);
        }
        if ascii_at(bytes, 8, 4) == "WAVE" {
            return Some(WAV);
        }
        return None;
    }
    if ascii_at(bytes, 4, 4) == "ftyp" {
        return Some(detect_iso_bmff(bytes));
    }
    if starts_with(bytes, &[0x1a, 0x45, 0xdf, 0xa3], 0) {
        return Some(WEBM);
    }
    if ascii_at(bytes, 0, 4) == "OggS" {
        return detect_ogg_codec(bytes);
    }
    if ascii_at(bytes, 0, 3) == "ID3" {
        return Some(MP3);
    }
    if bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0 {
        // MPEG audio frame sync (11 bits of 1s spanning byte 0 and the top
        // 3 bits of byte 1). The next 2 bits of byte 1 are the "layer"
        // field: binary 01 is Layer III (MP3); binary 00 is reserved in
        // the real MPEG audio spec and is exactly the value ADTS AAC
        // repurposes for its own, structurally different frame header —
        // so a reserved layer field after a valid sync is read as ADTS
        // AAC, not as a corrupt MP3 frame.
        let layer = (bytes[1] >> 1) & 0x3;
        if layer == 0b01 {
            return Some(MP3);
        }
        if layer == 0b00 {
            return Some(AAC);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_signature() {
        let bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        assert_eq!(detect_media_format(&bytes), Some(PNG));
    }

    #[test]
    fn jpeg_signature() {
        let bytes = [0xff, 0xd8, 0xff, 0xe0, 0, 0];
        assert_eq!(detect_media_format(&bytes), Some(JPEG));
    }

    #[test]
    fn gif_signature() {
        let bytes = b"GIF89a....";
        assert_eq!(detect_media_format(bytes), Some(GIF));
    }

    #[test]
    fn webp_signature() {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]); // chunk size, irrelevant
        bytes.extend_from_slice(b"WEBP");
        assert_eq!(detect_media_format(&bytes), Some(WEBP));
    }

    #[test]
    fn wav_signature() {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(b"WAVE");
        assert_eq!(detect_media_format(&bytes), Some(WAV));
    }

    #[test]
    fn riff_container_with_unknown_format_tag_is_none() {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(b"AVI ");
        assert_eq!(detect_media_format(&bytes), None);
    }

    #[test]
    fn mp4_signature_generic_brand() {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(b"isom");
        assert_eq!(detect_media_format(&bytes), Some(MP4));
    }

    #[test]
    fn mov_signature_qt_brand() {
        let mut bytes = vec![0, 0, 0, 0x14];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(b"qt  ");
        assert_eq!(detect_media_format(&bytes), Some(MOV));
    }

    #[test]
    fn m4v_signature() {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(b"M4V ");
        assert_eq!(detect_media_format(&bytes), Some(M4V));
    }

    #[test]
    fn m4a_signature() {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(b"M4A ");
        assert_eq!(detect_media_format(&bytes), Some(M4A));
    }

    #[test]
    fn webm_signature() {
        let bytes = [0x1a, 0x45, 0xdf, 0xa3, 0, 0];
        assert_eq!(detect_media_format(&bytes), Some(WEBM));
    }

    #[test]
    fn ogv_signature_theora_header_within_scan_window() {
        let mut bytes = b"OggS".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 20));
        bytes.extend_from_slice(b"\x80theora");
        assert_eq!(detect_media_format(&bytes), Some(OGV));
    }

    #[test]
    fn opus_signature_within_scan_window() {
        let mut bytes = b"OggS".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 20));
        bytes.extend_from_slice(b"OpusHead");
        assert_eq!(detect_media_format(&bytes), Some(OPUS));
    }

    #[test]
    fn oga_vorbis_signature_within_scan_window() {
        let mut bytes = b"OggS".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 20));
        bytes.extend_from_slice(b"\x01vorbis");
        assert_eq!(detect_media_format(&bytes), Some(OGA));
    }

    #[test]
    fn ogg_stream_with_unrecognised_codec_is_none() {
        let mut bytes = b"OggS".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 40));
        assert_eq!(detect_media_format(&bytes), None);
    }

    #[test]
    fn mp3_signature_id3_tag() {
        let bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00";
        assert_eq!(detect_media_format(bytes), Some(MP3));
    }

    #[test]
    fn mp3_signature_frame_sync_layer_iii() {
        // 0xFF F3: sync=11111111111, layer bits (bits 2-1 of second byte)
        // = 01 -> Layer III.
        let bytes = [0xff, 0xfb, 0x90, 0x00];
        assert_eq!(detect_media_format(&bytes), Some(MP3));
    }

    #[test]
    fn aac_signature_adts_frame_sync() {
        // 0xFF F1: sync=11111111111, layer bits = 00 -> reserved layer,
        // read as ADTS AAC.
        let bytes = [0xff, 0xf1, 0x50, 0x80];
        assert_eq!(detect_media_format(&bytes), Some(AAC));
    }

    #[test]
    fn extension_is_never_consulted_only_bytes_matter() {
        // `detect_media_format` takes no extension/filename argument at
        // all — the byte header alone decides the format, so a caller
        // cannot influence the result by lying about the source's
        // extension. The full "extension says .png, content is JPEG"
        // pipeline (source-name-driven filename vs. byte-header-driven
        // format) is exercised end to end in `asset_import::tests`, where
        // both a name and bytes are available together.
        let jpeg_bytes = [0xff, 0xd8, 0xff, 0xe0, 0, 0];
        assert_eq!(detect_media_format(&jpeg_bytes), Some(JPEG));
    }

    #[test]
    fn no_known_format_matches_is_none() {
        let bytes = b"this is not a media file at all";
        assert_eq!(detect_media_format(bytes), None);
    }

    #[test]
    fn empty_bytes_is_none() {
        assert_eq!(detect_media_format(&[]), None);
    }

    #[test]
    fn media_formats_table_has_all_fifteen_entries() {
        assert_eq!(MEDIA_FORMATS.len(), 15);
    }
}
