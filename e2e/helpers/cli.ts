// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

// Replaces the deleted TypeScript engine's in-process `CommandRegistry`
// with a same-shaped object backed by the real compiled `slidra` binary
// — via `packages/server/src/slidra/`'s argv encoder and `--json` runner
// (F7's bridge, the same one `POST /api/command` uses). This is what lets
// the ~200 `registry.dispatch(...)` call sites across the e2e suite stay
// untouched: only the import changes, not the call sites (plan section
// 3.4).
import { encodeCommandArgv, type EncodedCommand } from "../../packages/server/src/slidra/argv.js";
import { runJsonCommand, type CommandResult } from "../../packages/server/src/slidra/command.js";

export type { CommandResult };

/** Same shape as the deleted TypeScript CLI engine's `CommandRegistry` — only the one method the e2e suite actually calls. */
export interface CommandRegistry {
  dispatch<T = unknown>(name: string, input?: Record<string, unknown>): Promise<CommandResult<T>>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function plain(argv: string[]): EncodedCommand {
  return { argv, cleanup: async () => {} };
}

/**
 * The 8 commands `ARGV_ENCODERS` has no entry for — `POST /api/command`
 * never needs them (the front end opens/creates presentations through its
 * own routes, reads through `/api/raw/` and `/api/files/`, undoes through a
 * dedicated endpoint, never re-runs the author-initiated one-time
 * `convert`, and reads comments through `/api/comments` rather than
 * shelling out to `comment list`), but the e2e suite's former
 * `CommandRegistry.dispatch` calls exercised all 8. Added here rather than
 * to `packages/server/src/slidra/argv.ts` itself (plan boundary 2.0-6):
 * that map is `POST /api/command`'s input encoder, and these 8 have no
 * reason to ever be reachable from that endpoint.
 */
const E2E_ONLY_ENCODERS: Record<string, (input: Record<string, unknown>) => EncodedCommand> = {
  new: (i) => plain(["new", str(i.path), ...(i.name ? ["--name", str(i.name)] : [])]),
  open: (i) => plain(["open", str(i.path)]),
  cat: (i) => plain(["cat", str(i.id), str(i.path)]),
  ls: (i) => plain(["ls", str(i.id), ...(i.path ? [str(i.path)] : [])]),
  undo: (i) => plain(["undo", str(i.id)]),
  redo: (i) => plain(["redo", str(i.id)]),
  "effect list": (i) => plain(["effect", "list", str(i.id), str(i.slidePath)]),
  convert: (i) => plain(["convert", str(i.id)]),
  "comment list": (i) => plain(["comment", "list", str(i.id), ...(i.slidePath ? [str(i.slidePath)] : [])]),
};

/**
 * `--json`'s `cat` always returns `data: [{ path, content }]` with `content`
 * base64-encoded (the multi-path shape) — but every e2e caller was
 * written against the old registry's single-path shape, `data: { content }`
 * with `content` as plain UTF-8 text (none of them ever read a binary asset
 * through `dispatch("cat", ...)`, only `project.json`/`slides/*.svg`).
 * Decoding back here, rather than changing the ~26 call sites, is what
 * keeps this a pure import-path swap.
 */
function reshapeCatResult(result: CommandResult): CommandResult {
  if (!result.ok) {
    return result;
  }
  const entries = result.data as Array<{ path: string; content: string }>;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error(`cat --json returned data in an unexpected shape: ${JSON.stringify(result.data)}`);
  }
  return {
    ...result,
    data: { content: Buffer.from(entries[0]!.content, "base64").toString("utf-8") },
  };
}

export function createDefaultRegistry(): CommandRegistry {
  return {
    async dispatch<T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<CommandResult<T>> {
      const e2eEncoder = E2E_ONLY_ENCODERS[name];
      const encoded = e2eEncoder ? e2eEncoder(input) : await encodeCommandArgv(name, input);
      try {
        const result = await runJsonCommand<T>(encoded.argv);
        return name === "cat" ? (reshapeCatResult(result) as CommandResult<T>) : result;
      } finally {
        await encoded.cleanup();
      }
    },
  };
}
