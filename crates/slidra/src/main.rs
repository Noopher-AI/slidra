// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Entry point. Dispatch order (plan section 4.1) is hand-written here
//! rather than handed to `clap` for the whole argv: `slidra`'s existing
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
use std::io::Read;

use slidra::commands;
use slidra::node_entry;
use slidra::result::{self, Renderer};
use slidra::workspace::lock::PresentationLock;

fn main() {
    let argv: Vec<OsString> = env::args_os().skip(1).collect();
    std::process::exit(dispatch(argv));
}

fn dispatch(argv: Vec<OsString>) -> i32 {
    let Some(first) = argv.first() else {
        // argv is empty (`slidra`) — there is no coexistence-era fallback
        // left to hand off to, so Rust reports the error itself, matching
        // the existing wording byte-for-byte (originally printed by Node
        // for this exact message).
        eprintln!("missing command name");
        return 1;
    };

    // Non-UTF-8 argv[0] can never match a takeover-table name (all of which
    // are ASCII) or "--version"/"serve"/"export", so it always falls
    // through to the final "unknown command" branch below — untouched, no lossy
    // conversion performed on it until it is actually printed (plan 4.1's
    // "non-UTF-8 bytes" row).
    if let Some(first_str) = first.to_str() {
        if first_str == "--version" || first_str == "-V" {
            // This is a deliberate, ticket-scoped behavior CHANGE from the
            // Node CLI (which has no --version and errors on it) — called
            // out explicitly in the PR's human verification checklist per
            // acceptance criterion A1.
            println!("slidra {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }

        if first_str == "serve" || first_str == "export" {
            // The only two names that still exec Node — spec's "## Entry
            // point that bypasses the registry", not a coexistence-era
            // fallback. Always
            // taken even when arguments are missing/malformed — Rust never
            // pre-validates these, Node's own error path
            // (`runServeCli`/`runExportCli`) is the single source of truth
            // for their argument errors (plan 4.1/4.2).
            return node_entry::exec_node(&argv);
        }
    }

    // The family mechanism spans multiple tokens (`element move`,
    // `text style set`, ...), not just `argv[0]` — plan section 1.4. A
    // non-UTF-8 token can never equal any (ASCII) takeover-table entry, so
    // it is mapped to `""` here — a value no registered command token ever
    // is — rather than erroring or lossily converting: it simply fails to
    // match at that position and the whole argv falls through to the legacy
    // probe, then Node, untouched (plan 4.1's "non-UTF-8 bytes" row). This
    // view is used ONLY for matching; both dispatch calls below pass the
    // ORIGINAL `argv`.
    let str_tokens: Vec<&str> = argv.iter().map(|arg| arg.to_str().unwrap_or("")).collect();
    if let Some(matched) = commands::resolve_takeover(&str_tokens) {
        return dispatch_family_takeover(matched, &argv[matched.len()..]);
    }

    // Legacy (predecessor) mechanism: probe the first one or two argv
    // tokens against `TAKEOVER_TABLE` (plan 2.4) — a two-word command like
    // `effect add` needs both tokens to be valid UTF-8 to match at all; a
    // non-UTF-8 second token simply can't equal any (ASCII) table entry, so
    // it naturally falls through to the one-word probe, then to Node. Only
    // reached once the family mechanism above has already declined to
    // match — the two tables' first-token sets are disjoint (see
    // `commands` module doc), so there is no ordering ambiguity.
    if let Some(first_str) = first.to_str() {
        let second_str = argv.get(1).and_then(|arg| arg.to_str());
        let probe: Vec<&str> = match second_str {
            Some(second) => vec![first_str, second],
            None => vec![first_str],
        };
        if let Some((command, consumed)) = commands::match_takeover(&probe) {
            return dispatch_legacy_takeover(command, &argv[consumed..]);
        }
    }

    // Nothing matched: the coexistence-era fallback to Node for everything
    // outside serve/export is removed (plan section 0.1/2.1) — argv[0]
    // alone is reported, `to_string_lossy()` so a non-UTF-8 token still
    // prints something rather than panicking (plan 4.1's "legal but odd"
    // rows). This also covers a registered family name used with a
    // sub-command outside its own takeover entries when that family itself
    // is not in `TAKEOVER_TABLE` (e.g. `element frobnicate`) — deliberately
    // NOT the family's own "unknown subcommand: <family> <sub>" wording, which
    // stays reserved for families that ARE in `TAKEOVER_TABLE` (`slide`,
    // `chart`, `table`, `asset`, `presentation`, `template` — see
    // `dispatch_legacy_takeover`/`dispatch_asset`): reproducing that
    // wording for every other family here would be exactly the per-family
    // unknown-subcommand error surface `commands::mod`'s own doc comment
    // says this design avoids.
    eprintln!("unknown command: {}", first.to_string_lossy());
    1
}

/// Runs a family-mechanism takeover-table command's handler and renders
/// its `CommandResult`. `rest` is `argv` with the matched command-name
/// tokens already stripped off, so `undo`'s single-token name leaves the
/// same `rest` it always did and e.g. `element move`'s two-token name
/// leaves exactly the arguments that followed both words.
///
/// `--json` is a Rust-only flag (plan 4.3): meaningful only here, stripped
/// from the positional arguments the command handler sees, and never
/// forwarded to Node (the fallback path above never parses or forwards
/// `--json` specially — if it reaches Node at all, Node reports its own
/// "unknown argument" error, which is correct: `--json` has no meaning
/// outside the takeover table). Because matching happens against the
/// UN-stripped argv (see `dispatch` above), `--json` appearing BEFORE the
/// command name's tokens have all matched (including between them) simply
/// prevents a match in the first place and falls back to Node instead —
/// exactly the "--json appears before the command name" contract row.
fn dispatch_family_takeover(tokens: commands::CommandTokens, rest: &[OsString]) -> i32 {
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

    let _lock = match hold_presentation_lock(&positional) {
        Ok(lock) => lock,
        Err(code) => return code,
    };
    let command_result = commands::dispatch(tokens, &positional);

    // No command registered here (or `undo`/`redo`) has a
    // renderer — `None` here is correct, not a placeholder (plan 3.2 /
    // result.rs's doc: only `cat`-shaped commands get a raw-bytes
    // renderer, and this ticket registers none of those).
    result::render(&command_result, None, json_flag)
}

/// Runs a legacy-mechanism (predecessor) takeover-table command's handler
/// and renders its `CommandResult`.
/// `--json` is a Rust-only flag: meaningful only here, stripped from the
/// positional arguments the command handler sees, and never forwarded to
/// Node (the fallback path above never parses or forwards `--json`
/// specially — if it reaches Node at all, Node reports its own "unknown
/// argument" error, which is correct: `--json` has no meaning outside the
/// takeover table).
///
/// `--json` is recognised ONLY as the LAST token of `rest` — a
/// deliberate change from this mechanism's predecessor, which stripped it
/// from any position. Several commands take free-text as their final
/// positional (`slide notes set`'s `text`, `template rename`'s
/// `new-name`) and those may legitimately equal the literal string
/// `"--json"`; `--json` itself is a Rust-only flag with no TS-side
/// byte-compatibility burden, so this narrower rule is safe to adopt
/// outright.
fn dispatch_legacy_takeover(command: &str, rest: &[OsString]) -> i32 {
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

    let _lock = match hold_presentation_lock(&positional) {
        Ok(lock) => lock,
        Err(code) => return code,
    };

    let (command_result, renderer): (slidra::result::CommandResult, Option<Renderer<'_>>) =
        match command {
            "undo" => (commands::undo::run(&positional), None),
            "redo" => (commands::redo::run(&positional), None),
            "chart" => {
                let stdin_csv = maybe_read_stdin_csv(&positional);
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

    // None of undo/redo/chart/table/asset has a renderer (plan 3.2/4.3, and
    // cli.md's own "Renderer commands" list names only `cat`/`ls`/`slide
    // render`) — every match arm above reflects that.
    let code = result::render(&command_result, renderer, json_flag);
    // `validate` with findings exits 1 after rendering its full report:
    // the report is the point, so it is printed like any success,
    // and the exit code tells a script/agent "there are errors" — the same
    // "non-zero is a result, not a fault" convention `effect list` uses.
    if command == "validate" && code == 0 && commands::validate::has_findings(&command_result) {
        return 1;
    }
    code
}

/// Serialises every invocation that names a presentation: the
/// presentation id is the first positional after the command tokens for
/// most commands and the second/third for sub-verb families (`slide add
/// <id>`, `presentation canvas set <id>`), so the first three positionals
/// are tried against the registry and the first one that resolves is the
/// presentation. Paths (`new`, `open`) never resolve, so those commands run
/// unlocked. Reads (`cat`, `ls`, `slide render`) take the lock too — a read
/// that overlaps a write would otherwise see a half-written file, and the
/// lock costs nothing when there is no contention. Held until the caller's
/// `_lock` binding drops, i.e. for the rest of the process, so the whole
/// read-modify-write of every command is covered. `Err(code)` is the exit
/// code to return after the timeout message has been printed.
fn hold_presentation_lock(positional: &[String]) -> Result<Option<PresentationLock>, i32> {
    for candidate in positional.iter().take(3) {
        if candidate.starts_with("--") {
            continue;
        }
        let Ok(work_dir) = slidra::workspace::resolve_work_dir(candidate) else {
            continue;
        };
        return match PresentationLock::acquire(&work_dir) {
            Ok(lock) => Ok(Some(lock)),
            Err(err) => {
                eprintln!("{}", err.message());
                Err(1)
            }
        };
    }
    Ok(None)
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
/// `commands::chart::run`'s own "--csv - can only be used from the command line" fallback rather
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
/// grammar) states any other value reports "unknown subcommand: asset <x>"
/// (single token, unlike `chart`/`table`'s two-token unknown-subcommand
/// message — matching that section's literal wording).
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
