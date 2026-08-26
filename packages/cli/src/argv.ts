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
