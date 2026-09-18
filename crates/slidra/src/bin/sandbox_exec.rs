// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! NOOP-425 L2: the Linux half of the agent sandbox. Applies a Landlock
//! ruleset that permits writes only under the given paths, then execs the
//! real command in its place (`CommandExt::exec()` — same pid, same fds,
//! same exit code, which is what keeps AC5's byte-for-byte guarantee true
//! regardless of what wraps the command). Only write-class access is
//! restricted (`AccessFs::from_write`): reads, exec, network, and env are
//! all untouched (NOOP-425 owner decision, 2026-09-15 — AC3 needs the
//! network path open, and AC2's read refusal is `protected-paths.ts`'s job,
//! not this binary's).
//!
//! Two modes:
//!   slidra-sandbox-exec --allow-write <path> [--allow-write <path> ...] -- <cmd> <args...>
//!   slidra-sandbox-exec --self-check <scratch-dir>
//!
//! The second is `landlock-launcher.ts`'s startup probe (L7): it proves the
//! ruleset actually restricts something on *this* machine, rather than
//! trusting a kernel/ABI version string.

use std::process::ExitCode;

struct ParsedExec {
    allow_write: Vec<String>,
    command: String,
    command_args: Vec<String>,
}

enum Invocation {
    Exec(ParsedExec),
    SelfCheck(String),
}

