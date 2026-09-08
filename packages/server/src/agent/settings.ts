import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CoMotionError, resolveCoMotionHome } from "@co-motion/core";
import type { AgentKind } from "./adapters.js";

/**
 * User-level agent selection, persisted at `<CO_MOTION_HOME>/settings.json`
 * (F2/F1 — NOOP-230 §4.1). This is the only file this module touches;
 * `resolveCoMotionHome()` (never `homedir()` built by hand here) is the
 * single source of truth for where `CO_MOTION_HOME` actually is, shared
 * with every other module that reads/writes under it.
 *
 * The file may carry other keys in the future (F3/F4) — this module only
 * ever reads/writes the `agent` key, and `writeAgentSelection` preserves
 * everything else byte-for-byte (`## `未知 keys 一節`).
 */
export interface AgentSettings {
  agent: AgentKind | null;
}

const SETTINGS_FILE_NAME = "settings.json";

export function agentSettingsPath(): string {
  return path.join(resolveCoMotionHome(), SETTINGS_FILE_NAME);
}

/**
 * Reads the persisted agent selection.
 *
 * A missing file is not an error — nothing has been chosen yet — and this
 * function never creates one just because it was asked to read it; only
 * `writeAgentSelection` ever creates the file. Everything else that does not
 * parse as `{ agent: "claude" | "codex" | null, ... }` is an honest failure
 * (`CoMotionError`): this module never silently patches a broken file into
 * a default value. The caller (`cli.ts`) is the one place allowed to catch
 * that failure and continue with `agent: null` — this module's job stops at
 * reporting the truth.
 */
export async function readAgentSettings(): Promise<AgentSettings> {
  const filePath = agentSettingsPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { agent: null };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError(`設定檔格式錯誤，不是合法的 JSON：${filePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CoMotionError(`設定檔格式錯誤，最外層必須是一個物件：${filePath}`);
  }

  const value = (parsed as Record<string, unknown>).agent;
  if (value === undefined || value === null) {
    return { agent: null };
  }
  if (value === "claude" || value === "codex") {
    return { agent: value };
  }
  throw new CoMotionError(`設定檔的 agent 欄位值無效（必須是 claude、codex 或 null）：${filePath}`);
}

/**
 * Persists the user's agent selection. Preserves every other top-level key
 * already in the file (future F3/F4 settings) — only `agent` is overwritten.
 * `mkdir`s `CO_MOTION_HOME` if it does not exist yet, and writes through a
 * temp file + `rename` in the same directory so a crash or full disk
 * mid-write can never leave `settings.json` truncated or half-written —
 * the same discipline `workspace.ts`'s `writeRegistry` uses for
 * `projects.json`.
 */
export async function writeAgentSelection(kind: AgentKind): Promise<void> {
  const home = resolveCoMotionHome();
  const finalPath = agentSettingsPath();
  await mkdir(home, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(finalPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (error) {
    // A missing or unreadable/malformed existing file is not this
    // function's problem to diagnose — it is about to be replaced whole
    // with a valid one. Only ENOENT and a JSON/shape failure are expected
    // here; any other I/O failure (e.g. EACCES) surfaces below when the
    // actual write is attempted.
    if (!isEnoent(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const next = { ...existing, agent: kind };
  const tempPath = path.join(home, `.${SETTINGS_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
