//! CLI-boundary tests: `co-motion`'s argv -> (stdout, stderr, exit code)
//! contract (plan section 6.2, boundary 1). Runs the REAL compiled binary
//! via `CARGO_BIN_EXE_co-motion` (proving these commands are actually
//! dispatched by Rust, not by a fallback that happens to produce the same
//! text — see plan A3), and for fallback bit-parity, also runs the real
//! Node CLI (`packages/cli/bin/co-motion.js`) via `node` on `PATH` so both
//! sides of the comparison come from an actual process, not a
//! hand-transcribed expectation.
//!
//! These tests need `node` on `PATH` and a built `packages/cli`
//! (`npm run build --workspace=packages/cli`) — they are integration tests
//! against the coexisting Node CLI by design, not something that can run in
//! total isolation from the rest of the repo.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<repo>/crates/co-motion`.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root must exist")
}

fn rust_bin() -> &'static str {
    env!("CARGO_BIN_EXE_co-motion")
}

fn node_cli_entry() -> PathBuf {
    repo_root().join("packages/cli/bin/co-motion.js")
}

struct Fixture {
    home: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let base = env::temp_dir().join(format!(
            "co-motion-cli-golden-{label}-{}",
            std::process::id()
        ));
        let home = base.join("home");
        let workspace = base.join("ws");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        Fixture { home, workspace }
    }

    fn run_node(&self, args: &[&str]) -> Output {
        Command::new("node")
            .arg(node_cli_entry())
            .args(args)
            .env("CO_MOTION_HOME", &self.home)
            .output()
            .expect("node must be on PATH")
    }

    fn run_rust(&self, args: &[&str]) -> Output {
        Command::new(rust_bin())
            .args(args)
            .env("CO_MOTION_HOME", &self.home)
            .output()
            .expect("compiled co-motion binary must run")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn extract_id(open_output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&open_output.stdout);
    // `open`'s output is `<message>\n{...json...}`; the id is the JSON's
    // top-level "id" field.
    let json_start = stdout
        .find('{')
        .expect("open output must contain a JSON body");
    let value: serde_json::Value =
        serde_json::from_str(&stdout[json_start..]).expect("open output JSON must parse");
    value["id"]
        .as_str()
        .expect("open output JSON must have a string id")
        .to_string()
}

/// Pulls the first `id="el-..."` out of a raw SVG string — no `regex`
/// dependency is available (this ticket's Rust dependencies are fixed at
/// clap/serde/serde_json), so this is a small hand-rolled scan, good enough
/// for test fixtures whose shape is entirely under this test's own control.
fn extract_first_element_id(svg: &str) -> String {
    const NEEDLE: &str = "id=\"el-";
    let start = svg
        .find(NEEDLE)
        .expect("svg must contain at least one id=\"el-...\" element")
        + NEEDLE.len();
    let end = svg[start..]
        .find('"')
        .expect("id attribute value must be closed by a quote")
        + start;
    format!("el-{}", &svg[start..end])
}

#[test]
fn version_flag_is_answered_by_rust_not_node() {
    let output = Command::new(rust_bin())
        .arg("--version")
        .output()
        .expect("binary must run");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout, format!("co-motion {}\n", env!("CARGO_PKG_VERSION")));
    assert!(output.stderr.is_empty());
}

#[test]
fn empty_argv_falls_back_to_node_and_reports_missing_command_name() {
    let output = Command::new(rust_bin()).output().expect("binary must run");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stderr), "缺少命令名稱\n");
    assert!(output.stdout.is_empty());
}

