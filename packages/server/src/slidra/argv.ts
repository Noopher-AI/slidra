// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SlidraError } from "./errors.js";

/**
 * `POST /api/command`'s input→argv encoder (plan §3.9) — the reverse of
 * `packages/cli/src/argv.ts`'s `parseArgv` (argv→input), needed because
 * the front end sends a structured `input` object but the Rust binary only
 * takes argv. Every case here was written by opening `argv.ts`'s matching
 * `case` and copying its field names verbatim (§3.9's own instruction) —
 * `argv.ts` is the one authoritative source for what each command's input
 * shape is, since it already has to produce exactly the shape the shared
 * command handlers expect.
 *
 * `--json` is never appended here — `runJsonCommand` (`command.ts`) always
 * adds it as the argv's last token (§3.4).
 */

export interface EncodedCommand {
  argv: string[];
  /** Removes any temporary file this encoding created (`element paste`'s `--svg-file`, `table cell paste`'s `--tsv-file`). A no-op for every other command. */
  cleanup: () => Promise<void>;
}

type ArgvEncoder = (input: Record<string, unknown>) => Promise<EncodedCommand> | EncodedCommand;

const NOOP_CLEANUP = async (): Promise<void> => {};

function plain(argv: string[]): EncodedCommand {
  return { argv, cleanup: NOOP_CLEANUP };
}

/** An optional value-carrying flag: omitted entirely when `value` is `undefined`/`null` — including `0` and `""`, which must still be sent (§4.2). */
function optFlag(flag: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return [flag, String(value)];
}

/** A bare boolean flag: present only when `value === true` — `false`/`undefined` both omit it. */
function boolFlag(flag: string, value: unknown): string[] {
  return value === true ? [flag] : [];
}

/** `elementIds: string[]` -> one comma-joined token. An empty array still produces a (empty) token — the positional slot is never skipped (§4.2). */
function idsToken(ids: unknown): string {
  return Array.isArray(ids) ? (ids as string[]).join(",") : "";
}

