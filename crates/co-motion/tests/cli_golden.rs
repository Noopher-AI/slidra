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
