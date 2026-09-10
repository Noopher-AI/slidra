/**
 * `packages/server`'s own copy of `packages/core`'s error hierarchy
 * ([E4.T9]/F7 — the server no longer imports `packages/core` at all).
 * Identical class hierarchy to `packages/core/src/errors.ts`; see that
 * module for the reasoning behind the `CoMotionNotFoundError`/
 * `CoMotionInvalidRequestError` split.
 */
export class CoMotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionError";
  }
}

export class CoMotionNotFoundError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionNotFoundError";
  }
}

export class CoMotionInvalidRequestError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionInvalidRequestError";
  }
}