/// Acceptance criterion A2: for every one of these argv combinations, the
/// Rust binary's fallback path must byte-for-byte match the real Node CLI —
/// stdout, stderr, AND exit code all three.
#[test]
fn fallback_path_is_byte_identical_to_node_for_every_non_takeover_command() {
    let fixture = Fixture::new("fallback-parity");
    let comot_path = fixture.workspace.join("t.comot");

    let new_output = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    assert!(
        open_output.status.success(),
        "setup: `open` failed: {:?}",
        open_output
    );
    let id = extract_id(&open_output);

    let cases: Vec<Vec<&str>> = vec![
        vec!["ls", &id],
        vec!["ls", &id, "slides"],
        vec!["cat", &id, "project.json"],
        vec!["cat", &id, "slides/001.svg"],
        vec!["ls", "NOPE-does-not-exist"],
        vec!["cat", &id, "nope.txt"],
        vec!["frobnicate"],
    ];

    let mut failures = Vec::new();
    for args in &cases {
        let rust_out = fixture.run_rust(args);
        let node_out = fixture.run_node(args);
        if rust_out.stdout != node_out.stdout
            || rust_out.stderr != node_out.stderr
            || rust_out.status.code() != node_out.status.code()
        {
            failures.push(format!(
                "args={args:?}\n  rust: code={:?} stdout={:?} stderr={:?}\n  node: code={:?} stdout={:?} stderr={:?}",
                rust_out.status.code(),
                String::from_utf8_lossy(&rust_out.stdout),
                String::from_utf8_lossy(&rust_out.stderr),
                node_out.status.code(),
                String::from_utf8_lossy(&node_out.stdout),
                String::from_utf8_lossy(&node_out.stderr),
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "fallback parity mismatches:\n{}",
        failures.join("\n---\n")
    );
}

#[test]
fn undo_with_no_history_reports_nothing_to_undo_via_rust() {
    let fixture = Fixture::new("undo-empty");
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_output.status.success());
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let output = fixture.run_rust(&["undo", &id]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "沒有可復原的操作\n"
    );
}

/// Runs `new`/`open`/`text set` via the TS engine, staging one edit — the
/// setup every path below re-stages fresh (a separate `Fixture` each,
/// mirroring `undo_redo_round_trip_via_rust_binary_restores_exact_bytes`'s
/// own setup above; duplicated rather than shared so each path's fixture is
/// fully independent). Returns `(id, before, after)`.
fn build_edited_fixture(fixture: &Fixture) -> (String, Vec<u8>, Vec<u8>) {
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));

    let text_set = fixture.run_node(&[
        "text",
        "set",
        &id,
        "slides/001.svg",
        &element_id,
        "改過的標題",
    ]);
    assert!(
        text_set.status.success(),
        "setup: `text set` failed: {:?}",
        text_set
    );

    let after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_ne!(
        before, after,
        "setup: the staged edit must actually change the file"
    );

    (id, before, after)
}

fn read_stack_json(fixture: &Fixture, id: &str) -> String {
    fs::read_to_string(fixture.home.join("history").join(id).join("stack.json"))
        .expect("stack.json must exist after an undo/redo")
}

/// `stack.json`'s `groupId`/`snapshotId` are opaque random ids
/// (`packages/core/src/id.ts` / `crates/co-motion/src/id.rs`, both
/// `randomBytes(9).base64url`) — freshly generated on every apply, by
/// whichever engine performed it, so two structurally-identical stacks
/// never share literal id text. Replaces each with a placeholder assigned
/// in order of first appearance (`<GROUP_1>`, `<SNAPSHOT_1>`, ...) so a
/// TS-only reference run and a mixed-engine run can be compared
/// byte-for-byte despite neither engine's ids ever repeating between
/// processes.
fn normalize_stack_ids(raw: &str) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(raw).expect("stack.json must be valid JSON");
    let mut normalizer = StackIdNormalizer::default();
    if let Some(array) = value.get_mut("undo").and_then(|v| v.as_array_mut()) {
        for group in array {
            normalizer.normalize_group(group);
        }
    }
    if let Some(array) = value.get_mut("redo").and_then(|v| v.as_array_mut()) {
        for group in array {
            normalizer.normalize_group(group);
        }
    }
    if let Some(open_group) = value.get_mut("openGroup") {
        if !open_group.is_null() {
            normalizer.normalize_group(open_group);
        }
    }
    serde_json::to_string_pretty(&value).expect("normalized stack must serialize")
}

#[derive(Default)]
struct StackIdNormalizer {
    groups: std::collections::HashMap<String, String>,
    snapshots: std::collections::HashMap<String, String>,
}

impl StackIdNormalizer {
    fn group_placeholder(&mut self, real: &str) -> String {
        let next_index = self.groups.len() + 1;
        self.groups
            .entry(real.to_string())
            .or_insert_with(|| format!("<GROUP_{next_index}>"))
            .clone()
    }

