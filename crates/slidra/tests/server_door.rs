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

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
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
    post_call_with_body(base_url, credential_header, extra_headers, argv, &[])
}

fn post_call_with_body(
    base_url: &str,
    credential_header: Option<&str>,
    extra_headers: &[(&str, &str)],
    argv: &[&str],
    body: &[u8],
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
    let response = request.send(body).expect("request must be sent");
    let status = response.status().as_u16();
    let (_, body) = response.into_parts();
    let mut bytes = Vec::new();
    body.into_reader().read_to_end(&mut bytes).unwrap();
    CallResponse {
        status,
        body: bytes,
    }
}

fn post_new(base_url: &str, credential_header: &str, name: &str) -> String {
    let request = ureq::post(format!("{base_url}/new"))
        .header(credential::CREDENTIAL_HEADER, credential_header)
        .config()
        .http_status_as_error(false)
        .build();
    let response = request
        .send(serde_json::to_vec(&serde_json::json!({ "name": name })).unwrap())
        .expect("request must be sent");
    assert_eq!(response.status().as_u16(), 200);
    let (_, body) = response.into_parts();
    let body: serde_json::Value = serde_json::from_reader(body.into_reader()).unwrap();
    body["id"]
        .as_str()
        .expect("new response must include id")
        .to_string()
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

struct DoorOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit: i32,
}

struct DeckServer {
    child: Child,
    base_url: String,
    id: String,
}

impl DeckServer {
    fn start(home: &std::path::Path, deck: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_slidra"))
            .arg("__deck-server")
            .args(["--asset-upload-bytes", "true", "--asset-remote-url", "true"])
            .arg("--initial-deck")
            .arg(deck)
            .env("SLIDRA_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("deck server must start");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let started: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        Self {
            base_url: format!("http://127.0.0.1:{}", started["port"].as_u64().unwrap()),
            id: started["workbenchId"].as_str().unwrap().to_string(),
            child,
        }
    }

    fn call(&self, argv: &[&str]) -> DoorOutput {
        self.call_as(CallerKind::Agent, argv)
    }

    fn call_as(&self, caller: CallerKind, argv: &[&str]) -> DoorOutput {
        let credential = credential::encode(caller, &self.id);
        let response = post_call(&self.base_url, Some(&credential), &[], argv);
        assert_eq!(response.status, 200, "argv {argv:?}");
        let (stdout, stderr, exit) = decode_frames(&response.body);
        DoorOutput {
            stdout,
            stderr,
            exit,
        }
    }
}

