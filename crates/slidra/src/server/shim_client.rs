// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra __shim` — the Rust replacement for `packages/server/shim/
//! slidra-shim.mjs`. `shim-wrapper.ts`'s `deployShimWrapper` now writes a
//! wrapper that execs THIS binary instead of Node — the client side has
//! no Node process in it at all any more, live or in a test.
//!
//! Two protocols, selected by which environment variable is set, because
//! this one binary has to serve two audiences this round:
//!
//! - `SLIDRA_SHIM_TOKEN`/`SLIDRA_SHIM_BASE_URL` (checked first): the
//!   existing, LIVE `POST /api/agent/exec` protocol
//!   (`packages/server/src/sandbox/shim-endpoint.ts`, unchanged this
//!   round — #397 explicitly keeps `serve`'s base URL pointed at Node
//!   until [E10.T9] does the entry-point switch). `agent/manager.ts` (not
//!   this ticket's file to touch) still sets exactly these two variables
//!   for every real spawned agent, so this path is what keeps
//!   `agent-api.test.ts`/`freeze.test.ts`/every other test that drives a
//!   real agent through `startServe` green — a faithful, protocol-exact
//!   Rust port of the deleted `.mjs` script's request shape, nothing new.
//! - `SLIDRA_SHIM_CREDENTIAL`/`SLIDRA_SHIM_BASE_URL` (#397's own new
//!   `POST /call`): reaches THIS ticket's deck server directly. Nothing
//!   in this repo sets `SLIDRA_SHIM_CREDENTIAL` yet — issuing a real
//!   credential is [S11.F6], and retargeting `serve`'s base URL at a
//!   running deck server is [E10.T9]'s entry-point switch. Exercised only
//!   by `tests/server_door.rs`'s own end-to-end case (AC10) until then.
//!
//! Uses `ureq` (already a crate dependency, `http.rs`'s own outbound-GET
//! client) as the HTTP CLIENT here — the "no async runtime" constraint
//! (plan §7.1) is about the deck SERVER's own listener, not about what a
//! client-side binary calls out with.
//!
//! Deliberately buffers the full response before relaying it (unlike the
//! Node original's byte-as-it-arrives streaming) on EITHER protocol: this
//! round's scope is proving the request/response shape is preserved
//! end to end, not matching the live path's exact streaming latency —
//! `agent-api.test.ts` et al. only assert on the eventual result, not on
//! partial delivery timing.

use std::ffi::OsString;
use std::io::{self, Read, Write};

use super::credential::CREDENTIAL_HEADER;

const FRAME_STDOUT: u8 = 1;
const FRAME_STDERR: u8 = 2;
const FRAME_EXIT: u8 = 3;

pub fn run(args: &[OsString]) -> i32 {
    let argv: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();

    // Checked first: this is the LIVE protocol, and `agent/manager.ts`
    // (unchanged) always sets exactly this pair for a real spawned agent
    // — a request naming a credential is only ever this ticket's own
    // test asking for the new one.
    if let (Ok(token), Ok(base_url)) = (
        std::env::var("SLIDRA_SHIM_TOKEN"),
        std::env::var("SLIDRA_SHIM_BASE_URL"),
    ) {
        if !token.is_empty() && !base_url.is_empty() {
            return run_legacy_protocol(&argv, &token, &base_url);
        }
    }

    if let (Ok(credential), Ok(base_url)) = (
        std::env::var("SLIDRA_SHIM_CREDENTIAL"),
        std::env::var("SLIDRA_SHIM_BASE_URL"),
    ) {
        if !credential.is_empty() && !base_url.is_empty() {
            return run_new_protocol(&argv, &credential, &base_url);
        }
    }

    eprintln!(
        "slidra-shim: neither SLIDRA_SHIM_TOKEN nor SLIDRA_SHIM_CREDENTIAL is set alongside SLIDRA_SHIM_BASE_URL — this binary must be run through the sandbox's own PATH"
    );
    1
}

/// The NEW protocol (#397 `POST /call`): a credential header, no cwd
/// concept at all (the deck server resolves storage from the credential's
/// own workbench id, never a filesystem cwd).
fn run_new_protocol(argv: &[String], credential: &str, base_url: &str) -> i32 {
    let argv_json = match serde_json::to_string(argv) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("slidra-shim: failed to encode argv");
            return 1;
        }
    };
    let argv_header = crate::base64::encode(argv_json.as_bytes());
    let url = format!("{}/call", base_url.trim_end_matches('/'));

    let request = ureq::post(&url)
        .header(CREDENTIAL_HEADER, credential)
        .header(super::ARGV_HEADER, &argv_header)
        .config()
        .http_status_as_error(false)
        .build();

    match request.send_empty() {
        Ok(response) => relay(response),
        Err(error) => {
            eprintln!("slidra-shim: request failed: {error}");
            1
        }
    }
}