    fn snapshot_placeholder(&mut self, real: &str) -> String {
        let next_index = self.snapshots.len() + 1;
        self.snapshots
            .entry(real.to_string())
            .or_insert_with(|| format!("<SNAPSHOT_{next_index}>"))
            .clone()
    }

    fn normalize_group(&mut self, group: &mut serde_json::Value) {
        let Some(obj) = group.as_object_mut() else {
            return;
        };
        if let Some(serde_json::Value::String(group_id)) = obj.get("groupId") {
            let placeholder = self.group_placeholder(&group_id.clone());
            obj.insert(
                "groupId".to_string(),
                serde_json::Value::String(placeholder),
            );
        }
        if let Some(entries) = obj.get_mut("entries").and_then(|v| v.as_array_mut()) {
            for entry in entries.iter_mut() {
                let Some(entry_obj) = entry.as_object_mut() else {
                    continue;
                };
                if let Some(serde_json::Value::String(snapshot_id)) = entry_obj.get("snapshotId") {
                    let placeholder = self.snapshot_placeholder(&snapshot_id.clone());
                    entry_obj.insert(
                        "snapshotId".to_string(),
                        serde_json::Value::String(placeholder),
                    );
                }
            }
        }
    }
}

/// Acceptance criterion A5 (plan NOOP-277 section 5,父票 AC3): the undo/redo
/// stack must be interchangeable between the Rust and Node engines in
/// either direction — not just Rust-undo-then-Rust-redo, which
/// `undo_redo_round_trip_via_rust_binary_restores_exact_bytes` above already
/// covers. Each of the four paths below re-stages the same edit via the TS
/// engine (the only content-editing engine so far — history's write-path
/// staging API is not yet ported, per this module's own header comment)
/// then exercises undo/redo across engines, checking both the restored file
/// bytes AND `stack.json`'s id-normalized shape against an all-TS
/// reference run of the same edit + undo + redo.
///
/// The reference is valid for all four paths because `apply_group` (ported
/// identically on both engines — see `history.rs`'s own doc comment) always
/// re-derives its inverse group from the group being applied: same virtual
/// paths, one freshly-generated snapshot id per entry, `groupId` carried
/// through unchanged. That derivation does not depend on which engine
/// performed the previous step, so "after one undo" and "after undo+redo"
/// are each a single well-defined state regardless of engine mix.
#[test]
fn cross_engine_undo_redo_matches_ts_reference_stack_and_bytes_on_every_path() {
    let reference = Fixture::new("cross-engine-reference");
    let (ref_id, _before, _after) = build_edited_fixture(&reference);
    let ref_undo = reference.run_node(&["undo", &ref_id]);
    assert!(
        ref_undo.status.success(),
        "reference undo failed: {:?}",
        ref_undo
    );
    let reference_undo_stack = normalize_stack_ids(&read_stack_json(&reference, &ref_id));
    let ref_redo = reference.run_node(&["redo", &ref_id]);
    assert!(
        ref_redo.status.success(),
        "reference redo failed: {:?}",
        ref_redo
    );
    let reference_redo_stack = normalize_stack_ids(&read_stack_json(&reference, &ref_id));

    // Path 1+2 (A5 paths 1 and 2): TS builds history -> Rust undo -> Rust redo.
    {
        let fixture = Fixture::new("cross-engine-rust-undo-rust-redo");
        let (id, before, after) = build_edited_fixture(&fixture);

        let undo_output = fixture.run_rust(&["undo", &id]);
        assert!(
            undo_output.status.success(),
            "rust undo failed: {:?}",
            undo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            before,
            "path 1: rust undo must restore the pre-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_undo_stack,
            "path 1: rust undo's stack.json diverges from the TS reference"
        );

        let redo_output = fixture.run_rust(&["redo", &id]);
        assert!(
            redo_output.status.success(),
            "rust redo failed: {:?}",
            redo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            after,
            "path 2: rust redo must restore the post-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_redo_stack,
            "path 2: rust redo's stack.json diverges from the TS reference"
        );
    }

    // Path 3 (A5 path 3): TS builds history -> Rust undo -> TS redo.
    {
        let fixture = Fixture::new("cross-engine-rust-undo-ts-redo");
        let (id, before, after) = build_edited_fixture(&fixture);

        let undo_output = fixture.run_rust(&["undo", &id]);
        assert!(
            undo_output.status.success(),
            "rust undo failed: {:?}",
            undo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            before,
            "path 3 setup: rust undo must restore the pre-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_undo_stack,
            "path 3 setup: rust undo's stack.json diverges from the TS reference"
        );

        let redo_output = fixture.run_node(&["redo", &id]);
        assert!(
            redo_output.status.success(),
            "ts redo failed: {:?}",
            redo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            after,
            "path 3: ts redo (after a rust undo) must restore the post-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_redo_stack,
            "path 3: ts redo's stack.json diverges from the TS reference"
        );
    }

    // Path 4 (A5 path 4): TS builds history -> TS undo -> Rust redo.
    {
        let fixture = Fixture::new("cross-engine-ts-undo-rust-redo");
        let (id, before, after) = build_edited_fixture(&fixture);

        let undo_output = fixture.run_node(&["undo", &id]);
        assert!(
            undo_output.status.success(),
            "ts undo failed: {:?}",
            undo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            before,
            "path 4 setup: ts undo must restore the pre-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_undo_stack,
            "path 4 setup: ts undo's stack.json diverges from the TS reference"
        );

        let redo_output = fixture.run_rust(&["redo", &id]);
        assert!(
            redo_output.status.success(),
            "rust redo failed: {:?}",
            redo_output
        );
        assert_eq!(
            fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout,
            after,
            "path 4: rust redo (after a ts undo) must restore the post-edit bytes"
        );
        assert_eq!(
            normalize_stack_ids(&read_stack_json(&fixture, &id)),
            reference_redo_stack,
            "path 4: rust redo's stack.json diverges from the TS reference"
        );
    }
}

