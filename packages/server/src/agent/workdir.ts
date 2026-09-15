// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { cp, readFile, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SlidraError, SlidraNotFoundError } from "../slidra/errors.js";

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
    throw new SlidraError("Error reading the work directory");
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
 * did not name anything at all, so it is refused as "file not found" instead,
 * before the root is ever reached.
 */
export async function readAgentWorkdirFile(workdirReal: string, relativePath: string): Promise<string> {
  const hasSegment = relativePath.split("/").some((segment) => segment.length > 0);
  if (!hasSegment) {
    throw new SlidraNotFoundError(`file not found: ${relativePath}`);
  }
  const root = await buildWorkdirTree(workdirReal);
  const node = navigateWorkdirTree(root, relativePath);
  if (!node) {
    throw new SlidraNotFoundError(`file not found: ${relativePath}`);
  }
  if (node.type !== "file") {
    throw new SlidraNotFoundError(`not a file: ${relativePath}`);
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(node.realPath);
  } catch {
    throw new SlidraError(`Error reading file: ${relativePath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new SlidraError(`${relativePath} is a binary asset, cannot be read as text`);
  }
}

/**
 * The package-shipped source of the work directory's contents, resolved
 * relative to this module's own location — the same trick `serve.ts`'s
 * `resolveWebDist()` uses for `packages/web/dist`, which works unmodified
 * from both `src/` and `dist/` because both sit one directory level under
 * `packages/server/`. `agent-workdir/` is *not* copied into `dist/` by any
 * build step (unlike `packages/web/dist`, which Next.js itself produces) — it
 * stays at the package root, where this path resolves to it from either
 * location.
 */
export function resolveAgentWorkdirSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../agent-workdir");
}

/**
 * Where one presentation's work directory is deployed to, under this
 * `serve` process's own sandbox root (`sandbox/sandbox-root.ts`) —
 * `<sandboxRoot>/<presentationId>`.
 *
 * NOOP-425 D4: previously `<SLIDRA_HOME>/agent/<presentationId>`, a path
 * shared across every `slidra serve` on the machine, which needed a whole
 * retire/sweep generation scheme (see git history) to keep a second serve's
 * deploy from unlinking the directory an earlier serve's already-spawned
 * ACP agent was sitting in as its `cwd`. A per-serve sandbox root makes two
 * servers structurally unable to collide — each gets its own root — so that
 * scheme is no longer needed at all: `deployAgentWorkdir` below can simply
 * remove-then-copy.
 */
export function agentWorkdirTarget(sandboxRoot: string, presentationId: string): string {
  return path.join(sandboxRoot, presentationId);
}

/**
 * Deploys the package's `agent-workdir/` source to `agentWorkdirTarget()`,
 * overwriting the target wholesale every time it is called — this is a
 * product decision (a user's local edit is not meant to persist across
 * restarts, or a deck switch), not a caching optimization left undone.
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
export async function deployAgentWorkdir(sandboxRoot: string, presentationId: string): Promise<string> {
  const source = resolveAgentWorkdirSource();
  const target = agentWorkdirTarget(sandboxRoot, presentationId);

  try {
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    await cp(path.join(target, ".agents", "skills"), path.join(target, ".claude", "skills"), { recursive: true });
  } catch {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    // Never echo the underlying fs error's own message here — it embeds a
    // real filesystem path (ADR-0004, third layer), and this error can
    // surface all the way out to `startServe`'s caller.
    throw new SlidraError("Error deploying the agent work directory");
  }

  return realpath(target);
}
