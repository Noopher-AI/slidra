// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `CommandResult` and stdout/stderr rendering, ported from the contract
//! `packages/cli/src/bin.ts` `main()` implements (see NOOP-277 plan, section
//! 4.3). This is the single place that decides what bytes reach stdout/
//! stderr and what the process exit code is for every Rust-dispatched
//! command — F3–F6 build their commands on top of this, not on top of
//! `println!` directly, so that the EPIPE and `--json` handling stays in one
//! place.

use crate::errors::SlidraError;
use serde::Serialize;
use std::io::{self, ErrorKind, Write};

/// Serializes to `"not-found"` / `"failed"` for the `--json` envelope.
/// Mirrors the two `SlidraError` variants (errors.rs) but only exists on
/// `CommandResult` because the *shape* the HTTP layer (`serve`) needs a
/// discriminator for is a rendering concern, not an error-propagation one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    NotFound,
    Failed,
}

impl FailureKind {
    fn as_str(self) -> &'static str {
        match self {
            FailureKind::NotFound => "not-found",
            FailureKind::Failed => "failed",
        }
    }
}

pub struct CommandResult {
    pub ok: bool,
    pub data: Option<serde_json::Value>,
    pub message: String,
    pub failure_kind: Option<FailureKind>,
}

impl CommandResult {
    pub fn success(message: impl Into<String>, data: Option<serde_json::Value>) -> Self {
        CommandResult {
            ok: true,
            data,
            message: message.into(),
            failure_kind: None,
        }
    }

    pub fn failure(message: impl Into<String>, failure_kind: FailureKind) -> Self {
        CommandResult {
            ok: false,
            data: None,
            message: message.into(),
            failure_kind: Some(failure_kind),
        }
    }

    /// Converts a `SlidraError` straight into a failed `CommandResult` —
    /// `NotFound` maps to `FailureKind::NotFound`, `InvalidRequest` to
    /// `FailureKind::Failed`. [E4.T5] introduces this: `undo.rs`/`redo.rs`
    /// (this crate's only commands before this ticket) each carry their own
    /// private copy of this exact mapping, tolerable at two call sites; this
    /// ticket's ~29 command handlers all need the identical conversion, so
    /// it is a shared method here rather than a function duplicated into
    /// every handler file. `undo.rs`/`redo.rs` are left as they are — this
    /// is new plumbing for new code, not a refactor of existing files.
    pub fn from_error(err: &SlidraError) -> Self {
        let kind = match err {
            SlidraError::NotFound(_) => FailureKind::NotFound,
            SlidraError::InvalidRequest(_) => FailureKind::Failed,
        };
        CommandResult::failure(err.message().to_string(), kind)
    }
}

/// A renderer turns `data` into raw bytes written verbatim to stdout (no
/// trailing newline added — `process.stdout.write` in the TS original does
/// not add one either). Only commands that had a renderer in the TS registry
/// get one here; `undo`/`redo` (this ticket's only takeover-table entries)
/// have none, so `render()` is exercised on the no-renderer path only until
/// F3 adds commands that do.
pub type Renderer<'a> = &'a dyn Fn(&serde_json::Value) -> Vec<u8>;

/// Renders `result` to the real process stdout/stderr per the contract in
/// plan section 4.3 and returns the process exit code. `json_flag` is only
/// meaningful for takeover-table commands (`--json`); `serve`/`export`
/// never call this function with `json_flag: true` because `node_entry::
/// exec_node` passes argv through untouched and never parses Rust-side
/// flags at all.
///
/// A thin wrapper over `render_to` ([S11.F2]: the deck server needs the
/// exact same rendering logic to produce bytes for an HTTP response
/// instead of the real stdio streams it is writing to here — `cli.rs` is
/// the only other caller of `render_to`, and it is always this function
/// that the CLI binary itself calls).
pub fn render(result: &CommandResult, renderer: Option<Renderer<'_>>, json_flag: bool) -> i32 {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let stderr = io::stderr();
    let mut err = stderr.lock();
    render_to(&mut out, &mut err, result, renderer, json_flag)
}