#[test]
fn undo_redo_round_trip_via_rust_binary_restores_exact_bytes() {
    let fixture = Fixture::new("undo-redo-roundtrip");
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));

    let text_set = fixture.run_node(&[
        "text",
        "set",
        &id,
        "slides/001.svg",
        &element_id,
        "改過的標題",
    ]);
    assert!(
        text_set.status.success(),
        "setup: `text set` failed: {:?}",
        text_set
    );

    let after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_ne!(
        before, after,
        "setup: the staged edit must actually change the file"
    );

    let undo_output = fixture.run_rust(&["undo", &id]);
    assert!(
        undo_output.status.success(),
        "undo failed: {:?}",
        undo_output
    );
    let undone = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_eq!(
        undone, before,
        "rust undo must restore the exact pre-edit bytes"
    );

    let redo_output = fixture.run_rust(&["redo", &id]);
    assert!(
        redo_output.status.success(),
        "redo failed: {:?}",
        redo_output
    );
    let redone = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_eq!(
        redone, after,
        "rust redo must restore the exact post-edit bytes"
    );
}

// ---------------------------------------------------------------------------
// NOOP-281/F5: chart, table, and asset import command golden tests.
// ---------------------------------------------------------------------------

/// Replaces every `el-<12 chars>` id in `svg` with a placeholder assigned in
/// order of first appearance, so a Rust-engine run and a Node-engine run of
/// the same command sequence — each generating its own fresh random ids —
/// can be compared byte-for-byte. Mirrors `normalize_stack_ids`'s id
/// normalization above, applied to slide SVG content instead of
/// `stack.json`.
fn normalize_element_ids(svg: &str) -> String {
    const NEEDLE: &str = "el-";
    let mut out = String::with_capacity(svg.len());
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut rest = svg;
    loop {
        let Some(pos) = rest.find(NEEDLE) else {
            out.push_str(rest);
            break;
        };
        let (before, after_needle_start) = rest.split_at(pos);
        out.push_str(before);
        let after_needle = &after_needle_start[NEEDLE.len()..];
        // An id is exactly 12 base64url characters (A-Za-z0-9-_).
        let id_len = after_needle
            .char_indices()
            .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_'))
            .map(|(idx, _)| idx)
            .unwrap_or(after_needle.len())
            .min(12);
        let raw_id = format!("el-{}", &after_needle[..id_len]);
        let next_index = seen.len() + 1;
        let placeholder = seen
            .entry(raw_id)
            .or_insert_with(|| format!("<EL_{next_index}>"))
            .clone();
        out.push_str(&placeholder);
        rest = &after_needle[id_len..];
    }
    out
}

