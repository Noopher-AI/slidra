// The effect model (spec §6) and slide transitions (spec §7): validation of
// raw attribute values and step derivation. Pure functions over plain
// objects — no DOM — so they run unchanged under Node's test runner.

export const SUPPORTED_EFFECTS = Object.freeze({
  enter: ["appear", "fade", "fly-up", "fly-down", "fly-left", "fly-right", "zoom"],
  emphasis: ["pulse", "spin", "grow"],
  exit: ["disappear", "fade-out", "fly-out-up", "fly-out-down", "fly-out-left", "fly-out-right", "zoom-out"],
  path: ["path"],
  media: ["play", "pause"],
});

export const SUPPORTED_STARTS = Object.freeze(["on-click", "with-previous", "after-previous"]);
export const EASINGS = Object.freeze(["ease", "linear", "ease-in", "ease-out", "ease-in-out", "overshoot"]);
export const BUILD_UNITS = Object.freeze(["line", "word", "letter"]);
export const DEFAULT_STAGGER = 0.1;
export const TRANSITION_EFFECTS = Object.freeze(["none", "fade", "slide", "zoom"]);
/** `morph` is an arrival only (spec §7). */
export const ENTER_TRANSITION_EFFECTS = Object.freeze([...TRANSITION_EFFECTS, "morph"]);

export const DEFAULT_DURATION = 0.6;
export const DEFAULT_DURATION_MEDIA = 0;
export const DEFAULT_TRANSITION = Object.freeze({
  enter: Object.freeze({ effect: "none", duration: 0.6 }),
  exit: Object.freeze({ effect: "none", duration: 0.5 }),
});

export class EffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "EffectError";
  }
}

/** spec/schema/metadata.schema.json `$defs/seconds`, trimmed. */
const DECIMAL_SECONDS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

/**
 * An absent attribute (`null`/`undefined`) takes the default; a present one
 * must be a finite, non-negative decimal number — `duration=""` is invalid
 * (spec §6.4), never silently defaulted.
 */
export function parseSeconds(raw, fallback, label) {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = String(raw).trim();
  // Plain decimals only: Number() alone would also take "0x10", "1e3" or "Infinity".
  const value = DECIMAL_SECONDS.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new EffectError(`${label} value "${raw}" is not a valid number of seconds.`);
  }
  return value;
}

/**
 * Validates one `<slidra:effect>`'s raw attributes (spec §6.1). `raw` holds
 * attribute values or `null` when absent; `targetExists` / `triggerExists`
 * say whether the slide has an element with the target / trigger id.
 */
export function validateEffect(raw, index, targetExists, triggerExists = true) {
  const position = `effect ${index + 1}`;
  const label = isBlank(raw.target) ? position : `${position} (target ${raw.target})`;
  for (const name of ["target", "family", "effect", "start"]) {
    if (isBlank(raw[name])) throw new EffectError(`${label} is missing the required attribute ${name}.`);
  }
  const allowed = SUPPORTED_EFFECTS[raw.family];
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_EFFECTS, raw.family) || !allowed) {
    throw new EffectError(`${label} has an unknown family "${raw.family}".`);
  }
  if (!allowed.includes(raw.effect)) throw new EffectError(`${label} has an unknown ${raw.family} effect "${raw.effect}".`);
  if (!SUPPORTED_STARTS.includes(raw.start)) throw new EffectError(`${label} has an unknown start "${raw.start}".`);
  if (!targetExists) throw new EffectError(`${label} points at an element that does not exist on this slide.`);
  if (raw.family === "path" && isBlank(raw.d)) throw new EffectError(`${label} is a path effect with no d.`);

  const present = (name) => raw[name] !== null && raw[name] !== undefined;
  if (present("easing")) {
    if (!EASINGS.includes(raw.easing)) throw new EffectError(`${label} has an unknown easing "${raw.easing}".`);
    if (raw.family === "media") throw new EffectError(`${label} is a media effect, which takes no easing.`);
  }
  let repeat = 1;
  if (present("repeat")) {
    if (!/^[1-9]\d*$/.test(String(raw.repeat))) throw new EffectError(`${label} has repeat "${raw.repeat}", which is not a positive integer.`);
    if (raw.family !== "emphasis") throw new EffectError(`${label} repeats, but only emphasis effects can.`);
    repeat = Number(raw.repeat);
  }
  if (present("by")) {
    if (!BUILD_UNITS.includes(raw.by)) throw new EffectError(`${label} has an unknown by "${raw.by}".`);
    if (raw.family !== "enter" && raw.family !== "exit") throw new EffectError(`${label} builds by ${raw.by}, but only enter and exit effects can.`);
  }
  if (present("stagger") && !present("by")) throw new EffectError(`${label} has a stagger but no by.`);
  if (present("trigger")) {
    if (isBlank(raw.trigger)) throw new EffectError(`${label} has an empty trigger.`);
    if (!triggerExists) throw new EffectError(`${label}'s trigger points at an element that does not exist on this slide.`);
  }

  const effect = {
    target: raw.target,
    family: raw.family,
    effect: raw.effect,
    start: raw.start,
    duration: parseSeconds(raw.duration, raw.family === "media" ? DEFAULT_DURATION_MEDIA : DEFAULT_DURATION, `${label}'s duration`),
    delay: parseSeconds(raw.delay, 0, `${label}'s delay`),
    index,
  };
  if (!isBlank(raw.d)) effect.d = raw.d;
  if (present("easing")) effect.easing = raw.easing;
  if (repeat !== 1) effect.repeat = repeat;
  if (present("by")) {
    effect.by = raw.by;
    effect.stagger = parseSeconds(raw.stagger, DEFAULT_STAGGER, `${label}'s stagger`);
  }
  if (present("trigger")) effect.trigger = raw.trigger;
  return effect;
}

