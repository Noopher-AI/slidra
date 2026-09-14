// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * Reads the machine-readable head of `plan/outline.md` — the plan
 * file `slidra-plan` writes through `slidra plan set` (contract §1: a
 * leading ```json fence, then free markdown). Only the fence is parsed;
 * the markdown body is for people and the agent.
 *
 * Errors over fallbacks, but never into render: a file that is missing
 * the fence or has malformed JSON yields `null` (and a console warning)
 * so the gate simply does not open — a broken plan must not take the
 * editor down with it. The Rust `plan set` already refuses to write an
 * invalid file, so `null` here means a hand-edited or future-format file,
 * not a normal state.
 */

export type PlanPageType = "cover" | "section" | "bullets" | "compare" | "number" | "closing";
export type PlanRhythm = "anchor" | "dense" | "breathing";
/** What the page's content IS. Required — the geometry has to carry it. */
export type PlanRelationship =
  | "order"
  | "link"
  | "parent"
  | "membership"
  | "contrast"
  | "overlap"
  | "none";

export interface PlanPage {
  n: number;
  relationship: PlanRelationship;
  /**
   * #303 §A': a known solution's name, when one fits. Absent means the page
   * composes its own answer to `relationship` — most pages, since the
   * planner no longer chooses layouts at all.
   */
  type: PlanPageType | null;
  rhythm: PlanRhythm;
  title: string;
}

export interface PlanQuestionOption {
  value: string;
  label: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  note?: string;
  recommended: string;
  options: PlanQuestionOption[];
  free_text: boolean;
}

export interface PlanOutline {
  status: "draft" | "confirmed";
  mode: string;
  pages: PlanPage[];
  questions: PlanQuestion[];
  /** The fence's raw text — what `PlanGateModal` suppression keys on (same content ⇒ same gate). */
  fenceText: string;
}

const PAGE_TYPES: ReadonlySet<string> = new Set(["cover", "section", "bullets", "compare", "number", "closing"]);
const RHYTHMS: ReadonlySet<string> = new Set(["anchor", "dense", "breathing"]);
const RELATIONSHIPS: ReadonlySet<string> = new Set([
  "order",
  "link",
  "parent",
  "membership",
  "contrast",
  "overlap",
  "none",
]);

export const PAGE_TYPE_LABELS: Readonly<Record<PlanPageType, string>> = {
  cover: "Cover",
  section: "Section",
  bullets: "Bullets",
  compare: "Compare",
  number: "Big Number",
  closing: "Closing",
};

/** #303 §A': what the page's content is, in the author's words. */
export const RELATIONSHIP_LABELS: Readonly<Record<PlanRelationship, string>> = {
  order: "Order",
  link: "Link",
  parent: "Parent",
  membership: "Membership",
  contrast: "Contrast",
  overlap: "Overlap",
  none: "Single Claim",
};

export const RHYTHM_LABELS: Readonly<Record<PlanRhythm, string>> = {
  anchor: "Anchor",
  dense: "Dense",
  breathing: "Breathing",
};

/** Extracts the text inside the leading ```json … ``` fence, or null when the file does not start with one. */
export function extractJsonFence(text: string): string | null {
  const match = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(text);
  return match ? match[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePages(raw: unknown): PlanPage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pages: PlanPage[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return null;
    const { n, relationship, type, rhythm, title } = entry;
    if (typeof n !== "number" || n !== index + 1) return null;
    if (typeof relationship !== "string" || !RELATIONSHIPS.has(relationship)) return null;
    // `type` is optional (#303 §A'): a page with none composed its own
    // answer. Present-but-unknown is still a malformed file.
    if (type !== undefined && (typeof type !== "string" || !PAGE_TYPES.has(type))) return null;
    if (typeof rhythm !== "string" || !RHYTHMS.has(rhythm)) return null;
    if (typeof title !== "string") return null;
    pages.push({
      n,
      relationship: relationship as PlanRelationship,
      type: type === undefined ? null : (type as PlanPageType),
      rhythm: rhythm as PlanRhythm,
      title,
    });
  }
  return pages;
}

function parseQuestions(raw: unknown): PlanQuestion[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const questions: PlanQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const { id, question, note, recommended, options, free_text } = entry;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) return null;
    if (typeof question !== "string" || typeof recommended !== "string") return null;
    if (note !== undefined && typeof note !== "string") return null;
    if (free_text !== undefined && typeof free_text !== "boolean") return null;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) return null;
    const parsedOptions: PlanQuestionOption[] = [];
    for (const option of options) {
      if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") return null;
      parsedOptions.push({ value: option.value, label: option.label });
    }
    if (!parsedOptions.some((option) => option.value === recommended)) return null;
    seen.add(id);
    questions.push({
      id,
      question,
      ...(note === undefined ? {} : { note }),
      recommended,
      options: parsedOptions,
      free_text: free_text === true,
    });
  }
  return questions;
}

/**
 * Parses `plan/outline.md`. Returns `null` (after a console warning naming
 * the reason) for anything that is not a well-formed outline per contract
 * §1 — the caller treats that exactly like "no plan file".
 */
export function parsePlanOutline(text: string): PlanOutline | null {
  const fenceText = extractJsonFence(text);
  if (fenceText === null) {
    console.warn("plan/outline.md has no leading ```json fence, ignoring this plan");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceText);
  } catch (error) {
    console.warn(`plan/outline.md's JSON section failed to parse, ignoring this plan: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!isRecord(parsed)) {
    console.warn("plan/outline.md's JSON section is not an object, ignoring this plan");
    return null;
  }
  const { status, mode } = parsed;
  if (status !== "draft" && status !== "confirmed") {
    console.warn("plan/outline.md's status is neither draft nor confirmed, ignoring this plan");
    return null;
  }
  if (typeof mode !== "string") {
    console.warn("plan/outline.md is missing mode, ignoring this plan");
    return null;
  }
  const pages = parsePages(parsed.pages);
  if (pages === null) {
    console.warn("plan/outline.md's pages are malformed (must be non-empty, n numbered from 1, relationship/rhythm in the known set, type in the known set if present), ignoring this plan");
    return null;
  }
  const questions = parseQuestions(parsed.questions);
  if (questions === null) {
    console.warn("plan/outline.md's questions are malformed, ignoring this plan");
    return null;
  }
  return { status, mode, pages, questions, fenceText };
}

/** Contract §4: the answers the gate sends back as one `/slidra-build [plan-confirmed]` message. */
export interface PlanAnswers {
  /** question id → chosen option value */
  choices: Record<string, string>;
  /** question id → the author's own line, only for questions with `free_text` and a non-empty entry */
  notes: Record<string, string>;
  /** the bottom "overall" textarea, may be empty */
  overall: string;
}

export function buildConfirmMessage(answers: PlanAnswers): string {
  const lines: string[] = ["/slidra-build [plan-confirmed]"];
  for (const [id, value] of Object.entries(answers.choices)) {
    lines.push(`${id}=${value}`);
    const note = answers.notes[id]?.trim();
    if (note) lines.push(`${id}.note=${note}`);
  }
  lines.push(`Supplement: ${answers.overall.trim()}`);
  return lines.join("\n");
}

export function buildRedoMessage(reason: string): string {
  return `/slidra-plan [redo]${reason.trim()}`;
}
