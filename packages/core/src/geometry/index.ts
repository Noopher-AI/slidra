// Barrel for the geometry module. Landed in wave 1's base commit so that
// concurrent units extend their own barrel instead of the shared
// packages/core/src/index.ts (fan-out structure).
export {
  IDENTITY,
  parseTransform,
  multiplyMatrix,
  composeMatrices,
  applyMatrixToPoint,
  invertMatrix,
  decomposeMatrix,
  formatTransform,
} from "./transform.js";
export type { Matrix, Point, TransformParts } from "./transform.js";
export {
  transformRect,
  unionRects,
  primitiveBounds,
  pathBounds,
  elementBounds,
  absolutePosition,
} from "./bbox.js";
export type { Rect, ElementBoundsOptions } from "./bbox.js";