/**
 * Spec §6.3: an `on-click` effect opens a new step; `with-previous` and
 * `after-previous` join the current one. A list whose first effect is not
 * `on-click` is corrupt.
 */
export function deriveSteps(effects) {
  return groupSteps(effects.filter((effect) => !effect.trigger));
}

/**
 * Spec §6.3: effects with a `trigger` form that element's own sequence of
 * steps, by the same rule. Keyed by trigger id (a null-prototype object:
 * ids come from untrusted markup).
 */
export function deriveTriggers(effects) {
  const byTrigger = new Map();
  for (const effect of effects) {
    if (!effect.trigger) continue;
    if (!byTrigger.has(effect.trigger)) byTrigger.set(effect.trigger, []);
    byTrigger.get(effect.trigger).push(effect);
  }
  const triggers = Object.create(null);
  for (const [id, list] of byTrigger) triggers[id] = groupSteps(list);
  return triggers;
}

function groupSteps(effects) {
  const steps = [];
  for (const effect of effects) {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
      continue;
    }
    if (steps.length === 0) {
      throw new EffectError(`effect ${effect.index + 1} starts "${effect.start}", but there is no earlier step to join; the effect list is corrupted.`);
    }
    steps[steps.length - 1].effects.push(effect);
  }
  return steps;
}

/**
 * Every target whose FIRST effect in file order is `family="enter"` — the
 * elements not on screen when the slide opens. A slide's static look is
 * its final state with all effects run, so everything else starts visible.
 */
export function enterTargets(effects) {
  const seen = new Set();
  const hidden = [];
  for (const effect of effects) {
    if (seen.has(effect.target)) continue;
    seen.add(effect.target);
    if (effect.family === "enter") hidden.push(effect.target);
  }
  return hidden;
}

/** Validates one `<slidra:transition>`'s raw attributes (spec §7). */
export function validateTransition(raw) {
  const edge = (name, fallback) => {
    const effect = isBlank(raw[name]) ? "none" : raw[name];
    const allowed = name === "enter" ? ENTER_TRANSITION_EFFECTS : TRANSITION_EFFECTS;
    if (!allowed.includes(effect)) throw new EffectError(`transition ${name} "${raw[name]}" is not one of ${allowed.join(", ")}.`);
    const duration = parseSeconds(raw[`${name}-duration`], fallback, `transition ${name}-duration`);
    return { effect, duration };
  };
  return { enter: edge("enter", DEFAULT_TRANSITION.enter.duration), exit: edge("exit", DEFAULT_TRANSITION.exit.duration) };
}

/**
 * A CSS.escape()-equivalent for an id selector, hand-rolled because the
 * ids come from untrusted markup and the result is spliced into a
 * stylesheet inside the slide frame.
 */
export function cssEscapeId(id) {
  let result = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.charCodeAt(i);
    if (code === 0) {
      result += "�";
      continue;
    }
    if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) {
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
    const isAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (code >= 0x80 || ch === "-" || ch === "_" || isDigit || isAlpha) {
      result += ch;
      continue;
    }
    // A hex escape rather than `\\${ch}`: the result lands inside a
    // <style> element, so it must never carry a literal `<`.
    result += `\\${code.toString(16)} `;
  }
  return result;
}