#[test]
fn normalize_element_ids_assigns_placeholders_in_order_of_first_appearance() {
    let svg =
        r#"<g id="el-AAAAAAAAAAAA"><g id="el-BBBBBBBBBBBB"/></g><rect fill="el-AAAAAAAAAAAA"/>"#;
    let normalized = normalize_element_ids(svg);
    assert_eq!(
        normalized,
        r#"<g id="<EL_1>"><g id="<EL_2>"/></g><rect fill="<EL_1>"/>"#
    );
}

/// Acceptance criterion A2 (extended from NOOP-277's undo/redo-only version
/// to this ticket's 26 new commands): every one of them must actually be
/// dispatched by Rust, not merely happen to produce output that looks
/// right because it fell through to a Node fallback that isn't even on
/// `PATH`. `fallback::exec_node_fallback` prints the literal string "找不到
/// node" only when `Command::new("node")` itself fails to spawn — so with
/// `PATH` pointed at a directory with no `node` binary, any of these 26
/// commands producing that exact stderr would prove it fell back instead
/// of being handled by the Rust takeover table.
#[test]
fn chart_table_asset_commands_are_dispatched_by_rust_not_node() {
    let fixture = Fixture::new("dispatch-not-node");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_node(&["convert", &id]);

    let create = fixture.run_node(&["chart", "create", &id, "slides/001.svg"]);
    let chart_el = extract_id_field(&create.stdout, "elementId");
    let create_table = fixture.run_node(&[
        "table",
        "create",
        &id,
        "slides/001.svg",
        "--rows",
        "1",
        "--cols",
        "1",
        "--x",
        "0",
        "--y",
        "0",
    ]);
    let table_el = extract_id_field(&create_table.stdout, "elementId");

    let cases: Vec<Vec<String>> = vec![
        vec![
            "chart".into(),
            "create".into(),
            id.clone(),
            "slides/001.svg".into(),
        ],
        vec![
            "chart".into(),
            "data".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "--categories".into(),
            "A,B".into(),
            "--series".into(),
            "S=1,2".into(),
        ],
        vec![
            "chart".into(),
            "type".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "line".into(),
        ],
        vec![
            "chart".into(),
            "axis".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "single".into(),
        ],
        vec![
            "chart".into(),
            "legend".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "none".into(),
        ],
        vec![
            "chart".into(),
            "option".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "grid".into(),
            "false".into(),
        ],
        vec![
            "chart".into(),
            "palette".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "cool".into(),
        ],
        vec![
            "chart".into(),
            "stack".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            chart_el.clone(),
            "off".into(),
        ],
        vec![
            "table".into(),
            "create".into(),
            id.clone(),
            "slides/001.svg".into(),
            "--rows".into(),
            "1".into(),
            "--cols".into(),
            "1".into(),
            "--x".into(),
            "0".into(),
            "--y".into(),
            "0".into(),
        ],
        vec![
            "table".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "--markdown".into(),
            "|a|\n|-|\n|1|".into(),
        ],
        vec![
            "table".into(),
            "cell".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "--row".into(),
            "0".into(),
            "--col".into(),
            "0".into(),
            "--text".into(),
            "x".into(),
        ],
        vec![
            "table".into(),
            "cell".into(),
            "style".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "--row".into(),
            "0".into(),
            "--col".into(),
            "0".into(),
            "align".into(),
            "center".into(),
        ],
        vec![
            "table".into(),
            "cell".into(),
            "copy".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "--range".into(),
            "0,0:0,0".into(),
        ],
        vec![
            "table".into(),
            "theme".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "light".into(),
        ],
        vec![
            "table".into(),
            "header".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            table_el.clone(),
            "true".into(),
        ],
        vec![
            "asset".into(),
            "import".into(),
            id.clone(),
            "/definitely/missing/x.png".into(),
        ],
    ];

    let mut failures = Vec::new();
    for args in &cases {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = Command::new(rust_bin())
            .args(&arg_refs)
            .env("CO_MOTION_HOME", &fixture.home)
            .env("PATH", "/nonexistent")
            .output()
            .expect("compiled co-motion binary must run");
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.trim() == "找不到 node" {
            failures.push(format!("args={args:?} fell back to node: {stderr}"));
        }
    }
    assert!(
        failures.is_empty(),
        "dispatch-by-rust failures:\n{}",
        failures.join("\n")
    );
}

