//! `co-motion asset import <presentation-id> <source> [--as csv]` — copies
//! or downloads a media (or, with `--as csv`, data) asset into the
//! presentation's `assets/` (or `assets/data/`) directory (NOOP-90/T4,
//! ADR-0015). Ported from `packages/cli/src/commands/asset-import.ts`'s
//! `assetImportCommand`/`importAssetBytes`/`importDataAssetBytes`, with
//! Node's `fetch`/`readFile` replaced by `crate::http::download_source`/
//! `std::fs::read` and `createPresentationFile`/`listPresentationEntries`
//! replaced by their `crate::workspace` equivalents.
//!
//! Byte-header validation and filename-conflict resolution live in
//! `crate::asset_import` (`resolve_asset_import`/`resolve_data_asset_import`)
//! — this module only does the I/O and control flow: read the source
//! (local path or URL), decide media vs. data asset, then write through
//! `create_presentation_file` so the import gets undo for free (deleting
//! the file undoes it).
//!
//! One confirmed, deliberate behavior difference from the TS original
//! (`docs/spec/cli.md`'s `## \`asset import\`` section): a missing/unreadable
//! LOCAL source file maps to `not-found` here, where the TS CLI leaves it
//! `failed`. This is a spec-mandated correction, not a bug — see the
//! module-level comment on `run` below for why it's safe to diverge.

use crate::argv::asset::parse_import;
use crate::asset_import::{
    ResolveAssetImportInput, ResolveDataAssetImportInput, resolve_asset_import,
    resolve_data_asset_import,
};
use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::list_presentation_entries;
use crate::workspace::write::create_presentation_file;

struct AssetImportOutput {
    /// Virtual path of the imported file, e.g. "assets/photo-1.png" or
    /// "assets/data/sales.csv".
    path: String,
    mime_type: String,
    /// `"data"` only for a `--as csv` import — never a media kind, so the
    /// JSON output never claims a CSV is an image/video/audio.
    kind: String,
}

