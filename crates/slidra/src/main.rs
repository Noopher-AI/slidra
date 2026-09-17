// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Entry point. Dispatch order (plan section 4.1) is hand-written here
//! rather than handed to `clap` for the whole argv: `slidra`'s existing
//! (Node-side) commands accept a large surface of `--` flags (`--name`,
//! `--force`, `--series`, ...), and clap's default behaviour is to
//! intercept `--help`/`--version`/unknown-subcommand at any position and
//! print its own (English) error text — any one of those firing on a
//! fallback-bound argv would break byte-for-byte compatibility with the
//! Node CLI (acceptance criterion A2).
//!
//! [S11.F2] moved everything past this file's own five names into
//! `cli::run_argv` (the argv executor the deck server also calls, see
//! that module's doc comment) — this file now only recognises
//! `--version`/`-V`, `serve`/`export` (still exec Node, [E10.T9]'s job:
//! `main.rs:60-67`-equivalent below is unchanged), and the deck server's
//! two internal, bypass-the-registry entry points, `__deck-server` and
//! `__shim` — mirroring `serve`/`export`'s own "not a CLI command, never
//! in `docs/spec/cli.md`, never counted by `cli_golden.rs`'s 92" posture.
//! Everything else falls through to `cli::run_argv`.

use std::env;
use std::ffi::OsString;

use slidra::node_entry;
use slidra::{cli, server};

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

    // Non-UTF-8 argv[0] can never match "--version"/"serve"/"export"/the
    // two internal entry points (all ASCII), so it always falls through
    // to `cli::run_argv`, untouched.
    if let Some(first_str) = first.to_str() {
        if first_str == "--version" || first_str == "-V" {
            // A deliberate, ticket-scoped behavior CHANGE from the Node
            // CLI (which has no --version and errors on it) — called out
            // explicitly in the PR's human verification checklist per
            // acceptance criterion A1.
            println!("slidra {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }

        if first_str == "serve" || first_str == "export" {
            // The only two names that still exec Node — spec's "## Entry
            // point that bypasses the registry", not a coexistence-era
            // fallback. Always taken even when arguments are missing/
            // malformed — Rust never pre-validates these, Node's own
            // error path is the single source of truth for their
            // argument errors.
            return node_entry::exec_node(&argv);
        }

        if first_str == "__deck-server" {
            return server::run(&argv[1..]);
        }
        if first_str == "__shim" {
            return server::shim_client::run(&argv[1..]);
        }
    }

    cli::run_argv(&argv)
}
