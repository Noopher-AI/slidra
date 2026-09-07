// Barrel for the slide module. Landed in wave 1's base commit so that
// concurrent units extend their own barrel instead of the shared
// packages/core/src/index.ts (fan-out structure).
//
// Everything re-exported here is free of Node built-ins, transitively too:
// the slide model and its normalisation have to be computable in a browser
// too (跨波接縫 2). The file-writing half of `co-motion convert` therefore
// lives in the CLI, not here.
export {
  SLIDE_PRIMITIVE_TAGS,
  FORBIDDEN_TAGS,
  CONTAINER_ATTRIBUTES,
  MAX_CONTAINER_DEPTH,
  TEXT_WIDTH_ATTRIBUTE,
  checkSlideCompliance,
  assertSlideCompliant,
  parseSlide,
} from "./format.js";
export type {
  ComplianceCode,
  ComplianceIssue,
  SlideElement,
  SlideElementKind,
  SlideModel,
  SlidePrimitive,
} from "./format.js";
export { normaliseSlideSvg } from "./normalise.js";
export type { NormaliseOptions, NormaliseResult } from "./normalise.js";
// #200: the Style panel's Page tab reads `SlideModel.pageStyle` off the
// browser-safe `SlideElement`/`SlideModel` types above — `PageStyle` has to
// be reachable from this same subpath for that field to type-check.
export type { PageStyle } from "../slide-style.js";
// [E2.T3] adds these three: the web-side speaker-notes reader
// (`packages/web/src/notes.ts`) needs the offset-carrying scanner directly
// — DOMParser is unusable there because it treats an unbound `comot:`
// namespace prefix as a fatal parse error, and old on-disk notes predate
// this ticket's xmlns fix.
export { scanDocument, attributeOf } from "./scan.js";
export type { ScannedNode } from "./scan.js";
// [E2.T8]: the web-side comment reader (`packages/web/src/comments.ts`)
// needs the same splice-only parser the CLI's `comment` commands write
// through (`core/src/slide-ops.ts`), for the same DOMParser-unbound-namespace
// reason `scanDocument`/`attributeOf` above were exported for notes.
export { readSlideComments, addSlideComment, editSlideComment, deleteSlideComment } from "./comments.js";
export type { SlideComment } from "./comments.js";
// [E2.T11]: the web-side Animate › Page panel and `canvas.ts`'s page
// enter/exit playback both need the read side directly — same Node-free
// reasoning as every export above.
export { readSlideTransition } from "./transition.js";
export type { PageTransitionEffect, SlideTransition, SlideTransitionEdge } from "./transition.js";
