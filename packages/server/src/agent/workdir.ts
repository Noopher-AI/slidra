import { cp, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoMotionError, CoMotionNotFoundError } from "../comotion/errors.js";
import { isEnoent, resolveCoMotionHome } from "../comotion/home.js";

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
 * Structural containment for the work directory, scoped to exactly what
 * `readAgentWorkdirFile` below needs: build a tree by enumerating real
 * directories/files only (never following symlinks — `readdir({
 * withFileTypes: true })`'s `Dirent` only reports `isDirectory()`/
 * `isFile()` for the entry itself, so a symlink is neither and is silently
 * excluded), then resolve a caller-supplied relative path by exact segment
 * lookup. A path with a segment like ".." is just a literal name that was
 * never discovered on disk — it structurally cannot resolve to anything,
 * the same guarantee a presentation's own virtual filesystem gives its
 * content.
 */
type WorkdirNode = { type: "file"; realPath: string } | { type: "directory"; children: Map<string, WorkdirNode> };

async function buildWorkdirTree(realDir: string): Promise<WorkdirNode> {
  const root: WorkdirNode = { type: "directory", children: new Map() };
  await populateWorkdirTree(realDir, root);
  return root;
}

async function populateWorkdirTree(realDir: string, node: Extract<WorkdirNode, { type: "directory" }>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(realDir, { withFileTypes: true });
  } catch {
    // realDir is a real filesystem path inside the deployed work directory
    // (ADR-0004) — never quote it, even for a plain permission/I-O error.
    throw new CoMotionError("讀取工作目錄時發生錯誤");
  }
  for (const entry of entries) {
    const realPath = path.join(realDir, entry.name);
    if (entry.isDirectory()) {
      const child: WorkdirNode = { type: "directory", children: new Map() };
      node.children.set(entry.name, child);
      await populateWorkdirTree(realPath, child);
    } else if (entry.isFile()) {
      node.children.set(entry.name, { type: "file", realPath });
    }
  }
}

