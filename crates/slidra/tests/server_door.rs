// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Door-boundary tests for the deck server ([S11.F2], #397). Two ways of
//! reaching it, matching NOOP-637's plan:
//!
//! - Most tests here run the server in-process (`server::test_support::
//!   spawn_test_server`, a background thread on an ephemeral port) and
//!   talk to it over a real TCP connection with `ureq` — the same
//!   `POST /call` shape a real caller uses, just without a second OS
//!   process.
//! - `shim_reaches_the_deck_server_with_no_node_process_in_the_path`
//!   (AC10) spawns the REAL COMPILED BINARY twice — once as
//!   `__deck-server`, once as `__shim` — because AC10's own wording is
//!   about a real subprocess boundary, not an in-process call.
//!
//! `SLIDRA_HOME` is process-global state, and `workspace::resolve_home`
//! re-reads it on every call (never cached) — exactly what lets each test
//! below use its own temp home safely, PROVIDED no two tests read/write it
//! concurrently. `ENV_LOCK` below is this file's own copy of the crate's
//! internal `workspace::registry::ENV_LOCK` (that one is `pub(crate)`,
//! invisible to an external integration test crate like this file).

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use slidra::commands;
use slidra::server::credential::{self, CallerKind};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_home(label: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!(
        "slidra-server-door-{label}-{}",
        slidra::id::random_hex_suffix()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
}

/// Creates a fresh deck under `home` (already the current `SLIDRA_HOME`)
/// with one slide and one text box, and returns its presentation id.
/// Mirrors `cli_golden.rs`'s own `Fixture::seed_slide`, but calls the
/// public command handlers directly in-process (this test binary already
/// depends on `slidra` as a library, and every one of these is a `pub
/// fn`) rather than spawning the compiled binary — simpler, and doesn't
/// need a second `SLIDRA_HOME` propagation path.
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

fn add_textbox_with_text(id: &str, text: &str) {
    // `textbox` dispatches through the family mechanism
    // (`commands::textbox::dispatch`), not a plain `run(args, json_flag)`
    // — `TAKEOVER[0]` is `["textbox", "add"]`, and `args` starts right
    // after both of those tokens (mirrors `cli.rs`'s own
    // `dispatch_family_takeover`).
    let tokens = commands::textbox::TAKEOVER[0];
    let result = commands::textbox::dispatch(
        tokens,
        &[
            id.to_string(),
            "slides/001.svg".to_string(),
            "--x".to_string(),
            "80".to_string(),
            "--y".to_string(),
            "80".to_string(),
            // Wide enough that the real-path text below (AC9's test)
            // never line-wraps onto a second `<tspan>` — wrapping would
            // split the literal path bytes across an inserted tag, which
            // would make `redact_real_paths`'s exact-substring match miss
            // it (a false pass, not a real one).
            "--width".to_string(),
            "4000".to_string(),
            "--text".to_string(),
            text.to_string(),
        ],
    );
    assert!(result.ok, "setup: `textbox add` failed: {}", result.message);
}

fn argv_header(argv: &[&str]) -> String {
    let json = serde_json::to_string(argv).unwrap();
    slidra::base64::encode(json.as_bytes())
}

struct CallResponse {
    status: u16,
    body: Vec<u8>,
}

fn post_call(
    base_url: &str,
    credential_header: Option<&str>,
    extra_headers: &[(&str, &str)],
    argv: &[&str],
) -> CallResponse {
    let mut req =
        ureq::post(format!("{base_url}/call")).header("x-slidra-argv", &argv_header(argv));
    if let Some(cred) = credential_header {
        req = req.header(credential::CREDENTIAL_HEADER, cred);
    }
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    let request = req.config().http_status_as_error(false).build();
    let response = request.send_empty().expect("request must be sent");
    let status = response.status().as_u16();
    let (_, body) = response.into_parts();
    let mut bytes = Vec::new();
    body.into_reader().read_to_end(&mut bytes).unwrap();
    CallResponse {
        status,
        body: bytes,
    }
}

/// Decodes the same frame shape `server::write_frame_response` writes and
/// `server::shim_client::relay_frames` reads: `[1 byte kind][4 bytes
/// big-endian value][payload]`. Returns `(stdout, stderr, exit_code)`.
fn decode_frames(bytes: &[u8]) -> (Vec<u8>, Vec<u8>, i32) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut i = 0;
    while i + 5 <= bytes.len() {
        let kind = bytes[i];
        let raw = [bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]];
        i += 5;
        match kind {
            1 | 2 => {
                let len = u32::from_be_bytes(raw) as usize;
                let payload = &bytes[i..i + len];
                if kind == 1 {
                    stdout.extend_from_slice(payload);
                } else {
                    stderr.extend_from_slice(payload);
                }
                i += len;
            }
            3 => {
                exit_code = Some(i32::from_be_bytes(raw));
                break;
            }
            _ => break,
        }
    }
    (
        stdout,
        stderr,
        exit_code.expect("response must end with an exit frame"),
    )
}

