// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The deck server ([S11.F2], #397): an HTTP door in front of `cli::
//! run_argv_to`, so authorising a call and executing it happen in the
//! same process (ADR-0015) — no deck call is ever executed by spawning a
//! process (AC1). Reachable only through the crate's own internal,
//! bypass-the-registry entry point `slidra __deck-server` (`main.rs`),
//! never a CLI command in its own right.
//!
//! Scope, per NOOP-637's plan (the boundary this ticket and [E10.T9] agreed
//! on): this module gets the crate to the point where the server can be
//! started and called independently and verified end to end
//! (`tests/server_door.rs`). It does NOT wire into the live `serve`
//! process — `packages/server`'s `POST /api/agent/exec` still owns that
//! path until the launcher (T9) switches the entry point over. Credential
//! ISSUANCE is also out of scope (#397: "issuing credentials is [S11.F6]");
//! `credential::parse` below decodes a credential this ticket's own tests
//! construct directly, not one signed by a launcher that does not exist
//! yet — every place that matters is called out in this module's own doc
//! comments and the PR's "Uncertainties" section.
//!
//! Deliberately built on `std::net::TcpListener` + thread-per-connection +
//! `httparse`, never an async runtime (plan §7.1: this repo's existing
//! posture is "avoid a dependency where a few dozen lines suffice",
//! `agent/commands.ts:75`'s own YAML-parser refusal). Every response is
//! `Connection: close`, so a connection serves exactly one request.

use std::ffi::OsString;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};

use crate::cli;
use crate::commands::category::{Category, resolve_full_command};

pub mod allowlist;
pub mod assets;
pub mod credential;
pub mod deck_lifecycle;
pub mod deck_store;
pub mod editing_lock;
pub mod events;
pub mod raw;
pub mod reads;
pub mod redact;
pub mod shim_client;
pub mod trash;

use credential::{CallerKind, Credential, CredentialError};

const ARGV_HEADER: &str = "x-slidra-argv";

const FRAME_STDOUT: u8 = 1;
const FRAME_STDERR: u8 = 2;
const FRAME_EXIT: u8 = 3;

/// `slidra __deck-server [--addr <host:port>]` — binds (default
/// `127.0.0.1:0`, an ephemeral port), prints exactly one line to stdout,
/// `{"port":<n>}`, then serves forever. The one line is how a test
/// harness spawning this as a real subprocess (`tests/server_door.rs`,
/// AC10) learns which port to call back on without a fixed, collision-
/// prone port number.
pub fn run(args: &[OsString]) -> i32 {
    let addr = parse_addr_flag(args).unwrap_or_else(|| "127.0.0.1:0".to_string());
    let listener = match TcpListener::bind(&addr) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("slidra __deck-server: failed to bind {addr}: {err}");
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    println!("{{\"port\":{port}}}");
    let _ = std::io::stdout().flush();
    serve_forever(listener)
}

fn parse_addr_flag(args: &[OsString]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--addr" {
            return iter.next().and_then(|v| v.to_str()).map(str::to_string);
        }
    }
    None
}

fn serve_forever(listener: TcpListener) -> i32 {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        std::thread::spawn(move || {
            handle_connection(stream);
        });
    }
    0
}

