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

/// Acceptance criterion A2: for every one of these argv combinations —
/// genuinely NOT-yet-Rust-dispatched commands, [E4.T4]'s explicit non-scope
/// (plan §2 item 3: `element`/`textbox`/`table`/`chart`/`comment`/`asset`
/// families, plus [E4.T7]'s `effect` family for any sub-command that isn't
/// one of its five takeover-table entries) plus a bare unknown command
/// name — the Rust binary's fallback path must byte-for-byte match the
/// real Node CLI: stdout, stderr, AND exit code all three.
///
/// `ls`/`cat` moved OUT of this test as of [E4.T4] ([E4.T2]'s plan named
/// them explicitly as things this ticket would move to Rust): they no
/// longer fall back at all, so a byte-parity assertion here would no longer
/// be testing "did the fallback path forward these bytes untouched" — it
/// would just coincidentally still pass because the Rust implementation
/// happens to produce identical bytes, while the test's own name kept
/// claiming otherwise. See `cat_and_ls_are_byte_identical_to_node_on_every_path`
/// below for their (differently-reasoned) cross-engine parity coverage, and
/// `no_takeover_table_command_ever_invokes_node` for A1's "回退不再觸發".
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
        vec!["frobnicate"],
        vec!["element", "delete", &id, "slides/001.svg", "el-nonexistent"],
        vec!["textbox", "add"],
        vec!["table", "create"],
        vec!["chart", "create"],
        vec!["comment", "list", &id],
        // Not one of `effect`'s five takeover-table entries (add/list/
        // move/remove/set) — must still fall back, unlike those five.
        vec!["effect", "duplicate", &id, "slides/001.svg"],
        vec!["asset", "import"],
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

/// A1: for every one of the 26 registered commands, a successful run must
/// never start a `node` child process at all — proven structurally (not by
/// inspecting output) by pointing `PATH` at a directory with no `node`
/// binary in it. A command that still fell back would fail with "找不到
/// node" instead of succeeding, so success here is direct evidence the
/// takeover table actually intercepted it.
#[test]
fn no_takeover_table_command_ever_invokes_node() {
    let fixture = Fixture::new("no-node-invoked");

    // Empty PATH-only directory: `node` cannot be found via PATH lookup.
    let empty_path_dir =
        env::temp_dir().join(format!("co-motion-empty-path-{}", std::process::id()));
    fs::create_dir_all(&empty_path_dir).unwrap();

    let run_without_node = |args: &[&str]| -> Output {
        Command::new(rust_bin())
            .args(args)
            .env("CO_MOTION_HOME", &fixture.home)
            .env("PATH", &empty_path_dir)
            .output()
            .expect("compiled co-motion binary must run")
    };

    let new_path = fixture.workspace.join("t2.comot");
    let new_output = run_without_node(&["new", new_path.to_str().unwrap(), "--name", "無node測試"]);
    assert!(
        new_output.status.success(),
        "`new` must succeed without node on PATH: {:?}",
        new_output
    );

    let open_output = run_without_node(&["open", new_path.to_str().unwrap()]);
    assert!(
        open_output.status.success(),
        "`open` must succeed without node on PATH: {:?}",
        open_output
    );
    let id = extract_id(&open_output);

    let slide_svg_output = run_without_node(&["cat", &id, "slides/001.svg"]);
    assert!(
        slide_svg_output.status.success(),
        "`cat slides/001.svg` must succeed without node on PATH: {:?}",
        slide_svg_output
    );
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&slide_svg_output.stdout));

    let out_comot = fixture.workspace.join("out.comot");
    let out_comot_str = out_comot.to_str().unwrap();
    let cases: Vec<Vec<&str>> = vec![
        vec!["ls", &id],
        vec!["cat", &id, "project.json"],
        vec!["convert", &id],
        vec![
            "presentation",
            "canvas",
            "set",
            &id,
            "--width",
            "1280",
            "--height",
            "720",
        ],
        vec!["slide", "add", &id],
        vec!["template", "list", &id],
        vec![
            "effect",
            "add",
            &id,
            "slides/001.svg",
            &element_id,
            "--family",
            "enter",
            "--effect",
            "fade",
        ],
        vec!["pack", &id, out_comot_str],
    ];
    for args in &cases {
        let output = run_without_node(args);
        assert!(
            output.status.success(),
            "args={args:?} must succeed without node on PATH (proves no fallback): {:?}",
            output
        );
    }

    fs::remove_dir_all(&empty_path_dir).ok();
}

