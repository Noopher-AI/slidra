// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Door-boundary tests for the deck server's read/raw/events routes
//! ([S11.F9], #404 Scope): `GET /presentation`, `GET /assets`,
//! `GET /files/<path>`, `GET /effects/<path>`, `GET /raw/<path>`,
//! `GET /events`. Same in-process-server-over-real-TCP pattern as
//! `tests/server_door.rs` (see that file's own header for why); this is a
//! separate file (Plan §6: "可新增 2-3 檔") rather than appended there,
//! since that file's own scope is `POST /call` and its doc comments (e.g.
//! `there_is_only_one_route`) are specifically about the command-dispatch
//! door, not these REST-shaped read routes.
//!
//! `SLIDRA_HOME` is process-global; `ENV_LOCK` mirrors `server_door.rs`'s
//! own copy for the same reason (not visible across integration test
//! binaries).

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use slidra::commands;
use slidra::server::credential::{self, CallerKind};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_home(label: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!(
        "slidra-deck-server-reads-{label}-{}",
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
    headers: Vec<(String, String)>,
    body: Vec<u8>,
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
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let (_, body) = response.into_parts();
    let mut bytes = Vec::new();
    body.into_reader().read_to_end(&mut bytes).unwrap();
    HttpResponse {
        status,
        headers,
        body: bytes,
    }
}

fn header<'a>(resp: &'a HttpResponse, name: &str) -> Option<&'a str> {
    resp.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[test]
