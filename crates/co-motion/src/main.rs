//! Entry point. Dispatch order (plan section 4.1) is hand-written here
//! rather than handed to `clap` for the whole argv: `co-motion`'s existing
//! (Node-side) commands accept a large surface of `--` flags (`--name`,
//! `--force`, `--series`, ...), and clap's default behaviour is to
//! intercept `--help`/`--version`/unknown-subcommand at any position and
//! print its own (English) error text — any one of those firing on a
//! fallback-bound argv would break byte-for-byte compatibility with the
//! Node CLI (acceptance criterion A2). clap's role here is limited to
//! parsing arguments *within* a takeover-table command's own handler (none
//! of that parsing is needed yet — `undo`/`redo` take a single positional
//! id — so clap isn't invoked at all in this ticket; it stays a declared
//! dependency for F3+ commands to use).

use std::env;
use std::ffi::OsString;
use std::io::Read;

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

        if commands::is_in_takeover_table(first_str) {
            return dispatch_takeover(first_str, &argv[1..]);
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
        "chart" => {
            let stdin_csv = maybe_read_stdin_csv(&positional);
            commands::chart::run(&positional, stdin_csv)
        }
        "table" => commands::table::run(&positional),
        "asset" => dispatch_asset(&positional),
        _ => unreachable!("commands::is_in_takeover_table only admits the declared set"),
    };

    // None of undo/redo/chart/table/asset has a renderer (plan 3.2/4.3, and
    // cli.md's own "Renderer 命令" list names only `cat`/`ls`/`slide
    // render`) — `None` here is correct, not a placeholder.
    result::render(&command_result, None, json_flag)
}

/// `chart data set --csv -`'s stdin substitution: `cli.md` requires this to
/// happen at the process entry layer (here), never inside argv parsing,
/// since a future `serve` mode bypasses argv entirely. Scans for a literal
/// `--csv` immediately followed by `-` anywhere in `positional` — safe to
/// do unconditionally for every `chart` invocation because `--csv` is
/// unique to `chart data set` among all 8 chart subcommands, so this can
/// never misfire on an unrelated flag. Reads ALL of stdin as UTF-8; a
/// read failure (stdin not valid UTF-8, or genuinely empty with no data
/// available) is treated as "no stdin substitution" and left to
/// `commands::chart::run`'s own "--csv - 只能從命令列使用" fallback rather
/// than surfacing a raw I/O error here.
fn maybe_read_stdin_csv(positional: &[String]) -> Option<String> {
    let has_csv_dash = positional
        .windows(2)
        .any(|pair| pair[0] == "--csv" && pair[1] == "-");
    if !has_csv_dash {
        return None;
    }
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// `asset`'s only subcommand is `import` — `docs/spec/cli.md`'s "asset"
/// section (the same section that specifies `argv::asset::parse_import`'s
/// grammar) states any other value reports `未知的子命令：asset <x>`
/// (single token, unlike `chart`/`table`'s two-token unknown-subcommand
/// message — matching that section's literal wording).
fn dispatch_asset(positional: &[String]) -> result::CommandResult {
    match positional.first() {
        Some(first) if first == "import" => commands::asset_import::run(&positional[1..]),
        other => result::CommandResult::failure(
            format!(
                "未知的子命令：asset {}",
                other.map(String::as_str).unwrap_or("")
            ),
            result::FailureKind::Failed,
        ),
    }
}
