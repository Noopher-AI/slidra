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
export { buildShapeMarkup, removeElements } from "./edit.js";
export type { AddShapeInput, RemoveElementsResult } from "./edit.js";
export {
  insertSlidePathAt,
  removeSlidePath,
  moveSlidePath,
  nextSlideFileName,
  buildBlankSlideSvg,
} from "./order.js";
