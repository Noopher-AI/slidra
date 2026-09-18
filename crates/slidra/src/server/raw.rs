// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `GET /raw/<virtual-path>` ([S11.F9], #404 Scope) — byte-preserving
//! asset serving with HTTP Range support, in-process port of
//! `packages/server/src/raw.ts`. Behavior contract (Plan §4's table, and
//! `raw.ts`'s own `resolveByteRange`/`handleRawRequest`):
//!
//! - A missing asset is 404 EVEN for a Range request — the read happens
//!   before Range is ever inspected (`raw.ts:148-`), so a Range against a
//!   missing file is never 416.
//! - `Range` header absent, unparseable, multi-range, or naming an unknown
//!   unit -> the whole file, 200, `Accept-Ranges: bytes`.
//! - A satisfiable single range -> 206 with `Content-Range`.
//! - An unsatisfiable range (suffix of a 0-byte file, `start >= total`,
//!   `end < start`) -> 416 with `Content-Range: bytes */<len>`.
//! - Every response carries `Accept-Ranges: bytes`; 200/206 additionally
//!   carry `Cache-Control: no-store` (no ETag/Last-Modified — every
//!   response is one-shot, never conditional).

use std::net::TcpStream;

use crate::server::credential::CallerKind;
use crate::server::{self, RawRequest};
use crate::workspace::virtual_fs;

const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];