/// Reads exactly one HTTP/1.1 request off `stream`, dispatches it, and
/// writes exactly one response — never more than one request per
/// connection (`Connection: close` on every path), EXCEPT `GET /events`
/// (`events::handle`), which holds the connection open and writes zero or
/// more notification frames before the client (or this end, on a fatal
/// watch error) closes it — matching `changes.ts`'s one-way,
/// browser-reconnects-itself stream (Plan §4/§7.2/spec decision 18).
fn handle_connection(mut stream: TcpStream) {
    let request = match read_request(&mut stream) {
        Some(request) => request,
        None => return,
    };

    let path = path_only(&request.path);
    match (request.method.as_str(), path) {
        ("POST", "/call") => handle_call(&request, &mut stream),
        ("GET", "/presentation") => reads::handle_presentation(&request, &mut stream),
        ("GET", "/assets") => reads::handle_assets(&request, &mut stream),
        ("GET", "/events") => events::handle(&request, &mut stream),
        ("GET", p) if p.starts_with("/files/") => {
            reads::handle_files(&request, &mut stream, &p["/files/".len()..])
        }
        ("GET", p) if p.starts_with("/effects/") => {
            reads::handle_effects(&request, &mut stream, &p["/effects/".len()..])
        }
        ("GET", p) if p.starts_with("/raw/") => {
            raw::handle(&request, &mut stream, &p["/raw/".len()..])
        }
        ("POST", "/assets") => assets::handle(&request, &mut stream),
        ("POST", "/editing/begin") => editing_lock::handle_begin(&request, &mut stream),
        ("POST", "/editing/end") => editing_lock::handle_end(&request, &mut stream),
        ("GET", "/editing") => editing_lock::handle_status(&request, &mut stream),
        ("POST", "/editing/agent-begin") => editing_lock::handle_agent_begin(&request, &mut stream),
        ("POST", "/editing/agent-end") => editing_lock::handle_agent_end(&request, &mut stream),
        ("POST", "/new") => deck_lifecycle::handle_new(&request, &mut stream),
        ("POST", "/open") => deck_lifecycle::handle_open(&request, &mut stream),
        ("POST", "/deck/import") => deck_lifecycle::handle_import(&request, &mut stream),
        ("POST", "/deck/rename") => deck_lifecycle::handle_rename(&request, &mut stream),
        ("POST", "/deck/delete") => deck_lifecycle::handle_delete(&request, &mut stream),
        ("GET", "/decks") => deck_lifecycle::handle_list(&request, &mut stream),
        ("POST", "/deck/resolve") => deck_lifecycle::handle_resolve(&request, &mut stream),
        _ => write_plain_response(&mut stream, 404, "not found"),
    }
}

/// Strips a query string off `path` — none of this door's routes ever
/// consult one (every parameter travels as a header or a path segment), so
/// a caller-supplied `?...` is simply ignored rather than treated as part
/// of the route.
fn path_only(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

/// Percent-decodes a URL path segment (RFC 3986 `%XX`), then validates the
/// result as UTF-8. `None` on a malformed escape or invalid UTF-8 — callers
/// turn that into a 400, mirroring `serve.ts`'s own
/// `decodeURIComponent`-throws-\>-400 handling for `/api/files`/`/api/raw`.
pub(crate) fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                out.push(value);
                i += 3;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Every GET route's front door (Plan §4 row 1: "every new route" gets the
/// same credential handling `/call` has): rejects a self-asserted caller
/// kind (400), then parses the credential (401), then checks it is one of
/// `allowed` (403). On success, returns the credential AND the resolved
/// deck path for its workbench id (404 if the workbench/deck id is
/// unknown to the registry, 500 for any other registry failure) — every
/// route built on this door is deck-scoped, so resolving the path once
/// here saves every caller repeating it.
pub(crate) fn authorize_deck_scoped(
    request: &RawRequest,
    stream: &mut TcpStream,
    allowed: &[CallerKind],
) -> Option<(Credential, std::path::PathBuf)> {
    let credential = authorize(request, stream, allowed)?;
    match crate::workspace::resolve_work_dir(&credential.workbench_id) {
        Ok(work_dir) => Some((credential, work_dir)),
        Err(crate::errors::SlidraError::NotFound(message)) => {
            write_json_error(stream, 404, &message);
            None
        }
        Err(crate::errors::SlidraError::InvalidRequest(message)) => {
            write_json_error(stream, 500, &message);
            None
        }
    }
}

/// Same credential handling as `authorize_deck_scoped`, without resolving a
/// deck path — `events::handle` needs this split because a resolution
/// failure there must still be reported as 404 like every other route, but
/// the caller (not this function) owns turning the resolved path into a
/// long-lived watch.
pub(crate) fn authorize(
    request: &RawRequest,
    stream: &mut TcpStream,
    allowed: &[CallerKind],
) -> Option<Credential> {
    if request.has_header(credential::CALLER_KIND_HEADER) {
        write_plain_response(
            stream,
            400,
            "caller kind must not be asserted by the request",
        );
        return None;
    }
    let credential = match credential::parse(&request.headers) {
        Ok(credential) => credential,
        Err(CredentialError::Unauthorized) => {
            write_plain_response(stream, 401, "unauthorized");
            return None;
        }
    };
    if !allowed.contains(&credential.kind) {
        write_plain_response(stream, 403, "credential kind may not reach this route");
        return None;
    }
    Some(credential)
}

/// Writes a `{"error": message}` body — the shape every read/raw/events
/// error response in Plan §4's contract table uses.
pub(crate) fn write_json_error(stream: &mut TcpStream, status: u16, message: &str) {
    let body = serde_json::json!({ "error": message }).to_string();
    write_body_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &[],
        body.as_bytes(),
    );
}