fn extract_id_field(stdout: &[u8], field: &str) -> String {
    let text = String::from_utf8_lossy(stdout);
    let json_start = text.find('{').expect("output must contain a JSON body");
    let value: serde_json::Value =
        serde_json::from_str(&text[json_start..]).expect("output JSON must parse");
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("output JSON must have a string {field}: {text}"))
        .to_string()
}

/// Acceptance criteria A5/A6: the same fixture, run through the full
/// sequence of `chart *`/`table *` commands via the Rust binary, must
/// produce a byte-identical (id-normalized) slide to the same sequence run
/// through the real Node CLI.
#[test]
fn chart_command_sequence_matches_node_byte_for_byte() {
    let chart_ops: &[&[&str]] = &[
        &[
            "data",
            "set",
            "--categories",
            "Q1,Q2,Q3",
            "--series",
            "Revenue=120,150,170",
        ],
        &["type", "set", "line"],
        &["palette", "set", "cool", "--color", "Revenue=#5B6DEA"],
        &["axis", "set", "single"],
        &["legend", "set", "right"],
        &["option", "set", "grid", "false"],
        &["stack", "set", "off"],
    ];

    let node_svg = run_chart_sequence(|fixture, args| fixture.run_node(args), chart_ops);
    let rust_svg = run_chart_sequence(|fixture, args| fixture.run_rust(args), chart_ops);
    assert_eq!(
        normalize_element_ids(&rust_svg),
        normalize_element_ids(&node_svg),
        "rust and node chart command sequences diverged"
    );
}

fn run_chart_sequence(runner: impl Fn(&Fixture, &[&str]) -> Output, ops: &[&[&str]]) -> String {
    let fixture = Fixture::new("chart-sequence");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_node(&["convert", &id]);

    let create = runner(&fixture, &["chart", "create", &id, "slides/001.svg"]);
    assert!(create.status.success(), "chart create failed: {create:?}");
    let element_id = extract_id_field(&create.stdout, "elementId");

    // Every entry in `ops` is a two-word verb ("data set", "type set", ...)
    // followed by that command's own flags/positionals — id/slide-path/
    // element-id are inserted right after the verb, mirroring every
    // `chart *` subcommand's own argv shape (see `argv::chart::parse`).
    for op in ops {
        let mut full: Vec<&str> = vec!["chart", op[0], op[1], &id, "slides/001.svg", &element_id];
        full.extend_from_slice(&op[2..]);
        let out = runner(&fixture, &full);
        assert!(out.status.success(), "op {full:?} failed: {out:?}");
    }

    String::from_utf8(fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout).unwrap()
}

/// Acceptance criteria A5/A6 (table half): a full `table *` sequence run
/// through Rust must match the same sequence run through Node,
/// byte-for-byte after id normalization.
#[test]
fn table_command_sequence_matches_node_byte_for_byte() {
    let node_svg = run_table_sequence(|fixture, args| fixture.run_node(args));
    let rust_svg = run_table_sequence(|fixture, args| fixture.run_rust(args));
    assert_eq!(
        normalize_element_ids(&rust_svg),
        normalize_element_ids(&node_svg),
        "rust and node table command sequences diverged"
    );
}

fn run_table_sequence(runner: impl Fn(&Fixture, &[&str]) -> Output) -> String {
    let fixture = Fixture::new("table-sequence");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_node(&["convert", &id]);

    let create = runner(
        &fixture,
        &[
            "table",
            "create",
            &id,
            "slides/001.svg",
            "--rows",
            "2",
            "--cols",
            "2",
            "--x",
            "10",
            "--y",
            "10",
        ],
    );
    assert!(create.status.success(), "table create failed: {create:?}");
    let element_id = extract_id_field(&create.stdout, "elementId");

    let ops: Vec<Vec<&str>> = vec![
        vec![
            "table",
            "cell",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "--row",
            "0",
            "--col",
            "0",
            "--text",
            "A",
        ],
        vec![
            "table",
            "cell",
            "style",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "--row",
            "0",
            "--col",
            "0",
            "align",
            "center",
        ],
        vec![
            "table",
            "col",
            "width",
            &id,
            "slides/001.svg",
            &element_id,
            "--col",
            "0",
            "--width",
            "200",
        ],
        vec![
            "table",
            "row",
            "insert",
            &id,
            "slides/001.svg",
            &element_id,
            "--at",
            "1",
        ],
        vec![
            "table",
            "col",
            "insert",
            &id,
            "slides/001.svg",
            &element_id,
            "--at",
            "1",
        ],
        vec![
            "table",
            "theme",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "light",
        ],
        vec![
            "table",
            "header",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "false",
        ],
    ];
    for op in &ops {
        let out = runner(&fixture, op);
        assert!(out.status.success(), "op {op:?} failed: {out:?}");
    }

    String::from_utf8(fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout).unwrap()
}

