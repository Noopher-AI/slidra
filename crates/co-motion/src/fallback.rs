//! Falling back to the Node CLI for every command not in the takeover table
//! (plan section 4.2), including `serve`/`export`, which always fall back.
//!
//! `@co-motion/server` has no `bin` entry (confirmed against
//! `packages/server/package.json`) — its only Node entry point is
//! `packages/cli/bin/co-motion.js`, which dynamic-imports `@co-motion/server`
//! for the `serve`/`export` branches. So "exec the Node `@co-motion/server`
//! entry" concretely means "exec `node <repo>/packages/cli/bin/co-motion.js
//! <argv>`" — there is no separate server binary to shell out to.

use std::env;
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const NODE_ENTRY_RELATIVE: &str = "packages/cli/bin/co-motion.js";

/// Execs `node <repo>/packages/cli/bin/co-motion.js <argv>`, inheriting
/// stdio, and returns the process exit code this binary should itself exit
/// with. `argv` is passed through untouched (including non-UTF-8 bytes —
/// see main.rs's dispatch table, which never inspects argv when it is about
/// to fall back).
pub fn exec_node_fallback(argv: &[OsString]) -> i32 {
    let repo_root = match locate_repo_root() {
        Some(root) => root,
        None => {
            eprintln!("找不到 co-motion 的 Node 入口");
            return 1;
        }
    };
    let entry = repo_root.join(NODE_ENTRY_RELATIVE);

    let current_exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("co-motion"));

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .args(argv)
        .env("CO_MOTION_BIN", current_exe)
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
/// contains BOTH `Cargo.toml` and `packages/cli/bin/co-motion.js`. Both
/// conditions are required: checking only `Cargo.toml` can misfire inside
/// `target/` (e.g. a vendored crate that happens to embed one), landing on
/// the wrong ancestor before reaching the real repo root.
fn locate_repo_root() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;
    let start = current_exe.canonicalize().unwrap_or(current_exe);
    let mut dir: Option<&Path> = start.parent();

    while let Some(candidate) = dir {
        if candidate.join("Cargo.toml").is_file()
            && candidate.join(NODE_ENTRY_RELATIVE).is_file()
        {
            return Some(candidate.to_path_buf());
        }
        dir = candidate.parent();
    }
    None
}
