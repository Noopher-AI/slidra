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
 * A CoMotionError subtype for the one case that positively identifies the
 * requested thing as genuinely absent: a virtual path that does not
 * resolve to any node, a virtual path that resolves to something that is
 * not a file, or an unknown presentation id. Nothing else may throw this.
 *
 * Callers that need an HTTP-shaped answer (e.g. the `/api/raw/` route)
 * check for this subtype with `instanceof` and treat only it as 404 —
 * every other `CoMotionError`, including ones not yet invented, is a
 * server-side failure (500), because "not an instance of this type" is
 * not evidence that something is missing. This is the inverse of an
 * earlier design that tried to positively identify I/O failures instead:
 * that shape meant every new error kind defaulted to 404 unless someone
 * remembered to carve out an exception, which is how three prior rounds
 * of this ticket each fixed one more mistaken 404. Making "genuinely
 * absent" the thing that must be positively proven means a new error kind
 * defaults to a loud 500 instead of a silently wrong 404.
 */
export class CoMotionNotFoundError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionNotFoundError";
  }
}
