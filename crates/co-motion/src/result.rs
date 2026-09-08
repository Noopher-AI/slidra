//! `CommandResult` and stdout/stderr rendering, ported from the contract
//! `packages/cli/src/bin.ts` `main()` implements (see NOOP-277 plan, section
//! 4.3). This is the single place that decides what bytes reach stdout/
//! stderr and what the process exit code is for every Rust-dispatched
//! command — F3–F6 build their commands on top of this, not on top of
//! `println!` directly, so that the EPIPE and `--json` handling stays in one
//! place.

use serde::Serialize;
use std::io::{self, ErrorKind, Write};

/// Serializes to `"not-found"` / `"failed"` for the `--json` envelope.
/// Mirrors the two `CoMotionError` variants (errors.rs) but only exists on
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
        CommandResult { ok: true, data, message: message.into(), failure_kind: None }
    }

    pub fn failure(message: impl Into<String>, failure_kind: FailureKind) -> Self {
        CommandResult { ok: false, data: None, message: message.into(), failure_kind: Some(failure_kind) }
    }
}

/// A renderer turns `data` into raw bytes written verbatim to stdout (no
/// trailing newline added — `process.stdout.write` in the TS original does
/// not add one either). Only commands that had a renderer in the TS registry
/// get one here; `undo`/`redo` (this ticket's only takeover-table entries)
/// have none, so `render()` is exercised on the no-renderer path only until
/// F3 adds commands that do.
pub type Renderer<'a> = &'a dyn Fn(&serde_json::Value) -> Vec<u8>;

/// Renders `result` to stdout/stderr per the contract in plan section 4.3
/// and returns the process exit code. `json_flag` is only meaningful for
/// takeover-table commands (`--json`); the fallback path never calls this
/// function with `json_flag: true` because it doesn't parse Rust-side flags
/// at all (see fallback.rs).
pub fn render(result: &CommandResult, renderer: Option<Renderer<'_>>, json_flag: bool) -> i32 {
    if json_flag {
        return render_json(result);
    }

    if !result.ok {
        eprintln!("{}", result.message);
        return 1;
    }

    if let (Some(renderer), Some(data)) = (renderer, result.data.as_ref()) {
        let bytes = renderer(data);
        return write_stdout(&bytes);
    }

    match write_stdout_line(&result.message) {
        ExitOrContinue::Exit(code) => return code,
        ExitOrContinue::Continue => {}
    }

    if let Some(data) = result.data.as_ref() {
        // serde_json's `to_string_pretty` uses a 2-space indent by default,
        // matching `JSON.stringify(data, null, 2)` (confirmed against a
        // golden fixture in tests/unit_golden.rs — see plan 4.3).
        let pretty = serde_json::to_string_pretty(data).expect("Value serialization cannot fail");
        return match write_stdout_line(&pretty) {
            ExitOrContinue::Exit(code) => code,
            ExitOrContinue::Continue => 0,
        };
    }

    0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonEnvelope<'a> {
    ok: bool,
    data: &'a Option<serde_json::Value>,
    message: &'a str,
    failure_kind: Option<&'static str>,
}

fn render_json(result: &CommandResult) -> i32 {
    let envelope = JsonEnvelope {
        ok: result.ok,
        data: &result.data,
        message: &result.message,
        failure_kind: result.failure_kind.map(FailureKind::as_str),
    };
    let pretty = serde_json::to_string_pretty(&envelope).expect("Value serialization cannot fail");
    match write_stdout_line(&pretty) {
        ExitOrContinue::Exit(code) => code,
        ExitOrContinue::Continue => 0,
    }
}

enum ExitOrContinue {
    Exit(i32),
    Continue,
}

/// Writes `line` followed by `\n` to stdout. On EPIPE this is treated as
/// success (exit 0), matching `bin/co-motion.js`'s
/// `process.stdout.on("error", ...)` handler, which is installed only on
/// the one-shot (non-`serve`) branch — this module is never used to render
/// `serve`/`export` output (those always exec Node, see fallback.rs), so
/// mirroring only the one-shot handler here is correct, not a partial port.
fn write_stdout_line(line: &str) -> ExitOrContinue {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if let Err(err) = writeln!(handle, "{line}") {
        return ExitOrContinue::Exit(exit_code_for_write_error(&err));
    }
    ExitOrContinue::Continue
}

fn write_stdout(bytes: &[u8]) -> i32 {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if let Err(err) = handle.write_all(bytes) {
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
