// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The one argv executor shared by the CLI binary and the deck server
//! ([S11.F2] Plan §3/§7.5: "`cli.rs` is the CLI and server's shared, only
//! argv executor; the server must never re-recognise a command name
//! itself"). This is `main.rs`'s pre-[S11.F2] `dispatch` body (the family/
//! legacy takeover-table matching and both dispatch helpers, plus the
//! stdin-substitution and presentation-lock helpers those dispatch
//! functions call), moved here verbatim except for two things:
//!
//! - `--version`/`-V` and `serve`/`export` are NOT here — those two names
//!   still exec Node (`node_entry.rs`, untouched, [E10.T9]'s job) or print
//!   a version string, and `main.rs` keeps that little slice of `dispatch`
//!   itself, calling `cli::run_argv` only for everything else.
//! - Every function that used to write straight to the real process
//!   stdout/stderr/stdin now takes `out`/`err`/`stdin` as trait objects,
//!   so the exact same code produces either the CLI's real process bytes
//!   (`run_argv`, called only from `main.rs`) or the deck server's HTTP
//!   response frames (`run_argv_to`, called only from `server::dispatch`).

use std::ffi::OsString;
use std::io::{self, Read, Write};

use crate::commands;
use crate::result::{self, Renderer};
use crate::workspace::lock::PresentationLock;

/// Runs `argv` (already stripped of argv[0] — the binary name — by
/// whichever caller built it) against the real process's own stdout/
/// stderr/stdin. The CLI binary's only entry point into this module.
pub fn run_argv(argv: &[OsString]) -> i32 {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let stderr = io::stderr();
    let mut err = stderr.lock();
    let stdin = io::stdin();
    let mut input = stdin.lock();
    run_argv_to(argv, &mut out, &mut err, &mut input)
}

/// Same contract as `run_argv`, writing to/reading from `out`/`err`/`stdin`
/// instead of assuming the real process streams — the deck server's own
/// entry point (`server::dispatch`), which has no real child process to
/// speak of (AC1: no deck call is executed by spawning one) and instead
/// passes byte buffers it will go on to frame into an HTTP response.
pub fn run_argv_to(
    argv: &[OsString],
    out: &mut dyn Write,
    err: &mut dyn Write,
    stdin: &mut dyn Read,
) -> i32 {
    let Some(first) = argv.first() else {
        let _ = writeln!(err, "missing command name");
        return 1;
    };

    // Non-UTF-8 argv[0] can never match a takeover-table name (all of
    // which are ASCII), so it always falls through to the final "unknown
    // command" branch below — untouched, no lossy conversion performed on
    // it until it is actually printed.
    let str_tokens: Vec<&str> = argv.iter().map(|arg| arg.to_str().unwrap_or("")).collect();
    if let Some(matched) = commands::resolve_takeover(&str_tokens) {
        return dispatch_family_takeover(matched, &argv[matched.len()..], out, err, stdin);
    }

    // Legacy (predecessor) mechanism: probe the first one or two argv
    // tokens against `TAKEOVER_TABLE` — a two-word command like `effect
    // add` needs both tokens to be valid UTF-8 to match at all. Only
    // reached once the family mechanism above has already declined to
    // match — the two tables' first-token sets are disjoint, so there is
    // no ordering ambiguity.
    if let Some(first_str) = first.to_str() {
        let second_str = argv.get(1).and_then(|arg| arg.to_str());
        let probe: Vec<&str> = match second_str {
            Some(second) => vec![first_str, second],
            None => vec![first_str],
        };
        if let Some((command, consumed)) = commands::match_takeover(&probe) {
            return dispatch_legacy_takeover(command, &argv[consumed..], out, err, stdin);
        }
    }

    let _ = writeln!(err, "unknown command: {}", first.to_string_lossy());
    1
}

