/**
 * Seam C's parent half (C3 in the design doc): slide markup in, a play
 * plan out. All derivation logic lives here in the parent, where it is
 * unit-testable without a browser — the runtime that receives the plan is
 * deliberately dumb, it only applies what it is given (see
 * player-runtime.js). Reuses #26's parseEffects/deriveSteps rather than
 * re-parsing anything.
 */
import { deriveSteps, parseEffects } from "./effects.js";
import type { Effect, Step } from "./effects.js";

export interface PlayerPlan {
  steps: Step[];
  /**
   * Every `family="enter"` target, deduplicated, in first-appearance order.
   * These are the elements not on screen when the slide opens — everything
   * else starts visible (ADR-0009: a slide's static look is the final
   * state with all effects already run).
   */
  hidden: string[];
}

/** Throws whatever parseEffects/deriveSteps throw — see effects.ts for the (Traditional Chinese) messages. */
export function computePlayerPlan(svgMarkup: string): PlayerPlan {
  const effects = parseEffects(svgMarkup);
  const steps = deriveSteps(effects);
  return { steps, hidden: enterTargets(effects) };
}

function enterTargets(effects: Effect[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const effect of effects) {
    if (effect.family !== "enter") continue;
    if (seen.has(effect.target)) continue;
    seen.add(effect.target);
    result.push(effect.target);
  }
  return result;
}

/**
 * A `<style>` element that pre-hides every `hidden` target via `opacity:0`.
 * Injected into the play `srcdoc`'s `<head>` — never via script on
 * DOMContentLoaded — so there is no window in which the full slide is
 * painted before hiding takes effect (the "flash of full content" this
 * ticket must avoid). Returns "" when nothing needs hiding, rather than an
 * empty selector list, which would be invalid CSS.
 *
 * `!important`: a legal slide element is free to carry its own inline
 * `style="opacity:1"` (ADR-0010 — slide content is untrusted, but even
 * honestly-authored markup can do this). Inline style normally wins the
 * cascade over any external/injected stylesheet rule, which would let that
 * one element flash fully visible at the very start of play regardless of
 * this rule — exactly the "flash of full content" bug this ticket exists
 * to prevent. `!important` is what lets an injected stylesheet rule beat
 * an element's own inline style. The runtime's side of this same fix is in
 * player-runtime.js: it must set opacity back with `!important` too, or
 * this rule would simply never let a step's elements become visible again.
 */
export function renderHideStyle(hidden: string[]): string {
  if (hidden.length === 0) return "";
  const selector = hidden.map((id) => `#${cssEscapeId(id)}`).join(",");
  return `<style>${selector}{opacity:0 !important}</style>`;
}

/**
 * Element ids in this project come from a fixed generator (`el-<hex>`), but
 * this function does not assume that — it escapes any character CSS would
 * otherwise treat specially in an id selector, defensively, since the id
 * ultimately comes from untrusted slide markup (ADR-0010). A hand-rolled,
 * CSS.escape()-equivalent implementation, not a call to the real
 * `CSS.escape` — that function is not guaranteed present in every runtime
 * this module's tests run under (jsdom does not ship it). Handles the two
 * cases a naive "escape every non-alphanumeric character" miss: CSS
 * identifiers cannot start with an unescaped digit (so `id="1-title"` must
 * become `\31 -title`, not the syntactically-invalid `#1-title`), and a
 * standalone `-` must be escaped outright.
 */
function cssEscapeId(id: string): string {
  let result = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.codePointAt(i)!;

    if (code === 0x0000) {
      result += "\uFFFD";
      continue;
    }
    if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    const isDigit = code >= 0x30 && code <= 0x39;
    if (i === 0 && isDigit) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 1 && isDigit && id[0] === "-") {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && id.length === 1 && ch === "-") {
      result += "\\-";
      continue;
    }

    const isAsciiAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (code >= 0x0080 || ch === "-" || ch === "_" || isDigit || isAsciiAlpha) {
      result += ch;
      continue;
    }
    result += `\\${ch}`;
  }
  return result;
}

/** The `<script>` line that hands the plan to the runtime as `window.__COMOT_PLAN__`. */
export function renderPlanScript(plan: PlayerPlan): string {
  return `window.__COMOT_PLAN__ = ${JSON.stringify(plan)};`;
}