pub(crate) fn handle(request: &RawRequest, stream: &mut TcpStream, raw_virtual_path: &str) {
    let Some(virtual_path) = server::percent_decode(raw_virtual_path) else {
        server::write_json_error(stream, 400, "invalid path encoding");
        return;
    };
    let Some((_credential, work_dir)) =
        server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };
    let bytes = match virtual_fs::read_virtual_file_bytes(&work_dir, &virtual_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            let status = match &err {
                crate::errors::SlidraError::NotFound(_) => 404,
                crate::errors::SlidraError::InvalidRequest(_) => 500,
            };
            server::write_json_error(stream, status, err.message());
            return;
        }
    };
    let content_type = content_type_for(&virtual_path);
    let total = bytes.len();
    match resolve_byte_range(request.header("range"), total) {
        RangeOutcome::Ignore => {
            server::write_body_response(
                stream,
                200,
                content_type,
                &[
                    ("Cache-Control", "no-store".to_string()),
                    ("Accept-Ranges", "bytes".to_string()),
                ],
                &bytes,
            );
        }
        RangeOutcome::Satisfiable { start, end } => {
            let slice = &bytes[start..=end];
            server::write_body_response(
                stream,
                206,
                content_type,
                &[
                    ("Content-Range", format!("bytes {start}-{end}/{total}")),
                    ("Accept-Ranges", "bytes".to_string()),
                    ("Cache-Control", "no-store".to_string()),
                ],
                slice,
            );
        }
        RangeOutcome::Unsatisfiable { reason } => {
            let body = serde_json::json!({ "error": reason }).to_string();
            server::write_body_response(
                stream,
                416,
                "application/json; charset=utf-8",
                &[
                    ("Content-Range", format!("bytes */{total}")),
                    ("Accept-Ranges", "bytes".to_string()),
                ],
                body.as_bytes(),
            );
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RangeOutcome {
    Ignore,
    Satisfiable { start: usize, end: usize },
    Unsatisfiable { reason: String },
}

/// Ported from `raw.ts:77-116`'s `resolveByteRange`. `range_header` is the
/// raw `Range` header value (case-insensitively looked up by the caller),
/// `total_size` the full asset length.
fn resolve_byte_range(range_header: Option<&str>, total_size: usize) -> RangeOutcome {
    let Some(header) = range_header else {
        return RangeOutcome::Ignore;
    };
    let Some(spec) = header.strip_prefix("bytes=") else {
        return RangeOutcome::Ignore;
    };
    if spec.contains(',') {
        return RangeOutcome::Unsatisfiable {
            reason: "multi-range requests are not supported".to_string(),
        };
    }
    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return RangeOutcome::Ignore;
    };
    if start_raw.is_empty() && end_raw.is_empty() {
        return RangeOutcome::Ignore;
    }
    if !start_raw.chars().all(|c| c.is_ascii_digit())
        || !end_raw.chars().all(|c| c.is_ascii_digit())
    {
        return RangeOutcome::Ignore;
    }

    if start_raw.is_empty() {
        // Suffix range: the last `N` bytes.
        let Ok(suffix_length) = end_raw.parse::<u64>() else {
            return RangeOutcome::Ignore;
        };
        if suffix_length == 0 || total_size == 0 {
            return RangeOutcome::Unsatisfiable {
                reason: "range not satisfiable".to_string(),
            };
        }
        let total = total_size as u64;
        let start = total.saturating_sub(suffix_length);
        return RangeOutcome::Satisfiable {
            start: start as usize,
            end: (total - 1) as usize,
        };
    }

    let Ok(start) = start_raw.parse::<u64>() else {
        return RangeOutcome::Ignore;
    };
    if start >= total_size as u64 {
        return RangeOutcome::Unsatisfiable {
            reason: "range not satisfiable".to_string(),
        };
    }
    let end = if end_raw.is_empty() {
        total_size as u64 - 1
    } else {
        match end_raw.parse::<u64>() {
            Ok(raw_end) => raw_end.min(total_size as u64 - 1),
            Err(_) => return RangeOutcome::Ignore,
        }
    };
    if end < start {
        return RangeOutcome::Unsatisfiable {
            reason: "range not satisfiable".to_string(),
        };
    }
    RangeOutcome::Satisfiable {
        start: start as usize,
        end: end as usize,
    }
}

/// `raw.ts:30-53`'s `rawContentTypeFor` — extension-only lookup, no
/// sniffing; unknown extension -> `application/octet-stream`.
fn content_type_for(virtual_path: &str) -> &'static str {
    let ext = virtual_path
        .rfind('.')
        .map(|i| virtual_path[i + 1..].to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "csv" => "text/csv; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_range_header_ignores() {
        assert_eq!(resolve_byte_range(None, 100), RangeOutcome::Ignore);
    }

    #[test]
    fn unknown_unit_ignores() {
        assert_eq!(
            resolve_byte_range(Some("items=0-1"), 100),
            RangeOutcome::Ignore
        );
    }

    #[test]
    fn multi_range_is_unsatisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=0-1,2-3"), 100),
            RangeOutcome::Unsatisfiable {
                reason: "multi-range requests are not supported".to_string()
            }
        );
    }

    #[test]
    fn both_halves_empty_ignores() {
        assert_eq!(
            resolve_byte_range(Some("bytes=-"), 100),
            RangeOutcome::Ignore
        );
    }

    #[test]
    fn suffix_range_of_zero_length_file_is_unsatisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=-10"), 0),
            RangeOutcome::Unsatisfiable {
                reason: "range not satisfiable".to_string()
            }
        );
    }

    #[test]
    fn suffix_zero_is_unsatisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=-0"), 100),
            RangeOutcome::Unsatisfiable {
                reason: "range not satisfiable".to_string()
            }
        );
    }

    #[test]
    fn suffix_range_clamps_to_start_of_file() {
        assert_eq!(
            resolve_byte_range(Some("bytes=-1000"), 100),
            RangeOutcome::Satisfiable { start: 0, end: 99 }
        );
    }

    #[test]
    fn start_beyond_total_is_unsatisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=100-"), 100),
            RangeOutcome::Unsatisfiable {
                reason: "range not satisfiable".to_string()
            }
        );
    }

    #[test]
    fn open_ended_range_reads_to_the_end() {
        assert_eq!(
            resolve_byte_range(Some("bytes=50-"), 100),
            RangeOutcome::Satisfiable { start: 50, end: 99 }
        );
    }

    #[test]
    fn end_is_clamped_never_an_error() {
        assert_eq!(
            resolve_byte_range(Some("bytes=0-99999"), 100),
            RangeOutcome::Satisfiable { start: 0, end: 99 }
        );
    }

    #[test]
    fn end_before_start_is_unsatisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=50-10"), 100),
            RangeOutcome::Unsatisfiable {
                reason: "range not satisfiable".to_string()
            }
        );
    }

    #[test]
    fn ordinary_middle_range_is_satisfiable() {
        assert_eq!(
            resolve_byte_range(Some("bytes=10-19"), 100),
            RangeOutcome::Satisfiable { start: 10, end: 19 }
        );
    }

    #[test]
    fn content_type_falls_back_to_octet_stream() {
        assert_eq!(
            content_type_for("assets/data.bin"),
            "application/octet-stream"
        );
        assert_eq!(content_type_for("assets/pic.PNG"), "image/png");
        assert_eq!(content_type_for("assets/img.svg"), "image/svg+xml");
    }
}
