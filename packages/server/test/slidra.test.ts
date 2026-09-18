// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARGV_ENCODERS, COMMAND_WHITELIST, encodeCommandArgv } from "../src/slidra/argv.js";
import { runJsonCommand } from "../src/slidra/command.js";
import { readPresentationBytes, readPresentationText, renderSlide } from "../src/slidra/reads.js";

const ID = "P1";
const SLIDE = "slides/001.svg";

/**
 * One representative `input` per whitelisted command, and the exact argv
 * `encodeCommandArgv` must produce for it (§3.9's own argv syntax, taken
 * directly from `docs/spec/cli.md` — not from `argv.ts`'s own source, so
 * this is an independent check of the encoding, not a restatement of it).
 * `element paste` and `table cell paste` (the two commands with a
 * temp-file argument) are asserted separately, below.
 */
const CASES: Array<{ name: string; input: Record<string, unknown>; argv: string[] }> = [
  { name: "element move", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a", "el-b"], dx: 10, dy: -5, force: true },
    argv: ["element", "move", ID, SLIDE, "el-a,el-b", "--dx", "10", "--dy", "-5", "--force"] },
  { name: "element scale", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], factor: 2 },
    argv: ["element", "scale", ID, SLIDE, "el-a", "--factor", "2"] },
  { name: "element rotate", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], degrees: 30 },
    argv: ["element", "rotate", ID, SLIDE, "el-a", "--degrees", "30"] },
  { name: "textbox width", input: { id: ID, slidePath: SLIDE, elementId: "el-t", width: 200 },
    argv: ["textbox", "width", ID, SLIDE, "el-t", "200"] },
  { name: "text set", input: { id: ID, slidePath: SLIDE, elementId: "el-a", newText: "hello", force: true },
    argv: ["text", "set", ID, SLIDE, "el-a", "hello", "--force"] },
  { name: "slide add", input: { id: ID, templatePath: "templates/001.svg", at: 2 },
    argv: ["slide", "add", ID, "--template", "templates/001.svg", "--at", "2"] },
  { name: "slide delete", input: { id: ID, slidePath: SLIDE }, argv: ["slide", "delete", ID, SLIDE] },
  { name: "slide duplicate", input: { id: ID, slidePath: SLIDE }, argv: ["slide", "duplicate", ID, SLIDE] },
  { name: "slide move", input: { id: ID, slidePath: SLIDE, newIndex: 0 }, argv: ["slide", "move", ID, SLIDE, "0"] },
  { name: "slide notes set", input: { id: ID, slidePath: SLIDE, text: "notes" }, argv: ["slide", "notes", "set", ID, SLIDE, "notes"] },
  { name: "element copy", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"] }, argv: ["element", "copy", ID, SLIDE, "el-a"] },
  { name: "element cut", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"] }, argv: ["element", "cut", ID, SLIDE, "el-a"] },
  { name: "element insert", input: { id: ID, slidePath: SLIDE, kind: "rect", x: 10, y: 20, width: 30, height: 40, fill: "#000" },
    argv: ["element", "insert", "rect", ID, SLIDE, "--x", "10", "--y", "20", "--width", "30", "--height", "40", "--fill", "#000"] },
  { name: "textbox add", input: { id: ID, slidePath: SLIDE, x: 1, y: 2, width: 3, text: "hi", fontSize: 14 },
    argv: ["textbox", "add", ID, SLIDE, "--x", "1", "--y", "2", "--width", "3", "--text", "hi", "--font-size", "14"] },
  { name: "element align", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a", "el-b"], direction: "left" },
    argv: ["element", "align", ID, SLIDE, "el-a,el-b", "left"] },
  { name: "element distribute", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a", "el-b"], axis: "horizontal" },
    argv: ["element", "distribute", ID, SLIDE, "el-a,el-b", "horizontal"] },
  { name: "element order", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], direction: "front" },
    argv: ["element", "order", ID, SLIDE, "el-a", "front"] },
  { name: "element style set", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], attr: "fill", value: "#fff" },
    argv: ["element", "style", "set", ID, SLIDE, "el-a", "fill", "#fff"] },
  { name: "slide transition set", input: { id: ID, slidePath: SLIDE, enter: "fade", enterDuration: 0.5, exit: "zoom", exitDuration: 0.3, all: true },
    argv: ["slide", "transition", "set", ID, SLIDE, "--enter", "fade", "--enter-duration", "0.5", "--exit", "zoom", "--exit-duration", "0.3", "--all"] },
  { name: "template add", input: { id: ID, from: SLIDE, name: "tpl" }, argv: ["template", "add", ID, "--from", SLIDE, "--name", "tpl"] },
  { name: "template list", input: { id: ID }, argv: ["template", "list", ID] },
  { name: "template rename", input: { id: ID, templatePath: "templates/001.svg", newName: "Cover2" },
    argv: ["template", "rename", ID, "templates/001.svg", "Cover2"] },
  { name: "template delete", input: { id: ID, templatePath: "templates/001.svg" }, argv: ["template", "delete", ID, "templates/001.svg"] },
  { name: "element resize", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], width: 100, height: 50, anchor: "se", force: true },
    argv: ["element", "resize", ID, SLIDE, "el-a", "--width", "100", "--height", "50", "--anchor", "se", "--force"] },
  { name: "element delete", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"] }, argv: ["element", "delete", ID, SLIDE, "el-a"] },
  { name: "element duplicate", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], dx: 5, dy: 5 },
    argv: ["element", "duplicate", ID, SLIDE, "el-a", "--dx", "5", "--dy", "5"] },
  { name: "element group", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a", "el-b"] }, argv: ["element", "group", ID, SLIDE, "el-a,el-b"] },
  { name: "element ungroup", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a", "el-b"] }, argv: ["element", "ungroup", ID, SLIDE, "el-a,el-b"] },
  { name: "element name set", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], name: "CoverVideo" },
    argv: ["element", "name", "set", ID, SLIDE, "el-a", "CoverVideo"] },
  { name: "effect add", input: { id: ID, slidePath: SLIDE, elementIds: ["el-a"], family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0.1, index: 1 },
    argv: ["effect", "add", ID, SLIDE, "el-a", "--family", "enter", "--effect", "fade", "--start", "on-click", "--duration", "0.5", "--delay", "0.1", "--index", "1"] },
  { name: "effect remove", input: { id: ID, slidePath: SLIDE, indices: [1, 2, 3] }, argv: ["effect", "remove", ID, SLIDE, "1,2,3"] },
  { name: "effect move", input: { id: ID, slidePath: SLIDE, index: 1, direction: "up" }, argv: ["effect", "move", ID, SLIDE, "1", "up"] },
  { name: "effect set", input: { id: ID, slidePath: SLIDE, index: 1, effect: "fade", duration: 1 },
    argv: ["effect", "set", ID, SLIDE, "1", "--effect", "fade", "--duration", "1"] },
  { name: "comment add", input: { id: ID, slidePath: SLIDE, target: "el-a", text: "a comment", author: "me" },
    argv: ["comment", "add", ID, SLIDE, "el-a", "a comment", "--author", "me"] },
  { name: "comment edit", input: { id: ID, slidePath: SLIDE, commentId: "c-1", text: "an edited comment" },
    argv: ["comment", "edit", ID, SLIDE, "c-1", "an edited comment"] },
  { name: "comment delete", input: { id: ID, slidePath: SLIDE, commentId: "c-1" }, argv: ["comment", "delete", ID, SLIDE, "c-1"] },
  { name: "table cell copy", input: { id: ID, slidePath: SLIDE, elementId: "el-t", range: "0,0:1,1" },
    argv: ["table", "cell", "copy", ID, SLIDE, "el-t", "--range", "0,0:1,1"] },
  { name: "table cell cut", input: { id: ID, slidePath: SLIDE, elementId: "el-t", range: "0,0:1,1" },
    argv: ["table", "cell", "cut", ID, SLIDE, "el-t", "--range", "0,0:1,1"] },
  { name: "table create", input: { id: ID, slidePath: SLIDE, rows: 2, cols: 2, x: 0, y: 0, colWidth: 50, theme: "light", header: true },
    argv: ["table", "create", ID, SLIDE, "--rows", "2", "--cols", "2", "--x", "0", "--y", "0", "--col-width", "50", "--theme", "light", "--header", "true"] },
  { name: "table cell set", input: { id: ID, slidePath: SLIDE, elementId: "el-t", row: 0, col: 0, text: "x" },
    argv: ["table", "cell", "set", ID, SLIDE, "el-t", "--row", "0", "--col", "0", "--text", "x"] },
  { name: "table cell style set", input: { id: ID, slidePath: SLIDE, elementId: "el-t", row: 0, col: 0, rowEnd: 1, colEnd: 1, attr: "fill", value: "#000" },
    argv: ["table", "cell", "style", "set", ID, SLIDE, "el-t", "--row", "0", "--col", "0", "--row-end", "1", "--col-end", "1", "fill", "#000"] },
  { name: "table merge", input: { id: ID, slidePath: SLIDE, elementId: "el-t", row: 0, col: 0, rowSpan: 2, colSpan: 2, unmerge: false },
    argv: ["table", "merge", ID, SLIDE, "el-t", "--row", "0", "--col", "0", "--row-span", "2", "--col-span", "2"] },
  { name: "table col width", input: { id: ID, slidePath: SLIDE, elementId: "el-t", col: 0, width: 100, keepTotal: true },
    argv: ["table", "col", "width", ID, SLIDE, "el-t", "--col", "0", "--width", "100", "--keep-total"] },
  { name: "table col insert", input: { id: ID, slidePath: SLIDE, elementId: "el-t", at: 1 }, argv: ["table", "col", "insert", ID, SLIDE, "el-t", "--at", "1"] },
  { name: "table col delete", input: { id: ID, slidePath: SLIDE, elementId: "el-t", at: 1 }, argv: ["table", "col", "delete", ID, SLIDE, "el-t", "--at", "1"] },
  { name: "table row insert", input: { id: ID, slidePath: SLIDE, elementId: "el-t", at: 1 }, argv: ["table", "row", "insert", ID, SLIDE, "el-t", "--at", "1"] },
  { name: "table row delete", input: { id: ID, slidePath: SLIDE, elementId: "el-t", at: 1 }, argv: ["table", "row", "delete", ID, SLIDE, "el-t", "--at", "1"] },
  { name: "table theme set", input: { id: ID, slidePath: SLIDE, elementId: "el-t", theme: "dark" },
    argv: ["table", "theme", "set", ID, SLIDE, "el-t", "dark"] },
  { name: "table header set", input: { id: ID, slidePath: SLIDE, elementId: "el-t", header: false },
    argv: ["table", "header", "set", ID, SLIDE, "el-t", "false"] },
  { name: "table bind", input: { id: ID, slidePath: SLIDE, elementId: "el-t", source: "assets/data/sales.csv", templateRow: 1 },
    argv: ["table", "bind", ID, SLIDE, "el-t", "--source", "assets/data/sales.csv", "--template-row", "1"] },
  { name: "table refresh", input: { id: ID, slidePath: SLIDE, elementId: "el-t" }, argv: ["table", "refresh", ID, SLIDE, "el-t"] },
  { name: "table set", input: { id: ID, slidePath: SLIDE, elementId: "el-t", markdown: "# hi" },
    argv: ["table", "set", ID, SLIDE, "el-t", "--markdown", "# hi"] },
  { name: "chart create", input: { id: ID, slidePath: SLIDE, type: "bar", seriesCount: 2, categoriesCount: 3, palette: "default", x: 0, y: 0, width: 400, height: 300 },
    argv: ["chart", "create", ID, SLIDE, "--type", "bar", "--series", "2", "--categories", "3", "--palette", "default", "--x", "0", "--y", "0", "--width", "400", "--height", "300"] },
  { name: "chart data set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", categories: ["a", "b"], series: [{ name: "s1", values: [1, 2] }] },
    argv: ["chart", "data", "set", ID, SLIDE, "el-c", "--categories", "a,b", "--series", "s1=1,2"] },
  { name: "chart type set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", type: "line" },
    argv: ["chart", "type", "set", ID, SLIDE, "el-c", "line"] },
  { name: "chart palette set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", palette: "custom", colors: [{ name: "s1", color: "#fff" }] },
    argv: ["chart", "palette", "set", ID, SLIDE, "el-c", "custom", "--color", "s1=#fff"] },
  { name: "chart axis set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", axes: "dual", right: ["s2"] },
    argv: ["chart", "axis", "set", ID, SLIDE, "el-c", "dual", "--right", "s2"] },
  { name: "chart stack set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", stacked: true },
    argv: ["chart", "stack", "set", ID, SLIDE, "el-c", "on"] },
  { name: "chart legend set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", legend: "bottom" },
    argv: ["chart", "legend", "set", ID, SLIDE, "el-c", "bottom"] },
  { name: "chart option set", input: { id: ID, slidePath: SLIDE, elementId: "el-c", key: "smooth", value: "true" },
    argv: ["chart", "option", "set", ID, SLIDE, "el-c", "smooth", "true"] },
  { name: "textbox align", input: { id: ID, slidePath: SLIDE, elementId: "el-t", align: "center" },
    argv: ["textbox", "align", ID, SLIDE, "el-t", "center"] },
  { name: "slide style set", input: { id: ID, slidePath: SLIDE, background: "#111", accent: "#222" },
    argv: ["slide", "style", "set", ID, SLIDE, "--background", "#111", "--accent", "#222"] },
  { name: "presentation canvas set", input: { id: ID, width: 1024, height: 768 },
    argv: ["presentation", "canvas", "set", ID, "--width", "1024", "--height", "768"] },
];

