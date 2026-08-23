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
 */
export function renderHideStyle(hidden: string[]): string {
  if (hidden.length === 0) return "";
  const selector = hidden.map((id) => `#${cssEscapeId(id)}`).join(",");
  return `<style>${selector}{opacity:0}</style>`;
}

/**
 * Element ids in this project come from a fixed generator (`el-<hex>`), but
 * this function does not assume that — it escapes any character CSS would
 * otherwise treat specially in an id selector, defensively, since the id
 * ultimately comes from untrusted slide markup (ADR-0010).
 */
function cssEscapeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** The `<script>` line that hands the plan to the runtime as `window.__COMOT_PLAN__`. */
export function renderPlanScript(plan: PlayerPlan): string {
  return `window.__COMOT_PLAN__ = ${JSON.stringify(plan)};`;
}