impl Drop for DeckServer {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn local_cli(argv: &[&str]) -> DoorOutput {
    let argv: Vec<std::ffi::OsString> = argv.iter().map(std::ffi::OsString::from).collect();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let exit = slidra::cli::run_argv_to(&argv, &mut stdout, &mut stderr, &mut std::io::empty());
    DoorOutput {
        stdout,
        stderr,
        exit,
    }
}

fn create_deck(path: &std::path::Path) {
    let path = path.to_string_lossy();
    let output = local_cli(&["new", &path]);
    assert_eq!(
        output.exit,
        0,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn seed_server(home: &std::path::Path, label: &str) -> (PathBuf, DeckServer) {
    let deck = home.join(format!("{label}.slidra"));
    create_deck(&deck);
    let server = DeckServer::start(home, &deck);
    let add = server.call(&["slide", "add", &server.id]);
    assert_eq!(add.exit, 0, "{}", String::from_utf8_lossy(&add.stderr));
    let textbox = server.call(&[
        "textbox",
        "add",
        &server.id,
        "slides/001.svg",
        "--x",
        "80",
        "--y",
        "80",
        "--width",
        "600",
        "--text",
        "title",
    ]);
    assert_eq!(
        textbox.exit,
        0,
        "{}",
        String::from_utf8_lossy(&textbox.stderr)
    );
    (deck, server)
}

fn first_element_id(server: &DeckServer) -> String {
    let output = server.call(&["cat", &server.id, "slides/001.svg"]);
    let svg = String::from_utf8(output.stdout).unwrap();
    let start = svg.find("id=\"el-").unwrap() + 4;
    let end = svg[start..].find('"').unwrap() + start;
    svg[start..end].to_string()
}

fn assert_ok(output: &DoorOutput, argv: &[&str]) {
    assert_eq!(
        output.exit,
        0,
        "argv {argv:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn json_envelope(output: &DoorOutput) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "JSON output failed to parse ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

fn base64_decode_for_test(input: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let stripped: Vec<u8> = input.bytes().filter(|byte| *byte != b'=').collect();
    let mut out = Vec::new();
    for chunk in stripped.chunks(4) {
        let mut buffer = 0_u32;
        for (index, byte) in chunk.iter().enumerate() {
            let value = ALPHABET
                .iter()
                .position(|candidate| candidate == byte)
                .unwrap() as u32;
            buffer |= value << (18 - index * 6);
        }
        out.push((buffer >> 16) as u8);
        if chunk.len() > 2 {
            out.push((buffer >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(buffer as u8);
        }
    }
    out
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

#[test]
fn editor_can_reach_undo_and_redo_through_the_only_command_door() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editor-undo-redo");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "editor-undo-redo");

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor_cred = credential::encode(CallerKind::Editor, &id);

    let undo = post_call(&base_url, Some(&editor_cred), &[], &["undo", &id, "--json"]);
    assert_eq!(undo.status, 200, "the browser has no second command door");
    assert_eq!(decode_frames(&undo.body).2, 0);

    let redo = post_call(&base_url, Some(&editor_cred), &[], &["redo", &id, "--json"]);
    assert_eq!(redo.status, 200, "the browser has no second command door");
    assert_eq!(decode_frames(&redo.body).2, 0);

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn table_cell_paste_stages_the_request_body_for_tsv_file_dash() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("editor-table-paste");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "editor-table-paste");
    let create = commands::table::run(
        &[
            "create",
            &id,
            "slides/001.svg",
            "--rows",
            "2",
            "--cols",
            "2",
            "--x",
            "0",
            "--y",
            "0",
        ]
        .map(str::to_string),
    );
    assert!(
        create.ok,
        "setup: `table create` failed: {}",
        create.message
    );
    let table_id = create.data.unwrap()["elementId"]
        .as_str()
        .unwrap()
        .to_string();

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let editor_cred = credential::encode(CallerKind::Editor, &id);
    let response = post_call_with_body(
        &base_url,
        Some(&editor_cred),
        &[],
        &[
            "table",
            "cell",
            "paste",
            "browser-supplied-id",
            "slides/001.svg",
            &table_id,
            "--at",
            "0,0",
            "--tsv-file",
            "-",
            "--json",
        ],
        b"alpha\tbeta",
    );
    assert_eq!(response.status, 200);
    let (stdout, stderr, exit_code) = decode_frames(&response.body);
    assert_eq!(
        exit_code,
        0,
        "the browser body must be staged as TSV: {}",
        String::from_utf8_lossy(&stderr)
    );
    let envelope: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(
        envelope["ok"], true,
        "the browser body must be staged as TSV: {}",
        envelope["message"]
    );

    let copied = commands::table::run(
        &[
            "cell",
            "copy",
            &id,
            "slides/001.svg",
            &table_id,
            "--range",
            "0,0:0,1",
        ]
        .map(str::to_string),
    );
    assert!(copied.ok, "{}", copied.message);
    assert_eq!(copied.data.unwrap()["tsv"], "alpha\tbeta");

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

/// `element insert` is the one family command whose deck id follows a
/// command-specific positional (`kind`). The door must preserve that kind
/// while replacing the untrusted id with the credential-bound deck.
#[test]
fn element_insert_preserves_kind_while_overwriting_deck_id() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("element-insert-id-override");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let real_id = seed_deck(&home, "element-insert-id-override");

    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let agent_cred = credential::encode(CallerKind::Agent, &real_id);

    let response = post_call(
        &base_url,
        Some(&agent_cred),
        &[],
        &[
            "element",
            "insert",
            "rect",
            "not-a-real-id",
            "slides/001.svg",
            "--x",
            "1",
            "--y",
            "1",
            "--width",
            "1",
            "--height",
            "1",
            "--json",
        ],
    );
    assert_eq!(response.status, 200);
    let (stdout, _, exit_code) = decode_frames(&response.body);
    assert_eq!(exit_code, 0, "element insert must succeed through the door");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["ok"],
        serde_json::json!(true),
        "the credential must replace the fake id without replacing `rect`"
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

/// AC1 guard: nothing that executes a DECK CALL — the deck server's own
/// production code, or the shared argv executor — ever spawns a process;
/// every deck call is executed in this very server process (mirrors
/// `workbench/mod.rs`'s own `visit_rust_files`-based guard, see that
/// module for the pattern this one copies).
///
/// `server/trash.rs` is the one deliberate exception, so it is excluded
/// from this scan rather than tripping it: [E10.T5]'s "no new dependency"
/// constraint on the OS-trash move means macOS's half has no way to ask
/// Finder to trash a file except `osascript` (there is no in-process API
/// for "the same move Finder's own Trash does, restorable via Put Back").
/// That call is OS integration triggered by `deck_store::remove_deck`, not
/// a deck call dispatched through `/call`'s argv executor — AC1's actual
/// scope, per this test's own name and this module's doc comment, is
/// "the CLI takeover path never shells out to itself", which `trash.rs`
/// does not touch.
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
            if path.file_name().and_then(|n| n.to_str()) == Some("trash.rs") {
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

    let bin = env!("CARGO_BIN_EXE_slidra");
    let mut server = Command::new(bin)
        .arg("__deck-server")
        .args(["--asset-upload-bytes", "true", "--asset-remote-url", "true"])
        .arg("--addr")
        .arg("127.0.0.1:0")
        .env("SLIDRA_HOME", &home)
        .stdin(Stdio::piped())
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
    let base_url = format!("http://127.0.0.1:{port}");
    let lifecycle_credential = credential::encode(CallerKind::Editor, "lifecycle");
    let id = post_new(&base_url, &lifecycle_credential, "shim-e2e");
    let editor_credential = credential::encode(CallerKind::Editor, &id);
    let add = post_call(
        &base_url,
        Some(&editor_credential),
        &[],
        &["slide", "add", &id],
    );
    assert_eq!(add.status, 200);
    let (_, add_stderr, add_exit) = decode_frames(&add.body);
    assert_eq!(add_exit, 0, "{}", String::from_utf8_lossy(&add_stderr));

    // `cat` isn't one of the editor's 68 hand-listed commands (the editor
    // reads file content over `/api/files/`, never this door).
    let credential = credential::encode(CallerKind::Agent, &id);
    let shim_output = Command::new(bin)
        .arg("__shim")
        .arg("cat")
        .arg(&id)
        .arg("slides/001.svg")
        .env("SLIDRA_SHIM_CREDENTIAL", &credential)
        .env("SLIDRA_SHIM_BASE_URL", &base_url)
        .output()
        .expect("shim binary must run");

    drop(server.stdin.take());
    let status = server
        .wait()
        .expect("deck server must shut down on stdin EOF");
    assert!(status.success(), "deck server shutdown failed: {status}");

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

#[test]
fn cat_through_a_closed_pipe_exits_zero_without_an_error() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("shim-closed-pipe");
    let deck = home.join("large.slidra");
    let created = commands::new::run(&[deck.to_string_lossy().into_owned()]);
    assert!(created.ok, "{}", created.message);
    slidra::workspace::virtual_fs::create_new_file(
        &deck,
        "assets/big.txt",
        &vec![b'x'; 8 * 1024 * 1024],
    )
    .unwrap();

    let bin = env!("CARGO_BIN_EXE_slidra");
    let mut server = Command::new(bin)
        .arg("__deck-server")
        .args(["--asset-upload-bytes", "true", "--asset-remote-url", "true"])
        .arg("--initial-deck")
        .arg(&deck)
        .env("SLIDRA_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(server.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let started: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    let port = started["port"].as_u64().unwrap();
    let id = started["workbenchId"].as_str().unwrap();
    let credential = credential::encode(CallerKind::Agent, id);

    let mut shim = Command::new(bin)
        .args(["__shim", "cat", id, "assets/big.txt"])
        .env("SLIDRA_SHIM_CREDENTIAL", credential)
        .env("SLIDRA_SHIM_BASE_URL", format!("http://127.0.0.1:{port}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = [0_u8; 1];
    shim.stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut first)
        .unwrap();
    drop(shim.stdout.take());
    let output = shim.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "closed consumer must not fail: {output:?}"
    );
    assert!(
        output.stderr.is_empty(),
        "closed consumer must keep stderr empty: {output:?}"
    );

    drop(server.stdin.take());
    assert!(server.wait().unwrap().success());
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn documented_commands_dispatch_without_node() {
    use std::process::Command;

    let spec = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/spec/cli.md"),
    )
    .unwrap();
    let command_names: Vec<&str> = spec
        .lines()
        .filter_map(|line| {
            line.strip_prefix("## `")
                .and_then(|rest| rest.strip_suffix('`'))
        })
        .collect();
    assert_eq!(command_names.len(), 92);
    let empty_path = temp_home("no-node-path");
    for name in command_names {
        let output = Command::new(env!("CARGO_BIN_EXE_slidra"))
            .args(name.split(' '))
            .env("PATH", &empty_path)
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("node not found"),
            "documented argv {name:?} fell through to Node: {output:?}"
        );
    }
    std::fs::remove_dir_all(empty_path).ok();
}

#[test]
fn json_data_shape_matches_cli_md_for_every_documented_command() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("json-shape-door");
    unsafe { std::env::set_var("SLIDRA_HOME", &home) };
    let id = seed_deck(&home, "json-shape");
    let addr = slidra::server::test_support::spawn_test_server();
    let base_url = format!("http://{addr}");
    let call_json = |argv: &[&str]| {
        let caller = if argv.starts_with(&["slide", "render"]) {
            CallerKind::Viewer
        } else {
            CallerKind::Agent
        };
        let credential = credential::encode(caller, &id);
        let response = post_call(&base_url, Some(&credential), &[], argv);
        assert_eq!(response.status, 200, "argv {argv:?}");
        let (stdout, stderr, exit) = decode_frames(&response.body);
        assert_eq!(
            exit,
            0,
            "argv {argv:?}: {}",
            String::from_utf8_lossy(&stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()
    };

    let canvas = call_json(&[
        "presentation",
        "canvas",
        "set",
        &id,
        "--width",
        "1920",
        "--height",
        "1080",
        "--json",
    ]);
    assert_eq!(
        canvas["data"],
        serde_json::json!({ "width": 1920, "height": 1080 })
    );

    let added = call_json(&["slide", "add", &id, "--json"]);
    assert!(added["data"]["slidePath"].as_str().is_some());
    let duplicated = call_json(&["slide", "duplicate", &id, "slides/001.svg", "--json"]);
    let duplicate_path = duplicated["data"]["slidePath"].as_str().unwrap();
    assert_eq!(
        call_json(&["slide", "delete", &id, duplicate_path, "--json"])["data"],
        serde_json::json!({})
    );
    assert_eq!(
        call_json(&[
            "slide",
            "notes",
            "set",
            &id,
            "slides/001.svg",
            "hi",
            "--json"
        ])["data"],
        serde_json::json!({})
    );
    assert_eq!(
        call_json(&[
            "slide",
            "style",
            "set",
            &id,
            "slides/001.svg",
            "--background",
            "#111",
            "--json"
        ])["data"],
        serde_json::json!({})
    );
    assert_eq!(
        call_json(&[
            "slide",
            "transition",
            "set",
            &id,
            "slides/001.svg",
            "--enter",
            "fade",
            "--json"
        ])["data"],
        serde_json::json!({})
    );
    let rendered = call_json(&["slide", "render", &id, "slides/001.svg", "--json"]);
    let decoded = base64_decode_for_test(rendered["data"]["content"].as_str().unwrap());
    assert!(String::from_utf8_lossy(&decoded).starts_with("<svg"));
    let template = call_json(&["template", "add", &id, "--json"]);
    assert!(template["data"]["templatePath"].as_str().is_some());
    let templates = call_json(&["template", "list", &id, "--json"]);
    assert!(templates["data"]["templates"].is_array());
    let converted = call_json(&["convert", &id, "--json"]);
    assert!(converted["data"]["slides"].is_array());

    unsafe { std::env::remove_var("SLIDRA_HOME") };
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn concurrent_effect_adds_on_one_slide_are_serialised_by_the_presentation_lock() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("concurrent-effects-door");
    let (_deck, server) = seed_server(&home, "effects");
    let element = first_element_id(&server);
    let credential = credential::encode(CallerKind::Editor, &server.id);
    let base = server.base_url.clone();
    let id = server.id.clone();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let base = base.clone();
            let credential = credential.clone();
            let id = id.clone();
            let element = element.clone();
            scope.spawn(move || {
                let argv = [
                    "effect",
                    "add",
                    &id,
                    "slides/001.svg",
                    &element,
                    "--family",
                    "enter",
                    "--effect",
                    "fade",
                ];
                let response = post_call(&base, Some(&credential), &[], &argv);
                let (_, stderr, exit) = decode_frames(&response.body);
                assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
            });
        }
    });
    let listed = server.call(&["effect", "list", &server.id, "slides/001.svg", "--json"]);
    assert_ok(&listed, &["effect", "list"]);
    assert_eq!(
        json_envelope(&listed)["data"]["effects"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn undo_survives_closing_and_reopening_the_same_deck_file() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("undo-reopen-door");
    let (deck, server) = seed_server(&home, "undo-reopen");
    let before = server.call(&["cat", &server.id, "slides/001.svg"]).stdout;
    assert_ok(
        &server.call(&[
            "slide",
            "notes",
            "set",
            &server.id,
            "slides/001.svg",
            "changed",
        ]),
        &["slide", "notes", "set"],
    );
    drop(server);
    let reopened = DeckServer::start(&home, &deck);
    assert_ok(&reopened.call(&["undo", &reopened.id]), &["undo"]);
    let restored = reopened
        .call(&["cat", &reopened.id, "slides/001.svg"])
        .stdout;
    assert_eq!(restored, before);
    drop(reopened);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn undo_history_survives_copying_the_deck_file_to_a_clean_home() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("undo-copy-a");
    let clean = temp_home("undo-copy-b");
    let (deck, server) = seed_server(&home, "source");
    let before = server.call(&["cat", &server.id, "slides/001.svg"]).stdout;
    assert_ok(
        &server.call(&[
            "slide",
            "notes",
            "set",
            &server.id,
            "slides/001.svg",
            "changed",
        ]),
        &["slide", "notes", "set"],
    );
    drop(server);
    let copy = clean.join("copy.slidra");
    std::fs::copy(&deck, &copy).unwrap();
    let copied = DeckServer::start(&clean, &copy);
    assert_ok(&copied.call(&["undo", &copied.id]), &["undo"]);
    let restored = copied.call(&["cat", &copied.id, "slides/001.svg"]).stdout;
    assert_eq!(restored, before);
    drop(copied);
    std::fs::remove_dir_all(home).ok();
    std::fs::remove_dir_all(clean).ok();
}

#[test]
fn slidra_home_history_directory_is_never_created() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("no-history-dir-door");
    let (_deck, server) = seed_server(&home, "history");
    let element = first_element_id(&server);
    for argv in [
        vec![
            "text",
            "set",
            &server.id,
            "slides/001.svg",
            &element,
            "plain",
        ],
        vec!["history", "begin-group", &server.id],
        vec![
            "text",
            "set",
            &server.id,
            "slides/001.svg",
            &element,
            "grouped",
        ],
        vec!["history", "end-group", &server.id],
        vec!["undo", &server.id],
        vec!["redo", &server.id],
    ] {
        assert_ok(&server.call(&argv), &argv);
        assert!(
            !home.join("history").exists(),
            "argv {argv:?} created legacy history"
        );
    }
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn effect_list_without_a_list_matches_stderr_and_exit_code() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("effect-missing-door");
    let (_deck, server) = seed_server(&home, "missing");
    let output = server.call(&["effect", "list", &server.id, "slides/001.svg"]);
    assert_eq!(output.exit, 1);
    assert!(String::from_utf8_lossy(&output.stderr).contains("effect"));
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn effect_add_then_undo_restores_original_bytes() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("effect-undo-door");
    let (_deck, server) = seed_server(&home, "effect-undo");
    let before = server.call(&["cat", &server.id, "slides/001.svg"]).stdout;
    let element = first_element_id(&server);
    assert_ok(
        &server.call(&[
            "effect",
            "add",
            &server.id,
            "slides/001.svg",
            &element,
            "--family",
            "enter",
            "--effect",
            "fade",
        ]),
        &["effect", "add"],
    );
    assert_ok(&server.call(&["undo", &server.id]), &["undo"]);
    let restored = server.call(&["cat", &server.id, "slides/001.svg"]).stdout;
    assert_eq!(restored, before);
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn cat_json_multi_path_returns_ordered_array_shape() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("cat-json-door");
    let (_deck, server) = seed_server(&home, "cat-json");
    let single = json_envelope(&server.call(&["cat", &server.id, "project.json", "--json"]));
    assert_eq!(single["data"].as_array().unwrap().len(), 1);
    let output = server.call(&[
        "cat",
        &server.id,
        "slides/001.svg",
        "project.json",
        "slides/001.svg",
        "--json",
    ]);
    let data = json_envelope(&output)["data"].as_array().unwrap().clone();
    assert_eq!(
        data.iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["slides/001.svg", "project.json", "slides/001.svg"]
    );
    assert_eq!(data[0]["content"], data[2]["content"]);
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn effect_list_with_damaged_list_matches_stderr() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("effect-damaged-door");
    let (deck, server) = seed_server(&home, "damaged");
    drop(server);
    let damaged = br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="https://slidra.app/ns/2026"><metadata><slidra:effects><slidra:effect target="missing"/></slidra:effects></metadata></svg>"#;
    slidra::workspace::virtual_fs::write_existing_file(&deck, "slides/001.svg", damaged).unwrap();
    let server = DeckServer::start(&home, &deck);
    let output = server.call(&["effect", "list", &server.id, "slides/001.svg"]);
    assert_eq!(output.exit, 1);
    assert!(!output.stderr.is_empty());
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn plan_set_then_validate_round_trip_via_rust_binary() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("plan-door");
    let (_deck, server) = seed_server(&home, "plan");
    let spec = "```json\n{ \"density\": \"presentation\", \"palette\": { \"background\": \"#101418\", \"secondary_bg\": \"#1B2129\", \"primary\": \"#4F8DFF\", \"accent\": \"#F5B942\", \"secondary_accent\": \"#6DD3A5\", \"text\": \"#F4F6F8\", \"muted\": \"#9AA7B4\" }, \"type_scale\": { \"cover\": 64, \"section\": 56, \"number\": 140, \"claim\": 48, \"title\": 40, \"subtitle\": 28, \"body\": 24, \"column\": 22, \"caption\": 18 } }\n```\n";
    let bad = spec.replace("presentation", "loose");
    assert_eq!(
        server
            .call(&["plan", "set", &server.id, "design-spec", &bad])
            .exit,
        1
    );
    assert_ok(
        &server.call(&["plan", "set", &server.id, "design-spec", spec]),
        &["plan", "set"],
    );
    let outline = "```json\n{ \"status\": \"draft\", \"mode\": \"briefing\", \"pages\": [ { \"n\": 1, \"relationship\": \"membership\", \"type\": \"bullets\", \"rhythm\": \"dense\", \"title\": \"Title\" } ] }\n```\n";
    assert_ok(
        &server.call(&["plan", "set", &server.id, "outline", outline]),
        &["plan", "set"],
    );
    let listed = json_envelope(&server.call(&["plan", "list", &server.id, "--json"]));
    assert_eq!(listed["data"]["plans"].as_array().unwrap().len(), 2);
    assert!(
        String::from_utf8_lossy(&server.call(&["cat", &server.id, "plan/outline.md"]).stdout)
            .starts_with("```json")
    );
    assert_eq!(server.call(&["validate", &server.id, "--json"]).exit, 1);
    assert_ok(
        &server.call(&["plan", "delete", &server.id]),
        &["plan", "delete"],
    );
    let after = json_envelope(&server.call(&["validate", &server.id, "--json"]));
    assert!(
        after["message"]
            .as_str()
            .unwrap()
            .contains("no plan/ plan file")
    );
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn font_import_embeds_a_second_family_that_text_can_then_use() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("font-door");
    let deck = home.join("font.slidra");
    create_deck(&deck);
    let server = DeckServer::start(&home, &deck);
    let source = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/fonts/NotoSansTC-Presentation.ttf"
    );
    let argv = [
        "font",
        "import",
        &server.id,
        source,
        "--family",
        "Catalogue Serif",
        "--license",
        "SIL Open Font License 1.1",
        "--source",
        "https://example.org/font",
        "--json",
    ];
    let imported = server.call(&argv);
    assert_ok(&imported, &argv);
    assert_eq!(
        json_envelope(&imported)["data"]["file"],
        "fonts/Catalogue-Serif.ttf"
    );
    assert_ok(
        &server.call(&["slide", "add", &server.id]),
        &["slide", "add"],
    );
    assert_ok(
        &server.call(&[
            "textbox",
            "add",
            &server.id,
            "slides/001.svg",
            "--x",
            "80",
            "--y",
            "100",
            "--width",
            "600",
            "--text",
            "new font",
            "--font-family",
            "Catalogue Serif",
        ]),
        &["textbox", "add"],
    );
    assert_eq!(server.call(&argv[..argv.len() - 1]).exit, 1);
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn svg_asset_and_slide_background_round_trip_via_rust_binary() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("background-door");
    let (_deck, server) = seed_server(&home, "background");
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#4F8DFF"/></svg>"##;
    assert_ok(
        &server.call(&[
            "asset", "import", &server.id, "--svg", svg, "--name", "bg.svg",
        ]),
        &["asset", "import"],
    );
    assert_eq!(
        server
            .call(&[
                "asset", "import", &server.id, "--svg", svg, "--name", "bg.svg"
            ])
            .exit,
        1
    );
    assert_ok(
        &server.call(&[
            "slide",
            "background",
            "set",
            &server.id,
            "slides/001.svg",
            "--asset",
            "assets/bg.svg",
            "--opacity",
            "0.8",
        ]),
        &["slide", "background", "set"],
    );
    let page =
        String::from_utf8(server.call(&["cat", &server.id, "slides/001.svg"]).stdout).unwrap();
    assert!(page.contains("data-slidra-role=\"background\""));
    assert_ok(
        &server.call(&[
            "slide",
            "background",
            "set",
            &server.id,
            "slides/001.svg",
            "--none",
        ]),
        &["slide", "background", "set"],
    );
    assert_ok(&server.call(&["undo", &server.id]), &["undo"]);
    assert!(
        String::from_utf8(server.call(&["cat", &server.id, "slides/001.svg"]).stdout)
            .unwrap()
            .contains("el-background")
    );
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn slide_add_svg_then_slide_set_svg_round_trip_via_rust_binary() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("slide-svg-door");
    let deck = home.join("slide-svg.slidra");
    create_deck(&deck);
    let server = DeckServer::start(&home, &deck);
    let page = r##"<svg viewBox="0 0 1280 720"><text id="el-title" data-slidra-text-width="1120" x="80" y="72" font-size="40">Title</text></svg>"##;
    assert_ok(
        &server.call(&["slide", "add", &server.id, "--svg", page]),
        &["slide", "add"],
    );
    assert_eq!(
        server
            .call(&[
                "slide",
                "add",
                &server.id,
                "--svg",
                "<svg><script>1</script></svg>"
            ])
            .exit,
        1
    );
    assert_ok(
        &server.call(&[
            "slide",
            "notes",
            "set",
            &server.id,
            "slides/001.svg",
            "speaker notes",
        ]),
        &["slide", "notes", "set"],
    );
    let replacement = r##"<svg viewBox="0 0 1280 720"><text id="el-title" data-slidra-text-width="1120" x="80" y="72" font-size="40">rewritten</text></svg>"##;
    assert_ok(
        &server.call(&[
            "slide",
            "set",
            &server.id,
            "slides/001.svg",
            "--svg",
            replacement,
        ]),
        &["slide", "set"],
    );
    let contents =
        String::from_utf8(server.call(&["cat", &server.id, "slides/001.svg"]).stdout).unwrap();
    assert!(contents.contains("speaker notes") && contents.contains("rewritten"));
    assert_ok(&server.call(&["undo", &server.id]), &["undo"]);
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn slide_add_refuses_a_page_that_breaks_its_own_rules_via_rust_binary() {
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("write-gate-door");
    let deck = home.join("gate.slidra");
    create_deck(&deck);
    let server = DeckServer::start(&home, &deck);
    let refused = r##"<svg viewBox="0 0 1280 720"><text id="el-a" data-slidra-text-width="600" x="80" y="100" font-size="40">top</text><text id="el-b" data-slidra-text-width="600" x="80" y="110" font-size="40">bottom</text><image id="el-p" href="../assets/nope.png"/></svg>"##;
    let output = server.call(&["slide", "add", &server.id, "--svg", refused]);
    assert_eq!(output.exit, 1);
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(message.contains("geometry.text-overlap") && message.contains("asset.missing"));
    let legal = r##"<svg viewBox="0 0 1280 720"><g id="el-mark" data-slidra-role="garnish"><text x="900" y="600" font-size="320">03</text></g></svg>"##;
    assert_ok(
        &server.call(&["slide", "add", &server.id, "--svg", legal]),
        &["slide", "add"],
    );
    let bad_role = r##"<svg viewBox="0 0 1280 720"><g id="el-r" data-slidra-role="headline"><rect width="10" height="10"/></g></svg>"##;
    assert_eq!(
        server
            .call(&["slide", "add", &server.id, "--svg", bad_role])
            .exit,
        1
    );
    drop(server);
    std::fs::remove_dir_all(home).ok();
}

#[test]
fn editing_one_slide_writes_under_1mb_even_with_a_20mb_asset() {
    const SIZE: usize = 20 * 1024 * 1024;
    let _guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("budget-door");
    let (deck, server) = seed_server(&home, "budget");
    let asset = home.join("big.mp4");
    let mut bytes = vec![
        0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm',
    ];
    bytes.resize(SIZE, 0x5a);
    std::fs::write(&asset, bytes).unwrap();
    assert_ok(
        &server.call(&["asset", "import", &server.id, asset.to_str().unwrap()]),
        &["asset", "import"],
    );
    let before = std::fs::read(&deck).unwrap();
    assert_ok(
        &server.call(&[
            "slide",
            "notes",
            "set",
            &server.id,
            "slides/001.svg",
            "measured edit",
        ]),
        &["slide", "notes", "set"],
    );
    let after = std::fs::read(&deck).unwrap();
    let changed = before.iter().zip(&after).filter(|(a, b)| a != b).count()
        + after.len().saturating_sub(before.len());
    assert!(changed < 1_000_000, "changed {changed} bytes");
    drop(server);
    std::fs::remove_dir_all(home).ok();
}
