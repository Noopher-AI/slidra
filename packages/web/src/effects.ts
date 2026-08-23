export type EffectFamily = "enter" | "media";
export type EffectName = "fade" | "appear" | "play";
export type EffectStart = "on-click" | "with-previous" | "after-previous";

export interface Effect {
  /** Points at the id of an element in the slide. */
  target: string;
  family: EffectFamily;
  effect: EffectName;
  start: EffectStart;
}

export interface Step {
  effects: Effect[];
}

/** Custom namespace the effect list lives in (ADR-0009). */
const EFFECTS_NS = "https://co-motion.dev/ns";

/** What this round of the player can actually run. Anything else throws. */
const SUPPORTED_EFFECTS: Record<EffectFamily, EffectName[]> = {
  enter: ["fade", "appear"],
  media: ["play"],
};
const SUPPORTED_STARTS: EffectStart[] = ["on-click"];

/** Human-readable position, 1-based, for error messages. */
function at(index: number): string {
  return `第 ${index + 1} 項`;
}

/**
 * Reads the effect list out of a slide's <metadata>. Order matches the order
 * the entries appear in the file. A slide with no effects is legal and yields
 * an empty list; anything malformed or not yet implemented throws.
 */
export function parseEffects(svgMarkup: string): Effect[] {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  // image/svg+xml parsing is not forgiving like HTML: a failure shows up as a
  // <parsererror> element rather than an exception, so look for it.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("投影片不是合法的 XML，無法讀取效果清單。");
  }

  // Match by namespace URI — the "comot:" prefix is a convention, not a
  // guarantee.
  const lists = doc.getElementsByTagNameNS(EFFECTS_NS, "effects");
  if (lists.length === 0) {
    return [];
  }

  const nodes = Array.from(lists[0].getElementsByTagNameNS(EFFECTS_NS, "effect"));
  return nodes.map((node, index) => readEffect(node, index, doc));
}

function readEffect(node: Element, index: number, doc: Document): Effect {
  const position = at(index);
  const raw = {
    target: node.getAttribute("target"),
    family: node.getAttribute("family"),
    effect: node.getAttribute("effect"),
    start: node.getAttribute("start"),
  };

  const label = raw.target ? `${position}（target 為 ${raw.target}）` : position;
  for (const [name, value] of Object.entries(raw)) {
    if (!value) {
      throw new Error(`${label} 缺少必要屬性 ${name}。`);
    }
  }

  const family = raw.family as EffectFamily;
  const effect = raw.effect as EffectName;
  const start = raw.start as EffectStart;
  const target = raw.target as string;

  const allowedEffects = SUPPORTED_EFFECTS[family];
  if (!allowedEffects) {
    throw new Error(`${label} 的 family 值「${family}」尚未實作。`);
  }
  if (!allowedEffects.includes(effect)) {
    throw new Error(`${label} 的 effect 值「${effect}」尚未實作。`);
  }
  if (!SUPPORTED_STARTS.includes(start)) {
    throw new Error(`${label} 的 start 值「${start}」尚未實作。`);
  }

  if (!doc.getElementById(target)) {
    throw new Error(`${label} 指向的元素不存在於這張投影片，簡報已損毀。`);
  }

  return { target, family, effect, start };
}

/**
 * Groups an effect list into steps (ADR-0008: steps are derived, never
 * stored). An "on-click" effect opens a new step; "with-previous" and
 * "after-previous" join the current one.
 */
export function deriveSteps(effects: Effect[]): Step[] {
  const steps: Step[] = [];

  effects.forEach((effect, index) => {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
      return;
    }
    if (steps.length === 0) {
      throw new Error(`${at(index)} 的 start 是「${effect.start}」，但前面沒有可以併入的步驟，效果清單已損毀。`);
    }
    steps[steps.length - 1].effects.push(effect);
  });

  return steps;
}
