import { CoMotionError } from "@co-motion/core";

export interface ParsedCommand {
  name: string;
  input: unknown;
}

/**
 * Thin argv layer for the `co-motion` bin. It only turns argv into
 * structured input — it does not dispatch, does not print, does not exit.
 * A later caller (e.g. `co-motion serve`) builds structured input its own
 * way and calls the same registry directly.
 */
export function parseArgv(argv: string[]): ParsedCommand {
  const [name, ...rest] = argv;
  if (!name) {
    throw new CoMotionError("缺少命令名稱");
  }

  switch (name) {
    case "new": {
      const path = requirePositional(rest, 0, "new", "path");
      const nameFlagIndex = rest.indexOf("--name");
      let presentationName: string | undefined;
      if (nameFlagIndex >= 0) {
        // --name is present: it must be followed by a value that is not
        // itself flag-shaped. `--name --foo` almost certainly means --name
        // was left without a value — silently taking "--foo" as the name
        // would hide that typo instead of reporting it (no fallbacks).
        presentationName = rest[nameFlagIndex + 1];
        if (presentationName === undefined || isFlagLike(presentationName)) {
          throw new CoMotionError("--name 缺少值");
        }
      }
      return { name, input: { path, name: presentationName } };
    }
    case "open": {
      const path = requirePositional(rest, 0, "open", "path");
      return { name, input: { path } };
    }
    case "pack": {
      const id = requirePositional(rest, 0, "pack", "id");
      const path = requirePositional(rest, 1, "pack", "path");
      return { name, input: { id, path } };
    }
    case "cat": {
      const id = requirePositional(rest, 0, "cat", "id");
      const path = requirePositional(rest, 1, "cat", "path");
      return { name, input: { id, path } };
    }
    case "ls": {
      const id = requirePositional(rest, 0, "ls", "id");
      // path is optional: `ls <id>` lists the top level.
      const path = rest[1];
      return { name, input: { id, path } };
    }
    case "convert": {
      // One argument only: convert takes the whole presentation or none of
      // it (#72). No --dry-run and no single-slide form — a half-converted
      // deck would need its own answer to "is this compliant?".
      const id = requirePositional(rest, 0, "convert", "presentation-id");
      return { name, input: { id } };
    }
    case "text": {
      const sub = rest[0];
      if (sub !== "set") {
        throw new CoMotionError(`未知的子命令：text ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "text set", "presentation-id");
      const slidePath = requirePositional(args, 1, "text set", "slide-path");
      const elementId = requirePositional(args, 2, "text set", "element-id");
      // new-text may legitimately be an empty string (clears the element's
      // text), so it is checked for absence, not falsiness — unlike
      // requirePositional's other args, which reject empty strings too.
      const newText = args[3];
      if (newText === undefined) {
        throw new CoMotionError("命令 text set 缺少參數：new-text");
      }
      return { name: "text set", input: { id, slidePath, elementId, newText } };
    }
    case "textbox": {
      const sub = rest[0];
      const args = rest.slice(1);
      if (sub === "add") {
        const id = requirePositional(args, 0, "textbox add", "presentation-id");
        const slidePath = requirePositional(args, 1, "textbox add", "slide-path");
        const x = requireNumberFlag(args, "--x", "textbox add");
        const y = requireNumberFlag(args, "--y", "textbox add");
        const width = requireNumberFlag(args, "--width", "textbox add");
        const text = requireFlag(args, "--text", "textbox add");
        const fontSize = optionalNumberFlag(args, "--font-size", "textbox add");
        const fontFamily = optionalFlag(args, "--font-family");
        return { name: "textbox add", input: { id, slidePath, x, y, width, text, fontSize, fontFamily } };
      }
      if (sub === "width") {
        const id = requirePositional(args, 0, "textbox width", "presentation-id");
        const slidePath = requirePositional(args, 1, "textbox width", "slide-path");
        const elementId = requirePositional(args, 2, "textbox width", "element-id");
        const widthRaw = requirePositional(args, 3, "textbox width", "width");
        const width = Number(widthRaw);
        if (!Number.isFinite(width)) {
          throw new CoMotionError(`命令 textbox width 的 width 不是合法數字：${widthRaw}`);
        }
        return { name: "textbox width", input: { id, slidePath, elementId, width } };
      }
      throw new CoMotionError(`未知的子命令：textbox ${sub ?? ""}`);
    }
    case "rect": {
      const sub = rest[0];
      if (sub !== "add") {
        throw new CoMotionError(`未知的子命令：rect ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "rect add", "presentation-id");
      const slidePath = requirePositional(args, 1, "rect add", "slide-path");
      const x = requireNumberFlag(args, "--x", "rect add");
      const y = requireNumberFlag(args, "--y", "rect add");
      const width = requireNumberFlag(args, "--width", "rect add");
      const height = requireNumberFlag(args, "--height", "rect add");
      const fill = optionalFlag(args, "--fill");
      return { name: "rect add", input: { id, slidePath, x, y, width, height, fill } };
    }
    case "ellipse": {
      const sub = rest[0];
      if (sub !== "add") {
        throw new CoMotionError(`未知的子命令：ellipse ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "ellipse add", "presentation-id");
      const slidePath = requirePositional(args, 1, "ellipse add", "slide-path");
      const x = requireNumberFlag(args, "--x", "ellipse add");
      const y = requireNumberFlag(args, "--y", "ellipse add");
      const rx = requireNumberFlag(args, "--rx", "ellipse add");
      const ry = requireNumberFlag(args, "--ry", "ellipse add");
      const fill = optionalFlag(args, "--fill");
      return { name: "ellipse add", input: { id, slidePath, x, y, rx, ry, fill } };
    }
    case "line": {
      const sub = rest[0];
      if (sub !== "add") {
        throw new CoMotionError(`未知的子命令：line ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "line add", "presentation-id");
      const slidePath = requirePositional(args, 1, "line add", "slide-path");
      const x1 = requireNumberFlag(args, "--x1", "line add");
      const y1 = requireNumberFlag(args, "--y1", "line add");
      const x2 = requireNumberFlag(args, "--x2", "line add");
      const y2 = requireNumberFlag(args, "--y2", "line add");
      // --stroke is required (wave 2 R4): SVG has no default stroke colour,
      // and an un-stroked line renders nothing.
      const stroke = requireFlag(args, "--stroke", "line add");
      const strokeWidth = optionalNumberFlag(args, "--stroke-width", "line add");
      return { name: "line add", input: { id, slidePath, x1, y1, x2, y2, stroke, strokeWidth } };
    }
    case "path": {
      const sub = rest[0];
      if (sub !== "add") {
        throw new CoMotionError(`未知的子命令：path ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "path add", "presentation-id");
      const slidePath = requirePositional(args, 1, "path add", "slide-path");
      const x = requireNumberFlag(args, "--x", "path add");
      const y = requireNumberFlag(args, "--y", "path add");
      const d = requireFlag(args, "--d", "path add");
      const fill = optionalFlag(args, "--fill");
      const stroke = optionalFlag(args, "--stroke");
      const strokeWidth = optionalNumberFlag(args, "--stroke-width", "path add");
      return { name: "path add", input: { id, slidePath, x, y, d, fill, stroke, strokeWidth } };
    }
    case "element": {
      const sub = rest[0];
      if (sub !== "delete") {
        throw new CoMotionError(`未知的子命令：element ${sub ?? ""}`);
      }
      const args = rest.slice(1);
      const id = requirePositional(args, 0, "element delete", "presentation-id");
      const slidePath = requirePositional(args, 1, "element delete", "slide-path");
      // Trailing variadic positionals: every remaining argument is an
      // element id. requirePositional's flag-like guard applies to each one
      // individually so `element delete <id> <path> --foo` reports a
      // missing element-id instead of accepting "--foo" as one.
      const elementIds = args.slice(2);
      if (elementIds.length === 0 || elementIds.some((value) => isFlagLike(value))) {
        throw new CoMotionError("命令 element delete 缺少參數：element-id");
      }
      return { name: "element delete", input: { id, slidePath, elementIds } };
    }
    case "slide": {
      const sub = rest[0];
      const args = rest.slice(1);
      if (sub === "add") {
        const id = requirePositional(args, 0, "slide add", "presentation-id");
        const at = optionalNumberFlag(args, "--at", "slide add");
        return { name: "slide add", input: { id, at } };
      }
      if (sub === "delete") {
        const id = requirePositional(args, 0, "slide delete", "presentation-id");
        const slidePath = requirePositional(args, 1, "slide delete", "slide-path");
        return { name: "slide delete", input: { id, slidePath } };
      }
      if (sub === "duplicate") {
        const id = requirePositional(args, 0, "slide duplicate", "presentation-id");
        const slidePath = requirePositional(args, 1, "slide duplicate", "slide-path");
        return { name: "slide duplicate", input: { id, slidePath } };
      }
      if (sub === "move") {
        const id = requirePositional(args, 0, "slide move", "presentation-id");
        const slidePath = requirePositional(args, 1, "slide move", "slide-path");
        const to = requireNumberFlag(args, "--to", "slide move");
        return { name: "slide move", input: { id, slidePath, to } };
      }
      throw new CoMotionError(`未知的子命令：slide ${sub ?? ""}`);
    }
    case "undo": {
      const id = requirePositional(rest, 0, "undo", "presentation-id");
      return { name, input: { id } };
    }
    case "redo": {
      const id = requirePositional(rest, 0, "redo", "presentation-id");
      return { name, input: { id } };
    }
    default:
      // Unknown command: let the registry report it, so the error message
      // stays in one place.
      return { name, input: {} };
  }
}

function requirePositional(rest: string[], index: number, command: string, argName: string): string {
  const value = rest[index];
  // A flag-shaped value (starts with "--") in a positional slot means the
  // positional argument itself was omitted — e.g. `new --name Foo` must
  // not silently create a file literally named "--name". Reporting a
  // missing positional here is more accurate than accepting a flag as data.
  if (!value || isFlagLike(value)) {
    throw new CoMotionError(`命令 ${command} 缺少參數：${argName}`);
  }
  return value;
}

function isFlagLike(value: string): boolean {
  return value.startsWith("--");
}

/** The value following `flag` in `args`, or throws when the flag is absent or has no value. */
function requireFlag(args: string[], flag: string, command: string): string {
  const index = args.indexOf(flag);
  if (index === -1) {
    throw new CoMotionError(`命令 ${command} 缺少參數：${flag}`);
  }
  const value = args[index + 1];
  if (value === undefined || isFlagLike(value)) {
    throw new CoMotionError(`${flag} 缺少值`);
  }
  return value;
}

/** Same as `requireFlag`, but returns `undefined` when the flag is simply absent. */
function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || isFlagLike(value)) {
    throw new CoMotionError(`${flag} 缺少值`);
  }
  return value;
}

function requireNumberFlag(args: string[], flag: string, command: string): number {
  const raw = requireFlag(args, flag, command);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CoMotionError(`${flag} 不是合法數字：${raw}`);
  }
  return value;
}

function optionalNumberFlag(args: string[], flag: string, command: string): number | undefined {
  const raw = optionalFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CoMotionError(`${flag} 不是合法數字：${raw}`);
  }
  return value;
}
