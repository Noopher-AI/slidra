import { cp, mkdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoMotionError, CoMotionNotFoundError, readVirtualFile, resolveCoMotionHome } from "@co-motion/core";

/**
 * Relative-path top-level segments that name a *presentation* virtual file
 * (ADR-0004), never the agent's product work directory. Deliberately wider
 * than the architecture spec's literal "project.json, slides/**, assets/**"
 * — it also includes "fonts", the fourth top-level entry the presentation's
 * own virtual tree actually has (see `commands.test.ts`'s `ls` assertion) —
 * because narrowing it to exactly those three would make `slides` (no
 * trailing slash, an existing `chat.test.ts` regression) resolve into the
 * work directory instead and change that test's error message.
 */
const PRESENTATION_VIRTUAL_PREFIXES = new Set(["project.json", "slides", "assets", "fonts"]);

/** Where `fs/read_text_file`'s `params.path` (already translated to a virtual/relative shape) should be read from. */
export type AgentReadTarget =
  | { kind: "presentation"; virtualPath: string }
  | { kind: "workdir"; relativePath: string }
  | { kind: "refused" };

/**
 * Classifies an ACP `fs/read_text_file` path into one of three trees to
 * read from. `rawPath` is exactly what the agent sent — either the virtual
 * path the brief names directly, or (per a real `claude-code-acp` 0.12.6
 * probe) an absolute path rooted at the session cwd it was handed.
 *
 * The absolute-path prefix-stripping logic is unchanged from the pre-work-
 * directory `toVirtualPath`: `workdirReal` must already be resolved
 * (`realpath`'d) against the real filesystem, because a conforming agent
 * resolves the cwd's own symlinks before it ever echoes a path back (the
 * `/var` vs `/private/var` case on macOS).
 */
export function classifyAgentReadPath(rawPath: string, workdirReal: string): AgentReadTarget {
  let relative: string;
  if (path.isAbsolute(rawPath)) {
    const normalized = path.resolve(rawPath);
    const stripped = path.relative(workdirReal, normalized);
    if (stripped === "" || stripped.startsWith("..") || path.isAbsolute(stripped)) {
      return { kind: "refused" };
    }
    relative = stripped;
  } else {
    relative = rawPath;
  }

  const firstSegment = relative.split("/").find((segment) => segment.length > 0);
  if (firstSegment !== undefined && PRESENTATION_VIRTUAL_PREFIXES.has(firstSegment)) {
    return { kind: "presentation", virtualPath: relative };
  }
  return { kind: "workdir", relativePath: relative };
}

/**
 * Reads a file out of the deployed work directory's real tree. A thin
 * wrapper around `@co-motion/core`'s `readVirtualFile` — the same
 * structural containment a presentation's own virtual tree uses (symlinks
 * are excluded because `buildVirtualTree` only records `isDirectory()`/
 * `isFile()` entries, so `..`/symlink escapes resolve to nothing rather
 * than needing a second `realpath` guard).
 *
 * The one case `readVirtualFile` gets wrong for this caller: an empty path
 * (or one made of only `/`/`.`) resolves to the tree's own root, which
 * `readVirtualFile` reports as "不是檔案" (found a directory, not a file).
 * That reads as if the agent asked for *something* and got a directory —
 * but an empty path did not name anything at all, so it is refused as
 * "找不到檔案" instead, before the root is ever reached.
 */
export async function readAgentWorkdirFile(workdirReal: string, relativePath: string): Promise<string> {
  const hasSegment = relativePath.split("/").some((segment) => segment.length > 0);
  if (!hasSegment) {
    throw new CoMotionNotFoundError(`找不到檔案：${relativePath}`);
  }
  return readVirtualFile(workdirReal, relativePath);
}

/**
 * The package-shipped source of the work directory's contents, resolved
 * relative to this module's own location — the same trick `serve.ts`'s
 * `resolveWebDist()` uses for `packages/web/dist`, which works unmodified
 * from both `src/` and `dist/` because both sit one directory level under
 * `packages/server/`. `agent-workdir/` is *not* copied into `dist/` by any
 * build step (unlike `packages/web/dist`, which vite itself produces) — it
 * stays at the package root, where this path resolves to it from either
 * location.
 */
export function resolveAgentWorkdirSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../agent-workdir");
}

/** Where the work directory is deployed to on the user's machine — inside `CO_MOTION_HOME`, never cleaned up when `serve` exits. */
export function agentWorkdirTarget(): string {
  return path.join(resolveCoMotionHome(), "agent");
}

/**
 * Deploys the package's `agent-workdir/` source to `agentWorkdirTarget()`,
 * overwriting the target wholesale every time `serve` starts — this is a
 * product decision (a user's local edit is not meant to persist across
 * restarts), not a caching optimization left undone.
 *
 * Written via a staging directory + rename so a failure partway through
 * (disk full, a permissions error) never leaves the target half-written:
 * everything happens in a sibling directory first, and only a clean copy
 * ever gets renamed over the real target. The staging directory shares
 * `agentWorkdirTarget()`'s parent (`CO_MOTION_HOME`), and therefore its
 * filesystem, which is what makes the final `rename` atomic rather than a
 * copy-then-delete.
 *
 * `.claude/skills/` is never committed to the repo — `.agents/skills/` is
 * the only source of truth (so a skill is never written twice and cannot
 * drift between the two), and this is the one place that copy is made.
 *
 * Returns the target's `realpath` — resolved because it is about to be
 * handed to an ACP agent as its session `cwd`, and (as with the old
 * `mkdtemp`-based cwd) an agent that resolves symlinks before echoing a
 * path back must be compared against the same resolved form.
 */
export async function deployAgentWorkdir(): Promise<string> {
  const home = resolveCoMotionHome();
  const source = resolveAgentWorkdirSource();
  const target = agentWorkdirTarget();
  const staging = path.join(home, `agent.tmp-${randomUUID()}`);

  await mkdir(home, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true });
    await cp(path.join(staging, ".agents", "skills"), path.join(staging, ".claude", "skills"), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // Never echo the underlying fs error's own message here — it embeds a
    // real filesystem path (ADR-0004, third layer), and this error can
    // surface all the way out to `startServe`'s caller.
    throw new CoMotionError("部署 agent 工作目錄時發生錯誤");
  }

  return realpath(target);
}
