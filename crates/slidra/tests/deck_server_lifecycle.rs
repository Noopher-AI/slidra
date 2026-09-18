// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Door-boundary tests for [E10.T5] Slice C's HTTP-wired deck lifecycle
//! routes (`POST /new|/open|/deck/import|/deck/rename|/deck/delete|
//! /deck/resolve`, `GET /decks`, `GET /decks/thumbnail`). Same
//! in-process-server-over-real-TCP pattern as
//! `tests/deck_server_assets_and_editing_lock.rs`.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use slidra::server::credential::{self, CallerKind};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Sets `SLIDRA_HOME` to a fresh temp dir with a `settings.json` naming a
/// second fresh temp dir as the deck folder — mirrors `deck_store.rs`'s own
/// `TestHome` test helper (not shared across the crate/integration-test
/// boundary, since integration tests link the crate as an external
/// dependency and cannot reach a `#[cfg(test)]`-only item).
struct TestHome {
    home: PathBuf,
    deck_folder: PathBuf,
}

impl TestHome {
    fn set_up(label: &str) -> Self {
        let home = std::env::temp_dir().join(format!(
            "slidra-deck-server-lifecycle-home-{label}-{}",
            slidra::id::random_hex_suffix()
        ));
        let deck_folder = std::env::temp_dir().join(format!(
            "slidra-deck-server-lifecycle-decks-{label}-{}",
            slidra::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("settings.json"),
            serde_json::json!({ "deckFolder": deck_folder.to_string_lossy() }).to_string(),
        )
        .unwrap();
        unsafe { std::env::set_var("SLIDRA_HOME", &home) };
        TestHome { home, deck_folder }
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        unsafe { std::env::remove_var("SLIDRA_HOME") };
        std::fs::remove_dir_all(&self.home).ok();
        std::fs::remove_dir_all(&self.deck_folder).ok();
    }
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn post(
    base_url: &str,
    path: &str,
    credential_header: Option<&str>,
    extra_headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    let mut req = ureq::post(format!("{base_url}{path}"));
    if let Some(cred) = credential_header {
        req = req.header(credential::CREDENTIAL_HEADER, cred);
    }
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    let request = req.config().http_status_as_error(false).build();
    let response = request.send(body).expect("request must be sent");
    let status = response.status().as_u16();
    let headers = collect_headers(&response);
    let (_, resp_body) = response.into_parts();
    let mut bytes = Vec::new();
    resp_body.into_reader().read_to_end(&mut bytes).unwrap();
    HttpResponse {
        status,
        headers,
        body: bytes,
    }
}

fn get(
    base_url: &str,
    path: &str,
    credential_header: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> HttpResponse {
    let mut req = ureq::get(format!("{base_url}{path}"));
    if let Some(cred) = credential_header {
        req = req.header(credential::CREDENTIAL_HEADER, cred);
    }
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    let request = req.config().http_status_as_error(false).build();
    let response = request.call().expect("request must be sent");
    let status = response.status().as_u16();
    let headers = collect_headers(&response);
    let (_, resp_body) = response.into_parts();
    let mut bytes = Vec::new();
    resp_body.into_reader().read_to_end(&mut bytes).unwrap();
    HttpResponse {
        status,
        headers,
        body: bytes,
    }
}

fn collect_headers(response: &ureq::http::Response<ureq::Body>) -> Vec<(String, String)> {
    response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

fn json(resp: &HttpResponse) -> serde_json::Value {
    serde_json::from_slice(&resp.body).expect("body must be JSON")
}

/// Lifecycle routes are not deck-scoped, so the credential's `workbenchId`
/// is never resolved to a real registered deck — any non-empty value does.
fn editor_cred() -> String {
    credential::encode(CallerKind::Editor, "unused-workbench-id")
}

// ---- POST /new ------------------------------------------------------

#[test]
fn create_deck_registers_it_and_lists_it_back() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("create");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"My Deck"}"#,
    );
    assert_eq!(
        created.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&created.body)
    );
    let value = json(&created);
    assert_eq!(value["ok"], true);
    assert_eq!(value["fileName"], "My Deck.slidra");
    assert!(value["id"].as_str().is_some());

    let list = get(&base_url, "/decks", Some(&editor), &[]);
    assert_eq!(list.status, 200);
    let decks = json(&list)["decks"].as_array().unwrap().clone();
    assert_eq!(decks.len(), 1);
    assert_eq!(decks[0]["fileName"], "My Deck.slidra");
    assert_eq!(decks[0]["owner"], "Anonymous");
}

#[test]
fn create_deck_with_an_empty_body_falls_back_to_defaults() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("create-empty-body");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(&base_url, "/new", Some(&editor), &[], b"");
    assert_eq!(
        created.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&created.body)
    );
    assert_eq!(json(&created)["fileName"], "Untitled.slidra");
}

