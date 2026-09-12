/**
 * Browser-side effect model + route client + cache ([E4.T7]). Replaces the
 * former DOMParser-based `parseEffects`/`deriveSteps` (that computation now
 * lives server-side — `effect list`'s `data`, plan 4.1) with a thin fetch
 * client over `GET /api/effects/<slidePath>`, plus an in-memory cache keyed
 * by slide path so the canvas, the animate panel, and player-plan's step
 * derivation never issue duplicate requests for the same slide at once.
 *
 * D6: `SUPPORTED_EFFECTS`/`SUPPORTED_STARTS` and the five effect types are
 * re-declared here rather than imported from core's effects module — this
 * is the terminal shape (F8, NOOP-289, removes core from the web bundle
 * entirely), not a temporary duplication. `docs/spec/cli.md`'s `effect
 * add` entry is the normative source for these value sets, not this file.
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

export const SUPPORTED_EFFECTS: Readonly<Record<EffectFamily, readonly EffectName[]>> = {
  enter: ["appear", "fade", "fly-up", "fly-left", "zoom"],
  emphasis: ["pulse", "spin", "grow"],
  exit: ["disappear", "fade-out", "zoom-out"],
  path: ["path"],
  media: ["play", "pause"],
};

export const SUPPORTED_STARTS: readonly EffectStart[] = ["on-click", "with-previous", "after-previous"];

export interface Effect {
  /** Points at the id of an element (or group `<g>`) in the slide. */
  target: string;
  family: EffectFamily;
  effect: EffectName;
  start: EffectStart;
  duration: number;
  delay: number;
  /** SVG path syntax, slide coordinates. Only meaningful for family "path". */
  d?: string;
  /**
   * This item's 0-based position in the slide's effect list — web's own
   * convention (D4), independent of the `effect move`/`set`/`remove`
   * commands' 1-based addressing. The route client below is the one place
   * that translates between the two; every other web module only ever
   * sees 0-based.
   */
  index: number;
}

export interface Step {
  effects: Effect[];
}

export type PageTransitionEffect = "none" | "fade" | "slide" | "zoom";

export interface SlideTransitionEdge {
  effect: PageTransitionEffect;
  duration: number;
}

export interface SlideTransition {
  enter: SlideTransitionEdge;
  exit: SlideTransitionEdge;
}

export interface SlideEffectPlan {
  effects: Effect[];
  steps: Step[];
  /** Fetched but not yet consumed by any web module — F8 (NOOP-289) is the first reader. */
  transition: SlideTransition;
}

/** The `GET /api/effects/<path>` wire shape, 1-based `index` (server/CLI addressing) throughout. */
interface WireEffect {
  target: string;
  family: EffectFamily;
  effect: EffectName;
  start: EffectStart;
  duration: number;
  delay: number;
  d?: string;
  index: number;
}
interface WirePlan {
  effects: WireEffect[];
  steps: Array<{ effects: WireEffect[] }>;
  transition: SlideTransition;
}

function toZeroBased(effect: WireEffect): Effect {
  return { ...effect, index: effect.index - 1 };
}

/** Caches the in-flight/settled `Promise`, not the resolved value — so two callers racing for the same slide share one fetch (plan 4.4). */
const cache = new Map<string, Promise<SlideEffectPlan>>();

async function fetchFresh(slidePath: string): Promise<SlideEffectPlan> {
  const response = await fetch(`/api/effects/${slidePath}`);
  const body = (await response.json()) as Partial<WirePlan> & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Failed to load effect list: ${slidePath}`);
  }
  const wire = body as WirePlan;
  return {
    effects: wire.effects.map(toZeroBased),
    steps: wire.steps.map((step) => ({ effects: step.effects.map(toZeroBased) })),
    transition: wire.transition,
  };
}

/**
 * Fetches (and caches) `slidePath`'s effect plan. Concurrent calls for the
 * same path before the first resolves share the one in-flight fetch. A
 * failed fetch (non-2xx, or the network request itself rejecting) is never
 * cached — the next call retries from scratch.
 */
export function fetchSlideEffectPlan(slidePath: string): Promise<SlideEffectPlan> {
  const cached = cache.get(slidePath);
  if (cached) return cached;
  const promise = fetchFresh(slidePath).catch((error: unknown) => {
    cache.delete(slidePath);
    throw error;
  });
  cache.set(slidePath, promise);
  return promise;
}

/**
 * Invalidates one slide's cached plan (`slidePath` given) or every cached
 * plan (no argument) — call after any `effect *`/`element group`/`element
 * ungroup` command settles, so the next `fetchSlideEffectPlan` call re-fetches
 * instead of serving a stale plan.
 */
export function invalidateSlideEffectPlans(slidePath?: string): void {
  if (slidePath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(slidePath);
}