fn parse_args(args: &[String]) -> Result<Invocation, String> {
    if args.len() == 2 && args[0] == "--self-check" {
        return Ok(Invocation::SelfCheck(args[1].clone()));
    }

    let mut allow_write = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--allow-write" => {
                let path = args
                    .get(i + 1)
                    .ok_or("--allow-write requires a path argument")?;
                allow_write.push(path.clone());
                i += 2;
            }
            "--" => {
                i += 1;
                break;
            }
            other => return Err(format!("unrecognized argument: {other}")),
        }
    }
    if i >= args.len() {
        return Err("missing command after `--`".to_string());
    }
    let command = args[i].clone();
    let command_args = args[i + 1..].to_vec();
    Ok(Invocation::Exec(ParsedExec {
        allow_write,
        command,
        command_args,
    }))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = match parse_args(&args) {
        Ok(invocation) => invocation,
        Err(reason) => {
            eprintln!("slidra-sandbox-exec: {reason}");
            return ExitCode::from(2);
        }
    };

    match invocation {
        Invocation::SelfCheck(scratch_dir) => platform::self_check(&scratch_dir),
        Invocation::Exec(parsed) => platform::restrict_and_exec(parsed),
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::ParsedExec;
    use landlock::{
        ABI, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, path_beneath_rules,
    };
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, ExitCode};

    /// Restricts the *current* process to writing only under `allow_write`.
    /// A path that does not exist on disk is silently skipped by
    /// `path_beneath_rules` (confirmed against landlock 0.4.7's own source,
    /// `fs.rs`'s `Err(_) => None`) rather than failing the whole ruleset —
    /// the allow-list's own docstring (`policy.ts`) already documents this
    /// as deliberate ("an absent entry is simply not granted").
    ///
    /// Only `AccessFs::from_write` — write/remove/create/rename/truncate.
    /// Never `IoctlDev` (ABI V5): that is device access, not a write
    /// boundary, and would break unrelated tty-facing tools for no security
    /// benefit here.
    ///
    /// Returns `Err` for anything short of `FullyEnforced` with
    /// `no_new_privs` set — a caller must never treat a partial ruleset as
    /// "restricted enough" and exec anyway (AC1 depends on this).
    fn apply_ruleset(allow_write: &[String]) -> Result<(), String> {
        let access_w = AccessFs::from_write(ABI::V4);
        let status = Ruleset::default()
            .handle_access(access_w)
            .map_err(|e| format!("handle_access failed: {e}"))?
            .create()
            .map_err(|e| format!("create ruleset failed: {e}"))?
            .add_rules(path_beneath_rules(allow_write, access_w))
            .map_err(|e| format!("add_rules failed: {e}"))?
            .restrict_self()
            .map_err(|e| format!("restrict_self failed: {e}"))?;

        if status.ruleset != RulesetStatus::FullyEnforced {
            return Err(format!(
                "ruleset was not fully enforced (got {:?}) — refusing to run unrestricted",
                status.ruleset
            ));
        }
        if !status.no_new_privs {
            return Err("no_new_privs was not set — refusing to run unrestricted".to_string());
        }
        Ok(())
    }

    pub(super) fn restrict_and_exec(parsed: ParsedExec) -> ExitCode {
        if let Err(reason) = apply_ruleset(&parsed.allow_write) {
            eprintln!("slidra-sandbox-exec: {reason}");
            return ExitCode::from(1);
        }
        // `exec()` replaces this process's image outright on success and
        // never returns — the real command inherits this pid, these fds,
        // and reports its own exit code directly to the parent, which is
        // what keeps AC5's "byte-for-byte identical" true: nothing here
        // ever reads or transforms the child's stdout/stderr/exit code.
        let error = Command::new(&parsed.command)
            .args(&parsed.command_args)
            .exec();
        eprintln!(
            "slidra-sandbox-exec: failed to exec {}: {error}",
            parsed.command
        );
        ExitCode::from(126)
    }

    pub(super) fn self_check(scratch_dir: &str) -> ExitCode {
        let allowed = format!("{scratch_dir}/allowed");
        let blocked = format!("{scratch_dir}/blocked");
        if let Err(e) = fs::create_dir_all(&allowed) {
            eprintln!("self-check: cannot create {allowed}: {e}");
            return ExitCode::from(1);
        }
        if let Err(e) = fs::create_dir_all(&blocked) {
            eprintln!("self-check: cannot create {blocked}: {e}");
            return ExitCode::from(1);
        }
        // Only `allowed` is ever granted — `blocked` exists purely as the
        // negative case this self-check needs to prove something is
        // actually being restricted, not just that the syscalls succeeded.
        if let Err(reason) = apply_ruleset(&[allowed.clone()]) {
            eprintln!("self-check: {reason}");
            return ExitCode::from(1);
        }

        let allowed_write = fs::write(format!("{allowed}/probe.txt"), b"x");
        let blocked_write = fs::write(format!("{blocked}/probe.txt"), b"x");
        if let Err(e) = allowed_write {
            eprintln!("self-check: write to the allowed path failed unexpectedly: {e}");
            return ExitCode::from(1);
        }
        if blocked_write.is_ok() {
            eprintln!(
                "self-check: write to the blocked path unexpectedly succeeded — Landlock is not actually restricting anything"
            );
            return ExitCode::from(1);
        }
        ExitCode::SUCCESS
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::ParsedExec;
    use std::process::ExitCode;

    pub(super) fn restrict_and_exec(_parsed: ParsedExec) -> ExitCode {
        eprintln!("slidra-sandbox-exec: only supported on Linux");
        ExitCode::from(1)
    }

    pub(super) fn self_check(_scratch_dir: &str) -> ExitCode {
        eprintln!("slidra-sandbox-exec: only supported on Linux");
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repeated_allow_write_and_the_trailing_command() {
        let args: Vec<String> = [
            "--allow-write",
            "/a",
            "--allow-write",
            "/b",
            "--",
            "sh",
            "-c",
            "echo hi",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        match parse_args(&args).expect("should parse") {
            Invocation::Exec(parsed) => {
                assert_eq!(parsed.allow_write, vec!["/a".to_string(), "/b".to_string()]);
                assert_eq!(parsed.command, "sh");
                assert_eq!(
                    parsed.command_args,
                    vec!["-c".to_string(), "echo hi".to_string()]
                );
            }
            Invocation::SelfCheck(_) => panic!("expected an Exec invocation"),
        }
    }

    #[test]
    fn rejects_a_missing_separator_or_missing_command_instead_of_guessing() {
        let no_separator: Vec<String> = ["--allow-write", "/a"]
            .into_iter()
            .map(String::from)
            .collect();
        assert!(parse_args(&no_separator).is_err());

        let empty_command: Vec<String> = ["--allow-write", "/a", "--"]
            .into_iter()
            .map(String::from)
            .collect();
        assert!(parse_args(&empty_command).is_err());

        let self_check: Vec<String> = ["--self-check", "/tmp/scratch"]
            .into_iter()
            .map(String::from)
            .collect();
        assert!(
            matches!(parse_args(&self_check), Ok(Invocation::SelfCheck(dir)) if dir == "/tmp/scratch")
        );
    }
}
