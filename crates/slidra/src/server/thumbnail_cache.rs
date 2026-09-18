// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `GET /decks/thumbnail`'s implementation — in-process port of
//! `packages/server/src/storage/thumbnail-cache.ts`. Cache-first, keyed
//! on the deck file's own mtime, so a 50-deck folder is never re-rendered
//! on every visit. Every render is a first-slide SVG with its
//! `../assets/*` references inlined as data URIs so the cache file is
//! self-contained.
//!
//! Two deliberate deviations from the TS original, per this slice's own
//! ruling ("雜湊改標準庫，快取檔名格式可變、舊快取失效可接受" — hash moves
//! to the standard library, the cache filename format may change, and
//! invalidating old cache entries is acceptable):
//! - The cache key's hash is `std::hash::Hasher` (`DefaultHasher`), not
//!   SHA-256 — no crypto crate in this workspace's dependency budget, and
//!   this is a cache key, not a security boundary. `DefaultHasher`'s
//!   algorithm is not guaranteed stable across Rust versions; a rebuild
//!   that changes it just produces a full round of cache misses, not
//!   incorrect behavior.
//! - The mtime component of the cache file name is truncated to whole
//!   milliseconds (`f64 as i64`) rather than carrying JS's fractional
//!   `mtimeMs` verbatim — cosmetic only, since the mtime is read fresh
//!   from the same `stat` call either way.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::errors::SlidraError;
use crate::server::deck_store::{self, DeckStoreError};
use crate::server::reads;
use crate::workspace;

const MAX_INLINE_ASSET_BYTES: usize = 2 * 1024 * 1024;

pub struct ThumbnailResult {
    pub bytes: Vec<u8>,
    /// Already quoted, ready to write straight into an `ETag` header.
    pub etag: String,
}

#[derive(Debug)]
pub enum ThumbnailError {
    /// `fileName` does not name a file in the deck folder — the route's
    /// own 404.
    NotFound(String),
    /// The deck has no slides to render a thumbnail from — the route's
    /// own 204.
    NoSlides(String),
    Invalid(String),
}

impl From<SlidraError> for ThumbnailError {
    fn from(err: SlidraError) -> Self {
        match err {
            SlidraError::NotFound(message) => ThumbnailError::NotFound(message),
            SlidraError::InvalidRequest(message) => ThumbnailError::Invalid(message),
        }
    }
}

impl From<DeckStoreError> for ThumbnailError {
    fn from(err: DeckStoreError) -> Self {
        match err {
            DeckStoreError::NotFound(message) => ThumbnailError::NotFound(message),
            DeckStoreError::Invalid(message) => ThumbnailError::Invalid(message),
            DeckStoreError::NameConflict(message) => ThumbnailError::Invalid(message),
            DeckStoreError::ImportConfirmationRequired { .. } => ThumbnailError::Invalid(
                "unexpected import-confirmation error while resolving a thumbnail".to_string(),
            ),
        }
    }
}

fn thumbnails_dir(home: &Path) -> PathBuf {
    home.join("thumbnails")
}

/// `<hash(deck_path) as 16 hex chars>-<mtime whole ms>.svg` — the hash has
/// no `-` of its own, so splitting the file name on the first `-` always
/// recovers it (mirrors the TS original's own naming shape, see this
/// module's doc comment for what changed and why).
fn cache_file_name(deck_path: &Path, mtime_ms: f64) -> String {
    let mut hasher = DefaultHasher::new();
    deck_path.hash(&mut hasher);
    format!("{:016x}-{}.svg", hasher.finish(), mtime_ms as i64)
}

fn hash_prefix_of(cache_name: &str) -> &str {
    cache_name.split('-').next().unwrap_or(cache_name)
}

/// Resolves a slide SVG's `../assets/<name>` href to its `cat`-virtual
/// path — the only relative shape a slide ever uses (assets live one
/// directory up from `slides/`).
fn asset_virtual_path(href: &str) -> Option<&str> {
    if href.starts_with("../assets/") {
        Some(&href["../".len()..])
    } else {
        None
    }
}

