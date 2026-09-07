import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@zed-industries/agent-client-protocol";
import type { AgentKind } from "./adapters.js";

/**
 * `/` 清單的三個常態來源（architecture comment on #232/#236 — not a
 * fallback, all three always contribute): the agent's own ACP
 * `available_commands_update` report, CoMotion's shipped skills, and the
 * agent's own user-level skill directory. Same-name entries are resolved
 * agent > bundled > user (see `mergeSlashCommands`) — bundled is what gets
 * deployed into the agent's own cwd, so this mirrors the agent's own
 * resolution order (cwd-level skills shadow user-level ones).
 */
export type SlashCommandSource = "agent" | "bundled" | "user";

export interface SlashCommand {
  /** Never includes the leading "/" — callers add it for display. */
  name: string;
  description: string;
  source: SlashCommandSource;
}

export interface SkillDirs {
  bundled: string;
  user: string;
}

/**
 * Resolves the two skill directories a `/` list scans, in addition to
 * whatever the agent itself reports. `overrides` exists for tests, which
 * must never depend on `homedir()` (a real `~/.claude/skills` on the test
 * runner's machine would silently leak into assertions).
 */
export function resolveSkillDirs(kind: AgentKind, overrides?: Partial<SkillDirs>): SkillDirs {
  return {
    bundled: overrides?.bundled ?? defaultBundledSkillDir(),
    user: overrides?.user ?? defaultUserSkillDir(kind),
  };
}

/**
 * `<packages/server package root>/agent-workdir/.agents/skills` — the
 * directory T2 (F3, a separate ticket) deploys CoMotion's shipped skills
 * into. That directory does not exist yet on `main` (T2 is unmerged); this
 * module treats a missing directory as an empty source (see
 * `readSkillCommands`), so nothing here depends on T2 landing first.
 */
function defaultBundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../agent-workdir/.agents/skills");
}

/** Claude reads its own user-level skills from `~/.claude/skills`; Codex from `~/.agents/skills`. */
function defaultUserSkillDir(kind: AgentKind): string {
  return kind === "claude" ? path.join(homedir(), ".claude/skills") : path.join(homedir(), ".agents/skills");
}

/**
 * Reads a `SKILL.md`'s frontmatter for the two single-line keys this
 * feature cares about. No YAML parser (no new dependency, per the
 * architecture decision) — only single-line `key: value` pairs are
 * understood; multi-line/folded values are simply not picked up. Missing
 * frontmatter, or a missing/empty `name` key, falls back to `dirName` — the
 * directory name is what the agent itself actually invokes, so it is a fact,
 * not a fabrication. A missing `description` becomes an empty string.
 */
export function parseSkillFrontmatter(text: string, dirName: string): { name: string; description: string } {
  let name = dirName;
  let description = "";
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1];
      const value = stripQuotes(kv[2].trim());
      if (key === "name" && value.length > 0) name = value;
      else if (key === "description") description = value;
    }
  }
  return { name, description };
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Scans one skill directory's immediate subdirectories for a `SKILL.md`
 * each. A subdirectory with no `SKILL.md` contributes nothing (not an
 * error); the directory itself not existing at all (`ENOENT`/`ENOTDIR`) is
 * the common case (T2 unmerged, or no user-level skills installed) and also
 * contributes nothing. Any other I/O failure (e.g. permissions) is logged
 * and the source is skipped — a broken directory must not take down the
 * whole `/` list, which is a completion aid, not a required feature.
 */
export async function readSkillCommands(dir: string, source: SlashCommandSource): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirError(error)) return [];
    console.warn(`讀取 skill 目錄失敗（${dir}）：${describeError(error)}`);
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await readFile(skillPath, "utf8");
    } catch (error) {
      if (isMissingDirError(error)) continue;
      console.warn(`讀取 ${skillPath} 失敗：${describeError(error)}`);
      continue;
    }
    const { name, description } = parseSkillFrontmatter(text, entry.name);
    commands.push({ name, description, source });
  }
  return commands;
}

function isMissingDirError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strips one leading "/" (the agent may report either shape) and drops the
 * result if it normalizes to an empty string. Only ever applied to the
 * agent-reported names — bundled/user names come from directory names,
 * which never start with "/".
 */
function normalizeReportedName(raw: string): string | undefined {
  const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Union of same-named entries across the three source groups, keeping the
 * first occurrence — callers pass groups in priority order (agent > bundled
 * > user, per the architecture decision) so the first hit is always the
 * right one to keep. Sorted by `name` with plain `<` (not `localeCompare`,
 * which is locale-dependent and would make e2e assertions environment
 * sensitive).
 */
export function mergeSlashCommands(groups: readonly (readonly SlashCommand[])[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const group of groups) {
    for (const command of group) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The full `/` list for one moment in time: the agent's own report (as of
 * its latest `available_commands_update`) unioned with both skill
 * directories. `reported` entries with a non-string or empty `name` are
 * dropped individually (fail closed on that one entry, not the whole
 * notification) — see the behaviour contract table for why.
 */
export async function collectSlashCommands(
  reported: readonly acp.AvailableCommand[],
  dirs: SkillDirs,
): Promise<SlashCommand[]> {
  const agentCommands: SlashCommand[] = [];
  for (const command of reported) {
    if (typeof command.name !== "string") continue;
    const name = normalizeReportedName(command.name);
    if (name === undefined) continue;
    agentCommands.push({
      name,
      description: typeof command.description === "string" ? command.description : "",
      source: "agent",
    });
  }

  const [bundled, user] = await Promise.all([
    readSkillCommands(dirs.bundled, "bundled"),
    readSkillCommands(dirs.user, "user"),
  ]);

  return mergeSlashCommands([agentCommands, bundled, user]);
}