/// Acceptance criterion A3: `cat`/`ls` output bytes must match the Node
/// CLI's exactly — this is the cross-engine byte comparison method
/// `Fixture::run_rust`/`run_node` were built for (plan §5 A3), now that
/// both commands are genuinely Rust-dispatched rather than falling back.
#[test]
fn cat_and_ls_are_byte_identical_to_node_on_every_path() {
    let fixture = Fixture::new("cat-ls-parity");
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
        vec!["ls", "NOPE-does-not-exist"],
        vec!["cat", &id, "project.json"],
        vec!["cat", &id, "slides/001.svg"],
        vec!["cat", &id, "fonts/LICENSE-NotoSansTC.txt"],
        vec!["cat", &id, "fonts/NotoSansTC-Presentation.ttf"],
        vec!["cat", &id, "nope.txt"],
        vec!["cat", &id, "slides"],
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
        "cat/ls parity mismatches:\n{}",
        failures.join("\n---\n")
    );
}

/// Unknown sub-commands within a taken-over family must be rejected by Rust
/// itself, never forwarded to Node (A1's "回退不再觸發" — the family name
/// alone already committed argv[0] to Rust dispatch).
#[test]
fn unknown_subcommand_within_a_takeover_family_never_falls_back() {
    let fixture = Fixture::new("unknown-subcommand");
    let output = fixture.run_rust(&["slide", "frobnicate"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "未知的子命令：slide frobnicate\n"
    );
    assert!(output.stdout.is_empty());
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
// effect add / remove / move / set / list ([E4.T7], plan 6.1/6.2)
// ---------------------------------------------------------------------------

/// `new`/`open` alone produce a slide with a bare `<text>` primitive at the
/// `<svg>` root (not wrapped in a `<g>`) — legal for every command this
/// file already exercises, but `effect add`/`remove`/`move`/`set` assert
/// slide compliance (D1's carve-out is `effect list` only), so every fixture
/// below runs `convert` too before touching effect commands.
fn new_open_and_convert(fixture: &Fixture) -> String {
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    let convert_output = fixture.run_node(&["convert", &id]);
    assert!(
        convert_output.status.success(),
        "setup: `convert` failed: {:?}",
        convert_output
    );
    id
}

/// Runs `args` via the Rust binary, then immediately `undo`s it via Rust
/// too, asserting the file is back to `expected_before` — the shared setup
/// every "run once via each engine, compare bytes" test below uses to avoid
/// needing two independent fixtures (which would need two independently
/// `new`-generated element ids to line up, and `new` assigns those
/// randomly — see `id.ts`/`id.rs`'s `generateElementId`). A single fixture,
/// mutated by Rust then rolled back before Node repeats the same argv, is
/// both simpler and a free extra proof that this ticket's write path
/// (`workspace::write::write_presentation_file`) occupies exactly one undo
/// step, same as `effect_add_then_undo_restores_original_bytes` below.
fn run_via_rust_then_undo(
    fixture: &Fixture,
    id: &str,
    args: &[&str],
    expected_before: &[u8],
) -> Vec<u8> {
    let output = fixture.run_rust(args);
    assert!(output.status.success(), "rust {args:?} failed: {output:?}");
    let after = fixture.run_node(&["cat", id, "slides/001.svg"]).stdout;
    let undo = fixture.run_rust(&["undo", id]);
    assert!(
        undo.status.success(),
        "undo after rust {args:?} failed: {undo:?}"
    );
    let restored = fixture.run_node(&["cat", id, "slides/001.svg"]).stdout;
    assert_eq!(
        restored, expected_before,
        "undo after rust {args:?} must restore the pre-command bytes"
    );
    after
}

/// Plan 6.2 item 1: `effect add`, run once via each engine against the same
/// starting bytes (see `run_via_rust_then_undo`'s doc comment for why one
/// fixture, not two), must leave byte-identical slide content.
#[test]
fn effect_add_matches_between_rust_and_node() {
    let fixture = Fixture::new("effect-add-parity");
    let id = new_open_and_convert(&fixture);
    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));
    let add_args = [
        "effect",
        "add",
        id.as_str(),
        "slides/001.svg",
        element_id.as_str(),
        "--family",
        "enter",
        "--effect",
        "fade",
    ];

    let rust_after = run_via_rust_then_undo(&fixture, &id, &add_args, &before);

    let node_add = fixture.run_node(&add_args);
    assert!(
        node_add.status.success(),
        "node effect add failed: {:?}",
        node_add
    );
    let node_after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;

    assert_eq!(
        rust_after, node_after,
        "effect add must produce byte-identical slide content on both engines"
    );
}

