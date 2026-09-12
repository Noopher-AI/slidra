/**
 * Seam C's parent half (C3 in the design doc): slide markup in, a play
 * plan out. All derivation logic lives here in the parent, where it is
 * unit-testable without a browser — the runtime that receives the plan is
 * deliberately dumb, it only applies what it is given (see
 * player-runtime.js).
 *
 * [E4.T7]: `steps` is no longer derived here — `fetchSlideEffectPlan`
 * fetches it (already grouped) from `GET /api/effects/<slidePath>`, the
 * same computation `effect list` does for the CLI. `computePlayerPlan` is
 * therefore async now; everything else in this module (hidden/media/embed
 * derivation) is still a pure, synchronous function of `svgMarkup` alone.
 */
import { EMBED_PROVIDERS, type EmbedProvider } from "./embed.js";
import { fetchSlideEffectPlan } from "./effects.js";
import type { Effect, SlideTransition, Step } from "./effects.js";

export interface MediaCue {
  /** The raw `data-slidra-media` value, unmodified — the play document's <base> resolves it. */
  src: string;
  kind: "video" | "audio";
}

export interface PlayerPlan {
  steps: Step[];
  /**
   * Every target whose FIRST effect entry in the file (D12, [E2.T7]) is a
   * `family="enter"` effect, deduplicated, in first-appearance order. These
   * are the elements not on screen when the slide opens — everything else
   * starts visible (ADR-0009: a slide's static look is the final state with
   * all effects already run). A target whose first effect is `exit` (or
   * anything else) is NOT hidden at open, even if a later effect on it is
   * `enter` — it was already on screen.
   */
  hidden: string[];
  /**
   * `hidden[i]`'s already-escaped CSS id selector (D7) — computed once here
   * (`cssEscapeId`, this module) so the runtime never re-implements the
   * escaping rule; it only ever string-matches against these.
   */
  hideSelectors: Record<string, string>;
  /** Keyed by the `family="media"` effect's target id — see mediaCuesFor below. */
  media: Record<string, MediaCue>;
  /**
   * Every `data-slidra-media` element on the slide, effect or no effect —
   * `stageMediaFor`'s own table, the same one view mode's stage layer
   * already gets. Play mode needs it because a video an author simply
   * inserted carries no `family="media"` effect at all: without this, the
   * only thing `media` above knows about is effect targets, so such a
   * video is never created in play mode and the audience sees a dead
   * placeholder box. Targets that DO have a media effect stay the effect
   * list's business (`playMedia`) and are skipped by the stage layer.
   */
  stageMedia: Record<string, StageMediaEntry>;
  /**
   * The ids of every third-party embed on the slide. The runtime needs
   * only the ids — it measures those elements' on-screen boxes and posts
   * them out; the URLs stay in the parent, which is where the `<iframe>`
   * actually lives (`stageEmbedsFor`).
   */
  embedIds: string[];
  /**
   * The slide's `<slidra:transition>`, off the same
   * `fetchSlideEffectPlan` call `steps`/`hidden` above already came from —
   * `renderPlay()` used to re-derive this itself by parsing `svgMarkup`
   * directly (`readSlideTransition`, core), which the web bundle no longer
   * depends on. Riding along on the plan this module already builds avoids
   * a second `fetchSlideEffectPlan` call in `renderPlay()`'s own critical
   * path (even a cache-hit await is one more microtask on a path
   * `PlayChrome.tsx`'s 2.5s auto-hide timer is racing against).
   */
  transition: SlideTransition;
  /**
   * [E2.T7]/D8: Preview's own addressing, set by the CALLER (canvas.ts's
   * `previewEffects`) on top of an otherwise-ordinary plan — never by
   * `computePlayerPlan` itself, which has no notion of "which card was
   * clicked". `null` means "preview the whole slide, step by step"
   * (`controller.previewEffects(null)`, the panel's own Preview button); a
   * concrete list means "only these effect-list positions" (one card's ▶).
   */
  preview?: { effectIndices: number[] | null };
}

/** Rejects with whatever `fetchSlideEffectPlan` rejects with — see effects.ts for the (Traditional Chinese) messages. */
export async function computePlayerPlan(svgMarkup: string, slidePath: string): Promise<PlayerPlan> {
  const { effects, steps, transition } = await fetchSlideEffectPlan(slidePath);
  const hidden = enterTargets(effects);
  return {
    steps,
    hidden,
    hideSelectors: hideSelectorsFor(hidden),
    media: mediaCuesFor(svgMarkup, effects),
    stageMedia: stageMediaFor(svgMarkup),
    embedIds: Object.keys(stageEmbedsFor(svgMarkup)),
    transition,
  };
}

/**
 * D12/[E2.T7]: a target is hidden at open only when its FIRST effect entry
 * in file order is `family="enter"` — an element whose first effect is
 * something else (e.g. it exits before it ever gets an entrance effect) was
 * already on screen, and must not be pre-hidden. Walking the list once,
 * remembering only the first effect seen per target, implements this
 * directly without a second pass.
 */
