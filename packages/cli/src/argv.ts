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
        // --name is present: it must be followed by a value. Silently
        // falling back to the default name here would hide a typo'd
        // command from the caller (no fallbacks).
        presentationName = rest[nameFlagIndex + 1];
        if (presentationName === undefined) {
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
    default:
      // Unknown command: let the registry report it, so the error message
      // stays in one place.
      return { name, input: {} };
  }
}

function requirePositional(rest: string[], index: number, command: string, argName: string): string {
  const value = rest[index];
  if (!value) {
    throw new CoMotionError(`命令 ${command} 缺少參數：${argName}`);
  }
  return value;
}
