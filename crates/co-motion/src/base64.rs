//! Standard base64 (RFC 4648 §4, with `=` padding) — used only by `--json`
//! output's `content` field (`cat`/`slide render`). Deliberately separate
//! from `id.rs`'s base64**url** alphabet (no padding, `-`/`_` instead of
//! `+`/`/`): `--json` needs the padded standard alphabet Node's
//! `Buffer#toString("base64")` produces, not the URL-safe one ids use.

const STANDARD_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes `bytes` as standard base64 with `=` padding to a multiple of 4
/// characters — `Buffer.from(bytes).toString("base64")`'s exact output.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(STANDARD_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(STANDARD_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            STANDARD_ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            STANDARD_ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_empty_input_to_empty_string() {
        assert_eq!(encode(&[]), "");
    }

    #[test]
    fn encodes_with_standard_alphabet_and_padding() {
        // "Ma" -> "TWE=" (1 padding char, RFC 4648 test-vector shape).
        assert_eq!(encode(b"Ma"), "TWE=");
        // "M" -> "TQ==" (2 padding chars).
        assert_eq!(encode(b"M"), "TQ==");
        // "Man" -> "TWFu" (no padding, exactly 3 bytes).
        assert_eq!(encode(b"Man"), "TWFu");
    }

    #[test]
    fn uses_plus_slash_not_url_safe_chars() {
        // 0xfb 0xff 0xbf -> indices 62,63,62,63 in the standard alphabet: '+','/','+','/'.
        assert_eq!(encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }
}
