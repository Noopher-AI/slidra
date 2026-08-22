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