describe("slidra/argv.ts: encodeCommandArgv", () => {
  it.each(CASES)("$name encodes to the exact argv docs/spec/cli.md's syntax names", async ({ name, input, argv }) => {
    const encoded = await encodeCommandArgv(name, input);
    expect(encoded.argv).toEqual(argv);
    await encoded.cleanup();
  });

  it("element paste stages `svg` to a temp file and appends --svg-file last, honouring dx:0/dy:0", async () => {
    const encoded = await encodeCommandArgv("element paste", { id: ID, slidePath: SLIDE, svg: "<svg>pasted</svg>", dx: 0, dy: 0 });
    expect(encoded.argv.slice(0, -2)).toEqual(["element", "paste", ID, SLIDE, "--dx", "0", "--dy", "0"]);
    expect(encoded.argv[encoded.argv.length - 2]).toBe("--svg-file");
    const tempFile = encoded.argv[encoded.argv.length - 1]!;
    expect(await readFile(tempFile, "utf-8")).toBe("<svg>pasted</svg>");
    await encoded.cleanup();
    await expect(readFile(tempFile, "utf-8")).rejects.toThrow();
  });

  it("table cell paste stages `tsv` to a temp file and appends --tsv-file last", async () => {
    const encoded = await encodeCommandArgv("table cell paste", { id: ID, slidePath: SLIDE, elementId: "el-t", at: "0,0", tsv: "a\tb\nc\td" });
    expect(encoded.argv.slice(0, -2)).toEqual(["table", "cell", "paste", ID, SLIDE, "el-t", "--at", "0,0"]);
    expect(encoded.argv[encoded.argv.length - 2]).toBe("--tsv-file");
    const tempFile = encoded.argv[encoded.argv.length - 1]!;
    expect(await readFile(tempFile, "utf-8")).toBe("a\tb\nc\td");
    await encoded.cleanup();
  });

  // §4.2's boundary cases: 0, "", null, false, elementIds: [], `--json` last.
  it("sends numeric 0 rather than omitting it (falsy-but-legal)", async () => {
    const encoded = await encodeCommandArgv("element move", { id: ID, slidePath: SLIDE, elementIds: ["el-a"], dx: 0, dy: 0 });
    expect(encoded.argv).toEqual(["element", "move", ID, SLIDE, "el-a", "--dx", "0", "--dy", "0"]);
  });

  it("sends an empty string new-text rather than treating it as absent", async () => {
    const encoded = await encodeCommandArgv("text set", { id: ID, slidePath: SLIDE, elementId: "el-a", newText: "" });
    expect(encoded.argv).toEqual(["text", "set", ID, SLIDE, "el-a", ""]);
  });

  it("treats a null optional flag the same as undefined — omitted, never the string \"null\"", async () => {
    const encoded = await encodeCommandArgv("element duplicate", { id: ID, slidePath: SLIDE, elementIds: ["el-a"], dx: null, dy: null });
    expect(encoded.argv).toEqual(["element", "duplicate", ID, SLIDE, "el-a"]);
  });

  it("omits a false boolean flag entirely (same as absent)", async () => {
    const encoded = await encodeCommandArgv("element move", { id: ID, slidePath: SLIDE, elementIds: ["el-a"], dx: 1, dy: 1, force: false });
    expect(encoded.argv).toEqual(["element", "move", ID, SLIDE, "el-a", "--dx", "1", "--dy", "1"]);
  });

  it("an empty elementIds array still occupies its own positional slot as an empty token", async () => {
    const encoded = await encodeCommandArgv("element delete", { id: ID, slidePath: SLIDE, elementIds: [] });
    expect(encoded.argv).toEqual(["element", "delete", ID, SLIDE, ""]);
  });

  it("throws for a name with no encoder, never sending a partial argv", async () => {
    await expect(encodeCommandArgv("not a real command", { id: ID })).rejects.toThrow(/unknown command/);
  });
});