/// MIME lookup used for asset inlining — mirrors `media-types.ts`'s
/// `MEDIA_MIME_TYPES` table exactly (image/video/audio formats only, no
/// svg/font/etc — this intentionally does NOT delegate to `raw.rs`'s
/// broader `content_type_for`, which also covers non-media extensions
/// `thumbnail-cache.ts` never inlines).
fn media_mime_type_for(virtual_path: &str) -> Option<&'static str> {
    let ext = virtual_path
        .rfind('.')
        .map(|i| virtual_path[i..].to_ascii_lowercase())?;
    crate::media_format::MEDIA_FORMATS
        .iter()
        .find(|entry| entry.extension == ext || entry.alias_extensions.contains(&ext.as_str()))
        .map(|entry| entry.mime_type)
}

struct HrefMatch {
    full_start: usize,
    full_end: usize,
    href_start: usize,
    href_end: usize,
    is_xlink: bool,
}

/// Finds every `href="..."`/`xlink:href="..."` attribute in `svg`, in
/// order — a small hand-rolled scanner standing in for the TS original's
/// `/(?:xlink:)?href="([^"]*)"/g`, since this workspace has no `regex`
/// dependency.
fn find_href_matches(svg: &str) -> Vec<HrefMatch> {
    const NEEDLE: &str = "href=\"";
    let mut matches = Vec::new();
    let mut search_from = 0;
    while let Some(rel_idx) = svg[search_from..].find(NEEDLE) {
        let idx = search_from + rel_idx;
        let is_xlink = idx >= "xlink:".len() && &svg[idx - "xlink:".len()..idx] == "xlink:";
        let full_start = if is_xlink { idx - "xlink:".len() } else { idx };
        let href_start = idx + NEEDLE.len();
        let Some(rel_end) = svg[href_start..].find('"') else {
            break;
        };
        let href_end = href_start + rel_end;
        let full_end = href_end + 1;
        matches.push(HrefMatch {
            full_start,
            full_end,
            href_start,
            href_end,
            is_xlink,
        });
        search_from = full_end;
    }
    matches
}

/// Inlines every `../assets/*` href/xlink:href in `svg` as a data URI so
/// the cache file is self-contained. Best-effort: an asset over 2 MiB, an
/// unreadable one, or one with no known media MIME type is left as its
/// original relative href — never fails the whole thumbnail.
fn inline_assets(deck_path: &Path, svg: &str) -> String {
    let matches = find_href_matches(svg);
    let mut result = String::with_capacity(svg.len());
    let mut cursor = 0;
    for m in matches {
        result.push_str(&svg[cursor..m.full_start]);
        let href = &svg[m.href_start..m.href_end];
        let replacement = asset_virtual_path(href).and_then(|virtual_path| {
            let bytes =
                workspace::virtual_fs::read_virtual_file_bytes(deck_path, virtual_path).ok()?;
            if bytes.len() > MAX_INLINE_ASSET_BYTES {
                return None;
            }
            let mime = media_mime_type_for(virtual_path)?;
            Some(format!(
                "data:{mime};base64,{}",
                crate::base64::encode(&bytes)
            ))
        });
        match replacement {
            Some(data_uri) => {
                if m.is_xlink {
                    result.push_str("xlink:");
                }
                result.push_str("href=\"");
                result.push_str(&data_uri);
                result.push('"');
            }
            None => result.push_str(&svg[m.full_start..m.full_end]),
        }
        cursor = m.full_end;
    }
    result.push_str(&svg[cursor..]);
    result
}

