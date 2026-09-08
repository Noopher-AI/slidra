//! Entry point. Dispatch order (plan section 4.1) is hand-written here
//! rather than handed to `clap` for the whole argv: `co-motion`'s existing
//! (Node-side) commands accept a large surface of `--` flags (`--name`,
//! `--force`, `--series`, ...), and clap's default behaviour is to
//! intercept `--help`/`--version`/unknown-subcommand at any position and
//! print its own (English) error text — any one of those firing on a
//! fallback-bound argv would break byte-for-byte compatibility with the
//! Node CLI (acceptance criterion A2). clap's role here is limited to
//! parsing arguments *within* a takeover-table command's own handler — none
//! of that parsing goes through clap yet either: `undo`/`redo` take a
//! single positional id, and `effect add/remove/move/set/list`'s argv
//! parsing (`commands::effect`) is a direct, hand-written port of
//! `packages/cli/src/argv.ts`'s own hand-written parsing, not a clap
//! `Parser` derive — so clap still isn't invoked anywhere in this crate; it
//! stays a declared dependency for a future command that actually wants
//! it).

use std::env;
use std::ffi::OsString;

use co_motion::commands;
use co_motion::fallback;
use co_motion::result;

fn main() {
    let argv: Vec<OsString> = env::args_os().skip(1).collect();
    std::process::exit(dispatch(argv));
}

fn dispatch(argv: Vec<OsString>) -> i32 {
    let Some(first) = argv.first() else {
        // argv 為空（`co-motion`）— 回退 Node，讓它印「缺少命令名稱」並以
        // exit 1 結束，逐位元組對齊既有行為。
        return fallback::exec_node_fallback(&argv);
    };

    // Non-UTF-8 argv[0] can never match a takeover-table name (all of which
    // are ASCII) or "--version"/"serve"/"export", so it always falls
    // through to the final fallback call below — untouched, no lossy
    // conversion performed on it (plan 4.1's "非 UTF-8 位元組" row).
    if let Some(first_str) = first.to_str() {
        if first_str == "--version" || first_str == "-V" {
            // This is a deliberate, ticket-scoped behavior CHANGE from the
            // Node CLI (which has no --version and errors on it) — called
            // out explicitly in the PR's human verification checklist per
            // acceptance criterion A1.
            println!("co-motion {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }

        if first_str == "serve" || first_str == "export" {
            // Always falls back, even when arguments are missing/malformed
            // — Rust never pre-validates these, Node's own error path
            // (`runServeCli`/`runExportCli`) is the single source of truth
            // for their argument errors (plan 4.1).
            return fallback::exec_node_fallback(&argv);
        }

        // Probe the first one or two argv tokens against the takeover
        // table (plan 2.4): a two-word command like `effect add` needs
        // both tokens to be valid UTF-8 to match at all — a non-UTF-8
        // second token simply can't equal any (ASCII) table entry, so it
        // naturally falls through to the one-word probe, then to Node.
        let second_str = argv.get(1).and_then(|arg| arg.to_str());
        let probe: Vec<&str> = match second_str {
            Some(second) => vec![first_str, second],
            None => vec![first_str],
        };
        if let Some((command, consumed)) = commands::match_takeover(&probe) {
            return dispatch_takeover(command, &argv[consumed..]);
        }
    }

    fallback::exec_node_fallback(&argv)
}

/// Runs a takeover-table command's handler and renders its `CommandResult`.
/// `--json` is a Rust-only flag (plan 4.3): meaningful only here, stripped
/// from the positional arguments the command handler sees, and never
/// forwarded to Node (the fallback path above never parses or forwards
/// `--json` specially — if it reaches Node at all, Node reports its own
/// "unknown argument" error, which is correct: `--json` has no meaning
/// outside the takeover table).
fn dispatch_takeover(command: &str, rest: &[OsString]) -> i32 {
    let mut json_flag = false;
    let mut positional: Vec<String> = Vec::new();
    for arg in rest {
        match arg.to_str() {
            Some("--json") => json_flag = true,
            Some(s) => positional.push(s.to_string()),
            // A non-UTF-8 extra positional argument here would be ignored
            // by undo/redo anyway (only args[0], the id, is read — see
            // plan 4.1's "undo <id> extra" row) — lossy-converting it
            // rather than erroring keeps that "ignored" behavior intact
            // instead of turning a harmless extra argument into a crash.
            None => positional.push(arg.to_string_lossy().into_owned()),
        }
    }

    let command_result = match command {
        "undo" => commands::undo::run(&positional),
        "redo" => commands::redo::run(&positional),
        "effect add" => commands::effect::add(&positional),
        "effect list" => commands::effect::list(&positional),
        "effect move" => commands::effect::move_cmd(&positional),
        "effect remove" => commands::effect::remove(&positional),
        "effect set" => commands::effect::set(&positional),
        _ => unreachable!("commands::match_takeover only returns TAKEOVER_TABLE entries"),
    };

    // None of this ticket's takeover-table commands has a renderer (plan
    // 3.1 confirmed all five `effect` commands are `render: null` in the TS
    // registry, same as `undo`/`redo`) — `None` here is correct, not a
    // placeholder.
    result::render(&command_result, None, json_flag)
}