/// Runs a family-mechanism takeover-table command's handler and renders
/// its `CommandResult`. `rest` is `argv` with the matched command-name
/// tokens already stripped off.
///
/// `--json` is a Rust-only flag: meaningful only here, stripped from the
/// positional arguments the command handler sees, and never forwarded to
/// Node.
fn dispatch_family_takeover(
    tokens: commands::CommandTokens,
    rest: &[OsString],
    out: &mut dyn Write,
    err: &mut dyn Write,
    _stdin: &mut dyn Read,
) -> i32 {
    let mut json_flag = false;
    let mut positional: Vec<String> = Vec::new();
    for arg in rest {
        match arg.to_str() {
            Some("--json") => json_flag = true,
            Some(s) => positional.push(s.to_string()),
            // A non-UTF-8 extra positional argument here would be ignored
            // by undo/redo anyway (only args[0], the id, is read) —
            // lossy-converting it rather than erroring keeps that
            // "ignored" behavior intact instead of turning a harmless
            // extra argument into a crash.
            None => positional.push(arg.to_string_lossy().into_owned()),
        }
    }

    let _lock = match hold_presentation_lock(&positional, err) {
        Ok(lock) => lock,
        Err(code) => return code,
    };
    let command_result = commands::dispatch(tokens, &positional);

    // No command registered here (or `undo`/`redo`) has a renderer — only
    // `cat`-shaped commands get a raw-bytes renderer, and this family
    // registers none of those.
    result::render_to(out, err, &command_result, None, json_flag)
}