/// Acceptance criterion A3: `co-motion asset import <id> <path>` works from
/// the command line, landing bytes exactly as imported under `assets/`.
#[test]
fn asset_import_local_file_lands_under_assets_via_rust_binary() {
    let fixture = Fixture::new("asset-import-cli");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let png_path = fixture.workspace.join("tiny.png");
    let png_bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];
    fs::write(&png_path, png_bytes).unwrap();

    let import_result = fixture.run_rust(&["asset", "import", &id, png_path.to_str().unwrap()]);
    assert!(import_result.status.success(), "{import_result:?}");
    let path_field = extract_id_field(&import_result.stdout, "path");
    assert_eq!(path_field, "assets/tiny.png");

    // `cat` decodes strict UTF-8 and refuses binary content ("是二進位資產，
    // 無法以文字讀取") — not a usable read path for this assertion. Read the
    // real file back directly via the registry's workDir instead, the same
    // shortcut `packages/cli/test/asset-import.test.ts`'s
    // `readRealAssetBytes` uses.
    let registry_raw = fs::read_to_string(fixture.home.join("projects.json")).unwrap();
    let registry: serde_json::Value = serde_json::from_str(&registry_raw).unwrap();
    let work_dir = registry[&id]["workDir"].as_str().unwrap();
    let real_bytes = fs::read(PathBuf::from(work_dir).join("assets/tiny.png")).unwrap();
    assert_eq!(real_bytes, png_bytes);
}

/// Acceptance criterion A4: `chart data set --csv -` reads CSV from
/// stdin, producing the exact same `<comot:chart>` data a `--csv <file>`
/// import of the equivalent content would.
#[test]
fn chart_data_set_reads_csv_from_stdin() {
    let fixture = Fixture::new("chart-csv-stdin");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_node(&["convert", &id]);

    let create = fixture.run_rust(&["chart", "create", &id, "slides/001.svg"]);
    let element_id = extract_id_field(&create.stdout, "elementId");

    let csv_text = "Quarter,Revenue\nQ1,120\nQ2,150\n";
    let csv_path = fixture.workspace.join("q.csv");
    fs::write(&csv_path, csv_text).unwrap();
    let via_file = fixture.run_rust(&[
        "chart",
        "data",
        "set",
        &id,
        "slides/001.svg",
        &element_id,
        "--csv",
        csv_path.to_str().unwrap(),
    ]);
    assert!(via_file.status.success(), "{via_file:?}");
    let svg_via_file = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;

    // Undo the file-based data set, then repeat via stdin.
    fixture.run_rust(&["undo", &id]);
    let mut child = std::process::Command::new(rust_bin())
        .args([
            "chart",
            "data",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "--csv",
            "-",
        ])
        .env("CO_MOTION_HOME", &fixture.home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("compiled co-motion binary must run");
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(csv_text.as_bytes())
            .unwrap();
    }
    let via_stdin = child.wait_with_output().unwrap();
    assert!(via_stdin.status.success(), "{via_stdin:?}");
    let svg_via_stdin = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;

    assert_eq!(
        svg_via_stdin, svg_via_file,
        "--csv - must produce byte-identical output to --csv <equivalent file>"
    );

    // Empty stdin must fail, not silently succeed with an empty chart.
    let mut empty_child = std::process::Command::new(rust_bin())
        .args([
            "chart",
            "data",
            "set",
            &id,
            "slides/001.svg",
            &element_id,
            "--csv",
            "-",
        ])
        .env("CO_MOTION_HOME", &fixture.home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("compiled co-motion binary must run");
    drop(empty_child.stdin.take());
    let empty_result = empty_child.wait_with_output().unwrap();
    assert!(!empty_result.status.success(), "empty stdin must fail");
}