/// Same contract as `render`, writing to `out`/`err` instead of assuming
/// the real process streams — `out` gets the EPIPE -> exit-0 treatment
/// `write_bytes`/`exit_code_for_write_error` below implement; `err` does
/// not (mirrors the pre-refactor code, which only ever special-cased a
/// stdout write failure, never a bare `eprintln!`).
pub fn render_to(
    out: &mut dyn Write,
    err: &mut dyn Write,
    result: &CommandResult,
    renderer: Option<Renderer<'_>>,
    json_flag: bool,
) -> i32 {
    if json_flag {
        return render_json_to(out, result);
    }

    if !result.ok {
        let _ = writeln!(err, "{}", result.message);
        return 1;
    }

    if let (Some(renderer), Some(data)) = (renderer, result.data.as_ref()) {
        let bytes = renderer(data);
        return write_bytes(out, &bytes);
    }

    match write_line(out, &result.message) {
        ExitOrContinue::Exit(code) => return code,
        ExitOrContinue::Continue => {}
    }

    if let Some(data) = result.data.as_ref() {
        // serde_json's `to_string_pretty` uses a 2-space indent by default,
        // matching `JSON.stringify(data, null, 2)` (confirmed against a
        // golden fixture in tests/unit_golden.rs — see plan 4.3).
        let pretty = serde_json::to_string_pretty(data).expect("Value serialization cannot fail");
        return match write_line(out, &pretty) {
            ExitOrContinue::Exit(code) => code,
            ExitOrContinue::Continue => 0,
        };
    }

    0
}

/// `docs/spec/cli.md`'s `--json` envelope shape (plan §4.1/D10): single-line
/// compact JSON, field order `ok, data, message, failureKind`, and `data`/
/// `failureKind` omitted entirely (not `null`) when absent — never
/// `to_string_pretty`, which is reserved for the non-`--json` path's `data`
/// dump (see `render` above).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonEnvelope<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a serde_json::Value>,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_kind: Option<&'static str>,
}

fn render_json_to(out: &mut dyn Write, result: &CommandResult) -> i32 {
    let envelope = JsonEnvelope {
        ok: result.ok,
        data: result.data.as_ref(),
        message: &result.message,
        failure_kind: result.failure_kind.map(FailureKind::as_str),
    };
    let compact = serde_json::to_string(&envelope).expect("Value serialization cannot fail");
    match write_line(out, &compact) {
        ExitOrContinue::Exit(code) => code,
        ExitOrContinue::Continue => 0,
    }
}

enum ExitOrContinue {
    Exit(i32),
    Continue,
}

/// Writes `line` followed by `\n` to `out`. On EPIPE this is treated as
/// success (exit 0), matching `bin/slidra.js`'s
/// `process.stdout.on("error", ...)` handler, which is installed only on
/// the one-shot (non-`serve`) branch — this module is never used to render
/// `serve`/`export` output (those always exec Node, see node_entry.rs), so
/// mirroring only the one-shot handler here is correct, not a partial port.
fn write_line(out: &mut dyn Write, line: &str) -> ExitOrContinue {
    if let Err(err) = writeln!(out, "{line}") {
        return ExitOrContinue::Exit(exit_code_for_write_error(&err));
    }
    ExitOrContinue::Continue
}

fn write_bytes(out: &mut dyn Write, bytes: &[u8]) -> i32 {
    if let Err(err) = out.write_all(bytes) {
        return exit_code_for_write_error(&err);
    }
    0
}

fn exit_code_for_write_error(err: &io::Error) -> i32 {
    if err.kind() == ErrorKind::BrokenPipe {
        0
    } else {
        eprintln!("{err}");
        1
    }
}
