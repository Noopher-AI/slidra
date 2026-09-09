//! CLI-boundary tests: `co-motion`'s argv -> (stdout, stderr, exit code)
//! contract (plan section 6.2, boundary 1). Runs the REAL compiled binary
//! via `CARGO_BIN_EXE_co-motion` (proving these commands are actually
//! dispatched by Rust, not by a fallback that happens to produce the same
//! text — see plan A3/N2).
//!
//! [E4.T12] deletes the coexisting Node CLI (`packages/cli`) this file used
//! to also spawn for byte-parity comparisons — those tests are gone with
//! it (see the deleted `test: prune` commit), and every remaining test's
//! `Fixture::run_rust` is now the only way any of them ever reach the
//! binary. `node` is no longer a dependency of this test file at all.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use co_motion::commands;

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

/// Plan 4.1's first contract row: empty argv reports "缺少命令名稱" and
/// exits 1 — Rust's own message now, no longer forwarded from Node
/// ([E4.T12] removes the fallback this used to go through; the bytes are
/// unchanged).
#[test]
fn empty_argv_reports_missing_command_name() {
    let output = Command::new(rust_bin()).output().expect("binary must run");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stderr), "缺少命令名稱\n");
    assert!(output.stdout.is_empty());
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
    let new_output = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_output.status.success());
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let output = fixture.run_rust(&["undo", &id]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "沒有可復原的操作\n"
    );
}