/// Deletes every cached thumbnail sharing `hash_prefix` except `keep` —
/// the previous mtime's now-stale file.
fn prune_stale_cache_files(dir: &Path, hash_prefix: &str, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{hash_prefix}-");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name != keep && name.starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn get_or_create_thumbnail(file_name: &str) -> Result<ThumbnailResult, ThumbnailError> {
    let folder = deck_store::ensure_deck_folder()?;
    let deck_path = folder.join(file_name);
    if !deck_path.exists() {
        return Err(ThumbnailError::NotFound(format!(
            "no deck file found: {file_name}"
        )));
    }

    let mtime_ms = workspace::registry::deck_file_mtime_millis(&deck_path)?;
    let home = workspace::resolve_home();
    let dir = thumbnails_dir(&home);
    let cache_name = cache_file_name(&deck_path, mtime_ms);
    let cache_path = dir.join(&cache_name);
    let etag = format!("\"{}\"", &cache_name[..cache_name.len() - ".svg".len()]);

    if cache_path.exists() {
        let bytes = std::fs::read(&cache_path).map_err(|_| {
            ThumbnailError::Invalid(format!(
                "failed to read cached thumbnail: {}",
                cache_path.display()
            ))
        })?;
        return Ok(ThumbnailResult { bytes, etag });
    }

    let resolved = deck_store::resolve_id(file_name)?;
    let project = workspace::project::read_project_json(&deck_path)?;
    let Some(first_slide) = project.slides.first() else {
        return Err(ThumbnailError::NoSlides(format!(
            "deck has no slides: {file_name}"
        )));
    };
    let rendered = reads::render_slide(&resolved.id, first_slide)
        .map_err(|(_status, message)| ThumbnailError::Invalid(message))?;
    let bytes = inline_assets(&deck_path, &rendered).into_bytes();

    std::fs::create_dir_all(&dir).map_err(|_| {
        ThumbnailError::Invalid(format!(
            "failed to create thumbnail cache directory: {}",
            dir.display()
        ))
    })?;
    std::fs::write(&cache_path, &bytes).map_err(|_| {
        ThumbnailError::Invalid(format!(
            "failed to write cached thumbnail: {}",
            cache_path.display()
        ))
    })?;
    prune_stale_cache_files(&dir, hash_prefix_of(&cache_name), &cache_name);

    Ok(ThumbnailResult { bytes, etag })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_virtual_path_strips_the_leading_dotdot() {
        assert_eq!(
            asset_virtual_path("../assets/photo.png"),
            Some("assets/photo.png")
        );
        assert_eq!(asset_virtual_path("photo.png"), None);
        assert_eq!(asset_virtual_path("../slides/001.svg"), None);
    }

    #[test]
    fn media_mime_type_for_matches_only_media_formats() {
        assert_eq!(media_mime_type_for("assets/a.png"), Some("image/png"));
        assert_eq!(media_mime_type_for("assets/a.jpeg"), Some("image/jpeg"));
        assert_eq!(
            media_mime_type_for("assets/a.svg"),
            None,
            "svg is not an inlineable media format"
        );
        assert_eq!(media_mime_type_for("assets/a"), None);
    }

    #[test]
    fn find_href_matches_finds_both_plain_and_xlink_hrefs() {
        let svg = r#"<image href="../assets/a.png"/><use xlink:href="../assets/b.png"/>"#;
        let matches = find_href_matches(svg);
        assert_eq!(matches.len(), 2);
        assert!(!matches[0].is_xlink);
        assert_eq!(
            &svg[matches[0].href_start..matches[0].href_end],
            "../assets/a.png"
        );
        assert!(matches[1].is_xlink);
        assert_eq!(
            &svg[matches[1].href_start..matches[1].href_end],
            "../assets/b.png"
        );
    }

    #[test]
    fn inline_assets_replaces_a_readable_small_asset_and_leaves_others_untouched() {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-thumbnail-inline-{}",
            crate::id::random_hex_suffix()
        ));
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("T")
                .into_iter()
                .collect();
        crate::deck::create_new_with_files(&dir, &files).unwrap();
        let png_bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
        workspace::virtual_fs::create_new_file(&dir, "assets/a.png", png_bytes).unwrap();

        let svg = r#"<svg><image href="../assets/a.png"/><image href="../assets/missing.png"/><a href="https://example.com"/></svg>"#;
        let result = inline_assets(&dir, svg);

        assert!(
            result.contains("data:image/png;base64,"),
            "existing small asset must be inlined: {result}"
        );
        assert!(
            result.contains(r#"href="../assets/missing.png""#),
            "a missing asset must be left as-is: {result}"
        );
        assert!(
            result.contains(r#"href="https://example.com""#),
            "a non-asset href must be left as-is: {result}"
        );

        std::fs::remove_file(&dir).ok();
    }

    #[test]
    fn cache_file_name_round_trips_through_hash_prefix_of() {
        let name = cache_file_name(Path::new("/tmp/some/deck.slidra"), 1700000000123.456);
        assert!(name.ends_with("-1700000000123.svg"), "got {name}");
        let prefix = hash_prefix_of(&name);
        assert!(name.starts_with(&format!("{prefix}-")));
        assert!(!prefix.contains('-'));
    }
}
