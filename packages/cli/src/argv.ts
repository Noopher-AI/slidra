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
      if (sub === "set") {
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
        // --force (T3) can only follow new-text at a fixed position — new-text
        // itself is taken verbatim from args[3] regardless of its own content,
        // so a literal "--force" typed as text is never mistaken for the flag.
        const force = requireTrailingForceFlag(args, 4, "text set");
        return { name: "text set", input: { id, slidePath, elementId, newText, force } };
      }
      if (sub === "style") {
        const subsub = rest[1];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：text style ${subsub ?? ""}`);
        }
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "text style set", "presentation-id");
        const slidePath = requirePositional(args, 1, "text style set", "slide-path");
        const elementId = requirePositional(args, 2, "text style set", "element-id");
        const rangeRaw = requireFlag(args, "--range", "text style set");
        const rangeMatch = /^(\d+):(\d+)$/.exec(rangeRaw);
        if (!rangeMatch) {
          throw new CoMotionError(`--range 格式錯誤，必須是 數字:數字：${rangeRaw}`);
        }
        const rangeStart = Number(rangeMatch[1]);
        const rangeEnd = Number(rangeMatch[2]);
        if (!(rangeStart < rangeEnd)) {
          throw new CoMotionError("--range 的起點必須小於終點");
        }
        const fontWeight = optionalFlag(args, "--font-weight");
        const fontStyle = optionalFlag(args, "--font-style");
        if (fontWeight === undefined && fontStyle === undefined) {
          throw new CoMotionError("命令 text style set 至少要給 --font-weight 或 --font-style");
        }
        const force = hasFlag(args, "--force");
        return {
          name: "text style set",
          input: { id, slidePath, elementId, rangeStart, rangeEnd, fontWeight, fontStyle, force },
        };
      }
      if (sub === "list") {
        const subsub = rest[1];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：text list ${subsub ?? ""}`);
        }
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "text list set", "presentation-id");
        const slidePath = requirePositional(args, 1, "text list set", "slide-path");
        const elementId = requirePositional(args, 2, "text list set", "element-id");
        const paragraphRaw = requireFlag(args, "--paragraph", "text list set");
        const paragraph = Number(paragraphRaw);
        if (!Number.isInteger(paragraph) || paragraph < 0) {
          throw new CoMotionError(`--paragraph 不是合法的非負整數：${paragraphRaw}`);
        }
        const kind = requireFlag(args, "--kind", "text list set");
        if (kind !== "bullet" && kind !== "number" && kind !== "none") {
          throw new CoMotionError(`--kind 必須是 bullet、number 或 none：${kind}`);
        }
        const force = hasFlag(args, "--force");
        return { name: "text list set", input: { id, slidePath, elementId, paragraph, kind, force } };
      }
      throw new CoMotionError(`未知的子命令：text ${sub ?? ""}`);
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
        const fontWeight = optionalNumberFlag(args, "--font-weight", "textbox add");
        const fill = optionalFlag(args, "--fill");
        const align = optionalFlag(args, "--align");
        if (align !== undefined && !["left", "center", "right"].includes(align)) {
          throw new CoMotionError(`--align 必須是 left、center 或 right：${align}`);
        }
        return {
          name: "textbox add",
          input: { id, slidePath, x, y, width, text, fontSize, fontFamily, fontWeight, fill, align },
        };
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
        const force = requireTrailingForceFlag(args, 4, "textbox width");
        return { name: "textbox width", input: { id, slidePath, elementId, width, force } };
      }
      throw new CoMotionError(`未知的子命令：textbox ${sub ?? ""}`);
    }
    case "element": {
      const sub = rest[0];
      const args = rest.slice(1);

      if (sub === "insert") {
        const kind = requirePositional(args, 0, "element insert", "kind");
        if (!["rect", "ellipse", "line", "image", "path"].includes(kind)) {
          throw new CoMotionError(`element insert 不支援的 kind：${kind}`);
        }
        const id = requirePositional(args, 1, "element insert", "presentation-id");
        const slidePath = requirePositional(args, 2, "element insert", "slide-path");
        return {
          name: "element insert",
          input: {
            id,
            slidePath,
            kind,
            x: optionalNumberFlag(args, "--x", "element insert"),
            y: optionalNumberFlag(args, "--y", "element insert"),
            width: optionalNumberFlag(args, "--width", "element insert"),
            height: optionalNumberFlag(args, "--height", "element insert"),
            x1: optionalNumberFlag(args, "--x1", "element insert"),
            y1: optionalNumberFlag(args, "--y1", "element insert"),
            x2: optionalNumberFlag(args, "--x2", "element insert"),
            y2: optionalNumberFlag(args, "--y2", "element insert"),
            d: optionalFlag(args, "--d"),
            fill: optionalFlag(args, "--fill"),
            stroke: optionalFlag(args, "--stroke"),
            strokeWidth: optionalNumberFlag(args, "--stroke-width", "element insert"),
            href: optionalFlag(args, "--href"),
            media: optionalFlag(args, "--media"),
          },
        };
      }

      if (sub === "delete") {
        const id = requirePositional(args, 0, "element delete", "presentation-id");
        const slidePath = requirePositional(args, 1, "element delete", "slide-path");
        const elementIds = requireIdList(args, 2, "element delete");
        return { name: "element delete", input: { id, slidePath, elementIds } };
      }

      if (sub === "move") {
        const id = requirePositional(args, 0, "element move", "presentation-id");
        const slidePath = requirePositional(args, 1, "element move", "slide-path");
        const elementIds = requireIdList(args, 2, "element move");
        const dx = requireNumberFlag(args, "--dx", "element move");
        const dy = requireNumberFlag(args, "--dy", "element move");
        const force = hasFlag(args, "--force");
        return { name: "element move", input: { id, slidePath, elementIds, dx, dy, force } };
      }

      if (sub === "scale") {
        const id = requirePositional(args, 0, "element scale", "presentation-id");
        const slidePath = requirePositional(args, 1, "element scale", "slide-path");
        const elementIds = requireIdList(args, 2, "element scale");
        const factor = requireNumberFlag(args, "--factor", "element scale");
        const force = hasFlag(args, "--force");
        return { name: "element scale", input: { id, slidePath, elementIds, factor, force } };
      }

      if (sub === "resize") {
        const id = requirePositional(args, 0, "element resize", "presentation-id");
        const slidePath = requirePositional(args, 1, "element resize", "slide-path");
        const elementIds = requireIdList(args, 2, "element resize");
        const width = requireNumberFlag(args, "--width", "element resize");
        const height = requireNumberFlag(args, "--height", "element resize");
        const anchor = optionalFlag(args, "--anchor") ?? "nw";
        if (!["nw", "ne", "sw", "se"].includes(anchor)) {
          throw new CoMotionError(`element resize 不支援的 anchor：${anchor}`);
        }
        const force = hasFlag(args, "--force");
        return { name: "element resize", input: { id, slidePath, elementIds, width, height, anchor, force } };
      }

      if (sub === "rotate") {
        const id = requirePositional(args, 0, "element rotate", "presentation-id");
        const slidePath = requirePositional(args, 1, "element rotate", "slide-path");
        const elementIds = requireIdList(args, 2, "element rotate");
        const degrees = requireNumberFlag(args, "--degrees", "element rotate");
        const force = hasFlag(args, "--force");
        return { name: "element rotate", input: { id, slidePath, elementIds, degrees, force } };
      }

      if (sub === "style") {
        const subsub = args[0];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：element style ${subsub ?? ""}`);
        }
        const styleArgs = args.slice(1);
        const id = requirePositional(styleArgs, 0, "element style set", "presentation-id");
        const slidePath = requirePositional(styleArgs, 1, "element style set", "slide-path");
        const elementIds = requireIdList(styleArgs, 2, "element style set");
        const attr = requirePositional(styleArgs, 3, "element style set", "attr");
        const value = styleArgs[4];
        if (value === undefined) {
          throw new CoMotionError("命令 element style set 缺少參數：value");
        }
        const force = hasFlag(styleArgs, "--force");
        return { name: "element style set", input: { id, slidePath, elementIds, attr, value, force } };
      }

      if (sub === "order") {
        const id = requirePositional(args, 0, "element order", "presentation-id");
        const slidePath = requirePositional(args, 1, "element order", "slide-path");
        const elementIds = requireIdList(args, 2, "element order");
        const direction = requirePositional(args, 3, "element order", "direction");
        if (!["front", "back", "up", "down"].includes(direction)) {
          throw new CoMotionError(`element order 不支援的方向：${direction}`);
        }
        const force = hasFlag(args, "--force");
        return { name: "element order", input: { id, slidePath, elementIds, direction, force } };
      }

      if (sub === "lock") {
        const id = requirePositional(args, 0, "element lock", "presentation-id");
        const slidePath = requirePositional(args, 1, "element lock", "slide-path");
        const elementIds = requireIdList(args, 2, "element lock");
        return { name: "element lock", input: { id, slidePath, elementIds } };
      }

      if (sub === "unlock") {
        const id = requirePositional(args, 0, "element unlock", "presentation-id");
        const slidePath = requirePositional(args, 1, "element unlock", "slide-path");
        const elementIds = requireIdList(args, 2, "element unlock");
        return { name: "element unlock", input: { id, slidePath, elementIds } };
      }

      if (sub === "group") {
        const id = requirePositional(args, 0, "element group", "presentation-id");
        const slidePath = requirePositional(args, 1, "element group", "slide-path");
        const elementIds = requireIdList(args, 2, "element group");
        return { name: "element group", input: { id, slidePath, elementIds } };
      }

      if (sub === "ungroup") {
        const id = requirePositional(args, 0, "element ungroup", "presentation-id");
        const slidePath = requirePositional(args, 1, "element ungroup", "slide-path");
        const elementIds = requireIdList(args, 2, "element ungroup");
        return { name: "element ungroup", input: { id, slidePath, elementIds } };
      }

      if (sub === "align") {
        const id = requirePositional(args, 0, "element align", "presentation-id");
        const slidePath = requirePositional(args, 1, "element align", "slide-path");
        const elementIds = requireIdList(args, 2, "element align");
        const direction = requirePositional(args, 3, "element align", "direction");
        if (!["left", "hcenter", "right", "top", "vcenter", "bottom"].includes(direction)) {
          throw new CoMotionError(`element align 不支援的方向：${direction}`);
        }
        return { name: "element align", input: { id, slidePath, elementIds, direction } };
      }

      if (sub === "distribute") {
        const id = requirePositional(args, 0, "element distribute", "presentation-id");
        const slidePath = requirePositional(args, 1, "element distribute", "slide-path");
        const elementIds = requireIdList(args, 2, "element distribute");
        const axis = requirePositional(args, 3, "element distribute", "axis");
        if (!["horizontal", "vertical"].includes(axis)) {
          throw new CoMotionError(`element distribute 不支援的方向：${axis}`);
        }
        return { name: "element distribute", input: { id, slidePath, elementIds, axis } };
      }

      if (sub === "name") {
        const subsub = args[0];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：element name ${subsub ?? ""}`);
        }
        const nameArgs = args.slice(1);
        const id = requirePositional(nameArgs, 0, "element name set", "presentation-id");
        const slidePath = requirePositional(nameArgs, 1, "element name set", "slide-path");
        const elementIds = requireIdList(nameArgs, 2, "element name set");
        const value = nameArgs[3];
        if (value === undefined) {
          throw new CoMotionError("命令 element name set 缺少參數：name");
        }
        return { name: "element name set", input: { id, slidePath, elementIds, name: value } };
      }

      if (sub === "copy") {
        const id = requirePositional(args, 0, "element copy", "presentation-id");
        const slidePath = requirePositional(args, 1, "element copy", "slide-path");
        const elementIds = requireIdList(args, 2, "element copy");
        return { name: "element copy", input: { id, slidePath, elementIds } };
      }

      if (sub === "cut") {
        const id = requirePositional(args, 0, "element cut", "presentation-id");
        const slidePath = requirePositional(args, 1, "element cut", "slide-path");
        const elementIds = requireIdList(args, 2, "element cut");
        return { name: "element cut", input: { id, slidePath, elementIds } };
      }

      if (sub === "paste") {
        const id = requirePositional(args, 0, "element paste", "presentation-id");
        const slidePath = requirePositional(args, 1, "element paste", "slide-path");
        const dx = optionalNumberFlag(args, "--dx", "element paste") ?? 0;
        const dy = optionalNumberFlag(args, "--dy", "element paste") ?? 0;
        return { name: "element paste", input: { id, slidePath, dx, dy } };
      }

      if (sub === "duplicate") {
        const id = requirePositional(args, 0, "element duplicate", "presentation-id");
        const slidePath = requirePositional(args, 1, "element duplicate", "slide-path");
        const elementIds = requireIdList(args, 2, "element duplicate");
        const dx = optionalNumberFlag(args, "--dx", "element duplicate") ?? 0;
        const dy = optionalNumberFlag(args, "--dy", "element duplicate") ?? 0;
        return { name: "element duplicate", input: { id, slidePath, elementIds, dx, dy } };
      }

      throw new CoMotionError(`未知的子命令：element ${sub ?? ""}`);
    }
    case "effect": {
      const sub = rest[0];
      const args = rest.slice(1);

      if (sub === "list") {
        const id = requirePositional(args, 0, "effect list", "presentation-id");
        const slidePath = requirePositional(args, 1, "effect list", "slide-path");
        return { name: "effect list", input: { id, slidePath } };
      }

      if (sub === "add") {
        const id = requirePositional(args, 0, "effect add", "presentation-id");
        const slidePath = requirePositional(args, 1, "effect add", "slide-path");
        const elementIds = requireIdList(args, 2, "effect add");
        const family = requireFlag(args, "--family", "effect add");
        if (!["enter", "emphasis", "exit", "path", "media"].includes(family)) {
          throw new CoMotionError(`effect add 不支援的 family：${family}`);
        }
        const effect = requireFlag(args, "--effect", "effect add");
        const start = optionalFlag(args, "--start");
        if (start !== undefined && !["on-click", "with-previous", "after-previous"].includes(start)) {
          throw new CoMotionError(`effect add 不支援的 start：${start}`);
        }
        const duration = optionalNumberFlag(args, "--duration", "effect add");
        const delay = optionalNumberFlag(args, "--delay", "effect add");
        const d = optionalFlag(args, "--d");
        const index = optionalNumberFlag(args, "--index", "effect add");
        return { name: "effect add", input: { id, slidePath, elementIds, family, effect, start, duration, delay, d, index } };
      }

      if (sub === "remove") {
        const id = requirePositional(args, 0, "effect remove", "presentation-id");
        const slidePath = requirePositional(args, 1, "effect remove", "slide-path");
        const indices = requireIndexList(args, 2, "effect remove");
        return { name: "effect remove", input: { id, slidePath, indices } };
      }

      if (sub === "move") {
        const id = requirePositional(args, 0, "effect move", "presentation-id");
        const slidePath = requirePositional(args, 1, "effect move", "slide-path");
        const index = requireIndex(args, 2, "effect move");
        const direction = requirePositional(args, 3, "effect move", "direction");
        if (!["up", "down"].includes(direction)) {
          throw new CoMotionError(`effect move 不支援的方向：${direction}`);
        }
        return { name: "effect move", input: { id, slidePath, index, direction } };
      }

      if (sub === "set") {
        const id = requirePositional(args, 0, "effect set", "presentation-id");
        const slidePath = requirePositional(args, 1, "effect set", "slide-path");
        const index = requireIndex(args, 2, "effect set");
        const effect = optionalFlag(args, "--effect");
        const start = optionalFlag(args, "--start");
        if (start !== undefined && !["on-click", "with-previous", "after-previous"].includes(start)) {
          throw new CoMotionError(`effect set 不支援的 start：${start}`);
        }
        const duration = optionalNumberFlag(args, "--duration", "effect set");
        const delay = optionalNumberFlag(args, "--delay", "effect set");
        const d = optionalFlag(args, "--d");
        return { name: "effect set", input: { id, slidePath, index, effect, start, duration, delay, d } };
      }

      throw new CoMotionError(`未知的子命令：effect ${sub ?? ""}`);
    }
    case "table": {
      const level1 = rest[0];

      if (level1 === "create") {
        const args = rest.slice(1);
        const id = requirePositional(args, 0, "table create", "presentation-id");
        const slidePath = requirePositional(args, 1, "table create", "slide-path");
        const rows = requireNumberFlag(args, "--rows", "table create");
        const cols = requireNumberFlag(args, "--cols", "table create");
        const x = requireNumberFlag(args, "--x", "table create");
        const y = requireNumberFlag(args, "--y", "table create");
        const colWidth = optionalNumberFlag(args, "--col-width", "table create");
        const theme = optionalFlag(args, "--theme");
        const headerRaw = optionalFlag(args, "--header");
        let header: boolean | undefined;
        if (headerRaw !== undefined) {
          if (headerRaw !== "true" && headerRaw !== "false") {
            throw new CoMotionError(`--header 只能是 true 或 false：${headerRaw}`);
          }
          header = headerRaw === "true";
        }
        return { name: "table create", input: { id, slidePath, rows, cols, x, y, colWidth, theme, header } };
      }

      if (level1 === "refresh") {
        const args = rest.slice(1);
        const id = requirePositional(args, 0, "table refresh", "presentation-id");
        const slidePath = requirePositional(args, 1, "table refresh", "slide-path");
        const elementId = requirePositional(args, 2, "table refresh", "element-id");
        return { name: "table refresh", input: { id, slidePath, elementId } };
      }

      if (level1 === "bind") {
        const args = rest.slice(1);
        const id = requirePositional(args, 0, "table bind", "presentation-id");
        const slidePath = requirePositional(args, 1, "table bind", "slide-path");
        const elementId = requirePositional(args, 2, "table bind", "element-id");
        const source = requireFlag(args, "--source", "table bind");
        const templateRow = optionalNumberFlag(args, "--template-row", "table bind");
        return { name: "table bind", input: { id, slidePath, elementId, source, templateRow } };
      }

      if (level1 === "set") {
        const args = rest.slice(1);
        const id = requirePositional(args, 0, "table set", "presentation-id");
        const slidePath = requirePositional(args, 1, "table set", "slide-path");
        const elementId = requirePositional(args, 2, "table set", "element-id");
        const from = optionalFlag(args, "--from");
        const markdown = optionalFlag(args, "--markdown");
        const markdownFile = optionalFlag(args, "--markdown-file");
        const given = (from !== undefined ? 1 : 0) + (markdown !== undefined ? 1 : 0) + (markdownFile !== undefined ? 1 : 0);
        if (given !== 1) {
          throw new CoMotionError("table set 必須恰好提供一種資料來源：--from、--markdown 或 --markdown-file");
        }
        return { name: "table set", input: { id, slidePath, elementId, from, markdown, markdownFile } };
      }

      if (level1 === "merge") {
        const args = rest.slice(1);
        const id = requirePositional(args, 0, "table merge", "presentation-id");
        const slidePath = requirePositional(args, 1, "table merge", "slide-path");
        const elementId = requirePositional(args, 2, "table merge", "element-id");
        const row = requireNumberFlag(args, "--row", "table merge");
        const col = requireNumberFlag(args, "--col", "table merge");
        const unmerge = hasFlag(args, "--unmerge");
        const rowSpan = optionalNumberFlag(args, "--row-span", "table merge");
        const colSpan = optionalNumberFlag(args, "--col-span", "table merge");
        return { name: "table merge", input: { id, slidePath, elementId, row, col, rowSpan, colSpan, unmerge } };
      }

      const level2 = rest[1];
      const level3 = rest[2];

      if (level1 === "cell" && level2 === "set") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table cell set", "presentation-id");
        const slidePath = requirePositional(args, 1, "table cell set", "slide-path");
        const elementId = requirePositional(args, 2, "table cell set", "element-id");
        const row = requireNumberFlag(args, "--row", "table cell set");
        const col = requireNumberFlag(args, "--col", "table cell set");
        const text = requireFlag(args, "--text", "table cell set");
        return { name: "table cell set", input: { id, slidePath, elementId, row, col, text } };
      }

      if (level1 === "cell" && level2 === "style" && level3 === "set") {
        const args = rest.slice(3);
        const id = requirePositional(args, 0, "table cell style set", "presentation-id");
        const slidePath = requirePositional(args, 1, "table cell style set", "slide-path");
        const elementId = requirePositional(args, 2, "table cell style set", "element-id");
        const row = requireNumberFlag(args, "--row", "table cell style set");
        const col = requireNumberFlag(args, "--col", "table cell style set");
        const rowEnd = optionalNumberFlag(args, "--row-end", "table cell style set");
        const colEnd = optionalNumberFlag(args, "--col-end", "table cell style set");
        const value = args[args.length - 1];
        const attr = args[args.length - 2];
        if (attr === undefined || value === undefined || isFlagLike(attr) || isFlagLike(value)) {
          throw new CoMotionError("命令 table cell style set 缺少參數：attr/value");
        }
        return { name: "table cell style set", input: { id, slidePath, elementId, row, col, rowEnd, colEnd, attr, value } };
      }

      if (level1 === "col" && level2 === "width") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table col width", "presentation-id");
        const slidePath = requirePositional(args, 1, "table col width", "slide-path");
        const elementId = requirePositional(args, 2, "table col width", "element-id");
        const col = requireNumberFlag(args, "--col", "table col width");
        const width = requireNumberFlag(args, "--width", "table col width");
        return { name: "table col width", input: { id, slidePath, elementId, col, width } };
      }

      if (level1 === "col" && level2 === "insert") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table col insert", "presentation-id");
        const slidePath = requirePositional(args, 1, "table col insert", "slide-path");
        const elementId = requirePositional(args, 2, "table col insert", "element-id");
        const at = requireNumberFlag(args, "--at", "table col insert");
        return { name: "table col insert", input: { id, slidePath, elementId, at } };
      }

      if (level1 === "col" && level2 === "delete") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table col delete", "presentation-id");
        const slidePath = requirePositional(args, 1, "table col delete", "slide-path");
        const elementId = requirePositional(args, 2, "table col delete", "element-id");
        const at = requireNumberFlag(args, "--at", "table col delete");
        return { name: "table col delete", input: { id, slidePath, elementId, at } };
      }

      if (level1 === "row" && level2 === "insert") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table row insert", "presentation-id");
        const slidePath = requirePositional(args, 1, "table row insert", "slide-path");
        const elementId = requirePositional(args, 2, "table row insert", "element-id");
        const at = requireNumberFlag(args, "--at", "table row insert");
        return { name: "table row insert", input: { id, slidePath, elementId, at } };
      }

      if (level1 === "row" && level2 === "delete") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table row delete", "presentation-id");
        const slidePath = requirePositional(args, 1, "table row delete", "slide-path");
        const elementId = requirePositional(args, 2, "table row delete", "element-id");
        const at = requireNumberFlag(args, "--at", "table row delete");
        return { name: "table row delete", input: { id, slidePath, elementId, at } };
      }

      if (level1 === "theme" && level2 === "set") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table theme set", "presentation-id");
        const slidePath = requirePositional(args, 1, "table theme set", "slide-path");
        const elementId = requirePositional(args, 2, "table theme set", "element-id");
        const theme = requirePositional(args, 3, "table theme set", "theme");
        return { name: "table theme set", input: { id, slidePath, elementId, theme } };
      }

      if (level1 === "header" && level2 === "set") {
        const args = rest.slice(2);
        const id = requirePositional(args, 0, "table header set", "presentation-id");
        const slidePath = requirePositional(args, 1, "table header set", "slide-path");
        const elementId = requirePositional(args, 2, "table header set", "element-id");
        const value = requirePositional(args, 3, "table header set", "true|false");
        if (value !== "true" && value !== "false") {
          throw new CoMotionError(`table header set 不支援的值：${value}`);
        }
        return { name: "table header set", input: { id, slidePath, elementId, header: value === "true" } };
      }

      throw new CoMotionError(`未知的子命令：table ${rest.slice(0, 2).join(" ")}`);
    }
    case "slide": {
      const sub = rest[0];
      const args = rest.slice(1);

      if (sub === "render") {
        const id = requirePositional(args, 0, "slide render", "presentation-id");
        const path = requirePositional(args, 1, "slide render", "slide-path");
        return { name: "slide render", input: { id, path } };
      }

      if (sub === "add") {
        const id = requirePositional(args, 0, "slide add", "presentation-id");
        const templatePath = optionalFlag(args, "--template");
        const atRaw = optionalFlag(args, "--at");
        let at: number | undefined;
        if (atRaw !== undefined) {
          at = Number(atRaw);
          if (!Number.isFinite(at)) {
            throw new CoMotionError(`--at 不是合法數字：${atRaw}`);
          }
        }
        return { name: "slide add", input: { id, templatePath, at } };
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
        const newIndexRaw = requirePositional(args, 2, "slide move", "new-index");
        const newIndex = Number(newIndexRaw);
        if (!Number.isFinite(newIndex)) {
          throw new CoMotionError(`命令 slide move 的 new-index 不是合法數字：${newIndexRaw}`);
        }
        return { name: "slide move", input: { id, slidePath, newIndex } };
      }

      if (sub === "notes") {
        const subsub = args[0];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：slide notes ${subsub ?? ""}`);
        }
        const notesArgs = args.slice(1);
        const id = requirePositional(notesArgs, 0, "slide notes set", "presentation-id");
        const slidePath = requirePositional(notesArgs, 1, "slide notes set", "slide-path");
        // text may legitimately be an empty string (clears the notes), same
        // reasoning as `text set`'s new-text: checked for absence, not
        // falsiness.
        const text = notesArgs[2];
        if (text === undefined) {
          throw new CoMotionError("命令 slide notes set 缺少參數：text");
        }
        return { name: "slide notes set", input: { id, slidePath, text } };
      }

      throw new CoMotionError(`未知的子命令：slide ${sub ?? ""}`);
    }
    case "comment": {
      const sub = rest[0];
      const args = rest.slice(1);

      if (sub === "add") {
        const id = requirePositional(args, 0, "comment add", "presentation-id");
        const slidePath = requirePositional(args, 1, "comment add", "slide-path");
        const target = requirePositional(args, 2, "comment add", "target");
        // text may legitimately be an empty string at this layer (rejected
        // downstream, by `@co-motion/core`'s `addComment`) — checked for
        // absence, not falsiness, same reasoning as `slide notes set`'s text.
        const text = args[3];
        if (text === undefined) {
          throw new CoMotionError("命令 comment add 缺少參數：text");
        }
        const author = optionalFlag(args, "--author");
        return { name: "comment add", input: { id, slidePath, target, text, author } };
      }

      if (sub === "edit") {
        const id = requirePositional(args, 0, "comment edit", "presentation-id");
        const slidePath = requirePositional(args, 1, "comment edit", "slide-path");
        const commentId = requirePositional(args, 2, "comment edit", "comment-id");
        const text = args[3];
        if (text === undefined) {
          throw new CoMotionError("命令 comment edit 缺少參數：text");
        }
        return { name: "comment edit", input: { id, slidePath, commentId, text } };
      }

      if (sub === "delete") {
        const id = requirePositional(args, 0, "comment delete", "presentation-id");
        const slidePath = requirePositional(args, 1, "comment delete", "slide-path");
        const commentId = requirePositional(args, 2, "comment delete", "comment-id");
        return { name: "comment delete", input: { id, slidePath, commentId } };
      }

      if (sub === "list") {
        const id = requirePositional(args, 0, "comment list", "presentation-id");
        const slidePath = args[1];
        return { name: "comment list", input: { id, slidePath } };
      }

      throw new CoMotionError(`未知的子命令：comment ${sub ?? ""}`);
    }
    case "template": {
      const sub = rest[0];
      const args = rest.slice(1);
      if (sub === "add") {
        const id = requirePositional(args, 0, "template add", "presentation-id");
        const from = optionalFlag(args, "--from");
        const name = optionalFlag(args, "--name");
        return { name: "template add", input: { id, from, name } };
      }
      if (sub === "list") {
        const id = requirePositional(args, 0, "template list", "presentation-id");
        return { name: "template list", input: { id } };
      }
      if (sub === "rename") {
        const id = requirePositional(args, 0, "template rename", "presentation-id");
        const templatePath = requirePositional(args, 1, "template rename", "template-path");
        // newName may legitimately be an empty string (rejected downstream
        // as "name cannot be blank", not treated as "argument omitted") —
        // same reasoning as `slide notes set`'s text: checked for absence,
        // not falsiness.
        const newName = args[2];
        if (newName === undefined) {
          throw new CoMotionError("命令 template rename 缺少參數：new-name");
        }
        return { name: "template rename", input: { id, templatePath, newName } };
      }
      if (sub === "delete") {
        const id = requirePositional(args, 0, "template delete", "presentation-id");
        const templatePath = requirePositional(args, 1, "template delete", "template-path");
        return { name: "template delete", input: { id, templatePath } };
      }
      throw new CoMotionError(`未知的子命令：template ${sub ?? ""}`);
    }
    case "presentation": {
      const sub = rest[0];
      const args = rest.slice(1);
      if (sub === "transition") {
        const subsub = args[0];
        if (subsub !== "set") {
          throw new CoMotionError(`未知的子命令：presentation transition ${subsub ?? ""}`);
        }
        const transArgs = args.slice(1);
        const id = requirePositional(transArgs, 0, "presentation transition set", "presentation-id");
        const name = requirePositional(transArgs, 1, "presentation transition set", "name");
        return { name: "presentation transition set", input: { id, name } };
      }
      throw new CoMotionError(`未知的子命令：presentation ${sub ?? ""}`);
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

/** Splits `element move`'s (etc.) comma-separated element-id positional into a real string[] (第 4 節: 逗號分隔、不含空白的清單). */
function requireIdList(args: string[], index: number, command: string): string[] {
  const raw = requirePositional(args, index, command, "element-ids");
  const ids = raw.split(",").map((token) => token.trim());
  if (ids.some((token) => token.length === 0)) {
    throw new CoMotionError(`命令 ${command} 的元素清單格式錯誤：${raw}`);
  }
  return ids;
}

/** `effect remove`'s comma-separated 1-based index positional into a real number[] (mirrors `requireIdList`). */
function requireIndexList(args: string[], index: number, command: string): number[] {
  const raw = requirePositional(args, index, command, "index-list");
  return raw.split(",").map((token) => {
    const value = Number(token.trim());
    if (!Number.isInteger(value)) {
      throw new CoMotionError(`命令 ${command} 的效果項編號格式錯誤：${raw}`);
    }
    return value;
  });
}

/** A single 1-based effect-item index positional (`effect move` / `effect set`). */
function requireIndex(args: string[], index: number, command: string): number {
  const raw = requirePositional(args, index, command, "index");
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new CoMotionError(`命令 ${command} 的效果項編號不是合法整數：${raw}`);
  }
  return value;
}

/** A bare boolean flag with no value (`--force`, T3). Presence anywhere in `args` is enough — order relative to other flags does not matter. */
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * `--force` for a command whose last positional (`new-text`, `width`) is
 * taken verbatim by fixed index rather than by flag scanning — `text set`'s
 * new-text may legitimately equal the literal string "--force", so `--force`
 * is only recognised in the one slot strictly after that positional, never
 * searched for anywhere in `args` (which `hasFlag` does for the flag-based
 * commands). Anything else in that slot is an unknown trailing argument.
 */
function requireTrailingForceFlag(args: string[], index: number, command: string): boolean {
  const value = args[index];
  if (value === undefined) return false;
  if (value === "--force") return true;
  throw new CoMotionError(`命令 ${command} 未知的參數：${value}`);
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