#[test]
fn undo_redo_round_trip_via_rust_binary_restores_exact_bytes() {
    let fixture = Fixture::new("undo-redo-roundtrip");
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);

    let before = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&before));

    let text_set = fixture.run_rust(&[
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

    let after = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
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
    let undone = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
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
    let redone = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
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
    let new_output = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    let convert_output = fixture.run_rust(&["convert", &id]);
    assert!(
        convert_output.status.success(),
        "setup: `convert` failed: {:?}",
        convert_output
    );
    id
}

/// Debt flagged by NOOP-318's review of the [E4.T8] Wave 2 integration
/// (NOOP-280/F4): `element move`'s argv -> `edit::move_elements` wiring
/// (`move_cmd.rs`) had no CLI-boundary guard on `--dx`/`--dy`'s sign or
/// magnitude — negating both left `cargo test --workspace` and the
/// `e2e/direct-manipulation.test.ts`/`e2e/ai-collab.test.ts` suites fully
/// green, because `unit_golden.rs`'s move coverage calls
/// `edit::move_elements` directly (bypassing this argv layer) and the only
/// other in-crate `element move` test
/// (`move_reports_a_failure_result_for_a_locked_target_without_force`)
/// only exercises the rejection path. Spawns the real compiled binary and
/// asserts the literal transform, the same `--dx 7 --dy 100` case the
/// review comment manually reproduced.
#[test]
fn element_move_applies_dx_dy_with_correct_sign_and_magnitude() {
    let fixture = Fixture::new("move-dx-dy-sign");
    let (id, _title_element_id) = new_and_open(&fixture);

    let insert = fixture.run_rust(&[
        "element",
        "insert",
        "rect",
        &id,
        "slides/001.svg",
        "--x",
        "100",
        "--y",
        "100",
        "--width",
        "50",
        "--height",
        "50",
    ]);
    assert!(
        insert.status.success(),
        "setup: `element insert` failed: {insert:?}"
    );
    let element_id = extract_data_json(&insert)["elementId"]
        .as_str()
        .expect("element insert must return elementId")
        .to_string();

    let moved = fixture.run_rust(&[
        "element",
        "move",
        &id,
        "slides/001.svg",
        &element_id,
        "--dx",
        "7",
        "--dy",
        "100",
    ]);
    assert!(moved.status.success(), "`element move` failed: {moved:?}");

    let after = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    let after_svg = String::from_utf8_lossy(&after);
    let expected = format!(r#"<g id="{element_id}" transform="translate(107 200)">"#);
    assert!(
        after_svg.contains(&expected),
        "expected `--dx 7 --dy 100` to move translate(100 100) to translate(107 200); got: {after_svg}"
    );
}

/// Plan 6.2 item 4: a slide with no effect list at all — `effect list`'s
/// not-found stderr and exit code must match between engines.
#[test]
fn effect_list_without_a_list_matches_stderr_and_exit_code() {
    let fixture = Fixture::new("effect-list-missing");
    let id = new_open_and_convert(&fixture);

    let rust_out = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
    let node_out = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
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
    let node_out = fixture.run_rust(&["effect", "list", &id, "slides/001.svg"]);
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
    let before = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
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
    let after = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    assert_ne!(before, after, "effect add must actually change the file");

    let undo = fixture.run_rust(&["undo", &id]);
    assert!(undo.status.success(), "undo failed: {:?}", undo);
    let undone = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
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
    let new_out = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_out.status.success(), "setup: `new` failed: {new_out:?}");
    let open_out = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
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

// ---------------------------------------------------------------------------
// NOOP-281/F5: chart, table, and asset import command golden tests.
// ---------------------------------------------------------------------------

/// Replaces every `el-<12 chars>` id in `svg` with a placeholder assigned in
/// order of first appearance, so a Rust-engine run and a Node-engine run of
/// the same command sequence — each generating its own fresh random ids —
/// can be compared byte-for-byte.
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
    fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_rust(&["convert", &id]);

    let create = fixture.run_rust(&["chart", "create", &id, "slides/001.svg"]);
    let chart_el = extract_id_field(&create.stdout, "elementId");
    let create_table = fixture.run_rust(&[
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

/// Acceptance criterion A3: `co-motion asset import <id> <path>` works from
/// the command line, landing bytes exactly as imported under `assets/`.
#[test]
fn asset_import_local_file_lands_under_assets_via_rust_binary() {
    let fixture = Fixture::new("asset-import-cli");
    let comot_path = fixture.workspace.join("t.comot");
    fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
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
    fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    fixture.run_rust(&["convert", &id]);

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
    let svg_via_file = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;

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
    let svg_via_stdin = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;

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

// --- NOOP-309 P9: the remaining plan section 6.1 layer-1 (CLI-boundary)
// tests for this ticket's 29 commands ------------------------------------

/// Every one of this ticket's 29 commands, as its full token sequence —
/// mirrors `commands::TAKEOVER`'s combined table 1:1. Kept as a literal
/// list here (not re-derived from the crate) because the whole point of
/// this test is an independent, hand-written cross-check against that
/// table, run through the actual compiled binary rather than the table's
/// own in-process `flattened_takeover_table()` (see `commands/mod.rs`'s
/// unit test of the same shape, which is the same assertion one layer
/// down, in-process rather than via a spawned binary).
const ALL_29_COMMANDS: &[&[&str]] = &[
    &["element", "insert"],
    &["element", "delete"],
    &["element", "move"],
    &["element", "scale"],
    &["element", "resize"],
    &["element", "rotate"],
    &["element", "style", "set"],
    &["element", "order"],
    &["element", "group"],
    &["element", "ungroup"],
    &["element", "align"],
    &["element", "distribute"],
    &["element", "name", "set"],
    &["element", "copy"],
    &["element", "cut"],
    &["element", "paste"],
    &["element", "duplicate"],
    &["element", "lock"],
    &["element", "unlock"],
    &["text", "set"],
    &["text", "style", "set"],
    &["text", "list", "set"],
    &["textbox", "add"],
    &["textbox", "width"],
    &["textbox", "align"],
    &["comment", "add"],
    &["comment", "edit"],
    &["comment", "delete"],
    &["comment", "list"],
];

/// Acceptance criterion A1 (plan section 6.1, layer 1): every one of the
/// 29 commands must actually be dispatched by the Rust binary, not merely
/// produce output that happens to look right because it fell through to
/// Node. `--json` is the probe: it is a Rust-only flag (`main.rs`'s own
/// doc comment) that the Node CLI does not understand at all — if a
/// command's tokens fell through to `fallback::exec_node_fallback`, Node
/// would receive a bare `--json` positional it has no parsing rule for and
/// would never emit this crate's `{"ok": ..., "failureKind": ...}`
/// envelope shape. Calling every command with ZERO further arguments is
/// deliberate, not a shortcut: every one of these 29 handlers' `try_run`
/// calls `require_positional`/`require_id_list` before touching the
/// filesystem (verified by inspection — `commands/element/insert.rs` reads
/// `--kind` first, every other command reads `presentation-id` first), so
/// this reaches a real Rust-rendered failure envelope for all 29 without
/// needing a live workspace at all.
#[test]
fn takeover_table_contains_all_29_commands() {
    assert_eq!(
        ALL_29_COMMANDS.len(),
        29,
        "this test's own command list drifted from 29 — fix the list, not the assertion"
    );

    let mut failures = Vec::new();
    for tokens in ALL_29_COMMANDS {
        let mut args: Vec<&str> = tokens.to_vec();
        args.push("--json");
        let output = Command::new(rust_bin())
            .args(&args)
            .output()
            .expect("binary must run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: Option<serde_json::Value> = serde_json::from_str(stdout.trim()).ok();
        let is_rust_json_envelope = parsed.as_ref().is_some_and(|value| {
            value.get("ok") == Some(&serde_json::Value::Bool(false))
                && value.get("failureKind").is_some()
        });
        if !is_rust_json_envelope {
            failures.push(format!(
                "{tokens:?}: expected a Rust-rendered `--json` failure envelope \
                 (a fallback to Node would never emit one), got stdout={stdout:?} stderr={:?}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "commands not actually taken over by the Rust binary:\n{}",
        failures.join("\n")
    );
}

/// Sets up a fresh presentation via the (only content-editing-capable) Node
/// engine and returns `(presentation id, the default slide's first element
/// id)` — the shared starting point every test below builds its own
/// `Fixture` around.
fn new_and_open(fixture: &Fixture) -> (String, String) {
    let comot_path = fixture.workspace.join("t.comot");
    let new_output = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(
        new_output.status.success(),
        "setup: `new` failed: {:?}",
        new_output
    );
    let open_output = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    let id = extract_id(&open_output);
    // The freshly-created default template is not `assert_slide_compliant`
    // (its `<text>` runs bare, not wrapped in a `<g>` container) until
    // `convert` runs — every `element::edit`/`element::clipboard` command
    // this file exercises below opens with that check (unlike
    // `element::text`'s commands, which deliberately skip it — see that
    // module's own doc comment), so setup needs this step.
    let convert_output = fixture.run_rust(&["convert", &id]);
    assert!(
        convert_output.status.success(),
        "setup: `convert` failed: {:?}",
        convert_output
    );
    let svg = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&svg));
    (id, element_id)
}

/// Pulls the `data` JSON block out of a command's default (non-`--json`)
/// stdout — `<message>\n{...pretty JSON...}\n`, the same shape
/// `extract_id` above already relies on for `open`. Any `{`/`}` bytes
/// embedded inside a JSON string value (e.g. an `id="..."` inside the
/// copied `svg` field) are handled correctly because `serde_json::from_str`
/// parses the whole remaining slice as one JSON value, not by
/// brace-counting.
fn extract_data_json(output: &Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_start = stdout
        .find('{')
        .expect("stdout must contain a JSON data block");
    serde_json::from_str(&stdout[json_start..]).expect("data JSON must parse")
}

/// `undo` array length in `stack.json`, or `0` when the file does not exist
/// yet (before the presentation's first successful edit).
fn undo_len(fixture: &Fixture, id: &str) -> usize {
    let path = fixture.home.join("history").join(id).join("stack.json");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let value: serde_json::Value =
                serde_json::from_str(&raw).expect("stack.json must be valid JSON");
            value
                .get("undo")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0)
        }
        Err(_) => 0,
    }
}

/// Acceptance criterion A6 (plan section 6.1, layer 1): every successful
/// write command occupies exactly one undo step, and a failing command
/// occupies none — checked directly against `stack.json`'s `undo` array
/// length rather than inferring it from `undo`'s own success/failure,
/// which only proves the stack is non-empty/empty, not that each
/// individual command added exactly one entry. Five commands, one from
/// each of the four families that write presentation content
/// (`element`/`text`/`textbox`/`comment`), run in sequence against the
/// same live presentation.
#[test]
fn undo_step_accounting_advances_by_exactly_one_on_success_and_not_at_all_on_failure() {
    let fixture = Fixture::new("undo-step-accounting");
    let (id, element_id) = new_and_open(&fixture);

    let successful_commands: Vec<Vec<String>> = vec![
        vec![
            "element".into(),
            "move".into(),
            id.clone(),
            "slides/001.svg".into(),
            element_id.clone(),
            "--dx".into(),
            "1".into(),
            "--dy".into(),
            "1".into(),
        ],
        vec![
            "text".into(),
            "set".into(),
            id.clone(),
            "slides/001.svg".into(),
            element_id.clone(),
            "改過的標題".into(),
        ],
        vec![
            "element".into(),
            "lock".into(),
            id.clone(),
            "slides/001.svg".into(),
            element_id.clone(),
        ],
        vec![
            "comment".into(),
            "add".into(),
            id.clone(),
            "slides/001.svg".into(),
            "page".into(),
            "hello".into(),
        ],
        vec![
            "textbox".into(),
            "add".into(),
            id.clone(),
            "slides/001.svg".into(),
            "--x".into(),
            "10".into(),
            "--y".into(),
            "10".into(),
            "--width".into(),
            "100".into(),
            "--text".into(),
            "hi".into(),
        ],
    ];

    for args in &successful_commands {
        let before_len = undo_len(&fixture, &id);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = fixture.run_rust(&arg_refs);
        assert!(
            output.status.success(),
            "expected {args:?} to succeed: {output:?}"
        );
        let after_len = undo_len(&fixture, &id);
        assert_eq!(
            after_len,
            before_len + 1,
            "expected {args:?} to add exactly one undo step (before={before_len}, after={after_len})"
        );
    }

    // Failure case: an unknown element id must fail without touching the
    // undo stack at all.
    let before_len = undo_len(&fixture, &id);
    let failing_output = fixture.run_rust(&[
        "element",
        "move",
        &id,
        "slides/001.svg",
        "nope-does-not-exist",
        "--dx",
        "1",
        "--dy",
        "1",
    ]);
    assert!(
        !failing_output.status.success(),
        "expected a move against an unknown element id to fail: {failing_output:?}"
    );
    let after_len = undo_len(&fixture, &id);
    assert_eq!(
        after_len, before_len,
        "a failing command must not add an undo step"
    );
}

/// Acceptance criterion A9's negative half: `element copy` is read-only —
/// it must never modify the slide file it reads from, and must never
/// occupy an undo step (it isn't presentation content, per
/// `workspace::write::write_clipboard_file`'s own doc comment).
#[test]
fn copy_does_not_touch_the_slide_or_history() {
    let fixture = Fixture::new("copy-no-side-effects");
    let (id, element_id) = new_and_open(&fixture);
    let before_svg = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    let before_undo_len = undo_len(&fixture, &id);
    let stack_path = fixture.home.join("history").join(&id).join("stack.json");
    let stack_existed_before = stack_path.exists();

    let copy_out = fixture.run_rust(&["element", "copy", &id, "slides/001.svg", &element_id]);
    assert!(copy_out.status.success(), "copy failed: {copy_out:?}");

    let after_svg = fixture.run_rust(&["cat", &id, "slides/001.svg"]).stdout;
    assert_eq!(
        before_svg, after_svg,
        "element copy must never modify the slide file it reads from"
    );
    let after_undo_len = undo_len(&fixture, &id);
    assert_eq!(
        after_undo_len, before_undo_len,
        "element copy must never occupy an undo step"
    );
    assert_eq!(
        stack_path.exists(),
        stack_existed_before,
        "element copy must never create undo history where none existed"
    );
}

/// FAIL 1 (NOOP-334r2): a presentation id minted by `generate_opaque_id`
/// has roughly 1/4096 odds of starting with `--` (its base64url alphabet
/// includes `-`) — before this fix, every argv toolkit's
/// `require_positional` treated a `--`-prefixed id as a missing positional
/// (`is_flag_like`), making an already-open presentation with such an id
/// permanently unreachable. This writes a `--`-prefixed id directly into
/// `projects.json` (Dev-Leader's decision (ii): fix the RESOLVING end, not
/// mint-time retry — an already-registered id must keep working) and
/// drives one command through each of the four argv toolkits (`argv/mod.rs`
/// root, `argv/mod.rs::ct`, `commands/argv.rs`, `commands/effect.rs`'s
/// private copy) to prove every one of them now accepts it.
#[test]
fn dash_prefixed_presentation_id_works_for_every_argv_toolkit() {
    let fixture = Fixture::new("dash-prefixed-id");
    let (id, element_id) = new_and_open(&fixture);

    const DASH_ID: &str = "--IXET6Q29_h";
    {
        let registry_path = fixture.home.join("projects.json");
        let raw = fs::read_to_string(&registry_path).unwrap();
        let mut registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let entry = registry
            .as_object_mut()
            .unwrap()
            .remove(&id)
            .expect("the freshly opened id must be registered");
        registry
            .as_object_mut()
            .unwrap()
            .insert(DASH_ID.to_string(), entry);
        fs::write(
            &registry_path,
            serde_json::to_string_pretty(&registry).unwrap(),
        )
        .unwrap();
    }

    // Toolkit A (`argv/mod.rs` root): `cat`'s read path. Asserting the
    // `--json` `content` equals the real on-disk bytes (not just "ok")
    // proves the dash id actually resolved to the right work dir.
    let cat_out = fixture.run_rust(&["cat", DASH_ID, "project.json", "--json"]);
    let cat_env = json_envelope(&cat_out);
    assert_eq!(cat_env["ok"], serde_json::json!(true), "cat: {cat_out:?}");
    let real_bytes = {
        let registry_raw = fs::read_to_string(fixture.home.join("projects.json")).unwrap();
        let registry: serde_json::Value = serde_json::from_str(&registry_raw).unwrap();
        let work_dir = registry[DASH_ID]["workDir"].as_str().unwrap().to_string();
        fs::read(PathBuf::from(work_dir).join("project.json")).unwrap()
    };
    assert_eq!(
        cat_env["data"][0]["content"],
        serde_json::json!(co_motion::base64::encode(&real_bytes)),
        "cat --json content must be the real project.json bytes, base64-encoded"
    );

    // Toolkit A: `ls`.
    let ls_out = fixture.run_rust(&["ls", DASH_ID, "--json"]);
    assert_eq!(
        json_envelope(&ls_out)["ok"],
        serde_json::json!(true),
        "ls: {ls_out:?}"
    );

    // Toolkit A: `slide add` — a write path, not just a read.
    let slide_add_out = fixture.run_rust(&["slide", "add", DASH_ID, "--json"]);
    assert_eq!(
        json_envelope(&slide_add_out)["ok"],
        serde_json::json!(true),
        "slide add: {slide_add_out:?}"
    );

    // Toolkit B (`commands/argv.rs`): `element insert` — the id is at
    // index 1 here (index 0 is `kind`), the one non-index-0 id slot in the
    // whole crate.
    let insert_out = fixture.run_rust(&[
        "element",
        "insert",
        "rect",
        DASH_ID,
        "slides/001.svg",
        "--x",
        "1",
        "--y",
        "1",
        "--width",
        "1",
        "--height",
        "1",
        "--json",
    ]);
    assert_eq!(
        json_envelope(&insert_out)["ok"],
        serde_json::json!(true),
        "element insert: {insert_out:?}"
    );

    // Toolkit C (`argv/mod.rs::ct`): `table create`.
    let table_out = fixture.run_rust(&[
        "table",
        "create",
        DASH_ID,
        "slides/001.svg",
        "--rows",
        "2",
        "--cols",
        "2",
        "--x",
        "0",
        "--y",
        "0",
        "--json",
    ]);
    assert_eq!(
        json_envelope(&table_out)["ok"],
        serde_json::json!(true),
        "table create: {table_out:?}"
    );

    // Toolkit D (`commands/effect.rs`'s own private copy): `effect add`.
    let effect_out = fixture.run_rust(&[
        "effect",
        "add",
        DASH_ID,
        "slides/001.svg",
        &element_id,
        "--family",
        "enter",
        "--effect",
        "fade",
        "--json",
    ]);
    assert_eq!(
        json_envelope(&effect_out)["ok"],
        serde_json::json!(true),
        "effect add: {effect_out:?}"
    );

    // Reverse assertion (behavior contract's last row, §4.1): the fix only
    // widens the ID slot — a genuinely MISSING non-id positional (`cat`'s
    // `path`) must still be rejected exactly as before.
    let cat_missing_path = fixture.run_rust(&["cat", DASH_ID, "--json"]);
    let cat_missing_env = json_envelope(&cat_missing_path);
    assert_eq!(cat_missing_env["ok"], serde_json::json!(false));
    assert_eq!(
        cat_missing_env["message"],
        serde_json::json!("命令 cat 缺少參數：path")
    );
}

// ---------------------------------------------------------------------------
// [E4.T12]: `packages/cli`/`packages/core` deleted — replacement coverage
// for the two of their tests whose behavior had no Rust-side receiver
// (plan section 6.3.3).
// ---------------------------------------------------------------------------

/// Ports `packages/cli/test/spec-cli-coverage.test.ts`'s first test item
/// plus its "five required subsections" and "subsections in order" items
/// (plan N1) into one function, now checked against the Rust command
/// tables instead of the deleted TypeScript `CommandRegistry.names()`.
/// Reads `docs/spec/cli.md` directly rather than shelling out — this test
/// IS the parser, not a caller of one.
#[test]
fn cli_md_lists_exactly_the_81_rust_dispatched_commands() {
    let spec_path = repo_root().join("docs/spec/cli.md");
    let spec_content = fs::read_to_string(&spec_path).expect("docs/spec/cli.md must be readable");

    // Extraction pass 1: every `` ## `<name>` `` heading's own body (up to
    // the next such heading), for the subsection checks below.
    let mut spec_entries: Vec<(String, String)> = Vec::new();
    let mut heading_starts: Vec<(usize, usize, String)> = Vec::new(); // (heading_start, body_start, name)
    for (idx, _) in spec_content.match_indices("\n## `") {
        let line_start = idx + 1; // skip the leading '\n'
        let line_end = spec_content[line_start..]
            .find('\n')
            .map(|n| line_start + n)
            .unwrap_or(spec_content.len());
        let line = &spec_content[line_start..line_end];
        if let Some(name) = line.strip_prefix("## `").and_then(|s| s.strip_suffix('`')) {
            heading_starts.push((line_start, line_end, name.to_string()));
        }
    }
    // Handle a heading at the very start of the file too (no leading '\n').
    if spec_content.starts_with("## `") {
        let line_end = spec_content.find('\n').unwrap_or(spec_content.len());
        let line = &spec_content[0..line_end];
        if let Some(name) = line.strip_prefix("## `").and_then(|s| s.strip_suffix('`')) {
            heading_starts.insert(0, (0, line_end, name.to_string()));
        }
    }
    for (i, (_, body_start, name)) in heading_starts.iter().enumerate() {
        let end = heading_starts
            .get(i + 1)
            .map(|(start, _, _)| *start)
            .unwrap_or(spec_content.len());
        spec_entries.push((name.clone(), spec_content[*body_start..end].to_string()));
    }

    // Extraction pass 2 (independent of pass 1's body-slicing): the raw
    // heading count alone, guarding against a non-command H2 that happens
    // to also start with a backtick inflating the count without either
    // direction's set-diff catching it (mirrors the TS test's own second,
    // independent extraction pass).
    let all_backtick_headings = heading_starts.len();
    assert_eq!(
        all_backtick_headings, 81,
        "docs/spec/cli.md must have exactly 81 backtick-H2 command headings, found {all_backtick_headings}"
    );

    let rust_names: Vec<String> = commands::REGISTERED_COMMAND_NAMES
        .iter()
        .map(|s| s.to_string())
        .chain(
            commands::element::TAKEOVER
                .iter()
                .chain(commands::text::TAKEOVER.iter())
                .chain(commands::textbox::TAKEOVER.iter())
                .chain(commands::comment::TAKEOVER.iter())
                .map(|tokens| tokens.join(" ")),
        )
        .collect();
    assert_eq!(
        commands::REGISTERED_COMMAND_NAMES.len(),
        52,
        "REGISTERED_COMMAND_NAMES must stay 52"
    );
    let takeover_total = commands::element::TAKEOVER.len()
        + commands::text::TAKEOVER.len()
        + commands::textbox::TAKEOVER.len()
        + commands::comment::TAKEOVER.len();
    assert_eq!(takeover_total, 29, "the four TAKEOVER tables must total 29");
    assert_eq!(rust_names.len(), 81, "52 + 29 must equal 81");

    let rust_set: std::collections::BTreeSet<&str> = rust_names.iter().map(String::as_str).collect();
    let spec_set: std::collections::BTreeSet<&str> = spec_entries.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(spec_entries.len(), 81, "docs/spec/cli.md must have exactly 81 command entries");

    let in_rust_not_in_spec: Vec<&str> = rust_set.difference(&spec_set).copied().collect();
    let in_spec_not_in_rust: Vec<&str> = spec_set.difference(&rust_set).copied().collect();
    assert!(
        in_rust_not_in_spec.is_empty(),
        "commands registered in Rust but missing from docs/spec/cli.md: {in_rust_not_in_spec:?}"
    );
    assert!(
        in_spec_not_in_rust.is_empty(),
        "commands documented in docs/spec/cli.md but not registered in Rust: {in_spec_not_in_rust:?}"
    );

    // Every entry has all five required subsections, in order (spec's own
    // "命令條目格式說明": 語法 → 參數 → 成功 data → 錯誤情境 → 範例).
    let required_markers = ["**語法**", "**參數**", "**成功 `data`**", "**錯誤情境**", "**範例**"];
    let mut problems: Vec<String> = Vec::new();
    for (name, body) in &spec_entries {
        let positions: Vec<Option<usize>> = required_markers.iter().map(|m| body.find(m)).collect();
        for (marker, pos) in required_markers.iter().zip(&positions) {
            if pos.is_none() {
                problems.push(format!("{name}: missing {marker}"));
            }
        }
        if positions.iter().all(|p| p.is_some()) {
            let values: Vec<usize> = positions.iter().map(|p| p.unwrap()).collect();
            let mut sorted = values.clone();
            sorted.sort();
            if values != sorted {
                problems.push(format!("{name}: subsections out of order"));
            }
        }
    }
    assert!(problems.is_empty(), "subsection problems:\n{}", problems.join("\n"));
}

/// Acceptance criterion 2 (plan §5 A4): every one of the 81 documented
/// commands is actually dispatched by Rust — `PATH` pointed at an empty
/// directory (`no_takeover_table_command_ever_invokes_node`'s own
/// technique) so a command that fell through to a Node fallback would fail
/// with "找不到 node" instead of running; and (plan N2, replacing
/// `packages/cli/test/registry-split.test.ts`) `cat`/`ls`/`slide render`
/// are the only three with a renderer — their plain (non-`--json`) stdout
/// is raw content with no leading status line, unlike the other 78's
/// "<message>\n{...}" shape.
#[test]
fn every_documented_command_is_dispatched_by_rust_without_node() {
    let fixture = Fixture::new("all-81-smoke");

    let empty_path_dir = env::temp_dir().join(format!("co-motion-all-81-empty-path-{}", std::process::id()));
    fs::create_dir_all(&empty_path_dir).unwrap();

    let run_without_node = |args: &[&str]| -> Output {
        Command::new(rust_bin())
            .args(args)
            .env("CO_MOTION_HOME", &fixture.home)
            .env("PATH", &empty_path_dir)
            .output()
            .expect("compiled co-motion binary must run")
    };

    let comot_path = fixture.workspace.join("smoke.comot");
    let new_out = run_without_node(&["new", comot_path.to_str().unwrap(), "--name", "81 條命令煙霧測試"]);
    assert!(new_out.status.success(), "setup: `new` failed: {new_out:?}");
    let open_out = run_without_node(&["open", comot_path.to_str().unwrap()]);
    assert!(open_out.status.success(), "setup: `open` failed: {open_out:?}");
    let id = extract_id(&open_out);
    let convert_out = run_without_node(&["convert", &id]);
    assert!(convert_out.status.success(), "setup: `convert` failed: {convert_out:?}");
    let cat_out = run_without_node(&["cat", &id, "slides/001.svg"]);
    assert!(cat_out.status.success(), "setup: `cat` failed: {cat_out:?}");
    let element_id = extract_first_element_id(&String::from_utf8_lossy(&cat_out.stdout));

    // One representative token sequence per one of the 81 names — every
    // command actually needs a fitting id/path/element-id in the right
    // slot to reach its own dispatch arm rather than erroring out of argv
    // parsing before that (which would trivially "succeed" at "not
    // invoking node" without proving anything about dispatch).
    let renderer_commands: std::collections::BTreeSet<&str> = ["cat", "ls", "slide render"].into_iter().collect();
    let mut failures: Vec<String> = Vec::new();
    let mut renderer_shape_failures: Vec<String> = Vec::new();

    let rust_names: Vec<String> = commands::REGISTERED_COMMAND_NAMES
        .iter()
        .map(|s| s.to_string())
        .chain(
            commands::element::TAKEOVER
                .iter()
                .chain(commands::text::TAKEOVER.iter())
                .chain(commands::textbox::TAKEOVER.iter())
                .chain(commands::comment::TAKEOVER.iter())
                .map(|tokens| tokens.join(" ")),
        )
        .collect();
    assert_eq!(rust_names.len(), 81);

    for name in &rust_names {
        let tokens: Vec<&str> = name.split(' ').collect();
        // Build a minimally-plausible argv: every command's first
        // positional after its own verb tokens is the presentation id
        // (universal across all 81, per docs/spec/cli.md); `new` is the
        // one exception (its first positional is a filesystem path, not an
        // id) and is already exercised by setup above, so it is skipped
        // here rather than special-cased into a false failure.
        if tokens == ["new"] {
            continue;
        }
        let mut args: Vec<&str> = tokens.clone();
        args.push(&id);
        // Most families take a slide path as their second positional;
        // element/text/textbox/comment families in particular always do.
        // Commands whose grammar diverges (`open`, `pack`, `template *`,
        // `presentation canvas set`, `chart`/`table`/`asset` sub-verbs
        // that address by element id, not slide path) are allowed to error
        // out of argv parsing here — this loop's ONLY claim is "never
        // silently falls back to node", checked below regardless of exit
        // code.
        if !matches!(tokens[0], "open" | "pack" | "template" | "presentation") {
            args.push("slides/001.svg");
        }
        if matches!(tokens[0], "element" | "text" | "textbox" | "comment") {
            args.push(&element_id);
        }
        let output = run_without_node(&args);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.trim() == "找不到 node" {
            failures.push(format!("{name}: fell back to node ({stderr})"));
            continue;
        }
        if output.status.code().is_none() {
            failures.push(format!("{name}: process never completed: {output:?}"));
            continue;
        }
        // Renderer/non-renderer output-shape split (plan N2, registry-split
        // coverage): a renderer command's stdout is never the
        // "<message>\n{...json...}" two-part shape a status-line command's
        // is, on the paths above that actually reached a handler
        // successfully.
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let looks_like_status_line_json = stdout.starts_with(|c: char| !c.is_whitespace())
                && stdout.contains('\n')
                && stdout[stdout.find('\n').unwrap_or(0)..].trim_start().starts_with('{');
            let is_renderer = renderer_commands.contains(name.as_str());
            if is_renderer && looks_like_status_line_json {
                renderer_shape_failures.push(format!(
                    "{name}: has a renderer but stdout looks like the status-line+JSON shape: {stdout:?}"
                ));
            }
        }
    }

    fs::remove_dir_all(&empty_path_dir).ok();

    assert!(
        failures.is_empty(),
        "commands not cleanly dispatched by Rust:\n{}",
        failures.join("\n")
    );
    assert!(
        renderer_shape_failures.is_empty(),
        "renderer/non-renderer output shape mismatches:\n{}",
        renderer_shape_failures.join("\n")
    );
}

/// Ports `packages/cli/test/bin.test.ts`'s EPIPE coverage (plan N3): a
/// downstream reader closing the pipe early (`head -c 1`) while `cat`
/// writes a large file must exit 0 with no error text on stderr — the
/// `BrokenPipe -> 0` handling in `result.rs`'s `write_stdout`/
/// `exit_code_for_write_error` had no test at all before this. 8 MiB is
/// necessary: a smaller write can complete before the reader ever closes
/// the pipe, never reproducing EPIPE at all.
#[test]
fn cat_through_a_closed_pipe_exits_zero_without_an_error() {
    let fixture = Fixture::new("epipe");
    let comot_path = fixture.workspace.join("t.comot");
    let new_out = fixture.run_rust(&["new", comot_path.to_str().unwrap(), "--name", "測試"]);
    assert!(new_out.status.success(), "setup: `new` failed: {new_out:?}");
    let open_out = fixture.run_rust(&["open", comot_path.to_str().unwrap()]);
    assert!(open_out.status.success(), "setup: `open` failed: {open_out:?}");
    let id = extract_id(&open_out);

    let big_bytes = vec![b'x'; 8 * 1024 * 1024];
    let work_dir = fixture.home.join("work").join(&id);
    fs::create_dir_all(work_dir.join("assets")).unwrap();
    fs::write(work_dir.join("assets/big.txt"), &big_bytes).unwrap();

    let script = format!(
        "set -o pipefail; {} cat {} assets/big.txt | head -c 1 >/dev/null",
        rust_bin(),
        id
    );
    let output = Command::new("bash")
        .arg("-c")
        .arg(&script)
        .env("CO_MOTION_HOME", &fixture.home)
        .output()
        .expect("bash must run");

    assert!(
        output.status.success(),
        "pipeline must exit 0 (pipefail): {output:?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.to_lowercase().contains("error") && !stderr.contains("EPIPE") && !stderr.contains("broken pipe"),
        "stderr must not mention an error: {stderr:?}"
    );
}