function enterTargets(effects: readonly Effect[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const effect of effects) {
    if (seen.has(effect.target)) continue;
    seen.add(effect.target);
    if (effect.family === "enter") result.push(effect.target);
  }
  return result;
}

/**
 * Unambiguous allow-list (settled decision, not guessed from MIME
 * sniffing): anything else, including `.ogg`, throws. Exported so
 * apps/web/test/player-plan.test.ts can assert every entry here also
 * resolves to a real Content-Type in packages/server/src/raw.ts's
 * MIME_TYPES — the two lists must stay in lockstep, or an extension this
 * player accepts gets served as application/octet-stream, which some
 * browsers refuse to decode as media even though the bytes are fine.
 */
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".ogv"];
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".opus", ".oga", ".aac"];

/**
 * Builds `plan.media`, keyed by each `family="media"` effect's target. This
 * parses `svgMarkup` itself with a fresh `DOMParser` — `effects` came from
 * the `/api/effects/` route (no DOM involved on this side at all) — because
 * the only thing this needs from the markup is one attribute lookup per
 * media target — not worth a dedicated route field for.
 */
function mediaCuesFor(svgMarkup: string, effects: Effect[]): Record<string, MediaCue> {
  const mediaEffects = effects.filter((effect) => effect.family === "media" && effect.effect === "play");
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
    // [E2.T17]: an embed's `data-slidra-media` is a third-party player URL,
    // not a file — it has no extension for `mediaKindFor` to classify, and
    // there is no <video> element for the runtime to drive. A media effect
    // on one is legal and meaningful (it plays the embedded player, via
    // that player's own API from the parent document); it simply is not a
    // media CUE. `plan.embedIds` is how the runtime recognises it.
    if (el.hasAttribute("data-slidra-embed")) continue;
    const src = el.getAttribute("data-slidra-media");
    if (!src) {
      // ADR-0009: every effect points at an element, and a media effect's
      // element must carry data-slidra-media (ADR-0005) — its absence is a
      // damaged presentation, not a silently-skipped effect.
      throw new Error(`Element "${target}"'s effect has family="media" but no data-slidra-media; the presentation is corrupted.`);
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
    `Element "${target}"'s data-slidra-media "${src}" has extension "${extension}", which is not a supported media format. Use .oga for audio and .ogv for video.`,
  );
}

export interface StageMediaEntry {
  /** The raw `data-slidra-media` value, unmodified — same contract as `MediaCue.src`. */
  src: string;
  kind: "video" | "audio";
}

/**
 * [E2.T17] plan §4.4: the stage (view-mode) counterpart of `mediaCuesFor`,
 * but scanning every `data-slidra-media` element in the slide rather than
 * only the ones a `family="media"` effect points at — a slide can (and, per
 * the existing fixtures, does) carry ADR-0005 media placeholders with no
 * effect on them at all. Kept in this module, not `selection-runtime.js`
 * (a `?raw`-injected, import-free script — D3), so kind derivation has
 * exactly one implementation shared with the player.
 *
 * Deliberately DOES NOT throw the way `mediaKindFor` does: `mediaCuesFor`
 * only ever sees elements an author explicitly wired a media effect to, so
 * an unsupported extension there is a damaged presentation. This function
 * walks every `data-slidra-media` element on the page, image placeholders
 * (`style-panel-deck`'s photo) included — skipping what it cannot classify
 * is correct here, not silently degraded.
 */
export function stageMediaFor(svgMarkup: string): Record<string, StageMediaEntry> {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  // Object.create(null): same ADR-0010 untrusted-id reasoning as
  // mediaCuesFor above — a legal SVG id can be "__proto__".
  const result: Record<string, StageMediaEntry> = Object.create(null);
  const elements = doc.querySelectorAll("[data-slidra-media]");
  for (const el of Array.from(elements)) {
    const id = el.getAttribute("id");
    const src = el.getAttribute("data-slidra-media");
    if (!id || !src) continue;
    // An embed is not a media file: `src` is a third-party player URL with
    // no bytes and no extension to classify, and it is rendered by the
    // parent document's overlay (see stageEmbedsFor below), never by
    // either runtime's own <video>/<audio>.
    if (el.hasAttribute("data-slidra-embed")) continue;
    const declaredType = el.getAttribute("data-slidra-type");
    const kind = declaredType === "video" || declaredType === "audio" ? declaredType : mediaKindForStage(src);
    if (!kind) continue;
    result[id] = { src, kind };
  }
  return result;
}

export interface StageEmbedEntry {
  /** `data-slidra-embed`'s value, already narrowed to a provider this build knows. */
  provider: EmbedProvider;
  /** The player URL to load — `data-slidra-media`'s raw value (`embed.ts` canonicalised it at insert time). */
  url: string;
}

/**
 * [E2.T17]: every third-party player embed on the slide. Separate from
 * `stageMediaFor` because the two have nothing in common downstream — a
 * media entry becomes a `<video>` inside the sandboxed slide iframe, an
 * embed entry becomes an `<iframe>` in the PARENT document (measured:
 * the YouTube player refuses to load under `allow-scripts` alone, and
 * ADR-0011 forbids granting the slide document `allow-same-origin`; see
 * `packages/core/src/embed.ts`).
 *
 * An unknown provider is skipped rather than thrown on, for the same
 * reason `stageMediaFor` skips an unclassifiable src: this walks whatever
 * the slide happens to contain, including a file written by a newer build.
 */