#[test]
fn new_is_refused_for_viewer_and_agent_credentials() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("new-refused");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    for kind in [CallerKind::Viewer, CallerKind::Agent] {
        let cred = credential::encode(kind, "wb");
        let response = post(&base_url, "/new", Some(&cred), &[], b"{}");
        assert_eq!(response.status, 403, "kind {kind:?} must be refused");
    }
}

// ---- GET /decks -------------------------------------------------------

#[test]
fn list_decks_filters_by_owner_query_param() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("list-owner-filter");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    assert_eq!(
        post(
            &base_url,
            "/new",
            Some(&editor),
            &[],
            br#"{"name":"A","owner":"alice"}"#
        )
        .status,
        200
    );
    assert_eq!(
        post(
            &base_url,
            "/new",
            Some(&editor),
            &[],
            br#"{"name":"B","owner":"bob"}"#
        )
        .status,
        200
    );

    let filtered = get(&base_url, "/decks?owner=alice", Some(&editor), &[]);
    let decks = json(&filtered)["decks"].as_array().unwrap().clone();
    assert_eq!(decks.len(), 1);
    assert_eq!(decks[0]["fileName"], "A.slidra");
}

// ---- POST /open -------------------------------------------------------

#[test]
fn open_upload_writes_and_registers_the_uploaded_bytes() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = TestHome::set_up("open-upload");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let files: std::collections::BTreeMap<String, Vec<u8>> =
        slidra::presentation::build_minimal_presentation("Uploaded")
            .into_iter()
            .collect();
    let staged = std::env::temp_dir().join(format!(
        "slidra-lifecycle-upload-source-{}.slidra",
        slidra::id::random_hex_suffix()
    ));
    slidra::deck::create_new_with_files(&staged, &files).unwrap();
    let bytes = std::fs::read(&staged).unwrap();
    std::fs::remove_file(&staged).ok();

    let response = post(
        &base_url,
        "/open",
        Some(&editor),
        &[("x-slidra-file-name", "uploaded.slidra")],
        &bytes,
    );
    assert_eq!(
        response.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&response.body)
    );
    assert_eq!(json(&response)["fileName"], "uploaded.slidra");
    assert!(home.deck_folder.join("uploaded.slidra").exists());
}

#[test]
fn open_upload_with_an_empty_body_is_400() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("open-empty");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let response = post(&base_url, "/open", Some(&editor), &[], b"");
    assert_eq!(response.status, 400);
}

// ---- POST /deck/import --------------------------------------------------

#[test]
fn import_outside_the_folder_requires_confirmation_then_succeeds_with_a_disposition() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = TestHome::set_up("import");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let files: std::collections::BTreeMap<String, Vec<u8>> =
        slidra::presentation::build_minimal_presentation("External")
            .into_iter()
            .collect();
    let outside_dir = std::env::temp_dir().join(format!(
        "slidra-lifecycle-import-outside-{}",
        slidra::id::random_hex_suffix()
    ));
    std::fs::create_dir_all(&outside_dir).unwrap();
    let source = outside_dir.join("external.slidra");
    slidra::deck::create_new_with_files(&source, &files).unwrap();

    let body = serde_json::json!({ "sourcePath": source.to_string_lossy() }).to_string();
    let needs_confirm = post(
        &base_url,
        "/deck/import",
        Some(&editor),
        &[],
        body.as_bytes(),
    );
    assert_eq!(needs_confirm.status, 409);
    assert_eq!(json(&needs_confirm)["reason"], "confirm-import");
    assert!(source.exists());

    let body_with_disposition =
        serde_json::json!({ "sourcePath": source.to_string_lossy(), "disposition": "copy" })
            .to_string();
    let imported = post(
        &base_url,
        "/deck/import",
        Some(&editor),
        &[],
        body_with_disposition.as_bytes(),
    );
    assert_eq!(
        imported.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&imported.body)
    );
    assert_eq!(json(&imported)["fileName"], "external.slidra");
    assert!(source.exists(), "copy must leave the source in place");
    assert!(home.deck_folder.join("external.slidra").exists());

    std::fs::remove_dir_all(&outside_dir).ok();
}

// ---- POST /deck/rename / POST /deck/delete ------------------------------

#[test]
fn rename_then_delete_round_trips_and_moves_the_file_to_trash() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = TestHome::set_up("rename-delete");
    let trash_data_home = std::env::temp_dir().join(format!(
        "slidra-lifecycle-trash-{}",
        slidra::id::random_hex_suffix()
    ));
    if cfg!(target_os = "linux") {
        unsafe { std::env::set_var("XDG_DATA_HOME", &trash_data_home) };
    }
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"Old Name"}"#,
    );
    let id = json(&created)["id"].as_str().unwrap().to_string();

    let rename_body = serde_json::json!({ "id": id, "name": "New Name" }).to_string();
    let renamed = post(
        &base_url,
        "/deck/rename",
        Some(&editor),
        &[],
        rename_body.as_bytes(),
    );
    assert_eq!(
        renamed.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&renamed.body)
    );
    assert!(home.deck_folder.join("New Name.slidra").exists());
    assert!(!home.deck_folder.join("Old Name.slidra").exists());

    let delete_body = serde_json::json!({ "id": id }).to_string();
    let deleted = post(
        &base_url,
        "/deck/delete",
        Some(&editor),
        &[],
        delete_body.as_bytes(),
    );
    assert_eq!(
        deleted.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&deleted.body)
    );
    assert!(!home.deck_folder.join("New Name.slidra").exists());

    if cfg!(target_os = "linux") {
        assert!(
            trash_data_home
                .join("Trash")
                .join("files")
                .join("New Name.slidra")
                .exists()
        );
        unsafe { std::env::remove_var("XDG_DATA_HOME") };
    }
    std::fs::remove_dir_all(&trash_data_home).ok();
}