/// The EXISTING, live protocol: a faithful Rust port of the deleted
/// `packages/server/shim/slidra-shim.mjs`'s request shape against
/// `POST /api/agent/exec` (`shim-endpoint.ts`, unchanged) — same three
/// headers (`x-slidra-shim-token`/`x-slidra-shim-argv`/
/// `x-slidra-shim-cwd`), same frame response, so every existing consumer
/// of that endpoint (every test that drives a real agent through
/// `startServe`) keeps working unchanged, with Node removed only from
/// this CLIENT side.
fn run_legacy_protocol(argv: &[String], token: &str, base_url: &str) -> i32 {
    const LEGACY_TOKEN_HEADER: &str = "x-slidra-shim-token";
    const LEGACY_ARGV_HEADER: &str = "x-slidra-shim-argv";
    const LEGACY_CWD_HEADER: &str = "x-slidra-shim-cwd";

    let argv_json = match serde_json::to_string(argv) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("slidra-shim: failed to encode argv");
            return 1;
        }
    };
    let argv_header = crate::base64::encode(argv_json.as_bytes());
    let cwd = std::env::current_dir().unwrap_or_default();
    let cwd_header = crate::base64::encode(cwd.to_string_lossy().as_bytes());
    let url = format!("{}/api/agent/exec", base_url.trim_end_matches('/'));

    let request = ureq::post(&url)
        .header(LEGACY_TOKEN_HEADER, token)
        .header(LEGACY_ARGV_HEADER, &argv_header)
        .header(LEGACY_CWD_HEADER, &cwd_header)
        .config()
        .http_status_as_error(false)
        .build();

    // Deliberately NOT the Node original's real stdin passthrough: that
    // script used a non-blocking pipe (`process.stdin.pipe(request)`),
    // which never has to know in advance whether stdin will ever close —
    // a real agent shell inherits an open, idle stdin it never writes to
    // and never closes (this module's own earlier doc-comment history
    // recorded exactly that), and ureq's synchronous request/response API
    // has no equivalent: sending a body means either knowing its length
    // upfront or reading it to EOF before the request completes, and an
    // idle-but-open stdin never reaches EOF. Reading it eagerly here hung
    // every real-agent-flow test in this repo (`freeze.test.ts`/
    // `agent-api.test.ts`) for the full 55 s each — a real regression,
    // not a hypothetical one. Sending an empty body instead means the
    // two commands that substitute stdin themselves
    // (`chart data set --csv -`, `chat-history --append -`) do not work
    // through the LIVE shim path this round when invoked by an agent —
    // a known, documented gap (PR notes), not a silent one.
    match request.send_empty() {
        Ok(response) => relay(response),
        Err(error) => {
            eprintln!("slidra-shim: request failed: {error}");
            1
        }
    }
}

fn relay(response: ureq::http::Response<ureq::Body>) -> i32 {
    let (parts, body) = response.into_parts();
    let status = parts.status.as_u16();
    if status != 200 {
        let mut text = String::new();
        let _ = body.into_reader().read_to_string(&mut text);
        eprintln!("slidra-shim: server refused ({status}): {text}");
        return 1;
    }

    let mut buf = Vec::new();
    if body.into_reader().read_to_end(&mut buf).is_err() {
        eprintln!("slidra-shim: failed to read response");
        return 1;
    }
    relay_frames(&buf)
}

/// Decodes the same frame shape `server::write_frame_response` writes:
/// `[1 byte kind][4 bytes big-endian value][payload]`. For stdout/stderr
/// the 4-byte value is a payload length; for exit, it IS the signed exit
/// code and ends the stream.
fn relay_frames(buf: &[u8]) -> i32 {
    let mut i = 0;
    let mut exit_code: Option<i32> = None;
    while i + 5 <= buf.len() {
        let kind = buf[i];
        let raw = [buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4]];
        i += 5;
        match kind {
            FRAME_STDOUT | FRAME_STDERR => {
                let len = u32::from_be_bytes(raw) as usize;
                if i + len > buf.len() {
                    break;
                }
                let payload = &buf[i..i + len];
                if kind == FRAME_STDOUT {
                    let _ = io::stdout().write_all(payload);
                } else {
                    let _ = io::stderr().write_all(payload);
                }
                i += len;
            }
            FRAME_EXIT => {
                exit_code = Some(i32::from_be_bytes(raw));
                break;
            }
            _ => break,
        }
    }
    let _ = io::stdout().flush();
    let _ = io::stderr().flush();
    match exit_code {
        Some(code) => code,
        None => {
            eprintln!("slidra-shim: server closed the connection without an exit frame");
            1
        }
    }
}