export function stageEmbedsFor(svgMarkup: string): Record<string, StageEmbedEntry> {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const result: Record<string, StageEmbedEntry> = Object.create(null);
  for (const el of Array.from(doc.querySelectorAll("[data-slidra-embed]"))) {
    const id = el.getAttribute("id");
    const url = el.getAttribute("data-slidra-media");
    const provider = el.getAttribute("data-slidra-embed");
    if (!id || !url || !provider) continue;
    if (!EMBED_PROVIDERS.includes(provider as EmbedProvider)) continue;
    result[id] = { provider: provider as EmbedProvider, url };
  }
  return result;
}

/** Non-throwing counterpart of `mediaKindFor`: an unrecognised extension (an image, or anything else) resolves to `null` rather than an error — see `stageMediaFor`'s own comment for why. */
function mediaKindForStage(src: string): "video" | "audio" | null {
  const dot = src.lastIndexOf(".");
  const extension = dot === -1 ? "" : src.slice(dot).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return null;
}

/**
 * Per-id `<style>` rules that pre-hide every `hidden` target via
 * `opacity:0`. Injected into the play `srcdoc`'s `<head>` — never via
 * script on DOMContentLoaded — so there is no window in which the full
 * slide is painted before hiding takes effect (the "flash of full content"
 * this ticket must avoid). Returns "" when nothing needs hiding, rather
 * than an empty rule, which would be pointless CSS.
 *
 * [E2.T7]/D7: one rule per id, not one rule for a joined selector list, and
 * the `<style>` itself carries `id="slidra-hide"` — the runtime unhides an
 * element by removing just that id's rule from this stylesheet's
 * `textContent` (via `plan.hideSelectors`) and re-running `el.animate(...)`
 * in the same synchronous task, never by touching every other still-hidden
 * id's rule. A single joined selector could not support removing one id
 * without rebuilding the whole list from scratch inside the runtime, which
 * would mean re-deriving/re-escaping ids there — exactly the duplicated-
 * escaping-logic this decision avoids.
 *
 * `!important`: a legal slide element is free to carry its own inline
 * `style="opacity:1"` (ADR-0010 — slide content is untrusted, but even
 * honestly-authored markup can do this). Inline style normally wins the
 * cascade over any external/injected stylesheet rule, which would let that
 * one element flash fully visible at the very start of play regardless of
 * this rule — exactly the "flash of full content" bug this ticket exists
 * to prevent. `!important` is what lets an injected stylesheet rule beat
 * an element's own inline style. `!important` also beats a WAAPI/CSS
 * animation's own opacity keyframes (animation-level styles lose to any
 * `!important` declaration) — this is exactly why the runtime must remove
 * this id's rule from the stylesheet BEFORE calling `el.animate(...)`, in
 * the same synchronous task (player-runtime.js's `applyStep`): otherwise
 * this rule would simply keep the element invisible no matter what the
 * entrance animation's own opacity keyframes say.
 */
export function renderHideStyle(hidden: string[]): string {
  if (hidden.length === 0) return "";
  const rules = hidden.map((id) => `${hideSelectorsFor([id])[id]}{opacity:0 !important}`).join("");
  return `<style id="slidra-hide">${rules}</style>`;
}

/** `plan.hideSelectors` (D7): `hidden[i]` -> its already-escaped CSS id selector, computed once here so the runtime never re-implements `cssEscapeId`. */
export function hideSelectorsFor(hidden: readonly string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const id of hidden) {
    result[id] = `#${cssEscapeId(id)}`;
  }
  return result;
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
      result += "�";
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
 * `window.__SLIDRA_PLAN__`.
 *
 * Reconstructed via `JSON.parse(...)`, never a bare object-literal
 * assignment (`window.__SLIDRA_PLAN__ = ${JSON.stringify(plan)}`, this
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
 * every literal `<` in this function's output to `<` (gate review
 * round 3): that protection guards the *HTML tokenizer* reading the
 * `<script>` block's raw text, a concern one level below where JS or JSON
 * parsing even begins, and the invariant it relies on — every `<` in this
 * output sits inside a quoted string — still holds here (now inside the
 * outer JS string literal wrapping the escaped JSON text, instead of
 * directly inside a JSON string value).
 *
 * `startStep` (#46): a render-time argument, not part of `PlayerPlan`
 * itself — only the parent knows, at render time, whether this is a fresh
 * slide or a backwards retreat landing on a specific step; the plan's own
 * derivation from slide markup never changes. Default `-1` means "this
 * slide has not been advanced yet", today's behaviour, unchanged for every
 * existing call site that passes only `plan`.
 */
export function renderPlanScript(plan: PlayerPlan, startStep: number = -1): string {
  const json = JSON.stringify({ ...plan, startStep });
  return `window.__SLIDRA_PLAN__ = JSON.parse(${JSON.stringify(json)});`;
}
