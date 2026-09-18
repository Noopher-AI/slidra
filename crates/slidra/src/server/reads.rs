// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `GET /presentation`, `GET /assets`, `GET /files/<virtual-path>`,
//! `GET /effects/<virtual-path>` ([S11.F9], #404 Scope "the read routes
//! the editor and the render service use") — in-process ports of
//! `packages/server/src/read-routes.ts`'s four handlers of the same name
//! (`handleRawRoute` is `server::raw`, not here). Every response shape
//! below is copied from that file's own behavior, not reinvented: see
//! NOOP-643's delivery notes for the exact `read-routes.ts` line citations
//! this was checked against.
//!
//! Reachable by the editor's own browser session and by the read-only
//! viewer credential — never the agent, which reaches the same content
//! through `POST /call`'s `cat`/`effect list` commands instead (those are
//! already `DeckScoped` in `commands::category`, so the agent's allow-list
//! covers them without this module's help). This split is this ticket's
//! own judgement call, not spelled out verbatim in the plan's behavior
//! table — flagged in the PR's uncertainties section.

use std::net::TcpStream;

use crate::server::credential::CallerKind;
use crate::server::{self, RawRequest};
use crate::workspace::{project, virtual_fs};

const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];

/// `GET /presentation` — the entire `project.json` object, verbatim
/// (`read-routes.ts:43-46`'s `loadProject(id)` -> `sendJson(200, project)`).
pub(crate) fn handle_presentation(request: &RawRequest, stream: &mut TcpStream) {
    let Some((_credential, work_dir)) =
        server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };
    match project::read_project_json(&work_dir) {
        Ok(project) => server::write_json_response(stream, &serde_json::Value::Object(project.raw)),
        Err(err) => server::write_json_error(stream, 500, err.message()),
    }
}

/// `GET /assets` — the `assets/` directory's entry names. A deck with no
/// `assets/` directory yet answers 200 with an empty list, never 404
/// (`read-routes.ts:54-65`).
pub(crate) fn handle_assets(request: &RawRequest, stream: &mut TcpStream) {
    let Some((_credential, work_dir)) =
        server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };
    match virtual_fs::list_virtual_entries(&work_dir, "assets") {
        Ok(entries) => {
            server::write_json_response(stream, &serde_json::json!({ "entries": entries }))
        }
        Err(crate::errors::SlidraError::NotFound(_)) => {
            server::write_json_response(stream, &serde_json::json!({ "entries": [] }));
        }
        Err(err) => server::write_json_error(stream, 500, err.message()),
    }
}

/// `GET /files/<virtual-path>` — a slide's rendered content (dynamic-text
/// substitution applied, via `slide render`) if `virtual_path` is one of
/// `project.slides`, otherwise the file's raw text content.
/// `raw_virtual_path` is the still-percent-encoded path segment
/// (`read-routes.ts:68-100`).
pub(crate) fn handle_files(request: &RawRequest, stream: &mut TcpStream, raw_virtual_path: &str) {
    let Some(virtual_path) = server::percent_decode(raw_virtual_path) else {
        server::write_json_error(stream, 400, "invalid path encoding");
        return;
    };
    let Some((credential, work_dir)) = server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };
    let project = match project::read_project_json(&work_dir) {
        Ok(project) => project,
        Err(err) => {
            server::write_json_error(stream, error_status(&err), err.message());
            return;
        }
    };
    let content_result: Result<String, (u16, String)> = if project.slides.contains(&virtual_path) {
        render_slide(&credential.workbench_id, &virtual_path)
    } else {
        virtual_fs::read_virtual_file(&work_dir, &virtual_path)
            .map_err(|err| (error_status(&err), err.message().to_string()))
    };
    match content_result {
        Ok(content) => {
            server::write_body_response(
                stream,
                200,
                content_type_for(&virtual_path),
                &[],
                content.as_bytes(),
            );
        }
        Err((status, message)) => server::write_json_error(stream, status, &message),
    }
}