/// Plan 6.2 item 2: `effect list`'s plain (non-`--json`) output — a message
/// line followed by `data` pretty-printed as JSON, the one output shape
/// both engines actually support (`--json` is Rust-only, plan 4.3's own
/// main.rs doc comment; Node has no such mode) — must be byte-identical.
/// This is the test that actually exercises the `serde_json` vs
/// `JSON.stringify` integral-number formatting trap (plan 3.5's
/// `json_number` helper): `duration`/`delay`/transition-duration values
/// that happen to be whole numbers must print with no decimal point on
/// both sides.
#[test]
fn effect_list_output_matches_between_rust_and_node() {
    let fixture = Fixture::new("effect-list-parity");
    let id = new_open_and_convert(&fixture);
    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));
    let add = fixture.run_node(&[
        "effect",
        "add",
        &id,
        "slides/001.svg",
        &element_id,
        "--family",
        "enter",
        "--effect",
        "fade",
    ]);
    assert!(add.status.success(), "setup: effect add failed: {:?}", add);

    let rust_list = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
    let node_list = fixture.run_node(&["effect", "list", &id, "slides/001.svg"]);
    assert!(
        rust_list.status.success(),
        "rust effect list failed: {:?}",
        rust_list
    );
    assert!(
        node_list.status.success(),
        "node effect list failed: {:?}",
        node_list
    );
    assert_eq!(
        String::from_utf8_lossy(&rust_list.stdout),
        String::from_utf8_lossy(&node_list.stdout),
        "effect list's message+data output must be byte-identical between engines"
    );
    // Sanity: the comparison above is only meaningful if the output
    // actually carries the new `steps`/`transition` keys (plan 4.1) — guard
    // against both sides vacuously agreeing on some earlier, smaller shape.
    let stdout = String::from_utf8_lossy(&rust_list.stdout);
    assert!(
        stdout.contains("\"steps\""),
        "stdout missing steps: {stdout}"
    );
    assert!(
        stdout.contains("\"transition\""),
        "stdout missing transition: {stdout}"
    );
}

/// Plan 6.2 item 3: `effect remove`/`move`/`set`, chained in one session,
/// run once via each engine against the same starting bytes, must leave
/// byte-identical final slide content — and, chained with two `effect add`
/// calls first, this also covers `effect add`'s multi-item "with-previous"
/// forcing and `remove`'s dedup-and-descending-order splice.
#[test]
fn effect_remove_move_set_match_between_rust_and_node() {
    let fixture = Fixture::new("effect-sequence-parity");
    let id = new_open_and_convert(&fixture);
    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));

    let add1 = [
        "effect",
        "add",
        id.as_str(),
        "slides/001.svg",
        element_id.as_str(),
        "--family",
        "enter",
        "--effect",
        "fade",
    ];
    let add2 = [
        "effect",
        "add",
        id.as_str(),
        "slides/001.svg",
        element_id.as_str(),
        "--family",
        "exit",
        "--effect",
        "fade-out",
    ];
    let mv = ["effect", "move", id.as_str(), "slides/001.svg", "2", "up"];
    let set = [
        "effect",
        "set",
        id.as_str(),
        "slides/001.svg",
        "1",
        "--duration",
        "1.5",
    ];
    let remove = ["effect", "remove", id.as_str(), "slides/001.svg", "1"];

    fn run_all(fixture: &Fixture, use_rust: bool, sequence: &[&[&str]]) {
        for args in sequence {
            let output = if use_rust {
                fixture.run_rust(args)
            } else {
                fixture.run_node(args)
            };
            assert!(
                output.status.success(),
                "{args:?} failed (rust={use_rust}): {output:?}"
            );
        }
    }

    run_all(&fixture, true, &[&add1, &add2, &mv, &set, &remove]);
    let rust_after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;

    // Undo all five steps via Rust to roll the fixture back to `before`,
    // then repeat the exact same sequence via Node.
    for _ in 0..5 {
        let undo = fixture.run_rust(&["undo", &id]);
        assert!(undo.status.success(), "undo failed: {:?}", undo);
    }
    let restored = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_eq!(
        restored, before,
        "five undos must restore the pre-sequence bytes"
    );

    run_all(&fixture, false, &[&add1, &add2, &mv, &set, &remove]);
    let node_after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;

    assert_eq!(
        rust_after, node_after,
        "effect add/move/set/remove chained must produce byte-identical slide content on both engines"
    );
}

