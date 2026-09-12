// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { runJsonCommand } from "./command.js";
import { SlidraError, SlidraNotFoundError } from "./errors.js";
import { validateMinimalProjectJson, type ProjectJson } from "./project-json.js";

/** `cat <id> <path> --json`'s `data` shape (§3.5): always an array, even for one path. */
interface CatEntry {
  path: string;
  /** Base64 of the file's raw bytes — never UTF-8 text, so binary assets round-trip exactly. */
  content: string;
}

function throwForFailure(message: string, failureKind: string | undefined): never {
  if (failureKind === "not-found") {
    throw new SlidraNotFoundError(message);
  }
  throw new SlidraError(message);
}

function decodeCatEntries(data: unknown): CatEntry[] {
  if (
    !Array.isArray(data) ||
    !data.every(
      (entry): entry is CatEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CatEntry).path === "string" &&
        typeof (entry as CatEntry).content === "string",
    )
  ) {
    throw new SlidraError("cat returned malformed data");
  }
  return data;
}

/** Reads one virtual path's raw bytes through `cat <id> <path> --json` — the byte-preserving read every other read in this module builds on. */
export async function readPresentationBytes(id: string, virtualPath: string): Promise<Buffer> {
  const result = await runJsonCommand(["cat", id, virtualPath]);
  if (!result.ok) {
    throwForFailure(result.message, result.failureKind);
  }
  const entries = decodeCatEntries(result.data);
  if (entries.length !== 1) {
    throw new SlidraError("cat returned malformed data");
  }
  return Buffer.from(entries[0]!.content, "base64");
}

/**
 * Reads one virtual path's content, decoded as strict UTF-8 — the
 * agent-facing sibling of `readPresentationBytes` (§3.7). Any invalid UTF-8
 * byte sequence (i.e. the path names a binary asset) throws the exact
 * wording `packages/core`'s `readVirtualFile` used, so every existing
 * caller of this message keeps working unchanged.
 */
export async function readPresentationText(id: string, virtualPath: string): Promise<string> {
  const bytes = await readPresentationBytes(id, virtualPath);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SlidraError(`${virtualPath} is a binary asset, cannot be read as text`);
  }
}

/** `loadProject` (§3.7): `cat <id> project.json --json`, parsed and minimally validated. */
export async function loadProject(id: string): Promise<ProjectJson> {
  const result = await runJsonCommand(["cat", id, "project.json"]);
  if (!result.ok) {
    // Reuse the command's own message (e.g. "no presentation found for id: <id>")
    // instead of inventing a second wording for the same failure.
    throwForFailure(result.message, result.failureKind);
  }
  const entries = decodeCatEntries(result.data);
  if (entries.length !== 1) {
    throw new SlidraError("cat returned malformed data");
  }
  const bytes = Buffer.from(entries[0]!.content, "base64");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw new SlidraError("Could not parse the presentation's project.json");
  }
  return validateMinimalProjectJson(parsed);
}

/** `slide render <id> <path> --json` (§3.5): `data` is an object, never an array, unlike `cat`. */
export async function renderSlide(id: string, slidePath: string): Promise<string> {
  const result = await runJsonCommand(["slide", "render", id, slidePath]);
  if (!result.ok) {
    throwForFailure(result.message, result.failureKind);
  }
  const data = result.data;
  if (typeof data !== "object" || data === null || typeof (data as { content?: unknown }).content !== "string") {
    throw new SlidraError("slide render returned malformed data");
  }
  return Buffer.from((data as { content: string }).content, "base64").toString("utf-8");
}

/** `ls <id> [path] --json` -> `{ entries: string[] }`. */
export async function listEntries(id: string, virtualPath?: string): Promise<string[]> {
  const args = virtualPath === undefined ? ["ls", id] : ["ls", id, virtualPath];
  const result = await runJsonCommand(args);
  if (!result.ok) {
    throwForFailure(result.message, result.failureKind);
  }
  const data = result.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { entries?: unknown }).entries) ||
    !(data as { entries: unknown[] }).entries.every((entry) => typeof entry === "string")
  ) {
    throw new SlidraError("ls returned malformed data");
  }
  return (data as { entries: string[] }).entries;
}
