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
use co_motion::result::{self, Renderer};

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
/// `--json` is a Rust-only flag: meaningful only here, stripped from the
/// positional arguments the command handler sees, and never forwarded to
/// Node (the fallback path above never parses or forwards `--json`
/// specially — if it reaches Node at all, Node reports its own "unknown
/// argument" error, which is correct: `--json` has no meaning outside the
/// takeover table).
///
/// D9: `--json` is recognised ONLY as the LAST token of `rest` — a
/// deliberate change from this ticket's predecessor, which stripped it from
/// any position. Several commands take free-text as their final positional
/// (`slide notes set`'s `text`, `template rename`'s `new-name`) and those
/// may legitimately equal the literal string `"--json"`; `--json` itself is
/// a Rust-only flag with no TS-side byte-compatibility burden, so this
/// narrower rule is safe to adopt outright.
fn dispatch_takeover(command: &str, rest: &[OsString]) -> i32 {
    let mut positional: Vec<String> = rest
        .iter()
        .map(|arg| {
            arg.to_str().map(str::to_string).unwrap_or_else(|| {
                // A non-UTF-8 extra positional argument would be ignored by
                // most handlers anyway — lossy-converting it rather than
                // erroring keeps "ignored" behavior intact instead of
                // turning a harmless extra argument into a crash.
                arg.to_string_lossy().into_owned()
            })
        })
        .collect();
    let json_flag = positional.last().map(String::as_str) == Some("--json");
    if json_flag {
        positional.pop();
    }

    let (command_result, renderer): (co_motion::result::CommandResult, Option<Renderer<'_>>) =
        match command {
            "undo" => (commands::undo::run(&positional), None),
            "redo" => (commands::redo::run(&positional), None),
            "effect add" => (commands::effect::add(&positional), None),
            "effect list" => (commands::effect::list(&positional), None),
            "effect move" => (commands::effect::move_cmd(&positional), None),
            "effect remove" => (commands::effect::remove(&positional), None),
            "effect set" => (commands::effect::set(&positional), None),
            "new" => (commands::new::run(&positional), None),
            "open" => (commands::open::run(&positional), None),
            "pack" => (commands::pack::run(&positional), None),
            "convert" => (commands::convert::run(&positional), None),
            "presentation" => (commands::presentation::run(&positional), None),
            "template" => (commands::template::run(&positional), None),
            "ls" => (
                commands::ls::run(&positional),
                Some(&commands::ls::render as Renderer<'_>),
            ),
            "cat" => (
                commands::cat::run(&positional, json_flag),
                Some(&commands::cat::render as Renderer<'_>),
            ),
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

    result::render(&command_result, renderer, json_flag)
}