/// AC2: no credential at all is refused, and never dispatched.
#[test]
fn no_credential_is_refused_with_401() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("no-cred");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    let response = post_call(&base_url, None, &[], &["cat", "any-id"]);
    assert_eq!(response.status, 401);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC2: an empty credential header is refused identically to a missing
/// one (same status).
#[test]
fn empty_credential_header_is_refused_with_401() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("empty-cred");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    let response = post_call(&base_url, Some(""), &[], &["cat", "any-id"]);
    assert_eq!(response.status, 401);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC2/AC6: a viewer credential is accepted for a read and refused for a
/// mutating action, and the refused action never touches the deck.
#[test]
fn viewer_can_read_but_not_mutate() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("viewer");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "viewer");
    let before = std::fs::read(home.join("viewer.slidra")).unwrap();

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let viewer_cred = credential::encode(CallerKind::Viewer, &id);

    let read = post_call(
        &base_url,
        Some(&viewer_cred),
        &[],
        &["cat", &id, "slides/001.svg"],
    );
    assert_eq!(read.status, 200);
    let (_, _, exit_code) = decode_frames(&read.body);
    assert_eq!(exit_code, 0);

    let write = post_call(
        &base_url,
        Some(&viewer_cred),
        &[],
        &[
            "element",
            "move",
            &id,
            "slides/001.svg",
            "el-1",
            "--dx",
            "1",
            "--dy",
            "1",
        ],
    );
    assert_eq!(write.status, 403, "viewer must be refused before dispatch");

    let after = std::fs::read(home.join("viewer.slidra")).unwrap();
    assert_eq!(
        before, after,
        "a refused mutating call must not touch the deck"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC3: the caller can never assert its own kind — its mere presence in
/// the request is refused before the (otherwise valid) credential is even
/// consulted.
#[test]
fn caller_asserting_its_own_kind_is_refused() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("assert-kind");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "assert-kind");

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent_cred = credential::encode(CallerKind::Agent, &id);

    let response = post_call(
        &base_url,
        Some(&agent_cred),
        &[("x-slidra-caller-kind", "editor")],
        &["cat", &id],
    );
    assert_eq!(response.status, 400);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC6/AC7: a command outside the agent's allow-list — including one
/// with no category at all — is refused before dispatch.
#[test]
fn agent_is_confined_to_deck_scoped_commands() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("agent-scope");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "agent-scope");

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent_cred = credential::encode(CallerKind::Agent, &id);

    // `open` is `Category::Lifecycle` — outside the agent's allow-list.
    let lifecycle = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &["open", "/tmp/whatever.slidra"],
    );
    assert_eq!(lifecycle.status, 403);

    // `deck list` is `Category::CrossDeck` — also outside it.
    let cross_deck = post_call(&base_url, Some(&agent_cred), &[], &["deck", "list", "/tmp"]);
    assert_eq!(cross_deck.status, 403);

    // A DeckScoped command IS allowed for the agent.
    let deck_scoped = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &["cat", &id, "slides/001.svg"],
    );
    assert_eq!(deck_scoped.status, 200);

    // A name entirely outside the 94-command universe has no category at
    // all — refused, not merely "not found".
    let uncategorised = post_call(&base_url, Some(&agent_cred), &[], &["frobnicate", &id]);
    assert_eq!(uncategorised.status, 403);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC8: a workbench/deck id placed in the argv position is ignored; the