/// Runs a legacy-mechanism (predecessor) takeover-table command's handler
/// and renders its `CommandResult`.
///
/// `--json` is recognised ONLY as the LAST token of `rest` — several
/// commands take free-text as their final positional (`slide notes set`'s
/// `text`, `template rename`'s `new-name`) and those may legitimately
/// equal the literal string `"--json"`.
fn dispatch_legacy_takeover(
    command: &str,
    rest: &[OsString],
    out: &mut dyn Write,
    err: &mut dyn Write,
    stdin: &mut dyn Read,
) -> i32 {
    let mut positional: Vec<String> = rest
        .iter()
        .map(|arg| {
            arg.to_str()
                .map(str::to_string)
                .unwrap_or_else(|| arg.to_string_lossy().into_owned())
        })
        .collect();
    let json_flag = positional.last().map(String::as_str) == Some("--json");
    if json_flag {
        positional.pop();
    }

    // `chat-history` is deliberately exempt from the per-deck advisory
    // lock every other command here takes — see the pre-[S11.F2] main.rs
    // history for the full rationale (SQLite's own per-transaction file
    // locking already keeps concurrent `chat_history` writers from
    // corrupting each other).
    let _lock = if command == "chat-history" {
        None
    } else {
        match hold_presentation_lock(&positional, err) {
            Ok(lock) => lock,
            Err(code) => return code,
        }
    };

    let (command_result, renderer): (crate::result::CommandResult, Option<Renderer<'_>>) =
        match command {
            "undo" => (commands::undo::run(&positional), None),
            "redo" => (commands::redo::run(&positional), None),
            "chart" => {
                let stdin_csv = maybe_read_stdin_csv(&positional, stdin);
                (commands::chart::run(&positional, stdin_csv), None)
            }
            "table" => (commands::table::run(&positional), None),
            "asset" => (dispatch_asset(&positional), None),
            "font" => (commands::font::run(&positional), None),
            "effect add" => (commands::effect::add(&positional), None),
            "effect list" => (commands::effect::list(&positional), None),
            "effect move" => (commands::effect::move_cmd(&positional), None),
            "effect remove" => (commands::effect::remove(&positional), None),
            "effect set" => (commands::effect::set(&positional), None),
            "new" => (commands::new::run(&positional), None),
            "open" => (commands::open::run(&positional), None),
            "pack" => (commands::pack::run(&positional), None),
            "extract" => (commands::extract::run(&positional), None),
            "convert" => (commands::convert::run(&positional), None),
            "presentation" => (commands::presentation::run(&positional), None),
            "template" => (commands::template::run(&positional), None),
            "plan" => (commands::plan::run(&positional), None),
            "validate" => (commands::validate::run(&positional), None),
            "ls" => (
                commands::ls::run(&positional),
                Some(&commands::ls::render as Renderer<'_>),
            ),
            "cat" => (
                commands::cat::run(&positional, json_flag),
                Some(&commands::cat::render as Renderer<'_>),
            ),
            "chat-history" => {
                let stdin_body = maybe_read_stdin_chat_history(&positional, stdin);
                (commands::chat_history::run(&positional, stdin_body), None)
            }
            "slide" => {
                let renderer: Option<Renderer<'_>> =
                    if positional.first().map(String::as_str) == Some("render") {
                        Some(&commands::slide::render as Renderer<'_>)
                    } else {
                        None
                    };
                (commands::slide::run(&positional, json_flag), renderer)
            }
            _ => unreachable!(
                "commands::match_takeover only returns TAKEOVER_TABLE entries, all handled above"
            ),
        };

    let code = result::render_to(out, err, &command_result, renderer, json_flag);
    // `validate` with findings exits 1 after rendering its full report:
    // the report is the point, so it is printed like any success, and the
    // exit code tells a script/agent "there are errors" — the same
    // "non-zero is a result, not a fault" convention `effect list` uses.
    if command == "validate" && code == 0 && commands::validate::has_findings(&command_result) {
        return 1;
    }
    code
}

/// Serialises every invocation that names a presentation: the
/// presentation id is the first positional after the command tokens for
/// most commands and the second/third for sub-verb families, so the first
/// three positionals are tried against the registry and the first one
/// that resolves is the presentation. `Err(code)` is the exit code to
/// return after the timeout message has been written to `err`.
fn hold_presentation_lock(
    positional: &[String],
    err: &mut dyn Write,
) -> Result<Option<PresentationLock>, i32> {
    for candidate in positional.iter().take(3) {
        if candidate.starts_with("--") {
            continue;
        }
        let Ok(work_dir) = crate::workspace::resolve_work_dir(candidate) else {
            continue;
        };
        return match PresentationLock::acquire(&work_dir) {
            Ok(lock) => Ok(Some(lock)),
            Err(lock_err) => {
                let _ = writeln!(err, "{}", lock_err.message());
                Err(1)
            }
        };
    }
    Ok(None)
}

/// `chart data set --csv -`'s stdin substitution: `cli.md` requires this
/// to happen at the process entry layer (here), never inside argv
/// parsing. Scans for a literal `--csv` immediately followed by `-`
/// anywhere in `positional`. Reads ALL of `stdin` as UTF-8; a read
/// failure (not valid UTF-8, or genuinely empty with no data available)
/// is treated as "no stdin substitution" and left to `commands::chart::
/// run`'s own "--csv - can only be used from the command line" fallback
/// rather than surfacing a raw I/O error here.
fn maybe_read_stdin_csv(positional: &[String], stdin: &mut dyn Read) -> Option<String> {
    let has_csv_dash = positional
        .windows(2)
        .any(|pair| pair[0] == "--csv" && pair[1] == "-");
    if !has_csv_dash {
        return None;
    }
    let mut buf = String::new();
    stdin.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// `chat-history --append -`'s stdin substitution: the same entry-layer
/// technique `maybe_read_stdin_csv` uses for `chart data set --csv -`,
/// for the identical reason.
fn maybe_read_stdin_chat_history(positional: &[String], stdin: &mut dyn Read) -> Option<String> {
    let has_append_dash = positional
        .windows(2)
        .any(|pair| pair[0] == "--append" && pair[1] == "-");
    if !has_append_dash {
        return None;
    }
    let mut buf = String::new();
    stdin.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// `asset`'s only subcommand is `import` — `docs/spec/cli.md`'s "asset"
/// section states any other value reports "unknown subcommand: asset
/// <x>".
fn dispatch_asset(positional: &[String]) -> result::CommandResult {
    match positional.first() {
        Some(first) if first == "import" => commands::asset_import::run(&positional[1..]),
        other => result::CommandResult::failure(
            format!(
                "unknown subcommand: asset {}",
                other.map(String::as_str).unwrap_or("")
            ),
            result::FailureKind::Failed,
        ),
    }
}
