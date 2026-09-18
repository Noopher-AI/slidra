// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Stateless CLI-boundary tests for the real compiled binary.
//!
//! Stateful command behavior is intentionally not exercised by spawning one
//! process per command. Workbench ids belong to the deck-server runtime that
//! opened them; integration coverage for stateful calls therefore goes through
//! the real HTTP door in `server_door.rs`, while command modules cover the same
//! runtime directly in their unit tests.

use std::process::Command;

fn rust_bin() -> &'static str {
    env!("CARGO_BIN_EXE_slidra")
}

#[test]
fn version_flag_is_answered_by_rust() {
    let output = Command::new(rust_bin())
        .arg("--version")
        .output()
        .expect("binary must run");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("slidra {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn empty_argv_reports_missing_command_name() {
    let output = Command::new(rust_bin()).output().expect("binary must run");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "missing command name\n"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn unknown_subcommand_is_rejected_by_rust() {
    let output = Command::new(rust_bin())
        .args(["slide", "frobnicate"])
        .output()
        .expect("binary must run");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "unknown subcommand: slide frobnicate\n"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn unknown_command_never_falls_back_to_node() {
    let output = Command::new(rust_bin())
        .arg("frobnicate")
        .env("PATH", "")
        .output()
        .expect("binary must run");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "unknown command: frobnicate\n"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn stateful_id_is_not_restored_in_a_fresh_process() {
    let temp = std::env::temp_dir().join(format!(
        "slidra-cli-runtime-boundary-{}",
        slidra::id::random_hex_suffix()
    ));
    std::fs::create_dir_all(&temp).unwrap();
    let deck = temp.join("runtime-only.slidra");

    let created = Command::new(rust_bin())
        .args(["new", deck.to_str().unwrap(), "--name", "runtime-only"])
        .output()
        .expect("binary must run");
    assert!(created.status.success(), "{created:?}");
    let opened = Command::new(rust_bin())
        .args(["open", deck.to_str().unwrap()])
        .output()
        .expect("binary must run");
    assert!(opened.status.success(), "{opened:?}");
    let stdout = String::from_utf8_lossy(&opened.stdout);
    let json_start = stdout.find('{').expect("open output must contain JSON");
    let body: serde_json::Value = serde_json::from_str(&stdout[json_start..]).unwrap();
    let id = body["id"].as_str().unwrap();

    let later = Command::new(rust_bin())
        .args(["ls", id])
        .output()
        .expect("binary must run");
    assert_eq!(later.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&later.stderr),
        format!("no presentation found for id: {id}\n")
    );
    std::fs::remove_dir_all(&temp).ok();
}