#[test]
fn rename_to_an_existing_name_is_a_409_name_conflict() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("rename-conflict");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"Taken"}"#,
    );
    let created = post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"Movable"}"#,
    );
    let id = json(&created)["id"].as_str().unwrap().to_string();

    let rename_body = serde_json::json!({ "id": id, "name": "Taken" }).to_string();
    let response = post(
        &base_url,
        "/deck/rename",
        Some(&editor),
        &[],
        rename_body.as_bytes(),
    );
    assert_eq!(response.status, 409);
    assert_eq!(json(&response)["reason"], "name-conflict");
}

#[test]
fn delete_an_unregistered_id_is_404() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("delete-missing");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let body = serde_json::json!({ "id": "no-such-id" }).to_string();
    let response = post(
        &base_url,
        "/deck/delete",
        Some(&editor),
        &[],
        body.as_bytes(),
    );
    assert_eq!(response.status, 404);
}

// ---- POST /deck/resolve --------------------------------------------------

#[test]
fn resolve_reuses_an_existing_registration() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("resolve");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(&base_url, "/new", Some(&editor), &[], br#"{"name":"Deck"}"#);
    let created_value = json(&created);
    let id = created_value["id"].as_str().unwrap().to_string();
    let file_name = created_value["fileName"].as_str().unwrap().to_string();

    let body = serde_json::json!({ "fileName": file_name }).to_string();
    let resolved = post(
        &base_url,
        "/deck/resolve",
        Some(&editor),
        &[],
        body.as_bytes(),
    );
    assert_eq!(resolved.status, 200);
    assert_eq!(json(&resolved)["id"], id);
}

#[test]
fn resolve_rejects_a_filename_with_a_path_separator() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("resolve-bad-name");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let body = serde_json::json!({ "fileName": "../escape.slidra" }).to_string();
    let response = post(
        &base_url,
        "/deck/resolve",
        Some(&editor),
        &[],
        body.as_bytes(),
    );
    assert_eq!(response.status, 400);
}

// ---- GET /decks/thumbnail ------------------------------------------------

#[test]
fn thumbnail_renders_the_first_slide_caches_it_and_answers_304_on_a_matching_etag() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("thumbnail");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"Thumb"}"#,
    );
    let created_value = json(&created);
    let id = created_value["id"].as_str().unwrap().to_string();
    let file_name = created_value["fileName"].as_str().unwrap().to_string();
    let add = slidra::commands::slide::run(&["add".to_string(), id], false);
    assert!(add.ok, "setup: slide add failed: {}", add.message);

    let query = format!("/decks/thumbnail?fileName={}", urlencode(&file_name));
    let first = get(&base_url, &query, Some(&editor), &[]);
    assert_eq!(
        first.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&first.body)
    );
    assert_eq!(
        first.header("content-type"),
        Some("image/svg+xml; charset=utf-8")
    );
    let etag = first
        .header("etag")
        .expect("thumbnail response must carry an ETag")
        .to_string();
    assert!(!first.body.is_empty());

    let cached = get(&base_url, &query, Some(&editor), &[]);
    assert_eq!(cached.status, 200);
    assert_eq!(
        cached.body, first.body,
        "a cache hit must return byte-identical content"
    );

    let not_modified = get(
        &base_url,
        &query,
        Some(&editor),
        &[("if-none-match", &etag)],
    );
    assert_eq!(not_modified.status, 304);
    assert!(not_modified.body.is_empty());
    assert_eq!(not_modified.header("etag"), Some(etag.as_str()));
}

#[test]
fn thumbnail_of_a_deck_with_no_slides_is_204() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("thumbnail-no-slides");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let created = post(
        &base_url,
        "/new",
        Some(&editor),
        &[],
        br#"{"name":"Empty"}"#,
    );
    let file_name = json(&created)["fileName"].as_str().unwrap().to_string();

    let query = format!("/decks/thumbnail?fileName={}", urlencode(&file_name));
    let response = get(&base_url, &query, Some(&editor), &[]);
    assert_eq!(response.status, 204);
}

#[test]
fn thumbnail_of_a_missing_file_is_404() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _home = TestHome::set_up("thumbnail-missing");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = editor_cred();

    let response = get(
        &base_url,
        "/decks/thumbnail?fileName=nope.slidra",
        Some(&editor),
        &[],
    );
    assert_eq!(response.status, 404);
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
