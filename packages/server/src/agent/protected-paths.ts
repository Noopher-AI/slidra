// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { homedir } from "node:os";

/**
 * Decides whether a shell command reaches for a presentation's real files
 * (ADR-0003's second layer, as re-drawn: the CLI is the only way to change
 * a `.slidra`; everything else the agent wants to run is its own business).
 *
 * The rule this enforces is one sentence: **a `.slidra`'s contents may only
 * be changed through `slidra`.** So this module refuses a command when
 * any path it names lands in
 *
 *   - `<SLIDRA_HOME>` — the live work directories of every presentation,
 *     the undo history, `projects.json`, the save-state bookkeeping —
 *     *except* `<sandboxRoot>/<presentationId>`, which is the agent's own
 *     working directory and has to stay usable; or
 *   - a `.slidra` container file anywhere on disk.
 *
 * **What this is not.** It does not model the shell (see
 * `command-allowlist.ts` for why that game cannot be won), and it is not a
 * containment boundary: an agent that means to get at those files can
 * reach them through a path this never sees — a variable, a glob, a
 * `find`, a program that takes its target from stdin. It is a guard
 * against the thing that actually happens, which is an agent reaching for
 * `sed` on a slide because that is faster than composing a command. The
 * protection that does not depend on catching every spelling is the
 * `.slidra` container itself: the work directory is repacked from the CLI's
 * own view of it, so an edit made behind the CLI's back does not
 * necessarily survive, and `validate` still has the last word on what the
 * deck may contain.
 */
export interface ProtectedPaths {
  /** `<SLIDRA_HOME>` — everything under it is CLI-only, except `agentWorkdir`. */
  slidraHome: string;
  /** `<sandboxRoot>/<id>`: the agent's own cwd, deliberately left open. */
  agentWorkdir: string;
  /** The open presentation's `.slidra` file, when the registry knows one. */
  sourcePath?: string;
}

/**
 * True when `command` names a path the CLI alone may touch. Tokens are
 * taken from a plain whitespace split — good enough because a *missed*
 * token only means the command runs (this module never widens anything;
 * `slidra` commands are allowed before it is ever consulted), and
 * because a quoted path still appears in the split as a quoted token,
 * which `resolveToken` unquotes.
 */
export function touchesProtectedPath(command: string, paths: ProtectedPaths): boolean {
  const home = path.resolve(paths.slidraHome);
  const agentWorkdir = path.resolve(paths.agentWorkdir);
  const source = paths.sourcePath === undefined ? undefined : path.resolve(paths.sourcePath);

  for (const token of command.split(/\s+/)) {
    const resolved = resolveToken(token, agentWorkdir);
    if (resolved === undefined) continue;
    // Every `.slidra` is a presentation container, whoever owns it.
    if (resolved.endsWith(".slidra")) return true;
    if (source !== undefined && isWithin(source, resolved)) return true;
    if (isWithin(home, resolved) && !isWithin(agentWorkdir, resolved)) return true;
  }
  return false;
}

/**
 * A token turned into the absolute path it would name, or undefined when
 * it names no path at all. Relative tokens resolve against the agent's
 * cwd, which is the cwd the command will actually run in.
 */
function resolveToken(token: string, cwd: string): string | undefined {
  // Strip one layer of surrounding quotes; an inner quote is left alone,
  // since it can only make the path *not* match something protected.
  const bare = token.replace(/^['"]|['"]$/g, "");
  if (bare === "") return undefined;
  // A bare word with no path syntax at all (`ls`, `-la`, `--force`) names
  // no path — a file in the cwd would still be inside the agent's own
  // directory, which is open anyway.
  if (!bare.includes("/") && !bare.startsWith("~")) return undefined;
  const expanded = bare.startsWith("~") ? path.join(homedir(), bare.slice(1)) : bare;
  return path.resolve(cwd, expanded);
}

/** True when `child` is `parent` itself or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
