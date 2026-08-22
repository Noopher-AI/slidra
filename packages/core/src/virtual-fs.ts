import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { CoMotionError } from "./errors.js";

/**
 * A virtual directory tree, built once per call by enumerating a real work
 * directory. This is the structural counterpart to a guard-based path check
 * (ADR-0004, third layer): a virtual path either resolves to a node that was
 * actually discovered on disk, or it resolves to nothing at all. There is no
 * `path.join`/`path.resolve` of caller-supplied input against a real
 * directory anywhere in lookup, so a segment like ".." has no special
 * meaning — it is just a name that (structurally) never appears as a key,
 * because directory walking never produces an entry named ".." or "/".
 */
type VirtualNode = VirtualFile | VirtualDirectory;

interface VirtualFile {
  readonly type: "file";
  /** Real filesystem path. Internal only — never surfaced in any output. */
  readonly realPath: string;
}

interface VirtualDirectory {
  readonly type: "directory";
  readonly children: Map<string, VirtualNode>;
}

/** Builds the virtual tree for `workDir` by recursively enumerating it. */
export async function buildVirtualTree(workDir: string): Promise<VirtualDirectory> {
  const root: VirtualDirectory = { type: "directory", children: new Map() };
  await populate(workDir, root);
  return root;
}

async function populate(realDir: string, node: VirtualDirectory): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(realDir, { withFileTypes: true });
  } catch {
    // realDir is a real filesystem path inside the hidden work directory
    // (ADR-0004) — never quote it, even for a plain permission/I-O error.
    throw new CoMotionError("讀取簡報內容時發生錯誤");
  }
  for (const entry of entries) {
    const realPath = path.join(realDir, entry.name);
    if (entry.isDirectory()) {
      const child: VirtualDirectory = { type: "directory", children: new Map() };
      node.children.set(entry.name, child);
      await populate(realPath, child);
    } else if (entry.isFile()) {
      node.children.set(entry.name, { type: "file", realPath });
    }
  }
}

/**
 * Splits a caller-supplied virtual path into segments for map lookup.
 * Leading/trailing/duplicate slashes collapse away; no segment is ever
 * interpreted, resolved, or normalized against the real filesystem.
 */
function splitVirtualPath(virtualPath: string): string[] {
  return virtualPath.split("/").filter((segment) => segment.length > 0);
}

/** Walks the tree by exact segment lookup. Returns undefined if any step misses. */
function navigate(root: VirtualDirectory, segments: string[]): VirtualNode | undefined {
  let current: VirtualNode = root;
  for (const segment of segments) {
    if (current.type !== "directory") {
      return undefined;
    }
    const next = current.children.get(segment);
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
}

/**
 * Lists the entry names of the virtual directory at `virtualPath` (the
 * root when omitted). Throws when the path does not resolve to a directory.
 */
export async function listVirtualEntries(workDir: string, virtualPath = ""): Promise<string[]> {
  const root = await buildVirtualTree(workDir);
  const node = navigate(root, splitVirtualPath(virtualPath));
  if (!node || node.type !== "directory") {
    throw new CoMotionError(`找不到目錄：${virtualPath || "/"}`);
  }
  return [...node.children.keys()].sort();
}

/**
 * Reads the full original content of the file at `virtualPath`. Throws when
 * the path does not resolve to a file — including when it resolves to a
 * directory, or to nothing at all.
 */
export async function readVirtualFile(workDir: string, virtualPath: string): Promise<string> {
  const root = await buildVirtualTree(workDir);
  const node = navigate(root, splitVirtualPath(virtualPath));
  if (!node) {
    throw new CoMotionError(`找不到檔案：${virtualPath}`);
  }
  if (node.type !== "file") {
    throw new CoMotionError(`不是檔案：${virtualPath}`);
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(node.realPath);
  } catch {
    // node.realPath is a real filesystem path (ADR-0004) — never quote it.
    throw new CoMotionError(`讀取檔案時發生錯誤：${virtualPath}`);
  }
  try {
    // Strict decoding: any invalid UTF-8 byte sequence throws. This is a
    // structural test on the bytes themselves — not a filename guess — so a
    // mislabelled file can never slip through as corrupted text.
    // ignoreBOM: true keeps a leading BOM as ordinary content instead of
    // stripping it, so cat never silently alters bytes it claims to return.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new CoMotionError(`${virtualPath} 是二進位資產，無法以文字讀取`);
  }
}
