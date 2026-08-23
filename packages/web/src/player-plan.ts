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

export interface MediaCue {
  /** The raw `data-comot-media` value, unmodified — the play document's <base> resolves it. */
  src: string;
  kind: "video" | "audio";
}

export interface PlayerPlan {
  steps: Step[];
  /**
   * Every `family="enter"` target, deduplicated, in first-appearance order.
   * These are the elements not on screen when the slide opens — everything
   * else starts visible (ADR-0009: a slide's static look is the final
   * state with all effects already run).
   */
  hidden: string[];
  /** Keyed by the `family="media"` effect's target id — see mediaCuesFor below. */
  media: Record<string, MediaCue>;
}

/** Throws whatever parseEffects/deriveSteps throw — see effects.ts for the (Traditional Chinese) messages. */
export function computePlayerPlan(svgMarkup: string): PlayerPlan {
  const effects = parseEffects(svgMarkup);
  const steps = deriveSteps(effects);
  return { steps, hidden: enterTargets(effects), media: mediaCuesFor(svgMarkup, effects) };
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
 * Unambiguous allow-list (settled decision, not guessed from MIME
 * sniffing): anything else, including `.ogg`, throws. Exported so
 * packages/web/test/player-plan.test.ts can assert every entry here also
 * resolves to a real Content-Type in packages/server/src/raw.ts's
 * MIME_TYPES — the two lists must stay in lockstep, or an extension this
 * player accepts gets served as application/octet-stream, which some
 * browsers refuse to decode as media even though the bytes are fine.
 */
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".ogv"];
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".opus", ".oga", ".aac"];

/**
 * Builds `plan.media`, keyed by each `family="media"` effect's target. This
 * re-parses `svgMarkup` (parseEffects already parsed it once, but discards
 * its DOM) because the only new thing this ticket needs from the markup is
 * one attribute lookup per media target — not worth widening effects.ts's
 * return shape for.
 */
function mediaCuesFor(svgMarkup: string, effects: Effect[]): Record<string, MediaCue> {
  const mediaEffects = effects.filter((effect) => effect.family === "media");
  // Object.create(null) throughout this function, never {}: `target` comes
  // straight from untrusted slide content (ADR-0010), and a legal SVG id
  // can be "__proto__". Building this table via plain-object assignment
  // (`media[target] = cue`) does not create an own property for that
  // specific key — assigning to "__proto__" on an object that still has
  // Object.prototype's own __proto__ accessor in its chain reassigns the
  // object's [[Prototype]] instead, so the cue never becomes real,
  // enumerable, own data (Codex review gate round 1, P2; see
  // player-plan.test.ts's "__proto__" id test, which fails against a plain
  // {} here). Object.create(null) has no such accessor, so every
  // assignment — however the key is spelled — is an ordinary own property.
  if (mediaEffects.length === 0) return Object.create(null);

  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const media: Record<string, MediaCue> = Object.create(null);
  for (const effect of mediaEffects) {
    const target = effect.target;
    // parseEffects already verified `target` resolves to an element in this
    // document — that check ran against the same markup, so it holds here too.
    const el = doc.getElementById(target) as Element;
    const src = el.getAttribute("data-comot-media");
    if (!src) {
      // ADR-0009: every effect points at an element, and a media effect's
      // element must carry data-comot-media (ADR-0005) — its absence is a
      // damaged presentation, not a silently-skipped effect.
      throw new Error(`元素「${target}」的效果是 family="media"，但沒有 data-comot-media，簡報已損毀。`);
    }
    media[target] = { src, kind: mediaKindFor(src, target) };
  }
  return media;
}

/** Derives video/audio purely from the file extension — never MIME sniffing (would need an async HEAD, and the user gesture cannot survive that). */
function mediaKindFor(src: string, target: string): "video" | "audio" {
  const dot = src.lastIndexOf(".");
  const extension = dot === -1 ? "" : src.slice(dot).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  throw new Error(
    `元素「${target}」的 data-comot-media「${src}」副檔名「${extension}」不是支援的媒體格式。音訊請用 .oga，影片請用 .ogv。`,
  );
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

/**
 * The `<script>` line that hands the plan to the runtime as
 * `window.__COMOT_PLAN__`.
 *
 * Reconstructed via `JSON.parse(...)`, never a bare object-literal
 * assignment (`window.__COMOT_PLAN__ = ${JSON.stringify(plan)}`, this
 * function's previous shape) — that distinction is load-bearing, not
 * stylistic. `plan.media` is keyed by untrusted SVG element ids
 * (ADR-0010), and a legal id can be "__proto__". ECMAScript object-literal
 * syntax gives a non-computed `"__proto__": value` property key special
 * treatment at the *syntax* level: it sets the object's `[[Prototype]]`
 * instead of creating an own property — this is true no matter how the
 * value was built on the parent side (Object.create(null) or otherwise;
 * see the fix in mediaCuesFor above, which only protects construction on
 * this side of the wire, not reconstruction on the iframe side). The
 * result: `plan.media["__proto__"]`'s cue would still happen to read back
 * correctly (the `__proto__` accessor's getter returns the very
 * `[[Prototype]]` that was just set — a syntax coincidence, not a
 * guarantee), but `Object.keys()`, a `{...media}` spread, or
 * `structuredClone()` would all silently lose that entry, since it was
 * never a real own property to begin with. `JSON.parse` has no such
 * special case for any key, `__proto__` included — every key becomes a
 * genuine own, enumerable data property via `CreateDataProperty`, not the
 * `[[Set]]` that an object literal's `__proto__` key triggers. The plan is
 * therefore round-tripped through a JSON *string* literal (double
 * `JSON.stringify`) instead of a bare object literal.
 *
 * This does not touch canvas.ts's `wrapPlayDocument`, which still escapes
 * every literal `<` in this function's output to `\u003C` (gate review
 * round 3): that protection guards the *HTML tokenizer* reading the
 * `<script>` block's raw text, a concern one level below where JS or JSON
 * parsing even begins, and the invariant it relies on — every `<` in this
 * output sits inside a quoted string — still holds here (now inside the
 * outer JS string literal wrapping the escaped JSON text, instead of
 * directly inside a JSON string value).
 */
export function renderPlanScript(plan: PlayerPlan): string {
  const json = JSON.stringify(plan);
  return `window.__COMOT_PLAN__ = JSON.parse(${JSON.stringify(json)});`;
}