/** Writes `content` to a fresh temp file, for the two commands whose argv only accepts a file path (§3.9). */
async function stageTempFile(basename: string, content: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "slidra-argv-"));
  const filePath = path.join(dir, basename);
  await writeFile(filePath, content, "utf-8");
  return { filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * The only commands `POST /api/command` will run. Each entry was added as
 * a given panel needed it, not as a convenience. Relocated here from
 * `command-endpoint.ts` ([E10.T5] Slice B — that module is deleted, its
 * dispatch now forwarded through `POST /call` instead) since this is
 * where its one remaining consumer, `serve.ts`'s command forwarder, and
 * its cross-check partner, `ARGV_ENCODERS` below, both already live.
 */
export const COMMAND_WHITELIST: readonly string[] = [
  "element move",
  "element scale",
  "element rotate",
  "textbox width",
  "text set",
  "slide add",
  // Page management and speaker notes added these four.
  "slide delete",
  "slide duplicate",
  "slide move",
  "slide notes set",
  "element copy",
  "element cut",
  "element paste",
  "element insert",
  "textbox add",
  "element align",
  "element distribute",
  "element order",
  "element style set",
  // [E2.T11] replaces the presentation-wide `presentation transition set`
  // with the per-slide `slide transition set`.
  "slide transition set",
  // The template-management dialog added these four.
  "template add",
  "template list",
  "template rename",
  "template delete",
  // The plan-confirmation dialog: "Discard" deletes the plan/ draft
  // directly, without going through the agent; `plan list` lets the front
  // end check whether a draft exists even with no SSE event to trigger it.
  // Reading the plan file itself goes through `/api/files/`.
  "plan list",
  "plan delete",
  // Stage selection and direct manipulation added these three: the corner
  // handles send `element resize` (a new command); Delete/Backspace and the
  // element context menu's Delete send `element delete`; Cmd+D and the
  // context menu's Duplicate send `element duplicate` — the latter two
  // commands already existed in the registry, just never allowed through
  // this endpoint before, so without these three entries this whitelist
  // itself would 403 them.
  "element resize",
  "element delete",
  "element duplicate",
  // The Dock's Group/Ungroup buttons added these two.
  "element group",
  "element ungroup",
  // The Video/Image/Audio insert panel's caption field: the caption lands
  // as `data-slidra-name`, going through the existing `element name set`
  // command.
  "element name set",
  // The Animate panel / timeline / scenario bar's Edit animation added
  // these four; `effect list` is not among them — the GUI's list state
  // goes through the ordinary file-read path (`GET /api/files/`), which
  // does not need the command endpoint.
  "effect add",
  "effect remove",
  "effect move",
  "effect set",
  // The comment box / pinned context added these three — creating,
  // editing, and deleting a comment are all write paths for the GUI;
  // `comment list` need not be added since the front end reads comments
  // through `/api/raw/`, not through this endpoint.
  "comment add",
  "comment edit",
  "comment delete",
  // The clipboard added these three: Cmd+C/Cmd+X/Cmd+V on a cell range
  // route through to the table command family (only these three
  // cell-range commands are covered so far).
  "table cell copy",
  "table cell cut",
  "table cell paste",
  // The Table insert panel, cell editing/styling/merging/column-width
  // dragging, and the Style > Object tab's table section and Refresh
  // button.
  "table create",
  "table cell set",
  "table cell style set",
  "table merge",
  "table col width",
  "table col insert",
  "table col delete",
  "table row insert",
  "table row delete",
  "table theme set",
  "table header set",
  "table bind",
  "table refresh",
  "table set",
  // The chart insert panel, its data window, and its eight commands.
  "chart create",
  "chart data set",
  "chart type set",
  "chart palette set",
  "chart axis set",
  "chart stack set",
  "chart legend set",
  "chart option set",
  // The style panel added these three: text-box alignment, slide style
  // (background/accent color), and canvas size.
  "textbox align",
  "slide style set",
  "presentation canvas set",
  // The manual background-image control panel: upload/select/clear the
  // background image, adjust opacity.
  "slide background set",
];

/**
 * Every `COMMAND_WHITELIST` entry's encoder, keyed by command name.
 * `encodeCommandArgv` (below) is the only way this map is read; a
 * unit test (`slidra.test.ts`) asserts `new Set(COMMAND_WHITELIST)`
 * equals `new Set(Object.keys(ARGV_ENCODERS))` — the two must never drift.
 */
export const ARGV_ENCODERS: Record<string, ArgvEncoder> = {
  "element move": (i) =>
    plain([
      "element", "move", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--dx", i.dx), ...optFlag("--dy", i.dy), ...boolFlag("--force", i.force),
    ]),

  "element scale": (i) =>
    plain([
      "element", "scale", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--factor", i.factor), ...boolFlag("--force", i.force),
    ]),

  "element rotate": (i) =>
    plain([
      "element", "rotate", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--degrees", i.degrees), ...boolFlag("--force", i.force),
    ]),

  "textbox width": (i) =>
    plain([
      "textbox", "width", str(i.id), str(i.slidePath), str(i.elementId), str(i.width),
      ...boolFlag("--force", i.force),
    ]),

  "text set": (i) =>
    plain([
      "text", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.newText),
      ...boolFlag("--force", i.force),
    ]),

  "slide add": (i) =>
    plain(["slide", "add", str(i.id), ...optFlag("--template", i.templatePath), ...optFlag("--at", i.at)]),

  "slide delete": (i) => plain(["slide", "delete", str(i.id), str(i.slidePath)]),

  "slide duplicate": (i) => plain(["slide", "duplicate", str(i.id), str(i.slidePath)]),

  "slide move": (i) => plain(["slide", "move", str(i.id), str(i.slidePath), str(i.newIndex)]),

  "slide notes set": (i) => plain(["slide", "notes", "set", str(i.id), str(i.slidePath), str(i.text)]),

  "element copy": (i) => plain(["element", "copy", str(i.id), str(i.slidePath), idsToken(i.elementIds)]),

  "element cut": (i) => plain(["element", "cut", str(i.id), str(i.slidePath), idsToken(i.elementIds)]),

  "element paste": async (i) => {
    const base = ["element", "paste", str(i.id), str(i.slidePath), ...optFlag("--dx", i.dx), ...optFlag("--dy", i.dy)];
    if (typeof i.svg === "string") {
      const { filePath, cleanup } = await stageTempFile("paste.svg", i.svg);
      return { argv: [...base, "--svg-file", filePath], cleanup };
    }
    return plain([...base, ...optFlag("--svg-file", i.svgFile)]);
  },

  "element insert": (i) =>
    plain([
      "element", "insert", str(i.kind), str(i.id), str(i.slidePath),
      ...optFlag("--x", i.x), ...optFlag("--y", i.y),
      ...optFlag("--width", i.width), ...optFlag("--height", i.height),
      ...optFlag("--x1", i.x1), ...optFlag("--y1", i.y1),
      ...optFlag("--x2", i.x2), ...optFlag("--y2", i.y2),
      ...optFlag("--d", i.d), ...optFlag("--fill", i.fill), ...optFlag("--stroke", i.stroke),
      ...optFlag("--stroke-width", i.strokeWidth), ...optFlag("--href", i.href),
      ...optFlag("--media", i.media), ...optFlag("--embed", i.embed),
    ]),

  "textbox add": (i) =>
    plain([
      "textbox", "add", str(i.id), str(i.slidePath),
      ...optFlag("--x", i.x), ...optFlag("--y", i.y), ...optFlag("--width", i.width), ...optFlag("--text", i.text),
      ...optFlag("--font-size", i.fontSize), ...optFlag("--font-family", i.fontFamily),
      ...optFlag("--font-weight", i.fontWeight), ...optFlag("--fill", i.fill), ...optFlag("--align", i.align),
    ]),

  "element align": (i) => plain(["element", "align", str(i.id), str(i.slidePath), idsToken(i.elementIds), str(i.direction)]),

  "element distribute": (i) =>
    plain(["element", "distribute", str(i.id), str(i.slidePath), idsToken(i.elementIds), str(i.axis)]),

  "element order": (i) =>
    plain([
      "element", "order", str(i.id), str(i.slidePath), idsToken(i.elementIds), str(i.direction),
      ...boolFlag("--force", i.force),
    ]),

  "element style set": (i) =>
    plain([
      "element", "style", "set", str(i.id), str(i.slidePath), idsToken(i.elementIds), str(i.attr), str(i.value),
      ...boolFlag("--force", i.force),
    ]),

  "slide transition set": (i) =>
    plain([
      "slide", "transition", "set", str(i.id), str(i.slidePath),
      ...optFlag("--enter", i.enter), ...optFlag("--enter-duration", i.enterDuration),
      ...optFlag("--exit", i.exit), ...optFlag("--exit-duration", i.exitDuration),
      ...boolFlag("--all", i.all),
    ]),

  "template add": (i) => plain(["template", "add", str(i.id), ...optFlag("--from", i.from), ...optFlag("--name", i.name)]),

  "template list": (i) => plain(["template", "list", str(i.id)]),

  "template rename": (i) => plain(["template", "rename", str(i.id), str(i.templatePath), str(i.newName)]),

  "template delete": (i) => plain(["template", "delete", str(i.id), str(i.templatePath)]),

  "plan list": (i) => plain(["plan", "list", str(i.id)]),

  "plan delete": (i) => plain(["plan", "delete", str(i.id), ...(i.name === undefined ? [] : [str(i.name)])]),

  "element resize": (i) =>
    plain([
      "element", "resize", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--width", i.width), ...optFlag("--height", i.height), ...optFlag("--anchor", i.anchor),
      ...boolFlag("--force", i.force),
    ]),

  "element delete": (i) => plain(["element", "delete", str(i.id), str(i.slidePath), idsToken(i.elementIds)]),

  "element duplicate": (i) =>
    plain([
      "element", "duplicate", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--dx", i.dx), ...optFlag("--dy", i.dy),
    ]),

  "element group": (i) => plain(["element", "group", str(i.id), str(i.slidePath), idsToken(i.elementIds)]),

  "element ungroup": (i) => plain(["element", "ungroup", str(i.id), str(i.slidePath), idsToken(i.elementIds)]),

  "element name set": (i) =>
    plain(["element", "name", "set", str(i.id), str(i.slidePath), idsToken(i.elementIds), str(i.name)]),

  "effect add": (i) =>
    plain([
      "effect", "add", str(i.id), str(i.slidePath), idsToken(i.elementIds),
      ...optFlag("--family", i.family), ...optFlag("--effect", i.effect), ...optFlag("--start", i.start),
      ...optFlag("--duration", i.duration), ...optFlag("--delay", i.delay), ...optFlag("--d", i.d),
      ...optFlag("--index", i.index),
    ]),

  "effect remove": (i) => {
    const indices = Array.isArray(i.indices) ? (i.indices as number[]).join(",") : "";
    return plain(["effect", "remove", str(i.id), str(i.slidePath), indices]);
  },

  "effect move": (i) => plain(["effect", "move", str(i.id), str(i.slidePath), str(i.index), str(i.direction)]),

  "effect set": (i) =>
    plain([
      "effect", "set", str(i.id), str(i.slidePath), str(i.index),
      ...optFlag("--effect", i.effect), ...optFlag("--start", i.start),
      ...optFlag("--duration", i.duration), ...optFlag("--delay", i.delay), ...optFlag("--d", i.d),
    ]),

  "comment add": (i) =>
    plain(["comment", "add", str(i.id), str(i.slidePath), str(i.target), str(i.text), ...optFlag("--author", i.author)]),

  "comment edit": (i) => plain(["comment", "edit", str(i.id), str(i.slidePath), str(i.commentId), str(i.text)]),

  "comment delete": (i) => plain(["comment", "delete", str(i.id), str(i.slidePath), str(i.commentId)]),

  "table cell copy": (i) =>
    plain(["table", "cell", "copy", str(i.id), str(i.slidePath), str(i.elementId), "--range", str(i.range)]),

  "table cell cut": (i) =>
    plain(["table", "cell", "cut", str(i.id), str(i.slidePath), str(i.elementId), "--range", str(i.range)]),

  "table cell paste": async (i) => {
    const { filePath, cleanup } = await stageTempFile("paste.tsv", str(i.tsv));
    return {
      argv: ["table", "cell", "paste", str(i.id), str(i.slidePath), str(i.elementId), "--at", str(i.at), "--tsv-file", filePath],
      cleanup,
    };
  },

  "table create": (i) =>
    plain([
      "table", "create", str(i.id), str(i.slidePath),
      ...optFlag("--rows", i.rows), ...optFlag("--cols", i.cols), ...optFlag("--x", i.x), ...optFlag("--y", i.y),
      ...optFlag("--col-width", i.colWidth), ...optFlag("--theme", i.theme),
      ...(i.header === undefined ? [] : ["--header", i.header ? "true" : "false"]),
    ]),

  "table cell set": (i) =>
    plain([
      "table", "cell", "set", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--row", i.row), ...optFlag("--col", i.col), ...optFlag("--text", i.text),
    ]),

  "table cell style set": (i) =>
    plain([
      "table", "cell", "style", "set", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--row", i.row), ...optFlag("--col", i.col),
      ...optFlag("--row-end", i.rowEnd), ...optFlag("--col-end", i.colEnd),
      str(i.attr), str(i.value),
    ]),

  "table merge": (i) =>
    plain([
      "table", "merge", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--row", i.row), ...optFlag("--col", i.col),
      ...optFlag("--row-span", i.rowSpan), ...optFlag("--col-span", i.colSpan),
      ...boolFlag("--unmerge", i.unmerge),
    ]),

  "table col width": (i) =>
    plain([
      "table", "col", "width", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--col", i.col), ...optFlag("--width", i.width), ...boolFlag("--keep-total", i.keepTotal),
    ]),

  "table col insert": (i) =>
    plain(["table", "col", "insert", str(i.id), str(i.slidePath), str(i.elementId), ...optFlag("--at", i.at)]),

  "table col delete": (i) =>
    plain(["table", "col", "delete", str(i.id), str(i.slidePath), str(i.elementId), ...optFlag("--at", i.at)]),

  "table row insert": (i) =>
    plain(["table", "row", "insert", str(i.id), str(i.slidePath), str(i.elementId), ...optFlag("--at", i.at)]),

  "table row delete": (i) =>
    plain(["table", "row", "delete", str(i.id), str(i.slidePath), str(i.elementId), ...optFlag("--at", i.at)]),

  "table theme set": (i) => plain(["table", "theme", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.theme)]),

  "table header set": (i) =>
    plain(["table", "header", "set", str(i.id), str(i.slidePath), str(i.elementId), i.header ? "true" : "false"]),

  "table bind": (i) =>
    plain([
      "table", "bind", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--source", i.source), ...optFlag("--template-row", i.templateRow),
    ]),

  "table refresh": (i) => plain(["table", "refresh", str(i.id), str(i.slidePath), str(i.elementId)]),

  "table set": (i) =>
    plain([
      "table", "set", str(i.id), str(i.slidePath), str(i.elementId),
      ...optFlag("--from", i.from), ...optFlag("--markdown", i.markdown), ...optFlag("--markdown-file", i.markdownFile),
    ]),

  "chart create": (i) =>
    plain([
      "chart", "create", str(i.id), str(i.slidePath),
      ...optFlag("--type", i.type), ...optFlag("--series", i.seriesCount), ...optFlag("--categories", i.categoriesCount),
      ...optFlag("--palette", i.palette), ...optFlag("--x", i.x), ...optFlag("--y", i.y),
      ...optFlag("--width", i.width), ...optFlag("--height", i.height),
    ]),

  "chart data set": (i) => {
    const base = ["chart", "data", "set", str(i.id), str(i.slidePath), str(i.elementId)];
    if (i.csv !== undefined) return plain([...base, "--csv", str(i.csv)]);
    if (i.csvAsset !== undefined) return plain([...base, "--csv-asset", str(i.csvAsset)]);
    const categories = Array.isArray(i.categories) ? (i.categories as string[]).join(",") : "";
    const series = Array.isArray(i.series) ? (i.series as { name: string; values: number[] }[]) : [];
    return plain([
      ...base,
      "--categories", categories,
      ...series.flatMap((s) => ["--series", `${s.name}=${s.values.join(",")}`]),
    ]);
  },

  "chart type set": (i) => plain(["chart", "type", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.type)]),

  "chart palette set": (i) => {
    const colors = Array.isArray(i.colors) ? (i.colors as { name: string; color: string }[]) : [];
    return plain([
      "chart", "palette", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.palette),
      ...colors.flatMap((c) => ["--color", `${c.name}=${c.color}`]),
    ]);
  },

  "chart axis set": (i) => {
    const right = Array.isArray(i.right) ? (i.right as string[]) : [];
    return plain([
      "chart", "axis", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.axes),
      ...right.flatMap((r) => ["--right", r]),
    ]);
  },

  "chart stack set": (i) =>
    plain(["chart", "stack", "set", str(i.id), str(i.slidePath), str(i.elementId), i.stacked ? "on" : "off"]),

  "chart legend set": (i) => plain(["chart", "legend", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.legend)]),

  "chart option set": (i) =>
    plain(["chart", "option", "set", str(i.id), str(i.slidePath), str(i.elementId), str(i.key), str(i.value)]),

  "textbox align": (i) =>
    plain(["textbox", "align", str(i.id), str(i.slidePath), str(i.elementId), str(i.align), ...boolFlag("--force", i.force)]),

  "slide style set": (i) =>
    plain(["slide", "style", "set", str(i.id), str(i.slidePath), ...optFlag("--background", i.background), ...optFlag("--accent", i.accent)]),

  "slide background set": (i) =>
    plain([
      "slide", "background", "set", str(i.id), str(i.slidePath),
      ...optFlag("--asset", i.asset), ...boolFlag("--none", i.none), ...optFlag("--opacity", i.opacity),
    ]),

  "presentation canvas set": (i) =>
    plain(["presentation", "canvas", "set", str(i.id), ...optFlag("--width", i.width), ...optFlag("--height", i.height)]),
};

/** Encodes one whitelisted command's structured `input` into argv (without `--json`). Throws if `name` has no encoder — never sends a partial/guessed argv (§4.2). */
export async function encodeCommandArgv(name: string, input: Record<string, unknown>): Promise<EncodedCommand> {
  const encoder = ARGV_ENCODERS[name];
  if (!encoder) {
    throw new SlidraError(`unknown command: ${name}`);
  }
  return encoder(input);
}
