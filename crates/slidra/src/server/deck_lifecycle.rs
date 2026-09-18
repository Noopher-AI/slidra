// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The deck lifecycle HTTP routes — in-process port of
//! `packages/server/src/open-endpoint.ts`'s request handling, wired
//! directly on top of `deck_store.rs`'s pure logic exactly as Node's
//! `open-endpoint.ts` sits on top of `storage/deck-store.ts`. Every route
//! here is deck-session-independent (`deck_store.rs`'s own doc comment):
//! none of them switch, none of them require a deck to already be open —
//! the "renaming/deleting the currently-bound deck" 409 stays a
//! `packages/server`-side concern (Node checks `deckSession.currentId()`
//! before forwarding a rename/delete call here at all).
//!
//! Caller-kind restrictions (Editor-only for every mutation, Editor/Viewer
//! for `GET /decks` and `POST /deck/resolve`) are this module's own
//! judgement call, not spelled out in NOOP-641 Plan's behavior-contract
//! table (which predates this slice) — mirrors the same kind of call
//! `assets.rs`/`reads.rs` already made for `POST /assets`/`GET /events`.
//! None of these routes are deck-scoped in the door's `commands::category`
//! sense (they operate on the deck folder as a whole, or name a deck by a
//! caller-supplied id, never "this credential's own workbench"), so they
//! use `server::authorize` directly rather than `authorize_deck_scoped`.
//!
//! `GET /decks/thumbnail` is NOT implemented here yet — that is the next
//! piece of this slice (a thumbnail-cache port), not part of this file.

use std::net::TcpStream;

use crate::server::credential::CallerKind;
use crate::server::deck_store::{self, CreatedDeck, DeckStoreError, ImportDisposition};
use crate::server::{self, RawRequest};
use serde_json::Value;

const EDITOR_ONLY: &[CallerKind] = &[CallerKind::Editor];
const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];

const FILE_NAME_HEADER: &str = "x-slidra-file-name";
/// Same order-of-magnitude headroom as `assets.rs`'s own limit, halved: a
/// `.slidra` with no large embedded media is far smaller than this; a
/// bigger one should go through the CLI instead. Mirrors `open-endpoint.ts`'s
/// own `MAX_OPEN_BODY_BYTES`.
const MAX_OPEN_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Writes a JSON body at an arbitrary status — `server::write_json_error`
/// is fixed to `{"error": ...}`, which the 409 responses here need to
/// extend with a `reason` (and sometimes `sourcePath`) field.
fn write_json_status(stream: &mut TcpStream, status: u16, value: &Value) {
    let body = value.to_string();
    server::write_body_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &[],
        body.as_bytes(),
    );
}

fn created_deck_response(created: CreatedDeck) -> Value {
    serde_json::json!({ "ok": true, "id": created.id, "fileName": created.file_name })
}

/// Maps a `DeckStoreError` to its HTTP shape — the one place every route
/// below translates a store failure, mirroring `open-endpoint.ts`'s own
/// `sendStoreError`.
fn write_store_error(stream: &mut TcpStream, err: DeckStoreError) {
    match err {
        DeckStoreError::NotFound(message) => server::write_json_error(stream, 404, &message),
        DeckStoreError::Invalid(message) => server::write_json_error(stream, 400, &message),
        DeckStoreError::NameConflict(message) => {
            write_json_status(
                stream,
                409,
                &serde_json::json!({ "error": message, "reason": "name-conflict" }),
            );
        }
        DeckStoreError::ImportConfirmationRequired { source_path } => {
            let source_path = source_path.to_string_lossy().into_owned();
            write_json_status(
                stream,
                409,
                &serde_json::json!({
                    "error": format!("the source file is outside the deck folder: {source_path}"),
                    "reason": "confirm-import",
                    "sourcePath": source_path,
                }),
            );
        }
    }
}

/// Parses `request.body` as a JSON object, defaulting an EMPTY body to
/// `{}` — only `POST /new` tolerates a missing body this way, matching
/// `handleNewPost`'s own `raw.trim().length > 0 ? JSON.parse(raw) : {}`.
/// Every other route here requires a real JSON body (an empty one is a
/// parse failure, same as `JSON.parse("")` throwing in the TS original).
fn parse_json_object_or_empty(request: &RawRequest) -> Result<serde_json::Map<String, Value>, ()> {
    if request.body.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::Map::new());
    }
    parse_json_object(request)
}

fn parse_json_object(request: &RawRequest) -> Result<serde_json::Map<String, Value>, ()> {
    let parsed: Value = serde_json::from_slice(&request.body).map_err(|_| ())?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(()),
    }
}

/// `POST /new` — the GUI's New action: creates a brand-new, no-slides deck
/// in the deck folder. Body: `{ name?: string, owner?: string }`.
pub(crate) fn handle_new(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    let Ok(body) = parse_json_object_or_empty(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };

    let name = match body.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            server::write_json_error(stream, 400, "name must be a string");
            return;
        }
    };
    let owner = match body.get("owner") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            server::write_json_error(stream, 400, "owner must be a string");
            return;
        }
    };

    match deck_store::create_deck(name.as_deref(), owner.as_deref()) {
        Ok(created) => server::write_json_response(stream, &created_deck_response(created)),
        Err(err) => write_store_error(stream, err),
    }
}