describe("slidra/argv.ts: COMMAND_WHITELIST ⇔ ARGV_ENCODERS key set equality", () => {
  // Takes over the three deleted "every whitelisted name isn't 403'd" loop
  // tests from command-endpoint.test.ts and E2.T14/E2.T12's table/chart
  // variants (plan §6.1) — this is strictly stronger: it also proves every
  // whitelisted name actually encodes to a real argv, as a pure unit test
  // (no server, no subprocess).
  it("COMMAND_WHITELIST and the encoder table name exactly the same 68 commands", () => {
    expect(new Set(Object.keys(ARGV_ENCODERS))).toEqual(new Set(COMMAND_WHITELIST));
  });

  it("COMMAND_WHITELIST has exactly 68 entries, none of them repeated", () => {
    expect(COMMAND_WHITELIST.length).toBe(68);
    expect(new Set(COMMAND_WHITELIST).size).toBe(68);
  });
});

describe("slidra/command.ts: runJsonCommand (envelope parsing, exit-code-blind)", () => {
  let fakeBinDir: string;
  let fakeBinPath: string;
  let previousBin: string | undefined;

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(path.join(tmpdir(), "slidra-slidra-test-fakebin-"));
    fakeBinPath = path.join(fakeBinDir, "slidra-fake.mjs");
    previousBin = process.env.SLIDRA_BIN;
  });

  afterEach(async () => {
    if (previousBin === undefined) delete process.env.SLIDRA_BIN;
    else process.env.SLIDRA_BIN = previousBin;
    await rm(fakeBinDir, { recursive: true, force: true });
  });

  /** Writes a fake `slidra` binary that always prints `stdout` and exits with `exitCode`, and points `SLIDRA_BIN` at it. */
  async function installFakeBin(stdout: string, exitCode = 0, stderr = ""): Promise<void> {
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        `process.stderr.write(${JSON.stringify(stderr)});`,
        `process.stdout.write(${JSON.stringify(stdout)});`,
        `process.exitCode = ${exitCode};`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SLIDRA_BIN = fakeBinPath;
  }

  it("ok:true envelope, exit 0 → {ok:true, data, message}", async () => {
    await installFakeBin('{"ok":true,"data":{"id":"abc"},"message":"opened"}\n');
    const result = await runJsonCommand(["open", "/tmp/x.slidra"]);
    expect(result).toEqual({ ok: true, data: { id: "abc" }, message: "opened" });
  });

  it("ok:false envelope with failureKind, exit 0 → {ok:false, message, failureKind}", async () => {
    await installFakeBin('{"ok":false,"message":"no presentation found for id: x","failureKind":"not-found"}\n');
    const result = await runJsonCommand(["cat", "x", "project.json"]);
    expect(result).toEqual({ ok: false, message: "no presentation found for id: x", failureKind: "not-found" });
  });

  it("ok:false envelope, exit code 0 (§3.3's known Rust/spec mismatch) — still read as ok:false, exit code never consulted", async () => {
    await installFakeBin('{"ok":false,"message":"Command element move missing parameter: --dx","failureKind":"failed"}\n', 0);
    const result = await runJsonCommand(["element", "move", "p1", "s", "el-a"]);
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
  });

  it("ok:true envelope but non-zero exit code — still read as ok:true (e.g. an EPIPE after real work finished)", async () => {
    await installFakeBin('{"ok":true,"data":{},"message":"Packaging completed"}\n', 1);
    const result = await runJsonCommand(["pack", "p1", "/tmp/out.slidra"]);
    expect(result).toEqual({ ok: true, data: {}, message: "Packaging completed" });
  });

  it("stdout is not JSON at all (panic) → ok:false, message from stderr", async () => {
    await installFakeBin("thread panicked at ...\n", 101, "panic: index out of bounds\n");
    const result = await runJsonCommand(["cat", "p1", "project.json"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("panic: index out of bounds");
  });

  it("stdout is empty → ok:false, falls back to a fixed message when stderr is also empty", async () => {
    await installFakeBin("", 1, "");
    const result = await runJsonCommand(["cat", "p1", "project.json"]);
    expect(result).toEqual({ ok: false, message: "Command execution failed" });
  });

  it("stdout has multiple lines (extra debug output before the envelope) → not a legal envelope, ok:false", async () => {
    await installFakeBin('some stray log line\n{"ok":true,"data":{},"message":"ok"}\n', 0, "");
    const result = await runJsonCommand(["cat", "p1", "project.json"]);
    expect(result.ok).toBe(false);
  });

  it("--json is always the last argv token", async () => {
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'process.stdout.write(JSON.stringify({ ok: true, data: { lastArg: args[args.length - 1] }, message: "" }));',
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SLIDRA_BIN = fakeBinPath;
    const result = await runJsonCommand<{ lastArg: string }>(["cat", "p1", "project.json"]);
    expect(result.data?.lastArg).toBe("--json");
  });
});