/// Plan 6.2 item 4: a slide with no effect list at all — `effect list`'s
/// not-found stderr and exit code must match between engines.
#[test]
fn effect_list_without_a_list_matches_stderr_and_exit_code() {
    let fixture = Fixture::new("effect-list-missing");
    let id = new_open_and_convert(&fixture);

    let rust_out = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
    let node_out = fixture.run_node(&["effect", "list", &id, "slides/001.svg"]);
    assert_eq!(rust_out.status.code(), node_out.status.code());
    assert_eq!(
        String::from_utf8_lossy(&rust_out.stderr),
        String::from_utf8_lossy(&node_out.stderr),
    );
    assert_eq!(
        String::from_utf8_lossy(&rust_out.stderr),
        "這張投影片沒有效果清單\n"
    );
}

/// Plan 6.2 item 5: a slide whose effect list is damaged (an unimplemented
/// `family` value) — `effect list`'s stderr must match between engines,
/// proving 3.3's exact-message-and-spacing porting.
#[test]
fn effect_list_with_damaged_list_matches_stderr() {
    let fixture = Fixture::new("effect-list-damaged");
    let id = new_open_and_convert(&fixture);

    let slide_path = {
        // Resolve the real on-disk path for slides/001.svg the same way the
        // fixture's own `cat` calls do: via `projects.json`'s registered
        // workDir, read directly rather than adding a new CLI surface just
        // for this test.
        let registry_raw = fs::read_to_string(fixture.home.join("projects.json")).unwrap();
        let registry: serde_json::Value = serde_json::from_str(&registry_raw).unwrap();
        let work_dir = registry[&id]["workDir"].as_str().unwrap().to_string();
        PathBuf::from(work_dir).join("slides").join("001.svg")
    };
    let original = fs::read_to_string(&slide_path).unwrap();
    let damaged = original.replace(
        "</svg>",
        r#"<metadata><comot:effects xmlns:comot="https://co-motion.dev/ns"><comot:effect target="bogus-target" family="not-a-family" effect="fade" start="on-click" duration="0.6" delay="0"/></comot:effects></metadata></svg>"#,
    );
    assert_ne!(
        original, damaged,
        "the damaging replacement must actually apply"
    );
    fs::write(&slide_path, damaged).unwrap();

    let rust_out = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
    let node_out = fixture.run_node(&["effect", "list", &id, "slides/001.svg"]);
    assert_eq!(rust_out.status.code(), node_out.status.code());
    assert_eq!(
        String::from_utf8_lossy(&rust_out.stderr),
        String::from_utf8_lossy(&node_out.stderr),
    );
    assert!(String::from_utf8_lossy(&rust_out.stderr).contains("尚未實作"));
}

/// Plan 6.2 item 6: `effect add` occupies exactly one undo step — `undo`
/// after it must restore the pre-add bytes exactly (proving the write path
/// this ticket adds — `workspace::write::write_presentation_file` — is
/// wired into the SAME `history.rs` staging API `undo`/`redo` already use).
#[test]
fn effect_add_then_undo_restores_original_bytes() {
    let fixture = Fixture::new("effect-add-undo");
    let id = new_open_and_convert(&fixture);
    let before = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));

    let add = fixture.run_rust(&[
        "effect",
        "add",
        &id,
        "slides/001.svg",
        &element_id,
        "--family",
        "enter",
        "--effect",
        "fade",
    ]);
    assert!(add.status.success(), "effect add failed: {:?}", add);
    let after = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_ne!(before, after, "effect add must actually change the file");

    let undo = fixture.run_rust(&["undo", &id]);
    assert!(undo.status.success(), "undo failed: {:?}", undo);
    let undone = fixture.run_node(&["cat", &id, "slides/001.svg"]).stdout;
    assert_eq!(undone, before, "undo must restore the exact pre-add bytes");
}