/// one bound to the credential is used, regardless of what the caller
/// sent.
#[test]
fn argv_deck_id_is_overwritten_by_the_credential() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("id-override");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let real_id = seed_deck(&home, "id-override");

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent_cred = credential::encode(CallerKind::Agent, &real_id);

    // The argv names a deck id that was never registered at all.
    let response = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &["cat", "not-a-real-id", "slides/001.svg"],
    );
    assert_eq!(
        response.status, 200,
        "the door must substitute the credential's own id"
    );
    let (stdout, _, exit_code) = decode_frames(&response.body);
    assert_eq!(exit_code, 0);
    assert!(
        !stdout.is_empty(),
        "cat must have returned the real deck's slide content"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC9: no response to an agent credential contains a real filesystem
/// path — end to end, not just the `redact` unit tests' fabricated case:
/// a slide's own text content is made to literally contain `SLIDRA_HOME`'s
/// path, and `cat`'s raw (renderer) output must arrive with it replaced.
#[test]
fn agent_response_never_contains_a_real_filesystem_path() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("redact");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "redact");
    let home_str = home.display().to_string();
    add_textbox_with_text(&id, &format!("secret path: {home_str}/redact.slidra"));

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent_cred = credential::encode(CallerKind::Agent, &id);

    let response = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &["cat", &id, "slides/001.svg"],
    );
    assert_eq!(response.status, 200);
    let (stdout, _, exit_code) = decode_frames(&response.body);
    assert_eq!(exit_code, 0);
    let text = String::from_utf8(stdout).unwrap();
    assert!(
        !text.contains(&home_str),
        "agent response leaked a real path: {text}"
    );
    assert!(text.contains("<redacted-path>/redact.slidra"));

    // Viewer credential: the SAME text is NOT redacted (only the agent's
    // responses are — #397's scope is specifically the agent's own box).
    // `cat` isn't one of the editor's 68 hand-listed commands at all (the
    // editor reads file content over `/api/files/`, never this door), so
    // the viewer — also `DeckScoped { mutates: false }`, also able to
    // call `cat` — is the contrasting case here.
    let viewer_cred = credential::encode(CallerKind::Viewer, &id);
    let viewer_response = post_call(
        &base_url,
        Some(&viewer_cred),
        &[],
        &["cat", &id, "slides/001.svg"],
    );
    assert_eq!(viewer_response.status, 200);
    let (viewer_stdout, _, _) = decode_frames(&viewer_response.body);
    let viewer_text = String::from_utf8(viewer_stdout).unwrap();
    assert!(viewer_text.contains(&home_str));

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC4: a payload over one megabyte and a binary payload each arrive
/// byte-for-byte unchanged through the door.
#[test]
fn large_and_binary_payloads_arrive_byte_exact() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("large-payload");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "large-payload");

    let big_bytes = vec![b'x'; 2 * 1024 * 1024];
    slidra::workspace::virtual_fs::create_new_file(
        &home.join("large-payload.slidra"),
        "assets/big.txt",
        &big_bytes,
    )
    .unwrap();
    let expected_direct = slidra::workspace::virtual_fs::read_virtual_file_bytes(
        &home.join("large-payload.slidra"),
        "assets/big.txt",
    )
    .unwrap();
    assert_eq!(expected_direct.len(), big_bytes.len());

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    // `cat` isn't one of the editor's 68 hand-listed commands (the editor
    // reads file content over `/api/files/`, never this door) — use the
    // agent credential, which reaches every `DeckScoped` command.
    let agent_cred = credential::encode(CallerKind::Agent, &id);

    let response = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &["cat", &id, "assets/big.txt"],
    );
    assert_eq!(response.status, 200);
    let (stdout, _, exit_code) = decode_frames(&response.body);
    assert_eq!(exit_code, 0);
    assert_eq!(
        stdout, expected_direct,
        "a >1MB payload must arrive unchanged"
    );

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC5: there is exactly one call shape — no route besides `POST /call`
/// dispatches anything.
#[test]
fn there_is_only_one_route() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("one-route");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");

    let wrong_path = ureq::post(format!("{base_url}/api/agent/exec"))
        .config()
        .http_status_as_error(false)
        .build()
        .send_empty()
        .unwrap();
    assert_eq!(wrong_path.status().as_u16(), 404);

    let wrong_method = ureq::get(format!("{base_url}/call"))
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .unwrap();
    assert_eq!(wrong_method.status().as_u16(), 404);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