/// `GET /effects/<virtual-path>` — a slide's effect plan, computed by the
/// same `effect list` logic the agent/CLI use. A path that is not one of
/// `project.slides` is 404 (deliberately narrower than `effect list`
/// itself, which also accepts templates — `read-routes.ts:132-157`); a
/// slide that genuinely has no effects yet answers 200 with the empty plan
/// rather than the command's own not-found failure.
pub(crate) fn handle_effects(request: &RawRequest, stream: &mut TcpStream, raw_virtual_path: &str) {
    let Some(virtual_path) = server::percent_decode(raw_virtual_path) else {
        server::write_json_error(stream, 400, "invalid path encoding");
        return;
    };
    let Some((credential, work_dir)) = server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };
    let project = match project::read_project_json(&work_dir) {
        Ok(project) => project,
        Err(err) => {
            server::write_json_error(stream, error_status(&err), err.message());
            return;
        }
    };
    if !project.slides.contains(&virtual_path) {
        server::write_json_error(stream, 404, &format!("Not a slide: {virtual_path}"));
        return;
    }
    let argv = [
        "effect".to_string(),
        "list".to_string(),
        credential.workbench_id.clone(),
        virtual_path,
        "--json".to_string(),
    ];
    match run_json(&argv) {
        Ok(value) if value["ok"].as_bool() == Some(true) => {
            server::write_json_response(stream, &value["data"]);
        }
        Ok(value) if value["failureKind"].as_str() == Some("not-found") => {
            server::write_json_response(stream, &empty_effect_plan());
        }
        Ok(value) => {
            let message = value["message"]
                .as_str()
                .unwrap_or("effect list failed")
                .to_string();
            server::write_json_error(stream, 500, &message);
        }
        Err(message) => server::write_json_error(stream, 500, &message),
    }
}

/// `read-routes.ts`'s `EMPTY_EFFECT_PLAN` constant, verbatim.
fn empty_effect_plan() -> serde_json::Value {
    serde_json::json!({
        "effects": [],
        "steps": [],
        "transition": {
            "enter": { "effect": "none", "duration": 0.6 },
            "exit": { "effect": "none", "duration": 0.5 },
        },
    })
}

/// Runs `slide render <id> <path> --json` through the shared executor and
/// decodes its base64 `content` field — mirrors `commands::slide::
/// run_render`'s own `--json` branch exactly, but dispatched (rather than
/// called directly) because `render_slide_for_display` is a private helper
/// in `commands/slide.rs`, which Plan's "minimal changes" list does not
/// cover touching (this route reuses the same shared-executor pattern
/// `handle_effects` above and `server::handle_call` already establish).
/// `pub(crate)`: `server::thumbnail_cache` reuses this directly for the
/// same "render a slide" step, rather than a second `slide render`
/// dispatch — the deck id there is a real presentation id
/// (`deck_store::resolve_id`'s own return value), the same shape
/// `workbench_id` has here.
pub(crate) fn render_slide(workbench_id: &str, virtual_path: &str) -> Result<String, (u16, String)> {
    let argv = [
        "slide".to_string(),
        "render".to_string(),
        workbench_id.to_string(),
        virtual_path.to_string(),
        "--json".to_string(),
    ];
    let value = run_json(&argv).map_err(|message| (500u16, message))?;
    if value["ok"].as_bool() != Some(true) {
        let status = if value["failureKind"].as_str() == Some("not-found") {
            404
        } else {
            500
        };
        let message = value["message"]
            .as_str()
            .unwrap_or("slide render failed")
            .to_string();
        return Err((status, message));
    }
    let encoded = value["data"]["content"]
        .as_str()
        .ok_or_else(|| (500u16, "slide render returned no content".to_string()))?;
    let bytes = crate::server::decode_base64(encoded).ok_or_else(|| {
        (
            500u16,
            "slide render returned invalid content encoding".to_string(),
        )
    })?;
    String::from_utf8(bytes).map_err(|_| {
        (
            500u16,
            "slide render returned non-UTF-8 content".to_string(),
        )
    })
}

/// Runs `argv` through the crate's shared executor and parses its
/// `--json` envelope — `command-endpoint.ts`'s `runJsonCommand`, done
/// in-process (AC1: no deck call is ever executed by spawning a process).
fn run_json(argv: &[String]) -> Result<serde_json::Value, String> {
    let osv: Vec<std::ffi::OsString> = argv.iter().map(std::ffi::OsString::from).collect();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut stdin = std::io::empty();
    crate::cli::run_argv_to(&osv, &mut out, &mut err, &mut stdin);
    serde_json::from_slice(&out).map_err(|_| "command produced no valid JSON envelope".to_string())
}

fn content_type_for(virtual_path: &str) -> &'static str {
    let lower = virtual_path.to_ascii_lowercase();
    if lower.ends_with(".svg") {
        "image/svg+xml; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else {
        "text/plain; charset=utf-8"
    }
}

fn error_status(err: &crate::errors::SlidraError) -> u16 {
    match err {
        crate::errors::SlidraError::NotFound(_) => 404,
        crate::errors::SlidraError::InvalidRequest(_) => 500,
    }
}