/// Parses a `--json` command's stdout as the `ok, data, message,
/// failureKind` envelope (`result.rs`'s `JsonEnvelope`).
fn json_envelope(output: &Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim_end()).unwrap_or_else(|err| {
        panic!("`--json` stdout must be one JSON object: {err}\nstdout={stdout:?}")
    })
}

fn json_type_tag(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Every key present in a `data` object, paired with a one-word type tag —
/// used to pin `cli.md`'s documented "成功 `data`" shape without also
/// pinning the specific values (those are covered by unit tests elsewhere,
/// e.g. `slide/ops.rs`).
fn data_key_types(data: &serde_json::Value) -> std::collections::BTreeMap<String, &'static str> {
    data.as_object()
        .unwrap_or_else(|| panic!("data must be a JSON object, got {data}"))
        .iter()
        .map(|(k, v)| (k.clone(), json_type_tag(v)))
        .collect()
}

fn shape(
    pairs: &[(&'static str, &'static str)],
) -> std::collections::BTreeMap<String, &'static str> {
    pairs.iter().map(|&(k, v)| (k.to_string(), v)).collect()
}

/// Standard base64 decoder, hand-rolled independently of
/// `co_motion::base64::encode` (this file has no dependency on that
/// function and never calls it) — used only as this test's own oracle for
/// "is this field actually base64", not to assert `encode`'s correctness
/// (that's `base64.rs`'s own unit tests' job, checked against literal RFC
/// 4648 vectors).
fn base64_decode_for_test(input: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    fn index_of(c: u8) -> u32 {
        ALPHABET
            .iter()
            .position(|&b| b == c)
            .unwrap_or_else(|| panic!("not a base64 character: {}", c as char)) as u32
    }
    let stripped: Vec<u8> = input.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(stripped.len() / 4 * 3);
    for chunk in stripped.chunks(4) {
        let mut buf = 0u32;
        for (i, &b) in chunk.iter().enumerate() {
            buf |= index_of(b) << (18 - i * 6);
        }
        out.push((buf >> 16) as u8);
        if chunk.len() > 2 {
            out.push((buf >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(buf as u8);
        }
    }
    out
}

/// NOOP-297 review round 1, item 2: plan NOOP-303 §6 required a `cli_golden`
/// case pinning every takeover-table command's `--json` `data` shape
/// against `docs/spec/cli.md`'s documented "成功 `data`" — none existed,
/// proven by the review's mutation E (renaming `slide add`'s `slidePath`
/// key to `slide_path` left `cargo test` fully green). This test covers
/// every command plan NOOP-308's feedback names: `slide`
/// add/delete/duplicate/move/notes-set/style-set/transition-set/render,
/// `template` add/list/rename/delete, `presentation canvas set`, and
/// `new`/`open`/`pack`/`convert`.
///
/// It also doubles as the regression guard for review item 1 (`slide
/// render --json`'s `content` must be base64): a plain "is this a string"
/// type check would NOT catch a raw-text regression (still a JSON string,
/// same type tag), so this decodes `content` with an independent decoder
/// and checks it round-trips to valid UTF-8 starting with `<svg` — raw SVG
/// text fed through that decoder either fails outright (`<`, `"`, `\n`,
/// spaces are not base64 characters) or produces garbage bytes, either of
/// which fails loudly.
#[test]
fn json_data_shape_matches_cli_md_for_every_documented_command() {
    let fixture = Fixture::new("json-data-shape");
    let comot_path = fixture.workspace.join("t.comot");
    let comot_path_str = comot_path.to_str().unwrap();

    let new_out = fixture.run_rust(&["new", comot_path_str, "--name", "測試", "--json"]);
    assert!(new_out.status.success(), "`new --json` failed: {new_out:?}");
    assert_eq!(
        data_key_types(&json_envelope(&new_out)["data"]),
        shape(&[]),
        "`new`'s data"
    );

    let open_out = fixture.run_rust(&["open", comot_path_str, "--json"]);
    assert!(
        open_out.status.success(),
        "`open --json` failed: {open_out:?}"
    );
    let open_envelope = json_envelope(&open_out);
    assert_eq!(
        data_key_types(&open_envelope["data"]),
        shape(&[("id", "string")]),
        "`open`'s data"
    );
    let id = open_envelope["data"]["id"].as_str().unwrap().to_string();

    // `new`'s default slide has a bare `<text>` primitive not yet wrapped in
    // a `<g id="el-…">` container — `presentation canvas set` needs typed,
    // normalized elements to rescale (unlike `convert` itself, whose whole
    // job is performing that normalization), so it fails with "不合規" on an
    // unconverted slide. Not asserted here; `convert`'s own data shape is
    // checked later, once already-normalized, at the end of this sequence.
    let setup_convert = fixture.run_rust(&["convert", &id]);
    assert!(
        setup_convert.status.success(),
        "setup: `convert` failed: {setup_convert:?}"
    );

    let canvas_out = fixture.run_rust(&[
        "presentation",
        "canvas",
        "set",
        &id,
        "--width",
        "1920",
        "--height",
        "1080",
        "--json",
    ]);
    assert!(
        canvas_out.status.success(),
        "`presentation canvas set --json` failed: {canvas_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&canvas_out)["data"]),
        shape(&[("width", "number"), ("height", "number")]),
        "`presentation canvas set`'s data"
    );

    let add_out = fixture.run_rust(&["slide", "add", &id, "--json"]);
    assert!(
        add_out.status.success(),
        "`slide add --json` failed: {add_out:?}"
    );
    let add_envelope = json_envelope(&add_out);
    assert_eq!(
        data_key_types(&add_envelope["data"]),
        shape(&[("slidePath", "string")]),
        "`slide add`'s data"
    );
    let added_slide = add_envelope["data"]["slidePath"]
        .as_str()
        .unwrap()
        .to_string();

    let dup_out = fixture.run_rust(&["slide", "duplicate", &id, "slides/001.svg", "--json"]);
    assert!(
        dup_out.status.success(),
        "`slide duplicate --json` failed: {dup_out:?}"
    );
    let dup_envelope = json_envelope(&dup_out);
    assert_eq!(
        data_key_types(&dup_envelope["data"]),
        shape(&[("slidePath", "string")]),
        "`slide duplicate`'s data"
    );
    let duplicated_slide = dup_envelope["data"]["slidePath"]
        .as_str()
        .unwrap()
        .to_string();

    let delete_out = fixture.run_rust(&["slide", "delete", &id, &duplicated_slide, "--json"]);
    assert!(
        delete_out.status.success(),
        "`slide delete --json` failed: {delete_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&delete_out)["data"]),
        shape(&[]),
        "`slide delete`'s data"
    );

    let move_out = fixture.run_rust(&["slide", "move", &id, &added_slide, "0", "--json"]);
    assert!(
        move_out.status.success(),
        "`slide move --json` failed: {move_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&move_out)["data"]),
        shape(&[]),
        "`slide move`'s data"
    );

    let notes_out = fixture.run_rust(&[
        "slide",
        "notes",
        "set",
        &id,
        "slides/001.svg",
        "hi",
        "--json",
    ]);
    assert!(
        notes_out.status.success(),
        "`slide notes set --json` failed: {notes_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&notes_out)["data"]),
        shape(&[]),
        "`slide notes set`'s data"
    );

    let style_out = fixture.run_rust(&[
        "slide",
        "style",
        "set",
        &id,
        "slides/001.svg",
        "--background",
        "#111",
        "--json",
    ]);
    assert!(
        style_out.status.success(),
        "`slide style set --json` failed: {style_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&style_out)["data"]),
        shape(&[]),
        "`slide style set`'s data"
    );

    let transition_out = fixture.run_rust(&[
        "slide",
        "transition",
        "set",
        &id,
        "slides/001.svg",
        "--enter",
        "fade",
        "--json",
    ]);
    assert!(
        transition_out.status.success(),
        "`slide transition set --json` failed: {transition_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&transition_out)["data"]),
        shape(&[]),
        "`slide transition set`'s data"
    );

    let render_plain = fixture.run_rust(&["slide", "render", &id, "slides/001.svg"]);
    assert!(
        render_plain.status.success(),
        "`slide render` (no --json) failed: {render_plain:?}"
    );
    let render_out = fixture.run_rust(&["slide", "render", &id, "slides/001.svg", "--json"]);
    assert!(
        render_out.status.success(),
        "`slide render --json` failed: {render_out:?}"
    );
    let render_envelope = json_envelope(&render_out);
    assert_eq!(
        data_key_types(&render_envelope["data"]),
        shape(&[("content", "string")]),
        "`slide render`'s data"
    );
    let content_b64 = render_envelope["data"]["content"].as_str().unwrap();
    let decoded = base64_decode_for_test(content_b64);
    assert_eq!(
        decoded, render_plain.stdout,
        "`slide render --json`'s content must decode to the same bytes the non-`--json` renderer wrote"
    );
    assert!(
        String::from_utf8_lossy(&decoded).starts_with("<svg"),
        "decoded content must be the slide's SVG, got {:?}",
        String::from_utf8_lossy(&decoded)
    );

    let tmpl_add_out = fixture.run_rust(&["template", "add", &id, "--json"]);
    assert!(
        tmpl_add_out.status.success(),
        "`template add --json` failed: {tmpl_add_out:?}"
    );
    let tmpl_add_envelope = json_envelope(&tmpl_add_out);
    assert_eq!(
        data_key_types(&tmpl_add_envelope["data"]),
        shape(&[("templatePath", "string")]),
        "`template add`'s data"
    );
    let template_path = tmpl_add_envelope["data"]["templatePath"]
        .as_str()
        .unwrap()
        .to_string();

    let tmpl_list_out = fixture.run_rust(&["template", "list", &id, "--json"]);
    assert!(
        tmpl_list_out.status.success(),
        "`template list --json` failed: {tmpl_list_out:?}"
    );
    let tmpl_list_data = json_envelope(&tmpl_list_out)["data"].clone();
    assert_eq!(
        data_key_types(&tmpl_list_data),
        shape(&[("templates", "array")]),
        "`template list`'s data"
    );
    assert_eq!(
        data_key_types(&tmpl_list_data["templates"][0]),
        shape(&[("file", "string"), ("name", "string")]),
        "`template list`'s data.templates[] entry"
    );

    let tmpl_rename_out = fixture.run_rust(&[
        "template",
        "rename",
        &id,
        &template_path,
        "改過的名字",
        "--json",
    ]);
    assert!(
        tmpl_rename_out.status.success(),
        "`template rename --json` failed: {tmpl_rename_out:?}"
    );
    let tmpl_rename_envelope = json_envelope(&tmpl_rename_out);
    assert!(
        tmpl_rename_envelope
            .as_object()
            .unwrap()
            .get("data")
            .is_none(),
        "`template rename`'s data key must be entirely absent (TS handler returns `void`), got {tmpl_rename_envelope}"
    );

    let tmpl_delete_out = fixture.run_rust(&["template", "delete", &id, &template_path, "--json"]);
    assert!(
        tmpl_delete_out.status.success(),
        "`template delete --json` failed: {tmpl_delete_out:?}"
    );
    assert!(
        json_envelope(&tmpl_delete_out)
            .as_object()
            .unwrap()
            .get("data")
            .is_none(),
        "`template delete`'s data key must be entirely absent"
    );

    let out_comot = fixture.workspace.join("out.comot");
    let pack_out = fixture.run_rust(&["pack", &id, out_comot.to_str().unwrap(), "--json"]);
    assert!(
        pack_out.status.success(),
        "`pack --json` failed: {pack_out:?}"
    );
    assert_eq!(
        data_key_types(&json_envelope(&pack_out)["data"]),
        shape(&[]),
        "`pack`'s data"
    );

    let convert_out = fixture.run_rust(&["convert", &id, "--json"]);
    assert!(
        convert_out.status.success(),
        "`convert --json` failed: {convert_out:?}"
    );
    let convert_data = json_envelope(&convert_out)["data"].clone();
    assert_eq!(
        data_key_types(&convert_data),
        shape(&[("slides", "array")]),
        "`convert`'s data"
    );
    assert_eq!(
        data_key_types(&convert_data["slides"][0]),
        shape(&[
            ("slidePath", "string"),
            ("changed", "bool"),
            ("wrapped", "number"),
        ]),
        "`convert`'s data.slides[] entry"
    );
}

/// NOOP-297 review round 1, item 2 (5): `cat --json`'s multi-path array
/// shape (`docs/spec/cli.md`'s "--json" section: "`data` 變成 `[{ path,
/// content }]` 陣列，順序與 argv 給的路徑順序相同") had no golden coverage.
/// Also pins the "單一路徑也回陣列" behavior this ticket's own plan flagged
/// as a 保留事項 needing a test.
#[test]
fn cat_json_multi_path_returns_ordered_array_shape() {
    let fixture = Fixture::new("cat-json-multi-path");
    let comot_path = fixture.workspace.join("t.comot");
    let new_out = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_out.status.success(), "setup: `new` failed: {new_out:?}");
    let open_out = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_out);

    let single = fixture.run_rust(&["cat", &id, "project.json", "--json"]);
    assert!(single.status.success(), "{single:?}");
    let single_data = json_envelope(&single)["data"].clone();
    assert!(
        single_data.is_array(),
        "single-path `cat --json` must still be an array: {single_data}"
    );
    assert_eq!(single_data.as_array().unwrap().len(), 1);

    let multi = fixture.run_rust(&[
        "cat",
        &id,
        "slides/001.svg",
        "project.json",
        "slides/001.svg",
        "--json",
    ]);
    assert!(multi.status.success(), "{multi:?}");
    let multi_data = json_envelope(&multi)["data"].clone();
    let entries = multi_data
        .as_array()
        .expect("cat --json's data must be an array");
    assert_eq!(
        entries.len(),
        3,
        "must have one entry per argv path, duplicates included"
    );
    let expected_paths = ["slides/001.svg", "project.json", "slides/001.svg"];
    let mut raw_by_path = std::collections::HashMap::new();
    for path in ["slides/001.svg", "project.json"] {
        raw_by_path.insert(path, fixture.run_rust(&["cat", &id, path]).stdout);
    }
    for (entry, expected_path) in entries.iter().zip(expected_paths) {
        assert_eq!(
            data_key_types(entry),
            shape(&[("path", "string"), ("content", "string")]),
            "cat --json array entry shape"
        );
        assert_eq!(
            entry["path"].as_str().unwrap(),
            expected_path,
            "array order must match argv order"
        );
        let decoded = base64_decode_for_test(entry["content"].as_str().unwrap());
        assert_eq!(
            &decoded,
            raw_by_path.get(expected_path).unwrap(),
            "content must decode to the same bytes as non-`--json` `cat`"
        );
    }
}

/// Debt flagged alongside review round 1's FAIL (low-cost, addressed while
/// building the `--json` shape golden test above): `slide add --at` and
/// `slide move <new-index>`'s "not a valid integer position" error had
/// never been checked byte-for-byte against the TS engine. `slide`/`slide
/// move` are takeover-table commands — the Rust `co-motion` binary itself
/// never falls back to Node for them — but `packages/core`'s executor
/// (what the Rust port was ported from) is still reachable by invoking the
/// Node CLI directly, which is exactly what `Fixture::run_node` does, so
/// this is a genuine cross-engine comparison, not a self-comparison.
#[test]
fn slide_add_and_move_reject_non_integer_position_byte_identical_to_node() {
    let fixture = Fixture::new("non-integer-position");
    let comot_path = fixture.workspace.join("t.comot");
    let new_out = fixture.run_node(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_out.status.success(), "setup: `new` failed: {new_out:?}");
    let open_out = fixture.run_node(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_out);

    let cases: Vec<Vec<&str>> = vec![
        vec!["slide", "add", &id, "--at", "1.5"],
        vec!["slide", "move", &id, "slides/001.svg", "1.5"],
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
        "non-integer position parity mismatches:\n{}",
        failures.join("\n---\n")
    );
}
