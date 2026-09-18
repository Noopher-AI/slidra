// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `POST /assets` ([S11.F9], #404 Scope "Asset upload") — in-process port
//! of `packages/server/src/asset-upload.ts`'s `handleAssetPost`. Policy
//! (`FileEntryPolicy.remoteUrl`/`uploadBytes` — "Remote URL uploads are
//! disabled"/"Byte uploads are disabled") stays a Node-side concern
//! (policy/launcher issuance is [S11.F6]/T9, out of this ticket's scope):
//! `deck-server-client.ts`'s forwarder checks it BEFORE forwarding, so by
//! the time a request reaches here both upload modes are already known to
//! be allowed. Everything downstream of that — header validation, the
//! 32 MiB cap, staging the bytes and dispatching `asset import` — lives
//! here, unchanged in behavior from `asset-upload.ts`.
//!
//! Reachable by the Editor credential only (mirrors this ticket's own
//! reads.rs/raw.rs split: the agent uploads media through `POST /call`'s
//! `asset import` command instead, already `DeckScoped` in
//! `commands::category` — this route exists for the browser's upload UI).

use std::net::TcpStream;

use crate::server::credential::CallerKind;
use crate::server::{self, RawRequest};

const UPLOAD_CALLERS: &[CallerKind] = &[CallerKind::Editor];

const ASSET_NAME_HEADER: &str = "x-slidra-asset-name";
const ASSET_URL_HEADER: &str = "x-slidra-asset-url";
const MAX_ASSET_BODY_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn handle(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _work_dir)) =
        server::authorize_deck_scoped(request, stream, UPLOAD_CALLERS)
    else {
        return;
    };

    let has_name = request.has_header(ASSET_NAME_HEADER);
    let has_url = request.has_header(ASSET_URL_HEADER);
    if has_name && has_url {
        server::write_json_error(
            stream,
            400,
            &format!("Cannot provide both {ASSET_NAME_HEADER} and {ASSET_URL_HEADER}"),
        );
        return;
    }

    let result = if has_url {
        handle_url_asset(&credential.workbench_id, request)
    } else {
        handle_bytes_asset(&credential.workbench_id, request)
    };

    match result {
        Ok(value) => server::write_json_response(stream, &value),
        Err((status, message)) => server::write_json_error(stream, status, &message),
    }
}

type UploadResult = Result<serde_json::Value, (u16, String)>;

fn handle_bytes_asset(workbench_id: &str, request: &RawRequest) -> UploadResult {
    let raw_name = request.header(ASSET_NAME_HEADER).unwrap_or_default();
    let source_name = server::percent_decode(raw_name).ok_or_else(|| {
        (
            400u16,
            format!("Invalid header encoding: {ASSET_NAME_HEADER}"),
        )
    })?;
    if source_name.trim().is_empty() {
        return Err((
            400,
            format!("Missing header: {ASSET_NAME_HEADER} or {ASSET_URL_HEADER}"),
        ));
    }
    if request.body.len() > MAX_ASSET_BODY_BYTES {
        return Err((
            400,
            format!("Request body too large (limit {MAX_ASSET_BODY_BYTES} bytes)"),
        ));
    }
    run_asset_import(workbench_id, &source_name, &request.body)
}

fn handle_url_asset(workbench_id: &str, request: &RawRequest) -> UploadResult {
    let raw_url = request.header(ASSET_URL_HEADER).unwrap_or_default();
    let url = server::percent_decode(raw_url).ok_or_else(|| {
        (
            400u16,
            format!("Invalid header encoding: {ASSET_URL_HEADER}"),
        )
    })?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err((400, "x-slidra-asset-url must be an http(s) URL".to_string()));
    }
    let bytes = crate::http::download_source(&url).map_err(|err| {
        (
            400u16,
            format!("Failed to download source: {}", err.message()),
        )
    })?;
    if bytes.len() > MAX_ASSET_BODY_BYTES {
        return Err((
            400,
            format!("Downloaded content too large (limit {MAX_ASSET_BODY_BYTES} bytes): {url}"),
        ));
    }
    let basename = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("asset");
    let basename = server::percent_decode(basename).unwrap_or_else(|| basename.to_string());
    run_asset_import(workbench_id, &basename, &bytes)
}

/// Stages `bytes` under a fresh temp directory named after the source's own
/// basename, dispatches `asset import <id> <staged-path>`, and always
/// removes the temp directory afterward — mirrors `asset-upload.ts`'s
/// `runAssetImport` (`mkdtemp`/`finally { rm(dir) }`), minus the
/// subprocess boundary (AC1: this runs in-process via `commands::
/// asset_import::run`, not a spawned `slidra` call).
fn run_asset_import(workbench_id: &str, source_name: &str, bytes: &[u8]) -> UploadResult {
    let dir = std::env::temp_dir().join(format!("slidra-asset-{}", crate::id::random_hex_suffix()));
    std::fs::create_dir_all(&dir).map_err(|_| (500u16, "failed to stage upload".to_string()))?;
    let file_name = std::path::Path::new(source_name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("asset");
    let staged_path = dir.join(file_name);
    let write_result = std::fs::write(&staged_path, bytes);
    let outcome = if write_result.is_err() {
        Err((500u16, "failed to stage upload".to_string()))
    } else {
        let args = vec![
            workbench_id.to_string(),
            staged_path.to_string_lossy().into_owned(),
        ];
        let result = crate::commands::asset_import::run(&args);
        if result.ok {
            let data = result.data.unwrap_or_else(|| serde_json::json!({}));
            Ok(serde_json::json!({
                "ok": true,
                "data": data,
                "message": result.message,
            }))
        } else {
            // ADR-0003: a not-found failure here would be this route's own
            // staged temp path leaking into the error message (the
            // underlying command has no way to know it was ever given
            // anything else) — generic message instead, matching
            // asset-upload.ts's own "Import failed" fallback for exactly
            // that failure kind.
            let message = if result.failure_kind == Some(crate::result::FailureKind::NotFound) {
                "Import failed".to_string()
            } else {
                result.message
            };
            Err((400, message))
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}