/// `args` is whatever positional/flag arguments followed `asset import` on
/// the command line, already stripped of the Rust-only `--json` flag by
/// `main.rs` — the same convention `commands::undo::run` receives.
///
/// Control flow mirrors `assetImportCommand` exactly: the source is read
/// FIRST (URL download or local read), THEN `--as`'s value is validated,
/// THEN the presentation id is resolved (inside `import_asset_bytes`/
/// `import_data_asset_bytes`, via `list_presentation_entries`). This
/// ordering is preserved deliberately — when a source file is missing
/// AND the presentation id is also bogus, the source-read failure is what
/// surfaces, exactly as it does in the TS original, not the id lookup.
///
/// `docs/spec/cli.md` mandates ONE correction to that otherwise-faithful
/// port: a missing/unreadable local source file is `not-found` here,
/// where TS's `readLocalSource` leaves it a plain `failed` error. The spec
/// calls this safe because `asset import` could not be invoked from the
/// command line at all before this ticket (TS `argv.ts` had no `case
/// "asset"`), so no existing caller depends on the old `failed` kind for
/// this path.
pub fn run(args: &[String]) -> CommandResult {
    let parsed = match parse_import(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
        }
    };

    let bytes = if is_url(&parsed.source) {
        match crate::http::download_source(&parsed.source) {
            Ok(bytes) => bytes,
            Err(err) => {
                return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
            }
        }
    } else {
        match std::fs::read(&parsed.source) {
            Ok(bytes) => bytes,
            Err(_) => {
                // parsed.source is input the caller supplied directly (not
                // the hidden work directory ADR-0004 forbids naming), so
                // echoing it back is fine.
                return CommandResult::failure(
                    format!("找不到來源檔案：{}", parsed.source),
                    FailureKind::NotFound,
                );
            }
        }
    };

    if let Some(format) = parsed.as_format.as_deref() {
        if format != "csv" {
            return CommandResult::failure(
                format!("不支援的資料格式：{format}"),
                FailureKind::Failed,
            );
        }
    }

    let source_name = source_name_of(&parsed.source);

    let outcome = if parsed.as_format.is_some() {
        import_data_asset_bytes(&parsed.id, &source_name, &bytes)
    } else {
        import_asset_bytes(&parsed.id, &source_name, &bytes)
    };

    match outcome {
        Ok(data) => {
            let message = if data.kind == "data" {
                format!("已匯入資料：{}", data.path)
            } else {
                format!("已匯入媒體：{}", data.path)
            };
            let json_data = serde_json::json!({
                "path": data.path,
                "mimeType": data.mime_type,
                "kind": data.kind,
            });
            CommandResult::success(message, Some(json_data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// The format-decision + write half of asset import, with the source I/O
/// already done by the caller — mirrors TS's `importAssetBytes`.
fn import_asset_bytes(
    id: &str,
    source_name: &str,
    bytes: &[u8],
) -> Result<AssetImportOutput, CoMotionError> {
    let existing_asset_names = list_presentation_entries(id, "assets")?;
    let resolved = resolve_asset_import(ResolveAssetImportInput {
        source_name,
        bytes,
        existing_asset_names: &existing_asset_names,
    })?;
    let virtual_path = format!("assets/{}", resolved.file_name);
    create_presentation_file(id, &virtual_path, bytes)?;
    Ok(AssetImportOutput {
        path: virtual_path,
        mime_type: resolved.format.mime_type.to_string(),
        kind: resolved.format.kind.as_str().to_string(),
    })
}

/// The `--as csv` counterpart of `import_asset_bytes` — mirrors TS's
/// `importDataAssetBytes`. Destination is fixed to `assets/data/`, never
/// `assets/`, so a data asset and a media asset can never collide on the
/// same conflict-free-filename sequence.
fn import_data_asset_bytes(
    id: &str,
    source_name: &str,
    bytes: &[u8],
) -> Result<AssetImportOutput, CoMotionError> {
    let existing_asset_names = list_presentation_entries(id, "assets/data")?;
    let resolved = resolve_data_asset_import(ResolveDataAssetImportInput {
        source_name,
        bytes,
        existing_asset_names: &existing_asset_names,
    })?;
    let virtual_path = format!("assets/data/{}", resolved.file_name);
    create_presentation_file(id, &virtual_path, bytes)?;
    Ok(AssetImportOutput {
        path: virtual_path,
        mime_type: "text/csv".to_string(),
        kind: "data".to_string(),
    })
}

/// Mirrors TS's `URL_PATTERN = /^https?:\/\//i`.
fn is_url(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Mirrors TS's `sourceNameOf`: for a URL, the last path segment of its
/// pathname, percent-decoded; for a local path, its filesystem basename.
fn source_name_of(source: &str) -> String {
    if is_url(source) {
        url_basename(source)
    } else {
        local_basename(source)
    }
}

/// `path.basename` on POSIX: the final path component, ignoring a
/// trailing separator; `""` for a path with no final component (e.g. `""`
/// itself, or `"/"`).
fn local_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Extracts and percent-decodes the last non-empty path segment of a URL's
/// pathname — mirrors `decodeURIComponent(path.posix.basename(new
/// URL(source).pathname))`. Hand-rolled rather than pulling in a `url`
/// crate dependency (none is part of this ticket's approved dependency
/// budget — only `ureq`); this only feeds `sanitize_asset_base_name`,
/// which already collapses anything filesystem-illegal, so an imperfect
/// edge case here (e.g. malformed percent-encoding) has no correctness
/// impact beyond a slightly different base name.
fn url_basename(url: &str) -> String {
    let after_scheme = url.split_once("://").map_or("", |(_, rest)| rest);
    let path_start = after_scheme.find('/');
    let path_with_query = match path_start {
        Some(index) => &after_scheme[index..],
        None => "/",
    };
    let end = path_with_query
        .find(['?', '#'])
        .unwrap_or(path_with_query.len());
    let pathname = &path_with_query[..end];
    let encoded_basename = pathname
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("");
    percent_decode(encoded_basename)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Same convention as every other command handler in this crate
/// (`commands::undo::run`'s `failure_kind_for`): `NotFound` maps to
/// `FailureKind::NotFound`, everything else to `FailureKind::Failed`.
fn failure_kind_for(err: &CoMotionError) -> FailureKind {
    match err {
        CoMotionError::NotFound(_) => FailureKind::NotFound,
        CoMotionError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry::ENV_LOCK;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-cmd-asset-import-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn register(home: &std::path::Path, test_id: &str, work_dir: &std::path::Path) {
        let work_dir_json =
            serde_json::to_string(&work_dir.to_string_lossy().into_owned()).unwrap();
        let id_json = serde_json::to_string(test_id).unwrap();
        let json = format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#);
        std::fs::write(home.join("projects.json"), json).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            register(&home, test_id, &work);
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }
            std::fs::create_dir_all(work.join("assets")).unwrap();
            Fixture {
                home,
                work,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    const PNG_BYTES: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    #[test]
    fn imports_a_real_local_png_under_assets() {
        let fixture = Fixture::new("local-png", "pid-asset-1");
        let src_dir = temp_dir("local-png-src");
        let src_path = src_dir.join("photo.png");
        std::fs::write(&src_path, PNG_BYTES).unwrap();

        let args = vec![
            "pid-asset-1".to_string(),
            src_path.to_string_lossy().into_owned(),
        ];
        let result = run(&args);
        assert!(result.ok, "expected success, got: {}", result.message);
        let data = result.data.unwrap();
        assert_eq!(data["path"], "assets/photo.png");
        assert_eq!(data["mimeType"], "image/png");
        assert_eq!(data["kind"], "image");
        assert!(fixture.work.join("assets/photo.png").exists());

        std::fs::remove_dir_all(&src_dir).ok();
        drop(fixture);
    }

    #[test]
    fn local_source_file_missing_is_not_found() {
        let fixture = Fixture::new("local-missing", "pid-asset-2");
        let args = vec![
            "pid-asset-2".to_string(),
            "/definitely/missing/path/photo.png".to_string(),
        ];
        let result = run(&args);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
        drop(fixture);
    }

    #[test]
    fn as_csv_happy_path_lands_under_assets_data() {
        let fixture = Fixture::new("as-csv", "pid-asset-3");
        std::fs::create_dir_all(fixture.work.join("assets/data")).unwrap();
        let src_dir = temp_dir("as-csv-src");
        let src_path = src_dir.join("sales.csv");
        std::fs::write(&src_path, "name,value\na,1\nb,2\n").unwrap();

        let args = vec![
            "pid-asset-3".to_string(),
            src_path.to_string_lossy().into_owned(),
            "--as".to_string(),
            "csv".to_string(),
        ];
        let result = run(&args);
        assert!(result.ok, "expected success, got: {}", result.message);
        let data = result.data.unwrap();
        assert_eq!(data["path"], "assets/data/sales.csv");
        assert_eq!(data["mimeType"], "text/csv");
        assert_eq!(data["kind"], "data");
        assert!(fixture.work.join("assets/data/sales.csv").exists());

        std::fs::remove_dir_all(&src_dir).ok();
        drop(fixture);
    }

    #[test]
    fn unsupported_as_value_is_failed() {
        let fixture = Fixture::new("as-bad", "pid-asset-4");
        let src_dir = temp_dir("as-bad-src");
        let src_path = src_dir.join("sales.csv");
        std::fs::write(&src_path, "name,value\na,1\n").unwrap();

        let args = vec![
            "pid-asset-4".to_string(),
            src_path.to_string_lossy().into_owned(),
            "--as".to_string(),
            "yaml".to_string(),
        ];
        let result = run(&args);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::Failed));
        assert_eq!(result.message, "不支援的資料格式：yaml");

        std::fs::remove_dir_all(&src_dir).ok();
        drop(fixture);
    }

    #[test]
    fn unknown_presentation_id_is_not_found() {
        let fixture = Fixture::new("unknown-id", "pid-asset-known");
        let src_dir = temp_dir("unknown-id-src");
        let src_path = src_dir.join("photo.png");
        std::fs::write(&src_path, PNG_BYTES).unwrap();

        let args = vec![
            "definitely-not-a-registered-id".to_string(),
            src_path.to_string_lossy().into_owned(),
        ];
        let result = run(&args);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));

        std::fs::remove_dir_all(&src_dir).ok();
        drop(fixture);
    }

    #[test]
    fn imports_from_a_loopback_http_url() {
        use std::io::Write;
        use std::net::TcpListener;

        let fixture = Fixture::new("url-import", "pid-asset-5");
        let body = PNG_BYTES.to_vec();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let mut response = Vec::new();
                response.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
                response
                    .extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
                response.extend_from_slice(b"Connection: close\r\n\r\n");
                response.extend_from_slice(&body);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });

        let args = vec![
            "pid-asset-5".to_string(),
            format!("http://{addr}/downloads/photo.png"),
        ];
        let result = run(&args);
        assert!(result.ok, "expected success, got: {}", result.message);
        let data = result.data.unwrap();
        assert_eq!(data["path"], "assets/photo.png");
        assert!(fixture.work.join("assets/photo.png").exists());

        drop(fixture);
    }
}
