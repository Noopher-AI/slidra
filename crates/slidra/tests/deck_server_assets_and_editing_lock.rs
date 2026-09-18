// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Door-boundary tests for [E10.T5] Slice B: `POST /assets` and the
//! editing-lock routes (`POST /editing/begin|end|agent-begin|agent-end`,
//! `GET /editing`), plus the `POST /call` dispatch gate the lock adds.
//! Same in-process-server-over-real-TCP pattern as `tests/server_door.rs`.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use slidra::commands;
use slidra::server::credential::{self, CallerKind};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_home(label: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!(
        "slidra-deck-server-assets-{label}-{}",
        slidra::id::random_hex_suffix()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn seed_deck(home: &std::path::Path, label: &str) -> String {
    let deck_path = home.join(format!("{label}.slidra"));
    let new_result = commands::new::run(&[deck_path.to_string_lossy().into_owned()]);
    assert!(new_result.ok, "setup: `new` failed: {}", new_result.message);
    let open_result = commands::open::run(&[deck_path.to_string_lossy().into_owned()]);
    assert!(
        open_result.ok,
        "setup: `open` failed: {}",
        open_result.message
    );
    let id = open_result.data.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let add = commands::slide::run(&["add".to_string(), id.clone()], false);
    assert!(add.ok, "setup: `slide add` failed: {}", add.message);
    id
}

struct HttpResponse {
    status: u16,
    body: Vec<u8>,
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
    let (_, resp_body) = response.into_parts();
    let mut bytes = Vec::new();
    resp_body.into_reader().read_to_end(&mut bytes).unwrap();
    HttpResponse {
        status,
        body: bytes,
    }
}

fn get(base_url: &str, path: &str, credential_header: Option<&str>) -> HttpResponse {
    let mut req = ureq::get(format!("{base_url}{path}"));
    if let Some(cred) = credential_header {
        req = req.header(credential::CREDENTIAL_HEADER, cred);
    }
    let request = req.config().http_status_as_error(false).build();
    let response = request.call().expect("request must be sent");
    let status = response.status().as_u16();
    let (_, resp_body) = response.into_parts();
    let mut bytes = Vec::new();
    resp_body.into_reader().read_to_end(&mut bytes).unwrap();
    HttpResponse {
        status,
        body: bytes,
    }
}

fn json(resp: &HttpResponse) -> serde_json::Value {
    serde_json::from_slice(&resp.body).expect("body must be JSON")
}

// ---- POST /assets -----------------------------------------------------

#[test]
fn asset_upload_by_bytes_imports_and_returns_the_virtual_path() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("bytes");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let png_bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    let response = post(
        &base_url,
        "/assets",
        Some(&cred),
        &[("x-slidra-asset-name", "photo.png")],
        png_bytes,
    );
    assert_eq!(
        response.status,
        200,
        "body: {:?}",
        String::from_utf8_lossy(&response.body)
    );
    let value = json(&response);
    assert_eq!(value["ok"], true);
    assert!(
        value["data"]["path"]
            .as_str()
            .unwrap()
            .starts_with("assets/")
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn asset_upload_rejects_both_name_and_url_headers() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("both-headers");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = post(
        &base_url,
        "/assets",
        Some(&cred),
        &[
            ("x-slidra-asset-name", "a.png"),
            ("x-slidra-asset-url", "http://example.com/a.png"),
        ],
        b"x",
    );
    assert_eq!(response.status, 400);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn asset_upload_over_the_size_cap_is_400() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("oversize");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let oversized = vec![0u8; 33 * 1024 * 1024];
    let response = post(
        &base_url,
        "/assets",
        Some(&cred),
        &[("x-slidra-asset-name", "big.bin")],
        &oversized,
    );
    assert_eq!(response.status, 400);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn asset_upload_is_refused_for_viewer_and_agent_credentials() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("upload-refused");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    for kind in [CallerKind::Viewer, CallerKind::Agent] {
        let cred = credential::encode(kind, &id);
        let response = post(
            &base_url,
            "/assets",
            Some(&cred),
            &[("x-slidra-asset-name", "a.png")],
            b"x",
        );
        assert_eq!(response.status, 403, "kind {kind:?} must be refused");
    }

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

// ---- editing lock -------------------------------------------------------

#[test]
fn editing_begin_then_end_round_trips_and_reports_frozen_correctly() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editing-round-trip");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor = credential::encode(CallerKind::Editor, &id);

    let begin = post(&base_url, "/editing/begin", Some(&editor), &[], b"");
    assert_eq!(begin.status, 200);

    // A human lease never reports "frozen" — that means "the agent holds it".
    let status = get(&base_url, "/editing", Some(&editor));
    assert_eq!(json(&status)["frozen"], false);

    let end = post(&base_url, "/editing/end", Some(&editor), &[], b"");
    assert_eq!(end.status, 200);

    // Idempotent: a second end is not an error.
    let end2 = post(&base_url, "/editing/end", Some(&editor), &[], b"");
    assert_eq!(end2.status, 200);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn agent_begin_reports_frozen_and_blocks_editor_writes_until_agent_end() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editing-agent-floor");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent = credential::encode(CallerKind::Agent, &id);
    let editor = credential::encode(CallerKind::Editor, &id);

    let begin = post(&base_url, "/editing/agent-begin", Some(&agent), &[], b"");
    assert_eq!(begin.status, 200);

    let status = get(&base_url, "/editing", Some(&editor));
    assert_eq!(json(&status)["frozen"], true);

    // The editor's own write attempt through POST /call is refused while
    // the agent holds the floor — the exact gate `command-endpoint.ts`
    // used to apply inline, now enforced at the door itself.
    let argv = vec!["slide", "add", &id];
    let json_argv = serde_json::to_string(&argv).unwrap();
    let argv_header = slidra::base64::encode(json_argv.as_bytes());
    let call = ureq::post(format!("{base_url}/call"))
        .header("x-slidra-argv", &argv_header)
        .header(credential::CREDENTIAL_HEADER, &editor)
        .config()
        .http_status_as_error(false)
        .build()
        .send_empty()
        .unwrap();
    assert_eq!(call.status().as_u16(), 409);

    let end = post(&base_url, "/editing/agent-end", Some(&agent), &[], b"");
    assert_eq!(end.status, 200);

    let status_after = get(&base_url, "/editing", Some(&editor));
    assert_eq!(json(&status_after)["frozen"], false);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn begin_human_edit_is_refused_while_agent_holds_the_floor() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editing-conflict");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent = credential::encode(CallerKind::Agent, &id);
    let editor = credential::encode(CallerKind::Editor, &id);

    assert_eq!(
        post(&base_url, "/editing/agent-begin", Some(&agent), &[], b"").status,
        200
    );
    let begin = post(&base_url, "/editing/begin", Some(&editor), &[], b"");
    assert_eq!(begin.status, 409);
    assert_eq!(
        post(&base_url, "/editing/agent-end", Some(&agent), &[], b"").status,
        200
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn editing_routes_require_the_right_credential_kind() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editing-kinds");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let viewer = credential::encode(CallerKind::Viewer, &id);
    let agent = credential::encode(CallerKind::Agent, &id);
    let editor = credential::encode(CallerKind::Editor, &id);

    assert_eq!(
        post(&base_url, "/editing/begin", Some(&viewer), &[], b"").status,
        403
    );
    assert_eq!(
        post(&base_url, "/editing/begin", Some(&agent), &[], b"").status,
        403
    );
    assert_eq!(
        post(&base_url, "/editing/agent-begin", Some(&editor), &[], b"").status,
        403
    );
    assert_eq!(
        post(&base_url, "/editing/agent-begin", Some(&viewer), &[], b"").status,
        403
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}