/// Writes a 200 JSON body (compact, no pretty-printing — this is a wire
/// response, not `--json`'s stdout contract).
pub(crate) fn write_json_response(stream: &mut TcpStream, value: &serde_json::Value) {
    let body = value.to_string();
    write_body_response(
        stream,
        200,
        "application/json; charset=utf-8",
        &[],
        body.as_bytes(),
    );
}

/// The one low-level writer every GET route's response (success or error)
/// goes through: status line, `Connection: close`, `content-type`,
/// `content-length`, any `extra_headers`, then `body` verbatim. Byte-exact
/// for binary payloads (AC/Plan §4's raw-serving contract) — never
/// re-encoded.
pub(crate) fn write_body_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    extra_headers: &[(&str, String)],
    body: &[u8],
) {
    let reason = reason_phrase(status);
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (name, value) in extra_headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.write_all(body);
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

pub(crate) struct RawRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl RawRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub(crate) fn has_header(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(name))
    }
}

/// Reads the request line and headers via `httparse`, growing `buf` until
/// a complete head is seen (capped at 64 KiB — every header this door
/// defines is small and fixed-shape; nothing legitimate ever needs more),
/// then reads exactly `Content-Length` more bytes as the body. A
/// connection that never completes a valid head, or claims a body larger
/// than this door will ever accept, is simply dropped (no response) —
/// matching a raw TCP peer's own experience of a server that never
/// speaks HTTP at all, since at that point there is no way to know it
/// meant to.
fn read_request(stream: &mut TcpStream) -> Option<RawRequest> {
    const MAX_HEAD_BYTES: usize = 64 * 1024;
    // Above `assets::MAX_ASSET_BODY_BYTES` (32 MiB) on purpose: this cap
    // just bounds what the connection will ever read at all; the precise
    // "over 32 MiB -> 400 with a JSON body" contract for uploads is
    // `assets::handle`'s own check, which needs the body to have actually
    // arrived to answer with a proper response instead of a dropped
    // connection.
    const MAX_BODY_BYTES: usize = 40 * 1024 * 1024;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_len;
    loop {
        let mut headers_storage = [httparse::EMPTY_HEADER; 32];
        let mut req = httparse::Request::new(&mut headers_storage);
        match req.parse(&buf) {
            Ok(httparse::Status::Complete(len)) => {
                head_len = len;
                let method = req.method.unwrap_or("").to_string();
                let path = req.path.unwrap_or("").to_string();
                let headers = req
                    .headers
                    .iter()
                    .map(|h| {
                        (
                            h.name.to_string(),
                            String::from_utf8_lossy(h.value).into_owned(),
                        )
                    })
                    .collect::<Vec<_>>();
                let content_length: usize = headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.trim().parse().ok())
                    .unwrap_or(0);
                if content_length > MAX_BODY_BYTES {
                    return None;
                }
                let mut body = buf[head_len..].to_vec();
                while body.len() < content_length {
                    let n = stream.read(&mut chunk).ok()?;
                    if n == 0 {
                        return None;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                body.truncate(content_length);
                return Some(RawRequest {
                    method,
                    path,
                    headers,
                    body,
                });
            }
            Ok(httparse::Status::Partial) => {
                if buf.len() > MAX_HEAD_BYTES {
                    return None;
                }
                let n = stream.read(&mut chunk).ok()?;
                if n == 0 {
                    return None;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return None,
        }
    }
}

/// The door itself (AC2/AC3/AC6/AC8): parses the credential, refuses a
/// self-asserted caller kind, parses argv, resolves the full command name
/// and its category, checks the caller kind's allow-list BEFORE dispatch,
/// rewrites the deck-id argument to the credential's own workbench id
/// (never the caller's), runs it through `cli::run_argv_to`, and frames
/// the result — redacting real filesystem paths for an agent credential
/// only (AC9).
fn handle_call(request: &RawRequest, stream: &mut TcpStream) {
    if request.has_header(credential::CALLER_KIND_HEADER) {
        // The caller asserted its own kind directly — never believed, and
        // refused outright rather than merely ignored (AC3): the id this
        // header might otherwise be confused for is a legacy field, but a
        // caller-kind assertion can only be an attempt to be believed.
        write_plain_response(
            stream,
            400,
            "caller kind must not be asserted by the request",
        );
        return;
    }

    let credential = match credential::parse(&request.headers) {
        Ok(credential) => credential,
        Err(CredentialError::Unauthorized) => {
            write_plain_response(stream, 401, "unauthorized");
            return;
        }
    };

    let argv_header = match request.header(ARGV_HEADER) {
        Some(value) => value,
        None => {
            write_plain_response(stream, 400, "missing or invalid argv header");
            return;
        }
    };
    let argv = match parse_argv_header(argv_header) {
        Some(argv) if !argv.is_empty() => argv,
        _ => {
            write_plain_response(stream, 400, "missing or invalid argv header");
            return;
        }
    };

    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let Some((name, consumed)) = resolve_full_command(&argv_refs) else {
        write_plain_response(stream, 403, "command not recognised");
        return;
    };
    let category = category_for(name);

    if !allowlist::is_allowed(credential.kind, name, category) {
        write_plain_response(stream, 403, "command outside this caller's allow-list");
        return;
    }

    // The editing-lock floor (NOOP-641 Plan §裁示1): a non-agent credential
    // may not mutate this workbench's deck while an agent turn holds it —
    // mirrors `editing-lock.ts`'s own gate, previously applied inline at
    // `command-endpoint.ts`/`asset-upload.ts`/`save-state.ts`. The agent's
    // OWN writes are never checked here: by the time one of its commands
    // reaches this door, its turn has already called `POST /editing/
    // agent-begin` (which itself waited out any human lease), so the floor
    // is already correctly held.
    if let Some(Category::DeckScoped { mutates: true, .. }) = category {
        if credential.kind != CallerKind::Agent && editing_lock::is_frozen(&credential.workbench_id)
        {
            write_plain_response(stream, 409, "The agent is currently editing, please wait.");
            return;
        }
    }

    // AC8: the workbench identifier comes from the credential, never from
    // the request — whatever the caller put at the deck-id argv slot is
    // discarded and overwritten, exactly like `command-endpoint.ts:259`'s
    // `{ ...input, id: presentationId }`.
    let mut argv = argv;
    if let Some(Category::DeckScoped { deck_id_arg, .. }) = category {
        let slot = consumed + deck_id_arg;
        if slot >= argv.len() {
            write_plain_response(stream, 400, "argv too short for this command's id argument");
            return;
        }
        argv[slot] = credential.workbench_id.clone();
    }

    let osv: Vec<OsString> = argv.iter().map(OsString::from).collect();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut stdin = Cursor::new(request.body.clone());
    let exit_code = cli::run_argv_to(&osv, &mut out, &mut err, &mut stdin);

    if credential.kind == CallerKind::Agent {
        redact::redact_real_paths(&mut out);
        redact::redact_real_paths(&mut err);
    }

    write_frame_response(stream, &out, &err, exit_code);
}

fn category_for(name: &str) -> Option<Category> {
    crate::commands::category::category_of(name)
}

/// Decodes the argv header exactly like `shim-endpoint.ts`'s own
/// `parseArgvHeader`: base64 of a JSON array of one or more strings.
/// Never repairs or drops a bad element — any failure is the whole
/// request's failure.
fn parse_argv_header(value: &str) -> Option<Vec<String>> {
    let decoded = decode_base64(value)?;
    let parsed: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let array = parsed.as_array()?;
    let mut argv = Vec::with_capacity(array.len());
    for entry in array {
        argv.push(entry.as_str()?.to_string());
    }
    Some(argv)
}

/// Standard base64 (RFC 4648 §4) decoder — shared by the argv header here
/// and the credential header (`credential.rs`). `crate::base64` only ever
/// needed an encoder before this ticket (`--json`'s `content` field), so
/// this is new, not a duplicate of an existing decoder.
pub(crate) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let trimmed = input.trim_end_matches('=');
    if trimmed.is_empty() && !input.is_empty() {
        return Some(Vec::new());
    }
    let mut bits: u32 = 0;
    let mut bit_count = 0u32;
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4 + 1);
    for byte in trimmed.bytes() {
        let v = value(byte)?;
        bits = (bits << 6) | v as u32;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    Some(out)
}

fn write_plain_response(stream: &mut TcpStream, status: u16, message: &str) {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

/// Writes the 200 response: `Connection: close`, no `Content-Length`
/// (plan §7.2 — the body's true length is only known once framing ends),
/// stdout/stderr framed as they were produced, exit code last. Byte-exact
/// for binary payloads and payloads over one megabyte (AC4): frames carry
/// raw bytes, never re-encoded.
fn write_frame_response(stream: &mut TcpStream, out: &[u8], err: &[u8], exit_code: i32) {
    let head =
        "HTTP/1.1 200 OK\r\nConnection: close\r\ncontent-type: application/octet-stream\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    // 64 KiB frames (plan §4's contract row): large output is chunked on
    // the way out, and the shim client's job is to concatenate the
    // payloads back into one stream — never a size limit on the total.
    const CHUNK: usize = 64 * 1024;
    for chunk in out.chunks(CHUNK.max(1)).filter(|c| !c.is_empty()) {
        if write_frame(stream, FRAME_STDOUT, chunk).is_err() {
            return;
        }
    }
    for chunk in err.chunks(CHUNK.max(1)).filter(|c| !c.is_empty()) {
        if write_frame(stream, FRAME_STDERR, chunk).is_err() {
            return;
        }
    }
    let _ = write_exit_frame(stream, exit_code);
}

fn write_frame(stream: &mut TcpStream, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..5].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    stream.write_all(&header)?;
    stream.write_all(payload)
}

fn write_exit_frame(stream: &mut TcpStream, exit_code: i32) -> std::io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = FRAME_EXIT;
    header[1..5].copy_from_slice(&exit_code.to_be_bytes());
    stream.write_all(&header)
}

/// Test-only helper, but NOT `#[cfg(test)]`: `tests/server_door.rs` is an
/// external integration test crate linking this library as a normal
/// dependency, so it never sees anything gated on THIS crate's own `cfg
/// (test)` (that flag is only set while testing this crate itself, not
/// while compiling something that merely depends on it). Exposing this
/// one small helper unconditionally is the trade-off — the alternative
/// (a Cargo `[dev-dependencies]`-only helper crate, or a Cargo feature
/// flag) is a bigger change to the manifest than this ticket's "minimal
/// changes to `Cargo.toml`" scope covers.
pub mod test_support {
    use super::*;
    use std::net::SocketAddr;

    /// Binds an ephemeral port and serves in a background thread for the
    /// lifetime of the test process — used by this module's own unit
    /// tests and by `tests/server_door.rs`'s in-process cases. The real
    /// subprocess case (AC10) spawns the compiled binary directly instead
    /// (see that file), so this helper is not the only way the server is
    /// exercised.
    pub fn spawn_test_server() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        std::thread::spawn(move || {
            serve_forever(listener);
        });
        addr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_base64_round_trips_with_crate_encoder() {
        let bytes = b"hello world, this is a test payload!";
        let encoded = crate::base64::encode(bytes);
        assert_eq!(decode_base64(&encoded).unwrap(), bytes);
    }

    #[test]
    fn decode_base64_rejects_invalid_input() {
        assert_eq!(decode_base64("not valid base64!!"), None);
    }

    #[test]
    fn parse_argv_header_rejects_non_array_json() {
        let encoded = crate::base64::encode(b"\"just a string\"");
        assert_eq!(parse_argv_header(&encoded), None);
    }

    #[test]
    fn parse_argv_header_rejects_empty_array() {
        let encoded = crate::base64::encode(b"[]");
        // An empty array decodes fine but `handle_call` treats it as
        // invalid (mirrors `shim-endpoint.ts`'s own non-empty requirement)
        // — checked at the call site, not here.
        assert_eq!(parse_argv_header(&encoded).unwrap().len(), 0);
    }

    #[test]
    fn parse_argv_header_accepts_a_string_array() {
        let encoded = crate::base64::encode(br#"["cat","pid123"]"#);
        assert_eq!(
            parse_argv_header(&encoded).unwrap(),
            vec!["cat".to_string(), "pid123".to_string()]
        );
    }
}
