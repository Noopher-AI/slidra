// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { execFile } from "node:child_process";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SlidraError } from "../slidra/errors.js";

const execFileAsync = promisify(execFile);

/**
 * Moves `filePath` to the OS trash so it is restorable by the operating
 * system's own means (AC4) — never a plain `unlink`. Linux goes through the
 * XDG home trash directly (dependency-free, no new npm package); macOS asks
 * Finder to do it via `osascript`, the one way "Put Back" keeps working.
 * Every other platform (including Windows) is an explicit, unsupported
 * error — this ticket's scope is macOS and Linux only.
 */
export async function moveToTrash(filePath: string): Promise<void> {
  switch (process.platform) {
    case "linux":
      return moveToXdgTrash(filePath);
    case "darwin":
      return moveToFinderTrash(filePath);
    default:
      throw new SlidraError(`moving a file to the trash is not supported on this platform: ${process.platform}`);
  }
}

function xdgTrashHome(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return dataHome && dataHome !== "" ? path.join(dataHome, "Trash") : path.join(homedir(), ".local", "share", "Trash");
}

/** `YYYY-MM-DDThh:mm:ss`, local time, no timezone — the format the XDG Trash spec's `.trashinfo` `DeletionDate` key requires. */
function trashInfoDeletionDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** A candidate trash entry name not already claimed by an existing `.trashinfo` — `<base>`, then `<base>-1`, `<base>-2`, ... (extension preserved), mirroring the conflict-free-naming convention used elsewhere in this codebase. */
async function claimTrashInfoName(infoDir: string, baseName: string): Promise<{ name: string; handle: Awaited<ReturnType<typeof open>> }> {
  const ext = path.extname(baseName);
  const stem = ext.length > 0 ? baseName.slice(0, -ext.length) : baseName;
  for (let suffix = 0; ; suffix++) {
    const name = suffix === 0 ? baseName : `${stem}-${suffix}${ext}`;
    try {
      const handle = await open(path.join(infoDir, `${name}.trashinfo`), "wx");
      return { name, handle };
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
}

/**
 * The XDG home trash: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`),
 * `files/` holding the moved content and `info/<name>.trashinfo` recording
 * its original absolute path and deletion time. The `.trashinfo` file is
 * claimed first (exclusive-create, so two concurrent deletes of
 * same-named files never collide), then the real file is `rename`d in —
 * an `EXDEV` (trash on a different filesystem than the deck folder) is
 * reported explicitly rather than falling back to a copy+unlink, the same
 * "no silent degrade" rule `storage/deck-store.ts`'s import path follows.
 */
async function moveToXdgTrash(filePath: string): Promise<void> {
  const trashHome = xdgTrashHome();
  const filesDir = path.join(trashHome, "files");
  const infoDir = path.join(trashHome, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });

  const baseName = path.basename(filePath);
  const { name, handle } = await claimTrashInfoName(infoDir, baseName);
  const infoPath = path.join(infoDir, `${name}.trashinfo`);
  try {
    const content =
      `[Trash Info]\n` + `Path=${encodeURI(path.resolve(filePath))}\n` + `DeletionDate=${trashInfoDeletionDate(new Date())}\n`;
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }

  try {
    await rename(filePath, path.join(filesDir, name));
  } catch (error) {
    await rm(infoPath, { force: true }).catch(() => {});
    if (isExdev(error)) {
      throw new SlidraError(`cannot move to trash across filesystems: ${filePath}`);
    }
    throw new SlidraError(`failed to move to trash: ${filePath}`);
  }
}

/** `Application(Finder).delete()`'s AppleScript equivalent — this is what makes Finder's "Put Back" work, unlike a bare `unlink` or a manual move into `~/.Trash`. */
async function moveToFinderTrash(filePath: string): Promise<void> {
  const absolute = path.resolve(filePath);
  const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(absolute)}`;
  try {
    await execFileAsync("osascript", ["-e", script]);
  } catch {
    throw new SlidraError(`failed to move to trash: ${filePath}`);
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isExdev(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EXDEV";
}