describe("slidra/reads.ts: read decoding", () => {
  let fakeBinDir: string;
  let fakeBinPath: string;
  let previousBin: string | undefined;

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(path.join(tmpdir(), "slidra-reads-test-fakebin-"));
    fakeBinPath = path.join(fakeBinDir, "slidra-fake.mjs");
    previousBin = process.env.SLIDRA_BIN;
  });

  afterEach(async () => {
    if (previousBin === undefined) delete process.env.SLIDRA_BIN;
    else process.env.SLIDRA_BIN = previousBin;
    await rm(fakeBinDir, { recursive: true, force: true });
  });

  async function installFakeCat(base64Content: string): Promise<void> {
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        `const content = ${JSON.stringify(base64Content)};`,
        'process.stdout.write(JSON.stringify({ ok: true, data: [{ path: "x", content }], message: "" }));',
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SLIDRA_BIN = fakeBinPath;
  }

  async function installFakeSlideRender(base64Content: string): Promise<void> {
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        `const content = ${JSON.stringify(base64Content)};`,
        'process.stdout.write(JSON.stringify({ ok: true, data: { content }, message: "" }));',
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SLIDRA_BIN = fakeBinPath;
  }

  it("readPresentationBytes decodes `cat --json`'s array-of-one shape from base64", async () => {
    const originalBytes = Buffer.from([0x00, 0x01, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    await installFakeCat(originalBytes.toString("base64"));
    const bytes = await readPresentationBytes("p1", "assets/x.bin");
    expect(bytes.equals(originalBytes)).toBe(true);
  });

  it("renderSlide decodes `slide render --json`'s object shape (not an array) from base64", async () => {
    const svg = "<svg>rendered</svg>";
    await installFakeSlideRender(Buffer.from(svg, "utf-8").toString("base64"));
    const text = await renderSlide("p1", "slides/001.svg");
    expect(text).toBe(svg);
  });

  it("readPresentationText decodes valid UTF-8 text", async () => {
    const text = "plain text asset";
    await installFakeCat(Buffer.from(text, "utf-8").toString("base64"));
    expect(await readPresentationText("p1", "notes.txt")).toBe(text);
  });

  it("readPresentationText throws the exact binary-rejection wording for invalid UTF-8 bytes", async () => {
    // 0x89 can never be a valid UTF-8 lead byte.
    await installFakeCat(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    await expect(readPresentationText("p1", "assets/photo.png")).rejects.toThrow(
      "assets/photo.png is a binary asset, cannot be read as text",
    );
  });
});