/// `POST /open` — the GUI's Open action. A browser's `<input
/// type="file">` only ever hands over bytes, never a real filesystem path,
/// so this keeps the raw-body + `x-slidra-file-name` header shape
/// `POST /assets` uses for its own byte-upload mode.
pub(crate) fn handle_open(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };

    let display_name = match request.header(FILE_NAME_HEADER) {
        Some(raw) if !raw.trim().is_empty() => match server::percent_decode(raw) {
            Some(decoded) => Some(decoded),
            None => {
                server::write_json_error(
                    stream,
                    400,
                    &format!("Invalid header encoding: {FILE_NAME_HEADER}"),
                );
                return;
            }
        },
        _ => None,
    };

    if request.body.len() > MAX_OPEN_BODY_BYTES {
        server::write_json_error(stream, 400, "Presentation file too large");
        return;
    }
    if request.body.is_empty() {
        server::write_json_error(stream, 400, "No file content received");
        return;
    }

    match deck_store::open_upload(&request.body, display_name.as_deref()) {
        Ok(created) => server::write_json_response(stream, &created_deck_response(created)),
        Err(err) => write_store_error(stream, err),
    }
}

/// `POST /deck/import` — brings an external `.slidra` into the deck
/// folder. Body: `{ sourcePath: string, disposition?: "move" | "copy" }`.
pub(crate) fn handle_import(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    let Ok(body) = parse_json_object(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };

    let source_path = match body.get("sourcePath") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            server::write_json_error(stream, 400, "sourcePath must be a non-empty string");
            return;
        }
    };
    let disposition = match body.get("disposition") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == "move" => Some(ImportDisposition::Move),
        Some(Value::String(s)) if s == "copy" => Some(ImportDisposition::Copy),
        Some(_) => {
            server::write_json_error(stream, 400, "disposition must be \"move\" or \"copy\"");
            return;
        }
    };

    match deck_store::import_external(&source_path, disposition) {
        Ok(created) => server::write_json_response(stream, &created_deck_response(created)),
        Err(err) => write_store_error(stream, err),
    }
}

/// `POST /deck/rename`. Body: `{ id: string, name: string }`.
pub(crate) fn handle_rename(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    let Ok(body) = parse_json_object(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };

    let id = match body.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            server::write_json_error(stream, 400, "id must be a non-empty string");
            return;
        }
    };
    let name = match body.get("name") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            server::write_json_error(stream, 400, "name must be a non-empty string");
            return;
        }
    };

    match deck_store::rename_deck(&id, &name) {
        Ok(_file_name) => server::write_json_response(stream, &serde_json::json!({ "ok": true })),
        Err(err) => write_store_error(stream, err),
    }
}

/// `POST /deck/delete`. Body: `{ id: string }`.
pub(crate) fn handle_delete(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    let Ok(body) = parse_json_object(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };

    let id = match body.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            server::write_json_error(stream, 400, "id must be a non-empty string");
            return;
        }
    };

    match deck_store::remove_deck(&id) {
        Ok(()) => server::write_json_response(stream, &serde_json::json!({ "ok": true })),
        Err(err) => write_store_error(stream, err),
    }
}

/// Extracts `?owner=` from a raw request path (with its query string
/// still attached — `server::path_only` is for routing only). Returns
/// `None` when the key is absent at all (list unfiltered), `Some("")`
/// when present but empty (mirrors `URLSearchParams.has("owner")` being
/// true for `?owner=`), matching `handleDecksGet`'s own `hasOwnerParam`
/// distinction.
fn owner_query_param(path: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("owner", v)) => return Some(server::percent_decode(v).unwrap_or_default()),
            None if pair == "owner" => return Some(String::new()),
            _ => {}
        }
    }
    None
}

/// `GET /decks?owner=` — every entry is scanned directly out of the deck
/// folder, never out of the registry: a deck that has never been opened
/// still shows up here.
pub(crate) fn handle_list(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, READ_CALLERS) else {
        return;
    };
    let owner = owner_query_param(&request.path);

    match deck_store::list_decks(owner.as_deref()) {
        Ok(entries) => {
            let decks: Vec<Value> = entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "fileName": entry.file_name,
                        "name": entry.name,
                        "slideCount": entry.slide_count,
                        "owner": entry.owner,
                        "id": entry.id,
                        "lastModified": entry.last_modified,
                    })
                })
                .collect();
            server::write_json_response(stream, &serde_json::json!({ "decks": decks }));
        }
        Err(err) => write_store_error(stream, err),
    }
}

/// A deck folder entry's own file name — never a path fragment: no
/// separator, no `..`, matching `sanitize_deck_base_name`'s own
/// never-produces-a-separator guarantee for anything this route needs to
/// accept back.
fn is_valid_deck_file_name(value: &str) -> bool {
    !value.is_empty() && !value.contains('/') && !value.contains('\\') && !value.contains("..")
}

/// `POST /deck/resolve` — Deck Space's lazy registration. Body:
/// `{ fileName: string }`. Deck-independent, like the routes above: never
/// touches whichever deck this server currently has open.
pub(crate) fn handle_resolve(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, READ_CALLERS) else {
        return;
    };
    let Ok(body) = parse_json_object(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };

    let file_name = match body.get("fileName") {
        Some(Value::String(s)) if is_valid_deck_file_name(s) => s.clone(),
        _ => {
            server::write_json_error(
                stream,
                400,
                "fileName must be a non-empty file name with no path separators",
            );
            return;
        }
    };

    match deck_store::resolve_id(&file_name) {
        Ok(resolved) => server::write_json_response(
            stream,
            &serde_json::json!({ "id": resolved.id, "fileName": resolved.file_name }),
        ),
        Err(err) => write_store_error(stream, err),
    }
}