function navigateWorkdirTree(root: WorkdirNode, relativePath: string): WorkdirNode | undefined {
  let current = root;
  for (const segment of relativePath.split("/").filter((part) => part.length > 0)) {
    if (current.type !== "directory") return undefined;
    const next = current.children.get(segment);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/**
 * Reads a file out of the deployed work directory's real tree, through the
 * structural containment above — the same guarantee a presentation's own
 * virtual tree gives.
 *
 * The one case this must get right that a bare tree lookup would not: an
 * empty path (or one made of only `/`/`.`) resolves to the tree's own
 * root, which is a directory, not a file. That would otherwise read as if
 * the agent asked for *something* and got a directory — but an empty path
 * did not name anything at all, so it is refused as "找不到檔案" instead,
 * before the root is ever reached.
 */
export async function readAgentWorkdirFile(workdirReal: string, relativePath: string): Promise<string> {
  const hasSegment = relativePath.split("/").some((segment) => segment.length > 0);
  if (!hasSegment) {
    throw new CoMotionNotFoundError(`找不到檔案：${relativePath}`);
  }
  const root = await buildWorkdirTree(workdirReal);
  const node = navigateWorkdirTree(root, relativePath);
  if (!node) {
    throw new CoMotionNotFoundError(`找不到檔案：${relativePath}`);
  }
  if (node.type !== "file") {
    throw new CoMotionNotFoundError(`不是檔案：${relativePath}`);
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(node.realPath);
  } catch {
    throw new CoMotionError(`讀取檔案時發生錯誤：${relativePath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new CoMotionError(`${relativePath} 是二進位資產，無法以文字讀取`);
  }
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

/**
 * Where one presentation's work directory is deployed to on the user's
 * machine — `<COMOTION_HOME>/agent/<presentationId>`, never cleaned up
 * when `serve` exits.
 *
 * Keyed by presentation id rather than one shared `agent/` directory
 * because two `comotion serve` processes can run on the same machine at
 * the same time, and `deployAgentWorkdir()` replaces its target wholesale
 * on every startup. A shared path means the second `serve` to start pulls
 * the directory out from under the first one's already-spawned ACP agent,
 * whose session `cwd` is this path — and once that directory is unlinked
 * the agent gets ENOENT for every relative-path read, every write, and
 * even `getcwd`, silently, with nothing surfaced to the author. Per-id
 * targets also give each session its own Claude Code project slug (which
 * is derived from `cwd`), so two presentations' transcripts stop landing
 * in one directory.
 */
export function agentWorkdirTarget(presentationId: string): string {
  return path.join(resolveCoMotionHome(), "agent", presentationId);
}

/**
 * Names of the previous generations of `presentationId`'s work directory —
 * siblings of the target, so the retiring `rename` stays within one
 * filesystem. Scoped by id (rather than one shared `agent.old-` prefix)
 * because the sweep below must never reach into another presentation's
 * retired directory: that one may still be some other `serve`'s live agent
 * `cwd`.
 */
function retiredPrefixFor(presentationId: string): string {
  return `${presentationId}.old-`;
}

/**
 * Removes the retired generations of `presentationId`'s work directory, and
 * only those. Deliberately called at the *start* of a deploy rather than at
 * the end of the one that created them: a retired directory is the inode a
 * still-running agent may be sitting in, and it stays readable for exactly
 * as long as it is not unlinked. Deferring the delete by one deploy is what
 * turns "the older agent breaks instantly" into "the older agent keeps
 * reading the previous generation's files".
 *
 * Failures are swallowed per entry — a leftover directory is litter, never
 * a reason to refuse to start.
 */
async function sweepRetiredWorkdirs(parent: string, presentationId: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const prefix = retiredPrefixFor(presentationId);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => rm(path.join(parent, entry.name), { recursive: true, force: true }).catch(() => {})),
  );
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
 * `COMOTION_HOME` with the target, and therefore its filesystem, which is
 * what makes the final `rename` atomic rather than a copy-then-delete.
 *
 * The previous generation is *retired* (renamed aside), never deleted here
 * — deleting it would unlink the very inode an agent spawned by an earlier
 * `serve` of this same presentation is sitting in, which is exactly the
 * failure `agentWorkdirTarget`'s docstring describes. The retired copy is
 * swept at the start of the *next* deploy instead, by
 * `sweepRetiredWorkdirs`, so that agent keeps reading real files for the
 * rest of its life.
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
export async function deployAgentWorkdir(presentationId: string): Promise<string> {
  const home = resolveCoMotionHome();
  const source = resolveAgentWorkdirSource();
  const target = agentWorkdirTarget(presentationId);
  const parent = path.dirname(target);
  const staging = path.join(home, `agent.tmp-${randomUUID()}`);
  const retired = path.join(parent, `${retiredPrefixFor(presentationId)}${randomUUID()}`);

  await mkdir(parent, { recursive: true });
  await sweepRetiredWorkdirs(parent, presentationId);
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true });
    await cp(path.join(staging, ".agents", "skills"), path.join(staging, ".claude", "skills"), { recursive: true });
    // Retire whatever is already there instead of deleting it (see the
    // docstring). ENOENT just means this presentation has never been
    // served on this machine — every other failure is real.
    const retiredPrevious = await rename(target, retired).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    try {
      await rename(staging, target);
    } catch (error) {
      // The target slot is empty and the new copy did not land. Put the
      // previous generation back rather than leaving no work directory at
      // all — a stale one still runs, a missing one cannot.
      if (retiredPrevious) await rename(retired, target).catch(() => {});
      throw error;
    }
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // Never echo the underlying fs error's own message here — it embeds a
    // real filesystem path (ADR-0004, third layer), and this error can
    // surface all the way out to `startServe`'s caller.
    throw new CoMotionError("部署 agent 工作目錄時發生錯誤");
  }

  return realpath(target);
}
