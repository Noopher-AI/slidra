import { CoMotionError } from "../errors.js";
import { attributeValue, scanDocument, type ScannedNode } from "./scan.js";
import { formatSvgNumber } from "../svg-number.js";
import { EFFECTS_NS } from "../effects/index.js";

/**
 * Per-page enter/exit transitions ([E2.T11]): a pure `svgContent: string ->
 * …` splice writer/reader, modeled on `notes.ts`'s `setSlideNotes` and
 * `effects/edit.ts`'s effect-list reader/writer. Lives under `<metadata>`
 * as `<comot:transition>`, a third sibling alongside `<comot:effects>` and
 * `<comot:notes>` — no new metadata mechanism needed.
 *
 * No `node:` import here — this ships in the web bundle too
 * (`@co-motion/core/slide`).
 */

const TRANSITION_TAG = "comot:transition";
const METADATA_TAG = "metadata";
const TRANSITION_NS = EFFECTS_NS;

export type PageTransitionEffect = "none" | "fade" | "slide" | "zoom";
const PAGE_TRANSITION_EFFECTS: readonly PageTransitionEffect[] = ["none", "fade", "slide", "zoom"];

export interface SlideTransitionEdge {
  effect: PageTransitionEffect;
  duration: number;
}

export interface SlideTransition {
  enter: SlideTransitionEdge;
  exit: SlideTransitionEdge;
}

/** §4.2: "this page never had one set" — the same meaning as an absent `<comot:transition>` and, on the read side, an unknown future value. */
const DEFAULT_TRANSITION: SlideTransition = {
  enter: { effect: "none", duration: 0.6 },
  exit: { effect: "none", duration: 0.5 },
};

function requireSvgRoot(roots: readonly ScannedNode[]): ScannedNode {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

function locateTransition(svgRoot: ScannedNode): { metadata?: ScannedNode; transition?: ScannedNode } {
  const metadata = svgRoot.children.find((child) => child.tag === METADATA_TAG);
  if (!metadata) return {};
  const nodes = metadata.children.filter((child) => child.tag === TRANSITION_TAG);
  if (nodes.length > 1) {
    throw new CoMotionError(
      `這張投影片的 metadata 裡有 ${nodes.length} 組頁面進出場設定，但一張投影片只能有一份，簡報已損毀。`,
    );
  }
  return { metadata, transition: nodes[0] };
}

function parseEffectAttr(raw: string | null, label: "enter" | "exit"): PageTransitionEffect {
  if (raw === null) return "none";
  if (raw === "" || !(PAGE_TRANSITION_EFFECTS as readonly string[]).includes(raw)) {
    throw new CoMotionError(`頁面進出場的 ${label} 值「${raw}」尚未實作。`);
  }
  return raw as PageTransitionEffect;
}

function parseDurationAttr(raw: string | null, label: "enter-duration" | "exit-duration", fallback: number): number {
  if (raw === null) return fallback;
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CoMotionError(`頁面進出場的 ${label} 值「${raw}」不是合法的秒數。`);
  }
  return value;
}

/**
 * Reads a slide's page enter/exit transition (`co-motion slide transition
 * set`'s own read side, and `canvas.ts`/`AnimatePagePanel`'s data source).
 * See the module doc for the full read-side behaviour contract — absent/
 * missing pieces default; a present-but-illegal value throws.
 */
export function readSlideTransition(svgContent: string): SlideTransition {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { transition } = locateTransition(svgRoot);
  if (!transition) return DEFAULT_TRANSITION;

  return {
    enter: {
      effect: parseEffectAttr(attributeValue(transition, "enter"), "enter"),
      duration: parseDurationAttr(attributeValue(transition, "enter-duration"), "enter-duration", DEFAULT_TRANSITION.enter.duration),
    },
    exit: {
      effect: parseEffectAttr(attributeValue(transition, "exit"), "exit"),
      duration: parseDurationAttr(attributeValue(transition, "exit-duration"), "exit-duration", DEFAULT_TRANSITION.exit.duration),
    },
  };
}

/** Whether `svgContent` already carries a `<comot:transition>` — used only by the `formatVersion` 2→3 migration (`project-migration.ts`) to decide whether a slide should be left alone rather than overwritten. */
export function slideHasTransitionMetadata(svgContent: string): boolean {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  return locateTransition(svgRoot).transition !== undefined;
}

/**
 * Writes (creates or replaces) a slide's `<comot:transition>`, always with
 * all four attributes filled in — partial merging against the slide's
 * current values is the caller's job (`slide-ops.ts`'s
 * `setSlideTransitionOn`); this function trusts whatever `SlideTransition`
 * it is given and only handles the splice.
 */
export function setSlideTransition(svgContent: string, transition: SlideTransition): string {
  const markup =
    `<${TRANSITION_TAG} xmlns:comot="${TRANSITION_NS}" ` +
    `enter="${transition.enter.effect}" enter-duration="${formatSvgNumber(transition.enter.duration)}" ` +
    `exit="${transition.exit.effect}" exit-duration="${formatSvgNumber(transition.exit.duration)}"/>`;

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const { metadata, transition: existing } = locateTransition(svgRoot);

  if (!metadata) {
    const block = `<${METADATA_TAG}>${markup}</${METADATA_TAG}>`;
    const insertAt = svgRoot.contentStart;
    return svgContent.slice(0, insertAt) + block + svgContent.slice(insertAt);
  }
  if (!existing) {
    const insertAt = metadata.contentStart;
    return svgContent.slice(0, insertAt) + markup + svgContent.slice(insertAt);
  }
  return svgContent.slice(0, existing.start) + markup + svgContent.slice(existing.end);
}
