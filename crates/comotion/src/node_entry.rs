//! The Rust binary's only remaining reliance on Node: `docs/spec/cli.md`'s
//! "## Entry points that bypass the registry: serve and export" is normative — `serve` and
//! `export` are not CLI commands with a `data` shape, they start a
//! long-running HTTP server / drive a headless-browser export pipeline, and
//! that logic lives in `@comotion/server`, not in this crate. For those two
//! names (and only those two), this binary sets `COMOTION_BIN` to its own
//! absolute path, then execs Node against `packages/server`'s plain-JS entry
//! point, with argv, stdin, stdout, stderr, and exit code all passed through
//! byte-for-byte.
//!
//! This is NOT the coexistence-era fallback it replaces: every command
//! outside `serve`/`export` that used to fall through to here now gets
//! "unknown command" from `main.rs` instead (plan section 2.1) — there is no
//! takeover table left to miss.

use std::env;
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const NODE_ENTRY_RELATIVE: &str = "packages/server/bin/comotion-node.js";

/// Execs `node <repo>/packages/server/bin/comotion-node.js <argv>`,
/// inheriting stdio, and returns the process exit code this binary should
/// itself exit with. `argv` is passed through untouched (including
/// non-UTF-8 bytes) — `main.rs` only reaches this function for `serve`/
/// `export`, which it identifies by matching `argv[0]` as UTF-8 without
/// otherwise inspecting or validating the rest of argv.
pub fn exec_node(argv: &[OsString]) -> i32 {
    let repo_root = match locate_repo_root() {
        Some(root) => root,
        None => {
            eprintln!("找不到 comotion 的 serve/export 入口");
            return 1;
        }
    };
    let entry = repo_root.join(NODE_ENTRY_RELATIVE);

    let current_exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("comotion"));

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .args(argv)
        .env("COMOTION_BIN", current_exe)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = match command.status() {
        Ok(status) => status,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("找不到 node");
            return 1;
        }
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match status.code() {
        Some(code) => code,
        // Killed by a signal: no exit code. Bash's own convention (128 +
        // signal) is what a caller piping our stderr/exit code into a shell
        // script already expects; treating this as 0 would report success
        // for a process that never got to finish.
        None => 128 + status.signal().unwrap_or(0),
    }
}

/// Walks up from the running binary's location looking for a directory that
/// contains BOTH `Cargo.toml` and `packages/server/bin/comotion-node.js`.
/// Both conditions are required: checking only `Cargo.toml` can misfire
/// inside `target/` (e.g. a vendored crate that happens to embed one),
/// landing on the wrong ancestor before reaching the real repo root.
fn locate_repo_root() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;
    let start = current_exe.canonicalize().unwrap_or(current_exe);
    let mut dir: Option<&Path> = start.parent();

    while let Some(candidate) = dir {
        if candidate.join("Cargo.toml").is_file() && candidate.join(NODE_ENTRY_RELATIVE).is_file() {
            return Some(candidate.to_path_buf());
        }
        dir = candidate.parent();
    }
    None
}
