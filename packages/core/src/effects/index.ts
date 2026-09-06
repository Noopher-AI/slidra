import { CoMotionError } from "../errors.js";

/**
 * Single source of truth for "what is a legal effect item" (ADR-0009,
 * amended for [E2.T7]): the value sets, per-attribute validation, and step
 * derivation. `packages/web/src/effects.ts` keeps its own DOMParser-based
 * reader (it needs namespace-URI matching that this scanner-based package
 * cannot do — see that file), but every "is this value legal" judgement
 * calls into this module. `packages/core/src/effects/edit.ts` is the
 * writer half, built on the same types.
 *
 * No `node:` imports here (D1) — this module ships in the web bundle too.
 */

export type EffectFamily = "enter" | "emphasis" | "exit" | "path" | "media";

export type EffectName =
  | "appear"
  | "fade"
  | "fly-up"
  | "fly-left"
  | "zoom"
  | "pulse"
  | "spin"
  | "grow"
  | "disappear"
  | "fade-out"
  | "zoom-out"
  | "path"
  | "play"
  | "pause";

export type EffectStart = "on-click" | "with-previous" | "after-previous";

export interface Effect {
  /** Points at the id of an element (or group `<g>`) in the slide. */
  target: string;
  family: EffectFamily;
  effect: EffectName;
  start: EffectStart;
  duration: number;
  delay: number;
  /** SVG path syntax, slide coordinates. Only meaningful for family "path", but preserved verbatim (unvalidated, unused) when present on any other family — D4/4.2. */
  d?: string;
  /** This item's 0-based position in the slide's effect list — the runtime's addressing scheme for Preview (D8), since `deriveSteps` groups items into steps and would otherwise lose it. */
  index: number;
}

export interface Step {
  effects: Effect[];
}

/** Custom namespace the effect list lives in (ADR-0009). Shared with `packages/core/src/notes.ts`'s `<comot:notes>`, which lives in the same `<metadata>`. */
export const EFFECTS_NS = "https://co-motion.dev/ns";

/** The fixed value set (D4): not extended or trimmed without an ADR amendment. */
export const SUPPORTED_EFFECTS: Readonly<Record<EffectFamily, readonly EffectName[]>> = {
  enter: ["appear", "fade", "fly-up", "fly-left", "zoom"],
  emphasis: ["pulse", "spin", "grow"],
  exit: ["disappear", "fade-out", "zoom-out"],
  path: ["path"],
  media: ["play", "pause"],
};

export const SUPPORTED_STARTS: readonly EffectStart[] = ["on-click", "with-previous", "after-previous"];

const DEFAULT_DURATION_MEDIA = 0;
const DEFAULT_DURATION = 0.6;

/** Human-readable position, 1-based, for error messages. */
export function at(index: number): string {
  return `第 ${index + 1} 項`;
}

/** The four required attributes of a `<comot:effect>`, read as raw strings (or null when absent) by whichever scanner the caller uses. */
export interface RawEffectAttributes {
  target: string | null;
  family: string | null;
  effect: string | null;
  start: string | null;
  duration: string | null;
  delay: string | null;
  d: string | null;
}

/**
 * Validates one effect item's raw attributes against the fixed value sets
 * and per-attribute rules (4.2), filling in `duration`/`delay` defaults,
 * and returns the typed `Effect`. Throws `CoMotionError` (Traditional
 * Chinese, no filesystem paths) the moment anything is illegal — this
 * function never returns a patched-up value in place of a bad one.
 *
 * `targetExists` is supplied by the caller (a DOMParser lookup in the web
 * reader, a `scanDocument` walk in the writer) rather than computed here,
 * since "does an id exist in this document" is scanner-specific.
 */
export function validateEffectItem(raw: RawEffectAttributes, index: number, targetExists: boolean): Effect {
  const position = at(index);
  const label = raw.target ? `${position}（target 為 ${raw.target}）` : position;

  const required: readonly (readonly [string, string | null])[] = [
    ["target", raw.target],
    ["family", raw.family],
    ["effect", raw.effect],
    ["start", raw.start],
  ];
  for (const [name, value] of required) {
    if (!value) {
      throw new CoMotionError(`${label} 缺少必要屬性 ${name}。`);
    }
  }

  const target = raw.target as string;
  const family = raw.family as EffectFamily;
  const effect = raw.effect as EffectName;
  const start = raw.start as EffectStart;

  const allowedEffects = SUPPORTED_EFFECTS[family];
  if (!allowedEffects) {
    throw new CoMotionError(`${label} 的 family 值「${raw.family}」尚未實作。`);
  }
  if (!allowedEffects.includes(effect)) {
    throw new CoMotionError(`${label} 的 effect 值「${raw.effect}」尚未實作。`);
  }
  if (!SUPPORTED_STARTS.includes(start)) {
    throw new CoMotionError(`${label} 的 start 值「${raw.start}」尚未實作。`);
  }

  if (!targetExists) {
    throw new CoMotionError(`${label} 指向的元素不存在於這張投影片，簡報已損毀。`);
  }

  if (family === "path" && !raw.d) {
    throw new CoMotionError(`${label} 的 family 是 path，但沒有 d，簡報已損毀。`);
  }

  const duration = parseSecondsAttr(raw.duration, label, "duration", family === "media" ? DEFAULT_DURATION_MEDIA : DEFAULT_DURATION);
  const delay = parseSecondsAttr(raw.delay, label, "delay", 0);

  return { target, family, effect, start, duration, delay, d: raw.d ?? undefined, index };
}

/**
 * Missing (`raw === null`, the attribute is absent) takes the default —
 * "duration/delay 屬性缺席" is legal (4.2). An attribute that is *present*
 * but empty (`duration=""`) is a different case ("存在但不是合法的秒數")
 * and throws, same as any other non-numeric string — a scanner distinction
 * a raw DOM/XML attribute read can always make, so callers of this
 * function must too.
 */
function parseSecondsAttr(raw: string | null, label: string, attrName: "duration" | "delay", fallback: number): number {
  if (raw === null) return fallback;
  // `Number("")` is 0, not NaN — an explicit empty-string attribute must
  // still be rejected as "not a legal number of seconds" (4.2), not read
  // as a coincidentally-valid zero.
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CoMotionError(`${label} 的 ${attrName} 值「${raw}」不是合法的秒數。`);
  }
  return value;
}

/** Same legality rule as `parseSecondsAttr`, for a value that already arrived as a number (the writer's CLI/GUI inputs) rather than a raw XML string. */
export function assertLegalSeconds(value: number, label: string, attrName: "duration" | "delay"): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new CoMotionError(`${label} 的 ${attrName} 值「${value}」不是合法的秒數。`);
  }
}

export function defaultDurationFor(family: EffectFamily): number {
  return family === "media" ? DEFAULT_DURATION_MEDIA : DEFAULT_DURATION;
}

/**
 * Groups an effect list into steps (ADR-0008: steps are derived, never
 * stored). An "on-click" effect opens a new step; "with-previous" and
 * "after-previous" join the current one.
 */
export function deriveSteps(effects: readonly Effect[]): Step[] {
  const steps: Step[] = [];

  effects.forEach((effect, index) => {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
      return;
    }
    if (steps.length === 0) {
      throw new CoMotionError(`${at(index)} 的 start 是「${effect.start}」，但前面沒有可以併入的步驟，效果清單已損毀。`);
    }
    steps[steps.length - 1].effects.push(effect);
  });

  return steps;
}