/// AC1 guard: nothing in the deck server's own production code, or in
/// the shared argv executor, ever spawns a process — every deck call is
/// executed in this very server process (mirrors `workbench/mod.rs`'s own
/// `visit_rust_files`-based guard, see that module for the pattern this
/// one copies).
#[test]
fn server_and_cli_never_spawn_a_process() {
    fn visit_rust_files(dir: &std::path::Path, visitor: &mut dyn FnMut(&std::path::Path, &str)) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit_rust_files(&path, visitor);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            visitor(&path, &contents);
        }
    }

    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut offenders = Vec::new();
    let mut scan = |path: &std::path::Path| {
        visit_rust_files(path, &mut |file, contents| {
            let production = contents.split("#[cfg(test)]").next().unwrap();
            if production.contains("process::Command") {
                offenders.push(file.display().to_string());
            }
        });
    };
    scan(&crate_root.join("src/server"));
    if crate_root.join("src/cli.rs").is_file() {
        let contents = std::fs::read_to_string(crate_root.join("src/cli.rs")).unwrap();
        let production = contents.split("#[cfg(test)]").next().unwrap();
        if production.contains("process::Command") {
            offenders.push("src/cli.rs".to_string());
        }
    }
    assert!(
        offenders.is_empty(),
        "found std::process::Command in: {offenders:?}"
    );
}

/// AC10: the agent shim reaches the deck server with no Node process in
/// the path — the real compiled binary, spawned twice, once as the
/// server and once as the shim, calling it over the network.
#[test]
fn shim_reaches_the_deck_server_with_no_node_process_in_the_path() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("shim-e2e");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "shim-e2e");
    unsafe { std::env::remove_var("SLIDRA_HOME") };

    let bin = env!("CARGO_BIN_EXE_slidra");
    let mut server = Command::new(bin)
        .arg("__deck-server")
        .arg("--addr")
        .arg("127.0.0.1:0")
        .env("SLIDRA_HOME", &home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("deck server binary must start");

    let mut reader = BufReader::new(server.stdout.take().unwrap());
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("server must print its port line");
    let port_json: serde_json::Value =
        serde_json::from_str(line.trim()).expect("port line must be JSON");
    let port = port_json["port"]
        .as_u64()
        .expect("port field must be present");

    // `cat` isn't one of the editor's 68 hand-listed commands (the editor
    // reads file content over `/api/files/`, never this door).
    let credential = credential::encode(CallerKind::Agent, &id);
    let shim_output = Command::new(bin)
        .arg("__shim")
        .arg("cat")
        .arg(&id)
        .arg("slides/001.svg")
        .env("SLIDRA_SHIM_CREDENTIAL", &credential)
        .env("SLIDRA_SHIM_BASE_URL", format!("http://127.0.0.1:{port}"))
        .output()
        .expect("shim binary must run");

    let _ = server.kill();
    let _ = server.wait();

    assert!(
        shim_output.status.success(),
        "shim call failed: {shim_output:?}"
    );
    let stdout = String::from_utf8_lossy(&shim_output.stdout);
    // `cat <id> slides/001.svg` renders the slide's own raw SVG content —
    // `slide add`'s freshly created slide is a bare, valid SVG document.
    assert!(
        stdout.contains("<svg"),
        "shim output must contain the slide's own SVG content: {stdout}"
    );

    std::fs::remove_dir_all(&home).ok();
}