fn missing_credential_is_401_for_every_new_route() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("no-cred");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    for path in [
        "/presentation".to_string(),
        "/assets".to_string(),
        "/files/project.json".to_string(),
        "/effects/slides%2F001.svg".to_string(),
        "/raw/slides%2F001.svg".to_string(),
    ] {
        let response = get(&base_url, &path, None, &[]);
        assert_eq!(
            response.status, 401,
            "path {path} must be 401 with no credential"
        );
    }
    let _ = id;

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn asserted_caller_kind_is_400_before_credential_is_even_read() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("assert-kind");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(
        &base_url,
        "/presentation",
        Some(&cred),
        &[("x-slidra-caller-kind", "editor")],
    );
    assert_eq!(response.status, 400);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn agent_credential_is_refused_on_read_routes() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("agent-refused");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Agent, &id);

    let response = get(&base_url, "/presentation", Some(&cred), &[]);
    assert_eq!(
        response.status, 403,
        "agent reaches reads through POST /call's cat/effect list, not these routes"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn unknown_workbench_id_is_404() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("unknown-id");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, "no-such-workbench");

    let response = get(&base_url, "/presentation", Some(&cred), &[]);
    assert_eq!(response.status, 404);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn presentation_returns_the_whole_project_json_object() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("presentation");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/presentation", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    let value: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert!(value.get("formatVersion").is_some());
    assert_eq!(value["slides"].as_array().unwrap().len(), 1);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn assets_with_no_assets_directory_yet_is_200_empty_not_404() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("assets-empty");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Viewer, &id);

    let response = get(&base_url, "/assets", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    let value: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), 0);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn files_route_renders_a_slide_with_slide_number_substituted() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("files-slide");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/files/slides%2F001.svg", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    assert_eq!(
        header(&response, "content-type"),
        Some("image/svg+xml; charset=utf-8")
    );
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.contains("<svg"), "body: {body}");

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn files_route_returns_raw_text_for_a_non_slide_path() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("files-nonslide");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/files/project.json", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    assert_eq!(
        header(&response, "content-type"),
        Some("application/json; charset=utf-8")
    );
    let value: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert!(value.get("formatVersion").is_some());

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn files_route_404s_a_missing_file() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("files-missing");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/files/nope.txt", Some(&cred), &[]);
    assert_eq!(response.status, 404);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn effects_route_404s_a_path_that_is_not_a_slide() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("effects-notslide");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/effects/project.json", Some(&cred), &[]);
    assert_eq!(response.status, 404);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn effects_route_returns_the_empty_plan_for_a_slide_with_no_effects_yet() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("effects-empty");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Editor, &id);

    let response = get(&base_url, "/effects/slides%2F001.svg", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    let value: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(value["effects"].as_array().unwrap().len(), 0);
    assert_eq!(value["transition"]["enter"]["effect"], "none");

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn raw_route_serves_the_whole_asset_with_accept_ranges() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("raw-whole");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Viewer, &id);

    let response = get(&base_url, "/raw/slides%2F001.svg", Some(&cred), &[]);
    assert_eq!(response.status, 200);
    assert_eq!(header(&response, "accept-ranges"), Some("bytes"));
    assert_eq!(header(&response, "cache-control"), Some("no-store"));
    assert!(!response.body.is_empty());

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn raw_route_serves_a_satisfiable_range_as_206() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("raw-range");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Viewer, &id);

    let whole = get(&base_url, "/raw/slides%2F001.svg", Some(&cred), &[]);
    let total = whole.body.len();
    assert!(
        total > 4,
        "fixture slide must have enough bytes to range over"
    );

    let response = get(
        &base_url,
        "/raw/slides%2F001.svg",
        Some(&cred),
        &[("Range", "bytes=0-3")],
    );
    assert_eq!(response.status, 206);
    assert_eq!(response.body.len(), 4);
    assert_eq!(response.body, whole.body[0..4]);
    assert_eq!(
        header(&response, "content-range"),
        Some(format!("bytes 0-3/{total}").as_str())
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn raw_route_unsatisfiable_range_is_416_with_content_range_star() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("raw-416");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Viewer, &id);

    let whole = get(&base_url, "/raw/slides%2F001.svg", Some(&cred), &[]);
    let total = whole.body.len();

    let response = get(
        &base_url,
        "/raw/slides%2F001.svg",
        Some(&cred),
        &[("Range", &format!("bytes={}-", total + 100))],
    );
    assert_eq!(response.status, 416);
    assert_eq!(
        header(&response, "content-range"),
        Some(format!("bytes */{total}").as_str())
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn raw_route_404s_a_missing_asset_even_with_a_range_header() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("raw-404-range");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let cred = credential::encode(CallerKind::Viewer, &id);

    let response = get(
        &base_url,
        "/raw/assets%2Fmissing.png",
        Some(&cred),
        &[("Range", "bytes=0-3")],
    );
    assert_eq!(
        response.status, 404,
        "a Range request against a missing asset must still be 404, never 416"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC/spec decision 18: a notification carries no deck content, and a
/// burst of writes to the deck coalesces into a bounded number of
/// notifications (not one per write). This connects to the real HTTP
/// door — `events.rs`'s own unit tests already cover the debounce timing
/// in isolation; this proves the route is actually wired to a real deck
/// file and speaks real SSE framing.
#[test]
fn events_route_streams_a_content_free_notification_after_a_deck_change() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("events");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "d");
    let deck_path = home.join("d.slidra");
    let addr = slidra::server::test_support::spawn_test_server();
    let cred = credential::encode(CallerKind::Editor, &id);

    use std::io::Write as _;
    use std::net::TcpStream;
    let mut stream = TcpStream::connect(addr).unwrap();
    let request = format!(
        "GET /events HTTP/1.1\r\nHost: {addr}\r\nx-slidra-credential: {cred}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();

    // Touch the deck file so its mtime changes — the poll loop must
    // notice within one poll interval, then wait out its debounce window.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let bytes = std::fs::read(&deck_path).unwrap();
        std::fs::write(&deck_path, bytes).unwrap();
    });

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while !String::from_utf8_lossy(&buf).contains("presentation-changed") {
        if std::time::Instant::now() > deadline {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    assert!(
        text.contains("event: presentation-changed"),
        "got: {text:?}"
    );
    assert!(
        text.contains("data: {}"),
        "notification must carry no deck content, got: {text:?}"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}
