/**
 * A CoMotionError is an expected, user-facing failure: a bad container,
 * an unknown presentation id, a missing formatVersion, etc.
 *
 * It always carries a Traditional Chinese message safe to print verbatim —
 * in particular it must never contain a real filesystem path (ADR-0004).
 */
export class CoMotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionError";
  }
}

/**
 * A CoMotionError subtype for the specific case where a virtual path
 * resolved to a real, discovered file, but the underlying read of that
 * file failed (permissions, a failing disk, any other I/O error) — as
 * opposed to the path never resolving at all. Callers that need to tell
 * "genuinely not there" (404-shaped) apart from "storage/permissions is
 * broken" (500-shaped) can check for this subtype with `instanceof`;
 * everything that only cares about "an expected, user-facing failure
 * happened" can keep treating it as an ordinary CoMotionError.
 */
export class CoMotionIOError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionIOError";
  }
}
